"use client";

import { useEffect } from "react";
import { useHelixStore } from "@/stores/helix-store";

let checked = false;

/**
 *与更新检查无关（更新检查查的是 pi agent）。
 */
export async function getCurrentVersion(): Promise<string | null> {
  try {
    const info = await window.electron?.app?.getInfo?.();
    const v = info?.piVersion || info?.version;
    if (v) return String(v);
  } catch { /* empty */}
  return null;
}

/**
 * 启动时静默检查 pi agent 更新（npm registry）。后端 agent 是外部的
 * pi 包（@earendil-works/pi-coding-agent）
 */
export function useCheckUpdate() {
  useEffect(() => {
    if (checked) return;
    checked = true;

    const check = async () => {
      try {
        const res = await window.electron?.helix?.piCheckUpdates?.();
        const pi = res?.pi;
        if (pi?.hasUpdate && pi.latest) {
          const state = useHelixStore.getState();
          state.showToast({
            type: "info",
            title: "pi 有新版本可用",
            description: `v${pi.installed} → v${pi.latest}`,
            duration: 8000,
            onClick: () =>
              window.open(
                "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
                "_blank",
              ),
          });
          state.setPendingUpdate?.(pi.latest as string);
        }
      } catch {
        // Silent fail — startup check must never nag
      }
    };

    const timer = setTimeout(check, 5000);
    return () => clearTimeout(timer);
  }, []);
}
