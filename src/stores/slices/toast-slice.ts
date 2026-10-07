/**
 * Toast notification slice.
 * Isolated domain: toasts[] is consumed by ToastContainer; showToast/dismissToast
 * are called from many places but only read/write this slice's own state.
 */
import type { StateCreator } from "zustand";
import type { ToastMessage } from "../helix-types";
import { generateId } from "@/lib/format";

export interface ToastSlice {
  toasts: ToastMessage[];
  /** 弹出一条 toast，返回其 id（供 updateToast / dismissToast 使用）。 */
  showToast: (toast: Omit<ToastMessage, "id">) => string;
  /**
   * 原地更新一条已存在的 toast（如下载进度文案 / 进度条）。
   * duration 只在 patch 显式给出时才重新计时——高频进度更新若自动
   * 顺延计时，会把常驻 toast（duration: 0）意外变成 3 秒消失。
   */
  updateToast: (id: string, patch: Partial<Omit<ToastMessage, "id">>) => void;
  dismissToast: (id: string) => void;
}

// id → 自动消失定时器。挂在模块级，updateToast/dismissToast 才能重置或清掉它。
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const createToastSlice: StateCreator<ToastSlice, [], [], ToastSlice> = (
  set,
) => {
  const clearTimer = (id: string) => {
    const t = dismissTimers.get(id);
    if (t) {
      clearTimeout(t);
      dismissTimers.delete(id);
    }
  };

  const dismiss = (id: string) => {
    clearTimer(id);
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  };

  const schedule = (id: string, duration: number | undefined) => {
    clearTimer(id);
    // 0 = 常驻（进度类 toast 由代码显式更新/关闭）；缺省 3000ms。
    if (duration === 0) return;
    dismissTimers.set(
      id,
      setTimeout(() => dismiss(id), duration || 3000),
    );
  };

  return {
    toasts: [],
    showToast: (toast) => {
      const id = generateId();
      set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
      schedule(id, toast.duration);
      return id;
    },
    updateToast: (id, patch) => {
      set((state) => ({
        toasts: state.toasts.map((t) =>
          t.id === id ? { ...t, ...patch } : t,
        ),
      }));
      if ("duration" in patch) schedule(id, patch.duration);
    },
    dismissToast: dismiss,
  };
};
