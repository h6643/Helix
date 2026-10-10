/**
 * pi-permission 审批卡的 Tool/Command 解析 + 「本会话始终允许」的前缀派生与匹配。
 *
 * pi-permission（RPC 模式）的审批弹窗经网关转成 clarify_request，question 是
 * 扩展 formatTitle 的多行文本：
 *   [pi-permission] Approval required
 *   Tool: bash
 *   Command: git status --porcelain
 *   Reason: ...
 *   AI: risk=...（可选两行）
 *
 * 「始终允许」不是写进扩展的 userRules（那是永久规则，且只在 auto 档由扩展
 * 评估），而是前端会话级拦截：agent-flow-panel 在卡入队前查
 * sessionApprovalAllows，命中就直接代答。语义对齐 OpenCode 的 always：
 * 本会话有效、按模式放行、重启即清。
 */

/** 扩展 requestRpc 的选项原文：choice.startsWith("Approve") → 放行，否则拒绝。 */
export const PERM_APPROVE_ANSWER = "Approve (once)";
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
 * 从命令派生会话放行前缀（对齐 OpenCode「always 白名单一条安全命令前缀」）：
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

/** 前缀命中：命令等于前缀，或前缀后紧跟空格（"git status" 命中 "git status -s"，不命中 "git stash"）。 */
export function matchAllowPrefix(prefix: string, command?: string): boolean {
  if (!prefix) return true;
  if (!command) return false;
  return command === prefix || command.startsWith(prefix + " ");
}

/** 审批卡按钮上的 always 文案：把将要放行的范围直接写给用户看。 */
export function allowAlwaysLabel(tool: string, prefix: string): string {
  return prefix
    ? `本会话内始终允许 ${prefix}*`
    : `本会话内始终允许 ${tool} 的全部调用`;
}
