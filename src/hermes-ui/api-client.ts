'use client'

import { getElectronAPI, electronHermes } from '@/lib/electron-bridge'
import { warn, error as logError, debug } from '@/lib/logger'
import { buildAcpMcpServers } from '@/lib/mcp'
import { normalizeAcpContent } from '@/lib/text-utils'
import { useHelixStore } from '@/stores/helix-store'
import type { ResolvedModel, ChatMessage } from './types'

const AUTH_RE = /401|unauthorized|incorrect.*api.?key|invalid.*token|认证|令牌|授权/i

export function isAuthError(msg?: string | null): boolean {
  return !!msg && AUTH_RE.test(msg)
}

export function configHashOf(cfg: ResolvedModel): string {
  return `${cfg.baseUrl}||${cfg.apiKey}||${cfg.model}||${cfg.providerName}`
}

// ── Tool call tracking ──────────────────────────────────────────────────

export interface ToolCallInfo {
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  result?: string
  inlineDiff?: string
  summary?: string
  duration_s?: number
  status: 'running' | 'complete' | 'error'
  isError?: boolean
  startedAt: number
  finishedAt?: number
}

// ── Stream handlers (extended with reasoning + tool events) ──────────────

export interface StreamHandlers {
  onToken: (delta: string) => void
  onReasoningDelta?: (delta: string, replace?: boolean) => void
  onToolStart?: (info: ToolCallInfo) => void
  onToolProgress?: (info: Partial<ToolCallInfo> & { toolCallId: string }) => void
  onToolComplete?: (info: Partial<ToolCallInfo> & { toolCallId: string }) => void
  onWorkspaceChanged?: () => void
  onSessionTitle?: (title: string) => void
  onTodoUpdate?: (todos: unknown[]) => void
  onDone: () => void
  onError: (err: ChatError) => void
}

export interface ChatError {
  status?: number
  message: string
  isAuth: boolean
}

export interface SendOptions {
  system?: string
}

export interface HermesClientOptions {
  getConfig: () => ResolvedModel | null
  getCwd?: () => string
}

function hermes(): any {
  return getElectronAPI()?.hermes as any
}

// ── Delta queue for batched flushing (30fps) ────────────────────────────

const STREAM_DELTA_FLUSH_MS = 33 // ~30fps

interface DeltaQueue {
  textBuffer: string
  reasoningBuffer: string
  lastFlushAt: number
  flushTimer: ReturnType<typeof setTimeout> | null
  rafId: number | null
  scheduleFlush: () => void
}

function createDeltaQueue(flush: (text: string, reasoning: string) => void): DeltaQueue {
  const q: DeltaQueue = {
    textBuffer: '',
    reasoningBuffer: '',
    lastFlushAt: 0,
    flushTimer: null,
    rafId: null,
    scheduleFlush: () => {},
  }

  const doFlush = () => {
    const text = q.textBuffer
    const reasoning = q.reasoningBuffer
    q.textBuffer = ''
    q.reasoningBuffer = ''
    q.lastFlushAt = performance.now()
    q.flushTimer = null
    q.rafId = null
    if (text || reasoning) flush(text, reasoning)
  }

  q.scheduleFlush = () => {
    if (q.flushTimer !== null || q.rafId !== null) return
    const sinceLast = performance.now() - q.lastFlushAt
    if (sinceLast >= STREAM_DELTA_FLUSH_MS && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      q.rafId = window.requestAnimationFrame(() => {
        q.rafId = null
        doFlush()
      })
    } else {
      q.flushTimer = setTimeout(() => {
        q.flushTimer = null
        doFlush()
      }, Math.max(0, STREAM_DELTA_FLUSH_MS - sinceLast))
    }
  }

  return q
}

// ── Deep merge utility for tool args/results ────────────────────────────

function deepMergeArgs(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const [key, value] of Object.entries(source)) {
    if (key === 'todos') {
      // Carry todos across sparse progress payloads
      result[key] = value
    } else if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) &&
               result[key] !== null && result[key] !== undefined && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMergeArgs(result[key] as Record<string, unknown>, value as Record<string, unknown>)
    } else if (value !== null && value !== undefined) {
      result[key] = value
    }
  }
  return result
}

