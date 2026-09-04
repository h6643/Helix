/**
 * Helix hooks — simplified 5-point hook configuration.
 *
 * Helix's agent loop and tool execution live in the external `hermes`
 * subprocess. Hermes ships its OWN hooks engine that fires at REAL execution
 * points. This file defines the 5 hook points exposed in the UI.
 */

export type HookType = 'PreToolUse' | 'PostToolUse' | 'PreVerify' | 'SessionStart' | 'SessionEnd'

export interface HookConfig {
  id: string
  type: HookType
  matcher: string
  command: string
  enabled: boolean
  description?: string
}

export interface HooksSettings {
  enabled: boolean
  hooks: HookConfig[]
}

/** Legacy format for IPC with backend */
export interface HooksConfig {
  enabled?: boolean
  hooks: Record<string, { command: string; matcher?: string; timeout?: number }[]>
}

export const HOOK_META: Record<HookType, { label: string; desc: string; supportsMatcher: boolean }> = {
  PreToolUse: { label: '工具调用前', desc: '可拦截/拒绝', supportsMatcher: true },
  PostToolUse: { label: '工具调用后', desc: '审计/通知', supportsMatcher: true },
  PreVerify: { label: '收尾验证前', desc: '返回 continue 可续跑', supportsMatcher: false },
  SessionStart: { label: '会话开始', desc: '新会话创建时触发', supportsMatcher: false },
  SessionEnd: { label: '会话结束', desc: '会话结束时触发', supportsMatcher: false },
}

export const HOOK_TYPES: HookType[] = ['PreToolUse', 'PostToolUse', 'PreVerify', 'SessionStart', 'SessionEnd']

export const EMPTY_HOOKS_SETTINGS: HooksSettings = {
  enabled: true,
  hooks: [],
}

/** Generate a unique ID for a new hook */
export function generateHookId(): string {
  return 'hook-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}
