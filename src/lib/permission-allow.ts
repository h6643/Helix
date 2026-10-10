/**
 * pi-permission 审批卡的 Tool/Command 解析 + 「本会话始终允许」的前缀派生（仅用于按钮文案）。
 *
 * pi-permission（RPC 模式）的审批弹窗经网关转成 clarify_request，question 是
 * 扩展 formatTitle 的多行文本：
 *   [pi-permission] Approval required
 *   Tool: bash
 *   Command: git status --porcelain
 *   Reason: ...
 *   AI: risk=...（可选两行）
 *
 * 「本会话始终允许」的放行表现在**只有扩展一份**（[LOCAL PATCH 2026-10-10] 第三挡
 * Approve (session)）：Helix 点按钮只是把该原文当应答回给扩展，后续同类调用扩展自己
 * 命中表、根本不发起审批请求 → Helix 自然不弹卡。本文件的 deriveAllowPrefix 与扩展的
 * session-allow.ts 逐字一致，仅用来在按钮上预览放行范围；前端不再自己存表（旧实现是
 * 扩展只有两挡时的代职，且那张表不分会话会跨对话泄漏，已删）。
 */

/** 扩展 requestRpc 的选项原文：choice.startsWith("Approve") → 放行，否则拒绝。 */
export const PERM_APPROVE_ANSWER = "Approve (once)";
/**
 * 第三挡原文（扩展已原生支持；未补丁的旧扩展会因 startsWith("Approve") 把它当 once
 * 批准 —— 降级为「本次放行」，不会误拒，故旧版扩展下也能安全使用）。
 */
export const PERM_APPROVE_SESSION_ANSWER = "Approve (session)";
export const PERM_DENY_ANSWER = "Deny";

export interface PermissionAskInfo {
  tool: string;
  /** 无 Command 行（非 bash 类工具）时为 undefined */
  command?: string;
}

/** 从审批卡 question 解析 Tool/Command；不是 pi-permission 卡（无 Tool 行）返回 null。 */
export function parsePermissionAsk(question: string): PermissionAskInfo | null {
  const toolMatch = question.match(/^Tool:[ \t]*(.+)$/m);
  if (!toolMatch) return null;
  const tool = toolMatch[1].trim();
  if (!tool) return null;
  const cmdMatch = question.match(/^Command:[ \t]*(.*)$/m);
  const command = cmdMatch?.[1]?.trim();
  return { tool, command: command || undefined };
}

/**
 * 从命令派生会话放行前缀（与扩展 session-allow.ts 的 deriveAllowPrefix 逐字对齐，
 * 改这里必须同步改那里，否则按钮预览的宽窄与实际放行范围不一致）：
 *   "git status --porcelain" → "git status"（第二段是子命令才纳入）
 *   "rm -rf foo"             → "rm"（第二段是 flag，不纳入——按钮上显示 rm*，宽窄可见）
 *   "node"                   → "node"
 *   无命令                    → ""（放行该工具的全部调用）
 */
export function deriveAllowPrefix(command?: string): string {
  if (!command) return "";
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  if (tokens.length === 1) return tokens[0];
  if (/^[A-Za-z][\w.:-]*$/.test(tokens[1])) {
    return `${tokens[0]} ${tokens[1]}`;
  }
  return tokens[0];
}

/** 审批卡按钮上的 always 文案：把将要放行的范围直接写给用户看。 */
export function allowAlwaysLabel(tool: string, prefix: string): string {
  return prefix
    ? `本会话内始终允许 ${prefix}*`
    : `本会话内始终允许 ${tool} 的全部调用`;
}
