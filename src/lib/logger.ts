/**
 * Debug logger — only outputs in development builds or when HELIX_DEBUG=1.
 * Usage: import { debug, warn } from '@/lib/logger'; debug('msg', data)
 */
const enabled =
  typeof process !== "undefined" &&
  (process.env.NODE_ENV === "development" ||
    process.env.HELIX_DEBUG === "1" ||
    process.env.NEXT_PUBLIC_HELIX_DEBUG === "1");

export function debug(...args: unknown[]) {
  if (enabled) {
    console.log("[helix]", ...args);
    try {
      const k = "helix_trace";
      const arr = JSON.parse(localStorage.getItem(k) || "[]");
      arr.push({
        t: Date.now(),
        m: args
          .map((a) =>
            typeof a === "object" && a !== null ? JSON.stringify(a) : String(a),
          )
          .join(" "),
      });
      while (arr.length > 3000) arr.shift();
      localStorage.setItem(k, JSON.stringify(arr));
    } catch (e) { /* empty */}
  }
}

export function warn(...args: unknown[]) {
  if (enabled) {
    console.warn("[helix]", ...args);
    try {
      const k = "helix_trace";
      const arr = JSON.parse(localStorage.getItem(k) || "[]");
      arr.push({
        t: Date.now(),
        m:
          "[warn] " +
          args
            .map((a) =>
              typeof a === "object" && a !== null
                ? JSON.stringify(a)
                : String(a),
            )
            .join(" "),
      });
      while (arr.length > 3000) arr.shift();
      localStorage.setItem(k, JSON.stringify(arr));
    } catch (e) { /* empty */}
  }
}

export function error(...args: unknown[]) {
  // Always log errors — even in production
  console.error("[helix]", ...args);
}

/**
 * 审批 / 反问卡的生命周期落盘：`ui_card <event> k=v …` 经 `helix_trace` 命令写进
 * `~/.pi/agent/helix-recover.log`，和网关的 `permission_ask` / `evict_permission_asks`
 * 同一个 UTC 时钟、同一把写锁，两端日志能逐行对齐。
 *
 * 与 `debug()` 的关键区别：**不受 NODE_ENV / HELIX_DEBUG 门控**。「弹窗根本没弹、
 * 工具 5 分钟后自己 fail-closed 拒了」这类事故在 release 包里也必须留下凭据，
 * 否则事后只剩猜测（是被「停止」清空、被新建对话清空、前端面板当时没挂载、还是
 * 归属判给了别的对话 —— 网关侧这四种形态一模一样）。
 *
 * fire-and-forget，任何失败都吞掉：日志不参与交互，也不在非 Tauri 运行时（serve /
 * 浏览器）报错。
 */
export function traceCard(event: string, fields: Record<string, unknown> = {}) {
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) =>
      `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`,
    )
    .join(" ");
  const line = kv ? `ui_card ${event} ${kv}` : `ui_card ${event}`;
  if (enabled) debug(line);
  void (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("helix_trace", { message: line });
    } catch {
      /* 非 Tauri 运行时或命令未注册：静默跳过 */
    }
  })();
}
