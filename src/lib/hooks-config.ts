/**
 * Helix hooks — backend-aligned schema.
 *
 * Helix's agent loop and tool execution live in the external `hermes`
 * subprocess. Hermes ships its OWN hooks engine (`agent/shell_hooks.py`) that
 * fires at the REAL execution points (e.g. `pre_tool_call` can BLOCK a tool).
 * So Hook config is NOT executed by the Electron main process — it is written
 * into Hermes' own `config.yaml` (`hooks:` block) and the gateway is restarted
 * so Hermes registers them. This file mirrors Hermes' flat, snake_case schema
 * (see `hermes_cli/plugins.py` `VALID_HOOKS`), NOT Codex' nested shape.
 *
 *   config.yaml:
 *     hooks_auto_accept: true          # required so non-TTY launch registers them
 *     hooks:
 *       pre_tool_call:
 *         - command: "python3 ~/.helix/hooks/notify.py"
 *           matcher: "Bash"            # optional regex on tool name
 *           timeout: 30                # optional seconds
 *
 * pre_tool_call hooks may return `{"decision":"block","reason":"..."}` (or
 * `{"action":"block","message":"..."}`) on stdout to ABORT the tool call — a
 * real gate, unlike an observational Electron-side hook.
 */

/** Event names MUST match Hermes' `VALID_HOOKS` (snake_case). */
export type BackendHookEvent =
  | 'pre_tool_call'
  | 'post_tool_call'
  | 'pre_verify'
  | 'on_session_start'
  | 'on_session_end'
  | 'on_session_finalize'
  | 'on_session_reset'
  | 'subagent_start'
  | 'subagent_stop'
  | 'pre_llm_call'
  | 'post_llm_call'

export const HOOK_EVENTS: BackendHookEvent[] = [
  'pre_tool_call',
  'post_tool_call',
  'pre_verify',
  'on_session_start',
  'on_session_end',
  'on_session_finalize',
  'on_session_reset',
  'subagent_start',
  'subagent_stop',
  'pre_llm_call',
  'post_llm_call',
]

/** Friendly labels for the UI (mapping to Claude-Code / Codex concepts). */
export const HOOK_EVENT_LABELS: Record<BackendHookEvent, string> = {
  pre_tool_call: 'PreToolUse · 工具调用前（可拦截/拒绝）',
  post_tool_call: 'PostToolUse · 工具调用后',
  pre_verify: 'PreVerify · 收尾验证前（可续跑，返回 continue 阻止结束）',
  on_session_start: 'SessionStart · 会话开始',
  on_session_end: 'SessionEnd · 会话结束',
  on_session_finalize: 'SessionFinalize · 会话收尾',
  on_session_reset: 'SessionReset · 会话重置',
  subagent_start: 'SubagentStart · 子代理启动',
  subagent_stop: 'SubagentStop · 子代理停止',
  pre_llm_call: 'PreLLMCall · LLM 调用前',
  post_llm_call: 'PostLLMCall · LLM 调用后',
}

/** Short hint shown under each event in the UI. */
export const HOOK_EVENT_HINTS: Record<BackendHookEvent, string> = {
  pre_tool_call: 'matcher 为正则匹配工具名（如 ^Bash$）；留空=全部。stdout 返回 {"decision":"block","reason":"..."} 可拦截该工具调用。',
  post_tool_call: 'matcher 为正则匹配工具名；留空=全部。命令可读取工具输出做审计/通知。',
  pre_verify: 'agent 编辑完代码准备收尾验证前触发。stdout 返回 {"action":"continue","message":"..."} 可让它继续干活。',
  on_session_start: '新会话创建时触发（matcher 在此忽略）。',
  on_session_end: '会话正常结束时触发（matcher 在此忽略）。',
  on_session_finalize: '会话收尾时触发（matcher 在此忽略）。',
  on_session_reset: '会话被 reset 时触发（matcher 在此忽略）。',
  subagent_start: '子代理启动时触发（matcher 在此忽略）。',
  subagent_stop: '子代理停止时触发（matcher 在此忽略）。',
  pre_llm_call: 'LLM 调用前触发（matcher 在此忽略）。',
  post_llm_call: 'LLM 调用后触发（matcher 在此忽略）。',
}

export interface HookHandler {
  /** Shell command to run. The JSON context is piped to stdin. */
  command: string
  /** Optional regex tested against the tool name (tool-scoped events only). */
  matcher?: string
  /** Optional timeout in seconds (Hermes default 600). */
  timeout?: number
}

export interface HooksConfig {
  /** Master switch. Omitting/emptying hooks disables them. */
  enabled?: boolean
  /** Flat map: event name -> list of handlers. */
  hooks: Partial<Record<BackendHookEvent, HookHandler[]>>
}

export const EMPTY_HOOKS_CONFIG: HooksConfig = { enabled: true, hooks: {} }

export function isHookEvent(v: string): v is BackendHookEvent {
  return (HOOK_EVENTS as string[]).includes(v)
}
