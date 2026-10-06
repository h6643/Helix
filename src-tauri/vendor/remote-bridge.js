#!/usr/bin/env node
/**
 * remote-bridge.js — TCP → `pi --mode rpc` 桥接器（远程工作区）
 *
 * 在**远程主机**上运行。本地的 Helix 连上来时先发一行握手 `cwd:<路径>`，
 * 本桥接器就在那个目录 exec 一个 `pi --mode rpc`，然后双向透传 JSONL。
 *
 * fork-per-connection：每个 TCP 连接 = 一个独立的 pi 进程 = 一个会话实例。
 * 这和本地 Helix 的「一个对话一个 pi 子进程」模型同形，所以并发对话不会
 * 互相串台。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────
 *   远程主机上： node remote-bridge.js [port]        # 默认 18800
 *   PI_CLI=/path/to/pi node remote-bridge.js         # pi 不在 PATH 时指定
 *
 *   本地开 SSH 转发（必须，不要直接暴露端口到公网）：
 *     ssh -L 18800:127.0.0.1:18800 user@host
 *
 *   本地 Helix 设置里的「远程项目（连接）」写入 config.yaml：
 *     pi: remote_rpc: "127.0.0.1:18800"
 *   之后每个会话连过来而不是本地 spawn pi；删掉这行回到本地模式。
 *
 * ── 环境变量 ───────────────────────────────────────────────────────────
 *   HOST        监听地址，默认 127.0.0.1（只允许走隧道，最安全）
 *   PORT        监听端口，默认 18800
 *   PI_CLI      pi 可执行文件，默认 "pi"（取 PATH）
 *   PI_ARGS     pi 启动参数，默认 "--mode rpc"（空格分隔）
 *   DEFAULT_CWD 握手 cwd 无效时的回退目录，默认 HOME
 *   PI_OFFLINE  透传给 pi，默认 "1"（跳过启动时的模型/版本刷新网络等待）
 *
 * ── 已知限制 ───────────────────────────────────────────────────────────
 *   pi 的 stderr 走桥接器自己的 stderr（远程终端），不会进 Helix 的 spawn
 *   日志——因为 stderr 不能混进 JSONL 流。远程「连接中」卡住时看远程输出。
 *   pi 的 exit code 拿不到（TCP 只有 EOF 没有状态码）。
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || process.argv[2] || 18800);
const DEFAULT_CWD = process.env.DEFAULT_CWD || os.homedir();
const PI_OFFLINE = process.env.PI_OFFLINE ?? "1";
// 握手行上限：cwd 是一行路径，64KB 足够。超了说明对端不是 Helix，直接掐掉。
const HANDSHAKE_LIMIT = 64 * 1024;

// 把握手传来的 cwd 规整成绝对路径（node spawn 的 cwd 不认 ~，相对路径也
// 必须有个基准）：
//   "~" / "~/x"   → 相对 home 展开
//   相对路径        → 相对 bridge 的 cwd（默认 home）解析，兼容「只传项目名」
//   绝对路径        → 原样
// 解析结果**不存在**（比如把本地 Windows 路径误发过来）→ 兜底 DEFAULT_CWD
// （home），并打到 stderr——否则 spawn 直接 ENOENT，网关那边会误报成
// 「pi 进程死了」。
function resolveCwd(raw) {
  const p = (raw || "").trim();
  if (!p) return DEFAULT_CWD;
  let resolved;
  if (p === "~") resolved = os.homedir();
  else if (p.startsWith("~/")) resolved = path.join(os.homedir(), p.slice(2));
  else if (path.isAbsolute(p)) resolved = p;
  else resolved = path.join(DEFAULT_CWD, p);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return resolved;
  }
  console.error(`[remote-bridge] cwd ${p} 不存在，回退到 ${DEFAULT_CWD}`);
  return DEFAULT_CWD;
}

/**
 * 解析要启动的 pi：返回 { cmd, args }。
 * 1) PI_CLI 显式指定 → 原样用（args 用 PI_ARGS，默认 "--mode rpc"）；
 * 2) 否则找 npm 全局的 cli.js（node + cli.js --mode rpc）——Windows 上 npm 的
 *    `pi` 只是个 shim 脚本，`spawn("pi")` 不带 shell 会 ENOENT，必须绕开；
 * 3) 兜底 `pi --mode rpc`（Linux/macOS 上 `pi` 是真实可执行文件，能直接 spawn）。
 */
