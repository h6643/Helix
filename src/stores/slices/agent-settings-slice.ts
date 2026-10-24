/**
 * Agent behaviour settings slice — Helix Desktop style.
 * temperature / maxOutputTokens / customInstructions / streaming 等由后端管理，
 * 这里只留前端真正会改的开关。
 */
import type { StateCreator } from "zustand";
import type { ReasoningEffortLevel } from "@/stores/helix-types";

export interface AgentSettingsSlice {
  agentMaxIterations: number;
  autoCompactContext: boolean;
  autoSaveSession: boolean;
  // 自动归档旧任务：前端定时扫描会话，把「已完成 + 无未读 + 未置顶 + 超过保留期」
  // 的会话移入归档。见 src/lib/auto-archive.ts。
  autoArchiveOldTasks: boolean;
  /** 保留期（天）：savedAt 早于 now - 该天数才进候选。 */
  autoArchiveRetentionDays: number;
  reasoningEffort: ReasoningEffortLevel;

  setReasoningEffort: (v: ReasoningEffortLevel) => void;
  setAutoArchiveOldTasks: (v: boolean) => void;
  setAutoArchiveRetentionDays: (v: number) => void;
}

export const createAgentSettingsSlice: StateCreator<
  AgentSettingsSlice,
  [],
  [],
  AgentSettingsSlice
> = (set) => ({
  agentMaxIterations: 90,
  autoCompactContext: true,
  autoSaveSession: false,
  autoArchiveOldTasks: false,
  autoArchiveRetentionDays: 7,
  reasoningEffort: "medium",

  setReasoningEffort: (v) => set({ reasoningEffort: v }),
  setAutoArchiveOldTasks: (v) => set({ autoArchiveOldTasks: v }),
  setAutoArchiveRetentionDays: (v) => set({ autoArchiveRetentionDays: v }),
});
