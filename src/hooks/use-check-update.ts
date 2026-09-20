"use client";

import { useEffect } from "react";
import { useHelixStore } from "@/stores/helix-store";

let checked = false;

/**
 * 启动自动检查用：记录「已对哪个 pi 版本提醒过」。
 * 模块级 `checked` 只活在单个 JS 进程内，每次启动都会重置，所以真正
 * 跨启动去重要靠这个 localStorage 键。值存的是 `pi.latest`——同一个
 * 新版本只在第一次发现时弹一次 toast，后续启动不再打扰；pi 再出
 * 更新（latest 变了）才会重新提醒。
 */
const REMIND_KEY = "helix-pi-update-reminded";

/**
 * 读取「已提醒过的 pi 版本」。localStorage 不可用时返回 null（按从未提醒处理）。
 */
function getRemindedVersion(): string | null {
  try {
    return localStorage.getItem(REMIND_KEY);
  } catch {
    return null;
  }
}

/** 持久化「已提醒过的 pi 版本」。 */
function setRemindedVersion(version: string): void {
  try {
    localStorage.setItem(REMIND_KEY, version);
  } catch {
    /* localStorage 不可用（隐私模式/配额满）时静默降级：每次都提醒，但永不崩 */
  }
}

/**
 * 与更新检查无关（更新检查查的是 pi agent）。
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
 * 启动时静默检查 pi agent 更新（npm registry）
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
          // 只对新版本提醒一次：latest 与已记录版本不同才弹 toast。
          // 记录发生在弹 toast 之前，保证同一次启动只提醒一次。
          const state = useHelixStore.getState();
          if (getRemindedVersion() !== pi.latest) {
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
            setRemindedVersion(pi.latest);
          }
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
