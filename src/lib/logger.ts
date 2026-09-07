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
    } catch (e) {}
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
    } catch (e) {}
  }
}

export function error(...args: unknown[]) {
  // Always log errors — even in production
  console.error("[helix]", ...args);
}
