"use client";

import { useEffect } from "react";
import { checkHelixAppUpdate } from "@/lib/app-update";
import { useHelixStore } from "@/stores/helix-store";

/**
 * 模块级标记：每次启动（JS 进程生命周期内）只检查一次，之后不再检查。
 * 检查结果不弹 toast —— 新版本信息只写进 store（pendingUpdate /
 * pendingAppUpdate），需要展示时由 UI 自行读取；用户主动查更新走
 * 帮助菜单「检查更新」（那里有自己的完整反馈，与本 hook 无关）。
 */
let checked = false;

/** 当前 pi agent 版本（Helix 应用自身的版本走 app.getInfo().version）。 */
export async function getCurrentVersion(): Promise<string | null> {
  try {
    const info = await window.electron?.app?.getInfo?.();
    const v = info?.piVersion || info?.version;
    if (v) return String(v);
  } catch { /* empty */}
  return null;
}

/**
 * 启动时静默检查一次更新：先查 pi agent（npm registry），再查 Helix 应用
 * 自身（GitHub Release）。只记状态，不弹 toast，以后不再检查。
 */
export function useCheckUpdate() {
  useEffect(() => {
    if (checked) return;
    checked = true;

    const check = async () => {
      // pi agent 更新（npm registry）
      try {
        const res = await window.electron?.helix?.piCheckUpdates?.();
        const pi = res?.pi;
        if (pi?.hasUpdate && pi.latest) {
          useHelixStore.getState().setPendingUpdate?.(pi.latest as string);
        }
      } catch {
        // Silent fail — startup check must never nag
      }

      // Helix 应用自身更新（GitHub Release，tauri-plugin-updater）
      try {
        const res = await checkHelixAppUpdate();
        if (res?.available && res.version) {
          useHelixStore
            .getState()
            .setPendingAppUpdate?.(res.version as string);
        }
      } catch {
        // 离线 / release 尚无 latest.json：静默降级
      }
    };

    const timer = setTimeout(check, 5000);
    return () => clearTimeout(timer);
  }, []);
}