function mergeToolResult(existing: string | undefined, params: Record<string, unknown>): string | undefined {
  // Priority: result > output > message > summary
  const raw = params.result ?? params.output ?? params.message ?? params.summary
  if (typeof raw === 'string') return raw
  if (existing) return existing
  return undefined
}

// ── Permission store (session-level + persistent) ───────────────────────

export type ApprovalLevel = 'once' | 'session' | 'always' | 'deny'

const sessionPermissions = new Map<string, ApprovalLevel>() // toolName → level
let pendingApprovalResolve: ((level: ApprovalLevel) => void) | null = null
let pendingApprovalRequestId: string | null = null

export function respondApproval(level: ApprovalLevel) {
  if (pendingApprovalResolve) {
    pendingApprovalResolve(level)
    pendingApprovalResolve = null
    pendingApprovalRequestId = null
  }
}

/** Clear any pending approval (called on turn end / cancel / error) */
export function clearPendingApproval() {
  if (pendingApprovalResolve) {
    pendingApprovalResolve('deny')
    pendingApprovalResolve = null
    pendingApprovalRequestId = null
  }
}

function getSessionPermission(toolName: string): ApprovalLevel | null {
  const perm = sessionPermissions.get(toolName)
  return perm ?? null
}

function setSessionPermission(toolName: string, level: ApprovalLevel) {
  if (level === 'once') return
  sessionPermissions.set(toolName, level)
}

export function clearSessionPermissions() {
  sessionPermissions.clear()
}

// Tools that require approval (matching Hermes Desktop)
const APPROVAL_TOOLS = new Set(['terminal', 'execute_code', 'run_bash'])

function needsApproval(toolName: string): boolean {
  return APPROVAL_TOOLS.has(toolName)
}

// ── Main client ─────────────────────────────────────────────────────────

export class HermesChatClient {
  private sessionId: string | null = null
  private sessionConfigHash: string | null = null
  private inFlight = false
  private recovering = false
  private interrupted = false
  private retryCount = 0
  private pendingText: string | null = null
  private pendingHandlers: StreamHandlers | null = null
  private pendingOptions: SendOptions | null = null
  private unsubscribe: (() => void) | null = null
  private readonly getConfig: () => ResolvedModel | null
  private readonly getCwd: () => string
  private deltaQueue: DeltaQueue | null = null
  // Stream completion signal: resolves when message.complete arrives
  private streamCompleteResolve: (() => void) | null = null
  private streamCompleteReject: ((err: Error) => void) | null = null

  constructor(opts: HermesClientOptions) {
    this.getConfig = opts.getConfig
    this.getCwd = opts.getCwd ?? (() => (typeof process !== 'undefined' ? process.cwd() : ''))
    const h = hermes()
    if (h?.onEvent) {
      this.unsubscribe = h.onEvent((event: string, params?: any) => this.handleEvent(event, params))
    }
  }

  dispose() {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.pendingHandlers = null
    this.flushDeltaQueue()
  }

  // ── Public API ──────────────────────────────────────────────────────

  async streamChat(
    text: string,
    handlers: StreamHandlers,
    options: SendOptions = {},
  ): Promise<void> {
    const h = hermes()
    if (!h) {
      handlers.onError({ message: '当前环境不支持 Hermes 后端（仅 Electron 环境可用）', isAuth: false })
      return
    }
    this.pendingText = text
    this.pendingHandlers = handlers
    this.pendingOptions = options
    this.retryCount = 0
    this.interrupted = false

    // Create delta queue for this stream
    this.deltaQueue = createDeltaQueue((textDelta, reasoningDelta) => {
      if (!this.pendingHandlers) return
      if (textDelta) this.pendingHandlers.onToken(textDelta)
      if (reasoningDelta && this.pendingHandlers.onReasoningDelta) {
        this.pendingHandlers.onReasoningDelta(reasoningDelta)
      }
    })

    await this.runAttempt(text, handlers, options)
  }

  onModelSwitched() {
    const cfg = this.getConfig()
    if (this.sessionId) {
      electronHermes.notify('session/cancel', { session_id: this.sessionId })
    }
    this.inFlight = false
    this.recovering = false
    this.interrupted = true
    // Resolve stream promise so runAttempt exits cleanly
    if (this.streamCompleteResolve) {
      this.streamCompleteResolve()
      this.streamCompleteResolve = null
      this.streamCompleteReject = null
    }
    this.flushDeltaQueue()
    clearPendingApproval()
    if (cfg) {
      const hash = configHashOf(cfg)
      if (this.sessionId && this.sessionConfigHash !== hash) {
        warn('[HermesChatClient] 模型/Provider 切换 → config 变化，invalidate 当前 session')
        this.invalidateSession()
      }
    }
  }

