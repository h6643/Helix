/**
 * Formatting utility functions
 */

/**
 * Format timestamp to relative time string (Chinese format)
 */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

/**
 * Generate a random ID
 */
export function generateId(): string {
  return Math.random().toString(36).substr(2, 9);
}

/**
 * Format token count for display (e.g. 1500 -> "1.5K", 2000000 -> "2.0M")
 */
export function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toLocaleString();
}

/**
 * Format a duration in (possibly fractional) seconds as whole seconds.
 * 转录里的计时只回答「这步花了多久」，毫秒和小数点是噪音 —— 亚秒向上取 1s，
 * 绝不出现 "500ms" / "2.5s" 这种写法。
 *   < 60s  → "3s"
 *   < 60m  → "3m 15s" or "5m"
 *   ≥ 1h   → "1h 30m" or "2h"
 */
export function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.max(1, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const remSeconds = whole % 60;
  if (minutes < 60) {
    return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

/**
 * 缓存命中率的**唯一**计算口径，上下文环弹窗与设置里的用量面板共用（两处数字
 * 必须同语义，否则同一个"命中率"在两个地方对不上）。
 *
 * 分母是 prompt 侧 `input + cacheRead + cacheWrite`：pi（以及 Anthropic 系）把
 * `input` 报成**净**（未缓存）数，缓存命中/写入是另外两个字段。拿
 * `cacheRead / (input + output)` 之类的写法会算出几百 percent —— 上下文环本身
 * 就在 `pi_gateway.rs` 的 emit_usage 里踩过这个坑。
 *
 * `reported=false`：缓存两个字段全 0。这既可能是"供应商压根不上报缓存"（实测本机
 * 22 个会话里 7 个恒 0），也可能是"真的没命中"，两者数字一样、无法区分，所以
 * 调用方必须显示「未上报」而不是「0%」——后者是对一个没上报的供应商指控它缓存失效。
 */
export function promptCacheHit(counters: {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | null | undefined): { reported: boolean; percent: number | null } {
  const net = Math.max(0, counters?.input || 0);
  const read = Math.max(0, counters?.cacheRead || 0);
  const write = Math.max(0, counters?.cacheWrite || 0);
  const promptTotal = net + read + write;
  if (promptTotal <= 0) return { reported: false, percent: null };
  return { reported: read + write > 0, percent: (read / promptTotal) * 100 };
}

/**
 * Truncate a potentially huge string (e.g. tool output / file content) to a
 * bounded length, keeping a head + tail window so the truncated result is still
 * useful for display. Used by addChatMessage / addExecutionStep to prevent
 * multi-MB payloads from blowing the V8 heap across a long conversation.
 */
export function truncateString(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const head = Math.floor(maxLength * 0.6);
  const tail = Math.floor(maxLength * 0.3);
  const sep = "\n\n… (truncated) …\n\n";
  return text.slice(0, head) + sep + text.slice(-tail);
}
