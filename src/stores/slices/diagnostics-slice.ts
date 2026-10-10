/**
 * Diagnostics slice — 跑项目自带类型检查/lint 的结果与开关。
 *
 * 结果按工作目录存（不是按会话）：`tsc`/`cargo check` 检查的是磁盘上的项目状态，
 * 同一目录下并行开三个对话也共享同一份诊断；按会话存会让「切对话看没看到过
 * 错误」变成随机事件。
 */
import type { StateCreator } from "zustand";
import type { DiagnosticRunResult } from "@/types/electron";

export interface DiagnosticsSlice {
  /** 每轮结束后自动跑一次检查（「诊断」面板里的开关，默认关：大仓库的
   *  `cargo check` 要几分钟，不该由一次对话悄悄替你决定）。 */
  diagnosticsAfterRun: boolean;
  setDiagnosticsAfterRun: (v: boolean) => void;
  /** 最近一次检查的原始结果，key = 工作目录。 */
  lastDiagnostics: Record<string, DiagnosticRunResult>;
  setLastDiagnostics: (cwd: string, result: DiagnosticRunResult) => void;
}

export const createDiagnosticsSlice: StateCreator<
  DiagnosticsSlice,
  [],
  [],
  DiagnosticsSlice
> = (set) => ({
  diagnosticsAfterRun: false,
  setDiagnosticsAfterRun: (v) => set({ diagnosticsAfterRun: v }),
  lastDiagnostics: {},
  setLastDiagnostics: (cwd, result) =>
    set((s) => ({
      lastDiagnostics: { ...s.lastDiagnostics, [cwd]: result },
    })),
});