  cancel() {
    this.interrupted = true
    if (this.sessionId) electronHermes.notify('session/cancel', { session_id: this.sessionId })
    this.inFlight = false
    this.flushDeltaQueue()
    clearPendingApproval()
    // Resolve stream promise so runAttempt exits cleanly
    if (this.streamCompleteResolve) {
      this.streamCompleteResolve()
      this.streamCompleteResolve = null
      this.streamCompleteReject = null
    }
  }

  /** Invalidate session and clear permissions (e.g. on provider switch) */
  invalidateAndClear() {
    this.invalidateSession()
    clearSessionPermissions()
  }

  // ── Session lifecycle ──────────────────────────────────────────────

  private invalidateSession() {
    debug('[HermesChatClient] invalidateSession:', this.sessionId)
    this.sessionId = null
    this.sessionConfigHash = null
    clearSessionPermissions()
  }

  private async ensureSession(): Promise<void> {
    const cfg = this.getConfig()
    if (!cfg) throw new Error('未找到当前模型对应的 Provider 配置，请检查设置')
    if (!cfg.apiKey) throw new Error('当前 Provider 的 API Key 为空，请先在设置中填写')

    const hash = configHashOf(cfg)

    // Try to resume existing session first (Hermes Desktop style)
    if (this.sessionId && this.sessionConfigHash !== hash) {
      warn('[HermesChatClient] config 变化（Provider 切换），invalidate 当前 session')
      this.invalidateSession()
    }

    if (!this.sessionId) {
      const h = hermes()
      await h.setModel({
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        provider: cfg.providerName,
      })
      await this.waitForGatewayReady()

      // Try resume first, then create new
      const hermesStore = await import('@/stores/hermes-store')
      const savedSessionId = hermesStore.useHermesStore.getState().hermesSessionId
      if (savedSessionId) {
        try {
          const resumed: any = await h.send('session/resume', { session_id: savedSessionId })
          if (resumed?.session_id || resumed?._meta?.hermes?.sessionProvenance?.acpSessionId) {
            this.sessionId = resumed.session_id || resumed._meta?.hermes?.sessionProvenance?.acpSessionId
            this.sessionConfigHash = hash
            debug('[HermesChatClient] session 已恢复:', this.sessionId)
            return
          }
        } catch {
          // Resume failed, create new
        }
      }

      const result: any = await h.send('session/new', {
        cwd: this.getCwd(),
        mcpServers: buildAcpMcpServers(useHelixStore.getState().mcpServers),
      })
      const sid =
        result?._meta?.hermes?.sessionProvenance?.acpSessionId ||
        result?.session_id ||
        result?.sessionID ||
        (typeof result === 'string' ? result : null)
      if (!sid) throw new Error('无法创建会话（session/new 未返回 session_id）')
      this.sessionId = sid
      this.sessionConfigHash = hash
      debug('[HermesChatClient] session 已创建:', sid, 'hash=', hash)
    }
  }

  private async runAttempt(text: string, handlers: StreamHandlers, options: SendOptions): Promise<void> {
    this.recovering = false
    try {
      await this.ensureSession()
    } catch (e: any) {
      this.inFlight = false
      this.flushDeltaQueue()
      handlers.onError({ message: e?.message || '无法创建会话', isAuth: false })
      return
    }
    this.inFlight = true

    // Create a Promise that resolves when message.complete arrives
    const streamDone = new Promise<void>((resolve, reject) => {
      this.streamCompleteResolve = resolve
      this.streamCompleteReject = reject
    })

    try {
      // Send the prompt — race IPC error against stream completion
      // If IPC fails, the reject from streamCompleteReject won't fire;
      // the dispatchPrompt rejection propagates to catch below.
      const ipcSent = this.dispatchPrompt(text).catch((err) => {
        // IPC send failed — reject stream so cleanup runs
        if (this.streamCompleteReject) {
          this.streamCompleteReject(err)
          this.streamCompleteResolve = null
          this.streamCompleteReject = null
        }
        throw err // re-throw so runAttempt's catch handles it
      })

      // Wait for BOTH: IPC sent AND stream complete
      // Use Promise.all: ipcSent catches IPC errors, streamDone catches stream errors
      const streamTimeout = setTimeout(() => {
        if (this.streamCompleteReject) {
          this.streamCompleteReject(new Error('流式输出超时'))
          this.streamCompleteResolve = null
          this.streamCompleteReject = null
        }
      }, 600_000)

      await Promise.all([ipcSent, streamDone])
      clearTimeout(streamTimeout)

      // Only finalize if not interrupted
      if (!this.interrupted) {
        this.inFlight = false
        this.flushDeltaQueue()
        clearPendingApproval()
        handlers.onDone()
      }
    } catch (e: any) {
      this.inFlight = false
      this.flushDeltaQueue()
      clearPendingApproval()
      if (isAuthError(e?.message)) {
        this.handleAuthFailure(e.message)
      } else {
        handlers.onError({ message: e?.message || '请求失败', isAuth: false })
      }
    } finally {
      this.streamCompleteResolve = null
      this.streamCompleteReject = null
    }
  }

