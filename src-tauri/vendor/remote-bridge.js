#!/usr/bin/env node
/**
 * remote-bridge.js — TCP → `pi --mode rpc` 桥接器，在远程主机上运行。
 * 握手：[auth:<token>\n]cwd:<路径>\n，之后双向透传 JSONL。每个连接一个 pi 进程。
 *
 * 用法：node remote-bridge.js [port]；本地用 ssh -L 18800:127.0.0.1:18800 user@host 转发。
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const IS_WIN = process.platform === "win32";
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || process.argv[2] || 18800);
const DEFAULT_CWD = process.env.DEFAULT_CWD || os.homedir();
const STRICT_CWD = (process.env.STRICT_CWD ?? "1") !== "0";
const PI_OFFLINE = process.env.PI_OFFLINE ?? "1";
const TOKEN = process.env.BRIDGE_TOKEN || "";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 32);
const HANDSHAKE_TIMEOUT = Number(process.env.HANDSHAKE_TIMEOUT || 10000);
const HANDSHAKE_LIMIT = 64 * 1024;
const KILL_GRACE_MS = 5000;
const HALF_CLOSE_GRACE_MS = 3000;

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`[remote-bridge] 无效端口: ${process.env.PORT || process.argv[2]}`);
  process.exit(1);
}

const sessions = new Set();

function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function resolveCwd(raw) {
  const p = (raw || "").trim();
  if (!p) return STRICT_CWD ? { error: "握手缺少 cwd" } : { cwd: DEFAULT_CWD };

  let resolved;
  if (p === "~") resolved = os.homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) resolved = path.join(os.homedir(), p.slice(2));
  else if (path.isAbsolute(p)) resolved = p;
  else resolved = path.join(DEFAULT_CWD, p);

  try {
    if (fs.statSync(resolved).isDirectory()) return { cwd: resolved };
  } catch {}
  if (STRICT_CWD) return { error: `远程路径不存在或不是目录: ${resolved}` };
  console.error(`[remote-bridge] cwd ${p} 不存在，回退到 ${DEFAULT_CWD}`);
  return { cwd: DEFAULT_CWD };
}

// Windows 上 npm 的 pi 是 shim，不能直接 spawn，所以优先找 cli.js 用 node 启动
function resolvePiCli() {
  if (process.env.PI_CLI) {
    const cmd = process.env.PI_CLI;
    return {
      cmd,
      args: splitArgs(process.env.PI_ARGS || "--mode rpc"),
      shell: IS_WIN && /\.(cmd|bat)$/i.test(cmd),
    };
  }
  const npmGlobals = [
    path.join(os.homedir(), "AppData", "Roaming", "npm"),
    "/usr/local/lib/node_modules",
    path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
    "/usr/lib/node_modules",
  ];
  const pkg = path.join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  for (const base of npmGlobals) {
    for (const cli of [path.join(base, "node_modules", pkg), path.join(base, pkg)]) {
      if (fs.existsSync(cli)) return { cmd: process.execPath, args: [cli, "--mode", "rpc"], shell: false };
    }
  }
  return { cmd: "pi", args: ["--mode", "rpc"], shell: false };
}

function killTree(child, signal = "SIGTERM") {
  if (!child || !child.pid) return;
  try {
    if (IS_WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function makeLineLogger(prefix) {
  let buf = "";
  return {
    write(d) {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        process.stderr.write(`${prefix}${buf.slice(0, i)}\n`);
        buf = buf.slice(i + 1);
      }
    },
    flush() {
      if (buf) process.stderr.write(`${prefix}${buf}\n`);
      buf = "";
    },
  };
}

function reject(socket, message, { silent = false } = {}) {
  console.error(`[remote-bridge] 拒绝连接 ${socket.remoteAddress}:${socket.remotePort} — ${message}`);
  if (silent) return void socket.destroy();
  try {
    socket.end(JSON.stringify({ type: "bridge_error", message }) + "\n");
  } catch {
    socket.destroy();
  }
}

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);
  socket.on("error", () => {});

  let handshake = Buffer.alloc(0);
  let authed = !TOKEN;
  let child = null;

  const hsTimer = setTimeout(() => {
    if (!child) reject(socket, "握手超时", { silent: true });
  }, HANDSHAKE_TIMEOUT);

  const onHandshakeData = (chunk) => {
    handshake = Buffer.concat([handshake, chunk]);

    for (;;) {
      const nl = handshake.indexOf(0x0a);
      if (nl === -1) {
        if (handshake.length > HANDSHAKE_LIMIT) {
          clearTimeout(hsTimer);
          socket.off("data", onHandshakeData);
          reject(socket, "握手过长", { silent: true });
        }
        return;
      }
      const line = handshake.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
      handshake = handshake.subarray(nl + 1);

      if (line.startsWith("auth:")) {
        if (!TOKEN || !safeEqual(line.slice(5).trim(), TOKEN)) {
          clearTimeout(hsTimer);
          socket.off("data", onHandshakeData);
          return reject(socket, "认证失败", { silent: true });
        }
        authed = true;
        continue;
      }

      clearTimeout(hsTimer);
      socket.off("data", onHandshakeData);
      socket.pause();

      if (!authed) return reject(socket, "认证失败", { silent: true });
      if (!line.startsWith("cwd:")) return reject(socket, "握手格式错误：需要 cwd:<路径>");

      const r = resolveCwd(line.slice(4));
      if (r.error) return reject(socket, r.error);

      startSession(r.cwd, handshake);
      handshake = Buffer.alloc(0);
      return;
    }
  };

  function startSession(cwd, rest) {
    const { cmd, args, shell } = resolvePiCli();
    const log = makeLineLogger(`[pi#${socket.remotePort}] `);

    child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, PI_OFFLINE },
      stdio: ["pipe", "pipe", "pipe"],
      detached: !IS_WIN,
      shell,
      windowsHide: true,
    });
    sessions.add(child);
    console.log(`[remote-bridge] 会话开始 pid=${child.pid} cwd=${cwd}`);

    let killTimer = null;
    let halfCloseTimer = null;

    const cleanup = () => {
      clearTimeout(killTimer);
      clearTimeout(halfCloseTimer);
      log.flush();
      sessions.delete(child);
    };

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };

    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.on("error", (e) => {
      console.error(`[remote-bridge] spawn ${cmd} 失败: ${e.message}`);
      cleanup();
      reject(socket, `无法启动 pi: ${e.message}`);
    });

    // 用 close 而非 exit，确保 stdout 读完再关 socket
    child.on("close", (code, signal) => {
      console.log(`[remote-bridge] 会话结束 pid=${child.pid} code=${code} signal=${signal}`);
      cleanup();
      socket.end();
    });

    child.stderr.on("data", (d) => log.write(d));

    if (rest.length > 0) child.stdin.write(rest);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);

    socket.on("end", () => {
      halfCloseTimer = setTimeout(terminate, HALF_CLOSE_GRACE_MS);
      halfCloseTimer.unref();
    });
    socket.on("close", terminate);
  }

  socket.on("data", onHandshakeData);
  socket.on("close", () => clearTimeout(hsTimer));
});

server.on("error", (e) => {
  console.error(`[remote-bridge] 服务器错误: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const { cmd, args } = resolvePiCli();
  console.log(`[remote-bridge] listening on ${HOST}:${PORT} (pi=${cmd} ${args.join(" ")})`);
  if (!TOKEN) console.log("[remote-bridge] 提示：未设置 BRIDGE_TOKEN，同机任何本地用户都能通过该端口启动 pi。");
  if (!["127.0.0.1", "localhost", "::1"].includes(HOST)) {
    console.warn(`[remote-bridge] 警告：监听在 ${HOST}，请务必设置 BRIDGE_TOKEN 并限制来源。`);
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  for (const child of sessions) killTree(child, "SIGTERM");
  if (sessions.size === 0) process.exit(0);
  setTimeout(() => {
    for (const child of sessions) killTree(child, "SIGKILL");
    process.exit(0);
  }, 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);