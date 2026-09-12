"use client";

import { useEffect } from "react";
import { useHelixStore } from "@/stores/helix-store";

let checked = false;

/**
 * Helix 应用自身版本（Tauri get_info），用于"关于"里的版本号显示——
 * 与更新检查无关（更新检查查的是 pi agent）。
 */
export async function getCurrentVersion(): Promise<string | null> {
  try {
    const info = await (window as any).electron?.app?.getInfo?.();
    const v = info?.piVersion || info?.version;
    if (v) return String(v);
  } catch {}
  return null;
}

/**
 * 启动时静默检查 pi agent 更新（npm registry）。后端 agent 是外部的
 * pi 包（@earendil-works/pi-coding-agent），Helix 应用自身没有自动更新
 * 通道，GitHub releases 检查是 pi 迁移前的残留。
 */
export function useCheckUpdate() {
  useEffect(() => {
    if (checked) return;
    checked = true;

    const check = async () => {
      try {
        const res = await (window as any).electron?.helix?.piCheckUpdates?.();
        const pi = res?.pi;
        if (pi?.hasUpdate && pi.latest) {
          const state = useHelixStore.getState();
          const outdated = (res.packages || []).filter(
            (p: any) => p.hasUpdate,
          ).length;
          state.showToast({
            type: "info",
            title: "pi 有新版本可用",
            description: `v${pi.installed} → v${pi.latest}${
              outdated > 0 ? `（另有 ${outdated} 个插件可更新）` : ""
            }`,
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