  private dispatchPrompt(text: string): Promise<void> {
    const h = hermes()
    if (!h || !this.sessionId) return Promise.reject(new Error('session 未就绪'))
    return new Promise<void>((resolve, reject) => {
      h.send('session/prompt', {
        session_id: this.sessionId,
        prompt: [{ type: 'text', text }],
      })
        .then(() => resolve())
        .catch((err: any) => reject(err))
    })
  }

  private handleAuthFailure(msg: string) {
    if (!this.inFlight || this.recovering) return
    this.recovering = true
    this.inFlight = false

    if (this.retryCount >= 1) {
      this.pendingHandlers?.onError({ message: msg || '认证失败（401）', isAuth: true })
      return
    }
    warn('[HermesChatClient] 401 检测 → invalidate + 重建 session + 重试 1 次')
    this.retryCount = 1
    this.invalidateSession()
    void this.runAttempt(this.pendingText!, this.pendingHandlers!, this.pendingOptions!)
  }

  // ── Event handling (extended with reasoning + tool events) ──────────

  private handleEvent(event: string, params?: any) {
    if (this.interrupted) return
    if (this.sessionId && params?.session_id && params.session_id !== this.sessionId) return

    switch (event) {
      // ── Message lifecycle ──
      case 'message.start': {
        // Reset state for new assistant turn (Hermes Desktop style)
        this.interrupted = false
        break
      }

      case 'message.complete': {
        // Finalize: flush remaining deltas, then resolve the stream promise
        if (this.pendingHandlers && this.inFlight) {
          this.flushDeltaQueueNow()
          debug('[HermesChatClient] message.complete received')
        }
        // Signal stream completion to runAttempt
        if (this.streamCompleteResolve) {
          this.streamCompleteResolve()
          this.streamCompleteResolve = null
          this.streamCompleteReject = null
        }
        break
      }

      case 'session/title': {
        const title = params?.title || params?.name || ''
        if (title && this.pendingHandlers?.onSessionTitle) {
          this.pendingHandlers.onSessionTitle(title)
        }
        break
      }

      // ── Content delta ──
      case 'session/update': {
        const raw = params?.content
        if (typeof raw === 'string' && raw && this.pendingHandlers && this.inFlight) {
          const delta = normalizeAcpContent(raw)
          if (delta) {
            // Queue delta for batched flush
            if (this.deltaQueue) {
              this.deltaQueue.textBuffer += delta
              this.deltaQueue.scheduleFlush()
            } else {
              this.pendingHandlers.onToken(delta)
            }
          }
        }
        break
      }

      // ── Reasoning / thinking events ──
      case 'reasoning.delta': {
        if (this.pendingHandlers?.onReasoningDelta && this.inFlight) {
          const delta = params?.text || params?.delta || ''
          if (delta) {
            if (this.deltaQueue) {
              this.deltaQueue.reasoningBuffer += delta
              this.deltaQueue.scheduleFlush()
            } else {
              this.pendingHandlers.onReasoningDelta(delta)
            }
          }
        }
        break
      }

      case 'reasoning.available': {
        // Hermes Desktop: replace=true — replaces entire reasoning blob when no visible text yet
        if (this.pendingHandlers?.onReasoningDelta && this.inFlight) {
          const text = params?.text || params?.delta || ''
          if (text) {
            this.flushDeltaQueueNow()
            this.pendingHandlers.onReasoningDelta(text, true)
          }
        }
        break
      }

      // ── Thinking delta (spinner status only — ignore, Hermes Desktop style) ──
      case 'thinking.delta': {
        // Intentionally ignored — this is just a spinner status, not real reasoning
        break
      }

      // ── MoA (Mixture of Agents) reference ──
      case 'moa.reference': {
        // Surface MoA reference model output as labelled reasoning chunks
        if (this.pendingHandlers?.onReasoningDelta && this.inFlight) {
          const ref = params?.reference || params?.text || ''
          const model = params?.model || params?.reference_model || ''
          if (ref) {
            const label = model ? `[${model}] ` : ''
            const delta = `${label}${ref}`
            if (this.deltaQueue) {
              this.deltaQueue.reasoningBuffer += delta
              this.deltaQueue.scheduleFlush()
            } else {
              this.pendingHandlers.onReasoningDelta(delta)
            }
          }
        }
        break
      }

      case 'moa.aggregating': {
        // MoA aggregation phase — ignore (status-only)
        break
      }

      // ── Tool lifecycle events ──
      case 'tool.start':
      case 'tool.generating': {
        if (this.pendingHandlers?.onToolStart && this.inFlight) {
          // Flush text deltas before tool event to preserve ordering
          this.flushDeltaQueueNow()

          const rawArgs = params?.args || params?.arguments || params?.input
          const args = deepMergeArgs({}, typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {})

          this.pendingHandlers.onToolStart({
            toolCallId: params?.tool_call_id || params?.toolCallId || '',
            toolName: params?.tool_name || params?.toolName || params?.name || '',
            args,
            status: 'running',
            startedAt: Date.now(),
          })
        }
        break
      }

      case 'tool.progress': {
        if (this.pendingHandlers?.onToolProgress && this.inFlight) {
          // Flush text deltas before tool event
          this.flushDeltaQueueNow()

          const rawArgs = params?.args || params?.arguments || params?.input
          const mergedArgs = rawArgs && typeof rawArgs === 'object' ? rawArgs : undefined

          this.pendingHandlers.onToolProgress({
            toolCallId: params?.tool_call_id || params?.toolCallId || '',
            args: mergedArgs,
            result: mergeToolResult(undefined, params || {}),
            summary: params?.summary,
          })
        }
        break
      }

      case 'tool.complete': {
        if (this.pendingHandlers?.onToolComplete && this.inFlight) {
          // Flush text deltas before tool event
          this.flushDeltaQueueNow()

          const rawArgs = params?.args || params?.arguments || params?.input
          const mergedArgs = rawArgs && typeof rawArgs === 'object' ? rawArgs : undefined

          this.pendingHandlers.onToolComplete({
            toolCallId: params?.tool_call_id || params?.toolCallId || '',
            args: mergedArgs,
            result: mergeToolResult(undefined, params || {}),
            inlineDiff: params?.inline_diff || params?.diff,
            summary: params?.summary,
            duration_s: params?.duration_s,
            isError: params?.is_error || params?.isError,
            status: 'complete',
            finishedAt: Date.now(),
          })

          // Track workspace mutations
          if (this.pendingHandlers?.onWorkspaceChanged) {
            const name = params?.tool_name || params?.toolName || params?.name || ''
            if (['write_file', 'patch', 'run_bash', 'terminal', 'create_file', 'delete_file', 'apply_patch'].includes(name)) {
              this.pendingHandlers.onWorkspaceChanged()
            }
          }

          // Parse todos from todo_write tool
          const toolName = params?.tool_name || params?.toolName || params?.name || ''
          if (toolName === 'todo_write' && params?.todos && this.pendingHandlers?.onTodoUpdate) {
            this.pendingHandlers.onTodoUpdate(params.todos)
          }
        }
        break
      }

      // ── Approval requests (for terminal/execute_code) ──
      case 'approval.request': {
        if (this.pendingHandlers && this.inFlight) {
          this.handleApprovalRequest(params)
        }
        break
      }

      // ── Error ──
      case 'error': {
        const msg = params?.message || ''
        // Reject the stream promise — runAttempt's catch will call onError
        if (this.streamCompleteReject) {
          this.streamCompleteReject(new Error(msg || '未知错误'))
          this.streamCompleteResolve = null
          this.streamCompleteReject = null
        }
        if (isAuthError(msg)) {
          this.handleAuthFailure(msg)
        }
        break
      }
    }
  }