function resolvePiCli() {
  if (process.env.PI_CLI) {
    return {
      cmd: process.env.PI_CLI,
      args: (process.env.PI_ARGS || "--mode rpc").split(/\s+/).filter(Boolean),
    };
  }
  const node = process.execPath;
  const npmGlobals = [
    path.join(os.homedir(), "AppData", "Roaming", "npm"), // Windows
    "/usr/local/lib/node_modules", // macOS/Linux npm
    path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
    "/usr/lib/node_modules",
  ];
  const pkg = path.join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  for (const base of npmGlobals) {
    const cli = path.join(base, "node_modules", pkg);
    if (fs.existsSync(cli)) {
      return { cmd: node, args: [cli, "--mode", "rpc"] };
    }
  }
  return { cmd: "pi", args: ["--mode", "rpc"] };
}

const server = net.createServer((socket) => {
  let handshake = Buffer.alloc(0);
  let child = null;
  let awaitingDrain = false;

  // 握手阶段：缓冲到第一个 `\n`，解析 `cwd:<路径>`。
  const onHandshakeData = (chunk) => {
    handshake = Buffer.concat([handshake, chunk]);
    const nl = handshake.indexOf(0x0a);
    if (nl === -1) {
      if (handshake.length > HANDSHAKE_LIMIT) socket.destroy();
      return;
    }
    const line = handshake.subarray(0, nl).toString("utf8").trim();
    const rest = handshake.subarray(nl + 1);
    handshake = Buffer.alloc(0);
    socket.off("data", onHandshakeData);

    const raw = line.startsWith("cwd:") ? line.slice(4).trim() : "";
    const cwd = resolveCwd(raw);

    const { cmd, args } = resolvePiCli();
    child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, PI_OFFLINE },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", (e) => {
      console.error(`[remote-bridge] spawn ${cmd} failed: ${e.message}`);
      socket.destroy();
    });

    // 握手行之后、relay 挂上之前收到的字节，一并交给 pi。
    if (rest.length > 0) {
      if (!child.stdin.write(rest)) {
        child.stdin.pause();
        awaitingDrain = true;
      }
    }

    // pi stdout → socket（JSONL 单向流）
    child.stdout.on("data", (d) => socket.write(d));
    // socket → pi stdin（背压对称处理）
    socket.on("data", (d) => {
      if (!child.stdin.write(d)) {
        socket.pause();
      }
    });
    child.stdin.on("drain", () => {
      awaitingDrain = false;
      socket.resume();
    });
    socket.on("drain", () => {
      if (!awaitingDrain) child.stdin.resume();
    });

    // 任一侧关闭 → 两边都收掉
    child.on("exit", () => socket.destroy());
    socket.on("close", () => {
      if (child && child.exitCode === null && !child.killed) child.kill();
    });

    // pi 的 stderr 只能到桥接器自己的 stderr（不能混进 JSONL 流）。
    child.stderr.on("data", (d) => process.stderr.write(`[pi] ${d}`));
  };

  socket.on("data", onHandshakeData);
  socket.on("error", () => {});
});

server.listen(PORT, HOST, () => {
  const { cmd, args } = resolvePiCli();
  console.log(`[remote-bridge] listening on ${HOST}:${PORT} (pi=${cmd} ${args.join(" ")})`);
  console.log(`[remote-bridge] 在远程主机上运行；本地 Helix 经 ssh -L ${PORT}:127.0.0.1:${PORT} user@host 连接。`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));