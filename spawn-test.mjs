// Verifies pi --mode rpc now passes the get_state handshake after the
// extension path fixes. Usage: node spawn-test.mjs [cwd]
import { spawn } from "node:child_process";

const CLI = "C:/Users/hyt/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const cwd = process.argv[2] || "C:/Users/hyt";
console.log(`[test] cwd = ${cwd}`);

const child = spawn("node", [CLI, "--mode", "rpc"], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => {
  for (const line of d.split("\n")) if (line.trim()) console.log(`[stderr] ${line}`);
});

let gotState = false;
child.stdout.setEncoding("utf8");
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "response" && msg.command === "get_state") {
        gotState = true;
        console.log(`[test] get_state OK: sessionId=${msg.data?.sessionId ?? "none"} model=${msg.data?.model?.id ?? "none"}`);
      }
    } catch { console.log(`[stdout-raw] ${line.slice(0, 200)}`); }
  }
});

child.on("exit", (code, signal) => {
  console.log(`[test] EXIT code=${code} signal=${signal} handshake=${gotState ? "OK" : "FAILED"}`);
  process.exit(gotState ? 0 : 1);
});

setTimeout(() => {
  console.log("[test] sending get_state");
  child.stdin.write(JSON.stringify({ id: "test-1", type: "get_state" }) + "\n");
}, 2000);

setTimeout(() => {
  console.log(`[test] 60s elapsed, handshake=${gotState ? "OK" : "FAILED"}, killing child`);
  child.kill();
  process.exit(gotState ? 0 : 1);
}, 60000);