  private async handleApprovalRequest(params: any) {
    const toolName = params?.tool_name || params?.toolName || ''
    const requestId = params?.request_id || params?.requestId || `req_${Date.now()}`
    const allowPermanent = params?.allow_permanent !== false // default true
    const command = params?.command || params?.description || ''

    if (!needsApproval(toolName)) {
      // Auto-approve non-gated tools
      const h = hermes()
      if (h) {
        h.send('approval/respond', {
          session_id: this.sessionId,
          tool_call_id: params?.tool_call_id || params?.toolCallId,
          choice: 'once',
        }).catch(() => {})
      }
      return
    }

    // Check session-level permission
    const existing = getSessionPermission(toolName)
    if (existing === 'always' || existing === 'session') {
      const h = hermes()
      if (h) {
        h.send('approval/respond', {
          session_id: this.sessionId,
          tool_call_id: params?.tool_call_id || params?.toolCallId,
          choice: existing,
        }).catch((err: any) => warn('[Approval] auto-respond failed:', err))
      }
      return
    }

    // Need user approval — expose via promise with requestId for stale protection
    const level = await new Promise<ApprovalLevel>((resolve) => {
      pendingApprovalResolve = resolve
      pendingApprovalRequestId = requestId
    })

    // Stale check: if request was superseded or session was cancelled, discard
    if (pendingApprovalRequestId !== requestId) return
    if (this.interrupted || !this.inFlight) return

    if (level !== 'deny') {
      setSessionPermission(toolName, level)
    }

    const h = hermes()
    if (h && this.sessionId) {
      h.send('approval/respond', {
        session_id: this.sessionId,
        tool_call_id: params?.tool_call_id || params?.toolCallId,
        choice: level,
      }).catch((err: any) => warn('[Approval] respond failed:', err))
    }
  }

