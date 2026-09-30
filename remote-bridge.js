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
 * 为什么要这一层：pi 的 RPC 模式是纯 stdio，没有 socket 监听。所以远程 pi
 * 必须有人把 TCP 翻译成它的 stdin/stdout。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────
 *   远程主机上：
 *     node remote-bridge.js [port]                # 默认 18800
 *     PI_CLI="/path/to/pi" node remote-bridge.js  # pi 不在 PATH 时指定
 *     HOST=127.0.0.1 PORT=18800 node remote-bridge.js
 *
 *   本地开 SSH 端口转发（必须，不要直接暴露端口到公网）：
 *     ssh -L 18800:127.0.0.1:18800 user@host
 *
 *   本地 Helix 的 ~/.pi/agent/config.yaml：
 *     pi:
 *       remote_rpc: "127.0.0.1:18800"
 *
 *   设置 remote_rpc 之后，Helix 每个会话都会连过来而不是本地 spawn pi。
 *   删掉这一行就回到本地模式。
 *
 * ── 环境变量 ───────────────────────────────────────────────────────────
 *   HOST        监听地址，默认 127.0.0.1（只允许走隧道，最安全）
 *   PORT        监听端口，默认 18800
 *   PI_CLI      pi 可执行文件，默认 "pi"（取 PATH）
 *   PI_ARGS     pi 启动参数，默认 "--mode rpc"（空格分隔）
 *   DEFAULT_CWD 握手 cwd 无效时的回退目录，默认 HOME
 *   PI_OFFLINE  透传给 pi，默认 "1"（与 Helix 本地 spawn 一致：跳过启动时的
 *               模型/版本刷新网络等待，省掉每个子进程 8s+）
 *
 * ── 已知限制 ───────────────────────────────────────────────────────────
 *   pi 的 stderr 走桥接器自己的 stderr（远程终端），不会进 Helix 的 spawn
 *   日志——因为 stderr 不能混进 JSONL 流。所以远程「连接中」卡住时，要看
 *   远程那头的输出。
 *   pi 的 exit code 拿不到（TCP 只有 EOF 没有状态码），所以 Helix 的死亡
 *   诊断在远程模式下不会打印 status=。
 */

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || process.argv[2] || 18800);
const PI_CLI = process.env.PI_CLI || "pi";
const PI_ARGS = (process.env.PI_ARGS || "--mode rpc").split(/\s+/).filter(Boolean);
const DEFAULT_CWD = process.env.DEFAULT_CWD || os.homedir();
// 握手行上限：cwd 是一行路径，64KB 足够。超了说明对端不是 Helix，直接掐掉。
const HANDSHAKE_LIMIT = 64 * 1024;

let nextId = 0;
const live = new Map(); // id -> ChildProcess

function log(msg) {
  const t = new Date().toISOString().replace("T", " ").slice(0, 19);
  process.stderr.write(`[remote-bridge ${t}] ${msg}\n`);
}

/**
 * 读第一行握手，同时把握手行之后的字节原样带回来。
 *
 * 不要用 `socket.unshift` 回填剩余字节：实测在手包写入时（握手行和第一条
 * RPC 在同一个 TCP 段里，本地 loopback 上极常见）unshift 回去的字节会丢，
 * 导致 pi 丢掉第一条命令。所以直接把剩余字节作为返回值，由调用方在 pipe
 * 之前就写进 child.stdin，顺序也能保证。
 */
function readHandshake(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf(0x0a); // "\n"
      if (idx === -1) {
        if (buf.length > HANDSHAKE_LIMIT) {
          socket.removeListener("data", onData);
          reject(new Error(`handshake longer than ${HANDSHAKE_LIMIT} bytes`));
        }
        return;
      }
      socket.removeListener("data", onData);
      const line = buf.subarray(0, idx).toString("utf8").trim();
      const rest = idx + 1 < buf.length ? buf.subarray(idx + 1) : null;
      resolve({ line, rest });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("close", () =>
      reject(new Error("connection closed during handshake")),
    );
  });
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function startChild(socket, id, cwd, pending) {
  const ok = isDir(cwd);
  const realCwd = ok ? cwd : DEFAULT_CWD;
  const child = spawn(PI_CLI, PI_ARGS, {
    cwd: realCwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_OFFLINE: process.env.PI_OFFLINE || "1" },
  });
  live.set(id, child);
  log(
    `#${id} spawn pid=${child.pid} cwd=${realCwd}${ok ? "" : ` (握手给的不是目录，回退 ${DEFAULT_CWD})`} ${PI_CLI} ${PI_ARGS.join(" ")}`,
  );

  child.stdout.pipe(socket);
  // 握手行之后同包到达的字节（通常是第一条 RPC）必须先落进 stdin，再开始
  // pipe socket，否则既丢字节又错顺序。
  if (pending && pending.length > 0) child.stdin.write(pending);
  socket.pipe(child.stdin);
  child.stderr.on("data", (d) => process.stderr.write(`[pi #${id}] ${d}`));

  child.on("error", (err) => {
    log(`#${id} spawn failed: ${err.message}`);
    socket.destroy();
  });

  child.on("exit", (code, signal) => {
    live.delete(id);
    log(`#${id} pi exited code=${code} signal=${signal}`);
    socket.end();
  });

  socket.on("close", () => {
    if (live.has(id)) {
      live.delete(id);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      log(`#${id} connection closed → killed pi`);
    }
  });

  socket.on("error", () => socket.destroy());
}

const server = net.createServer((socket) => {
  const id = nextId++;
  socket.setNoDelay(true);
  log(`#${id} connection from ${socket.remoteAddress}:${socket.remotePort}`);
  readHandshake(socket)
    .then(({ line, rest }) => {
      const m = /^cwd:(.*)$/s.exec(line || "");
      if (!m) throw new Error(`bad handshake line: ${JSON.stringify(line)}`);
      startChild(socket, id, m[1].trim(), rest);
    })
    .catch((err) => {
      log(`#${id} handshake failed: ${err.message}`);
      socket.destroy();
    });
});

server.listen(PORT, HOST, () => {
  log(
    `listening on ${HOST}:${PORT} | pi=${PI_CLI} | default_cwd=${DEFAULT_CWD} | connections=${live.size}`,
  );
});

function shutdown(reason) {
  log(`shutting down (${reason}): killing ${live.size} child(ren)`);
  for (const [, child] of live) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  log(`uncaughtException: ${err && err.stack ? err.stack : err}`);
  shutdown("uncaughtException");
});
