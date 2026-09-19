"use client";

import { useEffect, useState } from "react";

/** 每秒刷新的"已运行秒数"；active 为 false 时返回 0 且不启动定时器。
 *  用于子 agent "正在后台执行…（已运行 N 秒）"这类需要跳秒的文案。 */
export function useElapsedSeconds(
  since: number | undefined,
  active: boolean,
): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return active && since ? Math.max(1, Math.round((now - since) / 1000)) : 0;
}