  private flushDeltaQueueNow() {
    if (this.deltaQueue) {
      const q = this.deltaQueue
      if (q.flushTimer) clearTimeout(q.flushTimer)
      if (q.rafId !== null && typeof window !== 'undefined') cancelAnimationFrame(q.rafId)
      q.flushTimer = null
      q.rafId = null
      if ((q.textBuffer || q.reasoningBuffer) && this.pendingHandlers) {
        if (q.textBuffer) this.pendingHandlers.onToken(q.textBuffer)
        if (q.reasoningBuffer && this.pendingHandlers.onReasoningDelta) {
          this.pendingHandlers.onReasoningDelta(q.reasoningBuffer)
        }
      }
      q.textBuffer = ''
      q.reasoningBuffer = ''
      q.lastFlushAt = performance.now()
    }
  }

  private flushDeltaQueue() {
    this.flushDeltaQueueNow()
    this.deltaQueue = null
  }

  private waitForGatewayReady(timeoutMs = 3000): Promise<boolean> {
    const h = hermes()
    if (!h) return Promise.resolve(false)
    return new Promise((resolve) => {
      let done = false
      const finish = (v: boolean) => {
        if (!done) {
          done = true
          cleanup()
          resolve(v)
        }
      }
      const unsub = h.onEvent((event: string) => {
        if (event === 'gateway.ready') finish(true)
      })
      const cleanup = () => {
        try { unsub?.() } catch { /* noop */ }
      }
      setTimeout(() => finish(true), timeoutMs)
    })
  }
}

// ── Per-model presets (Hermes Desktop style) ────────────────────────────

export interface ModelPreset {
  reasoningEffort: string
  fast: boolean
}

const MODEL_PRESETS_KEY = 'helix-model-presets'

export function loadModelPresets(): Record<string, ModelPreset> {
  try {
    const raw = localStorage.getItem(MODEL_PRESETS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveModelPreset(modelKey: string, preset: ModelPreset) {
  const presets = loadModelPresets()
  presets[modelKey] = preset
  localStorage.setItem(MODEL_PRESETS_KEY, JSON.stringify(presets))
}

export function getModelPreset(modelKey: string): ModelPreset | null {
  const presets = loadModelPresets()
  return presets[modelKey] ?? null
}

export type { ChatMessage }
