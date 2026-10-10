/**
 * Session approval allow slice — pi-permission 审批卡的「本会话内始终允许」。
 *
 * 用户在审批卡上点 always 后记一条 {tool, prefix}；后续同 tool 且命令命中
 * prefix 的审批请求由 agent-flow-panel 在入队前自动应答（不再弹卡）。
 * 仅存内存、不落 IndexedDB：重启即清 —— 与 OpenCode 的 always（本会话有效）
 * 同语义；要永久放行请用扩展的 userRules（设置页/扩展命令）。
 */
import type { StateCreator } from "zustand";
import { matchAllowPrefix } from "@/lib/permission-allow";

export interface SessionApprovalAllow {
  tool: string;
  /** 命令前缀（deriveAllowPrefix 的产物）；"" = 该工具全部命令 */
  prefix: string;
}

export interface ApprovalAllowSlice {
  sessionApprovalAllows: SessionApprovalAllow[];
  /** 记一条会话级放行；重复（同 tool+prefix）不重复入列。 */
  addSessionApprovalAllow: (rule: SessionApprovalAllow) => void;
  /** 审批卡是否命中某条会话级放行。 */
  matchesSessionApprovalAllow: (tool: string, command?: string) => boolean;
}

export const createApprovalAllowSlice: StateCreator<
  ApprovalAllowSlice,
  [],
  [],
  ApprovalAllowSlice
> = (set, get) => ({
  sessionApprovalAllows: [],
  addSessionApprovalAllow: (rule) =>
    set((state) =>
      state.sessionApprovalAllows.some(
        (r) => r.tool === rule.tool && r.prefix === rule.prefix,
      )
        ? {}
        : { sessionApprovalAllows: [...state.sessionApprovalAllows, rule] },
    ),
  matchesSessionApprovalAllow: (tool, command) =>
    get().sessionApprovalAllows.some(
      (r) => r.tool === tool && matchAllowPrefix(r.prefix, command),
    ),
});
