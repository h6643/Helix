"use client";

import { useEffect } from "react";
import { checkHelixAppUpdate, installHelixAppUpdate } from "@/lib/app-update";
import { useHelixStore } from "@/stores/helix-store";

let checked = false;

/**
 * 启动自动检查用：「已对哪个版本提醒过」，跨启动去重靠 localStorage。
 * 两个独立键：pi agent（npm registry）与 Helix 应用自身（GitHub Release）。
 * 值存最新版本号——同一个新版本只弹一次 toast，版本再变才重新提醒。
 * 模块级 `checked` 只活在单个 JS 进程内，每次启动都会重置。
 */
const PI_REMIND_KEY = "helix-pi-update-reminded";
const APP_REMIND_KEY = "helix-app-update-reminded";

/**
 * 读取「已提醒过的版本」。localStorage 不可用时返回 null（按从未提醒处理）。
 */
function getRemindedVersion(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 持久化「已提醒过的版本」。 */
function setRemindedVersion(key: string, version: string): void {
  try {
    localStorage.setItem(key, version);
  } catch {
    /* localStorage 不可用（隐私模式/配额满）时静默降级：每次都提醒，但永不崩 */
  }
}

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
 * 启动时静默检查更新：先查 pi agent（npm registry），再查 Helix 应用
 * 自身（GitHub Release）。发现新版本各弹一次 toast；Helix 应用更新的
 * toast 可点击直接下载安装。
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
          // 只对新版本提醒一次：latest 与已记录版本不同才弹 toast。
          // 记录发生在弹 toast 之前，保证同一次启动只提醒一次。
          const state = useHelixStore.getState();
          if (getRemindedVersion(PI_REMIND_KEY) !== pi.latest) {
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
            setRemindedVersion(PI_REMIND_KEY, pi.latest);
          }
          state.setPendingUpdate?.(pi.latest as string);
        }
      } catch {
        // Silent fail — startup check must never nag
      }

      // Helix 应用自身更新（GitHub Release，tauri-plugin-updater）
      try {
        const res = await checkHelixAppUpdate();
        if (res?.available && res.version) {
          const state = useHelixStore.getState();
          if (getRemindedVersion(APP_REMIND_KEY) !== res.version) {
            const version = res.version;
            const toastId = state.showToast({
              type: "info",
              title: `Helix v${version} 可用`,
              description: "点击下载并安装，完成后应用将自动重启",
              duration: 12000,
              onClick: () => {
                useHelixStore.getState().dismissToast(toastId);
                void installHelixAppUpdate(version);
              },
            });
            setRemindedVersion(APP_REMIND_KEY, version);
          }
        }
      } catch {
        // 离线 / release 尚无 latest.json：静默降级
      }
    };

    const timer = setTimeout(check, 5000);
    return () => clearTimeout(timer);
  }, []);
}
