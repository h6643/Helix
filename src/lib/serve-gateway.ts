'use client'

/**
 * serve-gateway.ts — hermes serve 网关适配器（阶段2，任务64）
 *
 * 目标：渲染层直连 `hermes serve` 的 WS JSON-RPC + REST 网关，同时对外保持与
 * `window.electron.hermes`（ACP IPC 桥）**完全同形**的接口。所有现有调用点
 * （api-client.ts / use-hermes.ts / agent-flow-panel.tsx / ...）零逻辑改动，
 * 仅把 `window.electron.hermes` 换成 `hermesApi()` 即可按模式自动分流。
 *
 * 协议事实（源码核查，见 docs/serve-migration.md）：
 * - WS 端点 ws://127.0.0.1:<port>/api/ws?token=<t>，换行分隔 JSON-RPC 2.0。
 * - 连接后服务端推 {"method":"event","params":{"type":"gateway.ready",...}}。
 * - 事件封套：params = { type, session_id?, payload? }。
 * - prompt.submit 仅同步 ack {"status":"streaming"}；真正回复走 message.* 事件。
 *   → 适配器把它桥接成「等 message.complete 才 resolve 且携带 usage」，
 *     保持 ACP session/prompt 的语义（Helix 两处调用点依赖此语义）。
 * - approval.request/respond 无 request_id，session 级 FIFO。
 * - 无 session.set_mode；审批绕过 = config.set {key:'yolo'}。
 * - 文本增量字段是 payload.text；工具唯一 id 字段是 payload.tool_id。
 */

import { warn, error as logError, debug } from '@/lib/logger'

// ── 类型 ────────────────────────────────────────────────────────────────

export interface ServeGatewayInfo {
  mode: 'serve'
  pending?: boolean
  port?: number
  token?: string
  baseUrl?: string
  wsUrl?: string
}

type EventCallback = (event: string, params?: any) => void

interface PendingRpc {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingPrompt {
  resolve: (v: any) => void
  reject: (e: Error) => void
}

// ── usage 映射（serve payload → Helix 期望的驼峰字段）──────────────────

function num(u: any, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = Number(u?.[k])
    if (Number.isFinite(v) && v >= 0) return v
  }
  return undefined
}

function mapUsage(u: any): any {
  if (!u || typeof u !== 'object') return null
  return {
    totalTokens: num(u, 'totalTokens', 'total_tokens'),
    inputTokens: num(u, 'inputTokens', 'input_tokens', 'prompt_tokens'),
    outputTokens: num(u, 'outputTokens', 'output_tokens', 'completion_tokens'),
    thoughtTokens: num(u, 'thoughtTokens', 'thought_tokens', 'reasoning_tokens'),
    cachedReadTokens: num(u, 'cachedReadTokens', 'cache_read_tokens', 'cache_read_input_tokens'),
    cachedWriteTokens: num(u, 'cachedWriteTokens', 'cache_write_tokens', 'cache_creation_input_tokens'),
    ...u,
  }
}

function promptBlocksToText(prompt: any): string {
  if (typeof prompt === 'string') return prompt
  if (Array.isArray(prompt)) {
    return prompt
      .map((b: any) => (typeof b === 'string' ? b : (b?.text ?? '')))
      .filter(Boolean)
      .join('\n')
  }
  return String(prompt ?? '')
}

/** 从 session.resume 返回的 messages（{role, text, ...}）提取最后一条可见正文 */
function lastAssistantText(messages: any): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'assistant') {
      const text = typeof m?.text === 'string' ? m.text : ''
      if (text.trim()) return text
    }
  }
  return ''
}

/**
 * Derive a Hermes-style tool "kind" from the tool name. The ACP adapter maps
 * file-modifying tools (write_file / edit / str_replace / apply_patch) to
 * kind='edit', which the UI uses to detect pending file changes for the diff
 * preview. serve events don't carry a `kind`, so reconstruct it from the name.
 */
function toolKindFromName(name: string): string {
  const n = (name || '').toLowerCase()
  if (n.includes('write') || n.includes('edit') || n.includes('patch') || n.includes('str_replace') || n.includes('create_file')) return 'edit'
  if (n.includes('read') || n.includes('list') || n.includes('glob') || n.includes('grep') || n.includes('search') || n.includes('find')) return 'read'
  if (n.includes('bash') || n.includes('execute') || n.includes('terminal') || n.includes('shell') || n.includes('run')) return 'execute'
  return ''
}

// ── 网关客户端 ──────────────────────────────────────────────────────────

const RPC_TIMEOUT_MS = 60_000
const RECONNECT_DELAYS = [1000, 2000, 5000, 10_000]

export class ServeGatewayClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<string | number, PendingRpc>()
  private pendingPrompts = new Map<string, PendingPrompt>()
  private listeners = new Set<EventCallback>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private approvalSeq = 0
  /** 最近一次 message.complete 缓存（session_id → payload），供 prompt resolve 用 */
  private lastComplete = new Map<string, any>()
  /** 等待 WS 首次 OPEN 的挂起者（修 CONNECTING 窗口内 rpc 被误拒的竞态） */
  private openWaiters: Array<() => void> = []

  constructor(public info: Required<Pick<ServeGatewayInfo, 'baseUrl' | 'wsUrl'>> & ServeGatewayInfo) {}

  // ── 连接管理 ──────────────────────────────────────────────

  /**
   * 网关重启换端口后更新地址并立即重连。
   * 背景：主进程的 restartGatewayDebounced（配置同步等触发）会 kill+respawn
   * serve，`--port 0` 下新实例端口必变；旧 wsUrl 会永久 ERR_CONNECTION_REFUSED。
   */
  updateInfo(next: ServeGatewayInfo): void {
    if (!next?.wsUrl || !next?.baseUrl) return
    const changed = next.wsUrl !== this.info.wsUrl || next.baseUrl !== this.info.baseUrl
    this.info = { ...this.info, ...next } as any
    debug('[ServeGateway] ⟳ serveInfo received port=', next.port, 'changed=', changed)
    if (!changed || this.disposed) return
    // 地址变了 = 网关是全新进程：旧实例上做过的模型同步对它无效，
    // 必须重置标志，让下一次 session/new 重新走 ensureModelSynced。
    // （否则 respawn 后的新实例会拿 HERMES_HOME 里可能陈旧的配置建 agent → 30s 超时）
    this.modelSynced = false
    this.modelSyncPromise = null
    debug('[ServeGateway] 网关地址变更 → port=', next.port, '，重连')
    const old = this.ws
    this.ws = null // 先置空：旧 socket 的 onclose 会被陈旧检查忽略
    try { old?.close() } catch { /* noop */ }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.reconnectAttempt = 0
    this.connect()
  }

  /** 重连前向主进程拉最新网关信息，防止对已死端口无限重试 */
  private async refreshInfoFromMain(): Promise<void> {
    try {
      const ipc = (window as any).electron?.hermes
      const info = await ipc?.getGatewayInfo?.()
      if (info?.mode === 'serve' && !info.pending && info.wsUrl && info.baseUrl) {
        if (info.wsUrl !== this.info.wsUrl) {
          debug('[ServeGateway] 重连前发现端口变更 →', info.port)
        }
        this.info = { ...this.info, ...info }
      }
    } catch { /* noop */ }
  }

  connect(): void {
    if (this.disposed || (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))) return
    try {
      const ws = new WebSocket(this.info.wsUrl)
      this.ws = ws
      debug('[ServeGateway] ▶ connect →', String(this.info.wsUrl).replace(/token=[^&]+/, 'token=***'))

      ws.onopen = () => {
        this.reconnectAttempt = 0
        debug('[ServeGateway] WS connected:', this.info.wsUrl.replace(/token=[^&]+/, 'token=***'))
        // 唤醒 CONNECTING 窗口内挂起的 rpc 调用
        const waiters = this.openWaiters.splice(0)
        for (const w of waiters) { try { w() } catch { /* noop */ } }
        // 对齐官方桌面端：WS 断开时 Hermes 会把运行中的会话 detach 到 drop
        // sentinel 继续执行，客户端重连后必须调用 session.resume 把 transport
        // 重绑回会话（server.py _live_session_payload 里 session["transport"]=
        // transport），事件流才会恢复。不 resume 的话，断连期间产生的事件永久丢失。
        this.resumePendingPrompts()
        this.emit('gateway.reconnected', {})
        // gateway.ready 由服务端主动推，不在这里合成
      }

      ws.onmessage = (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : ''
        // 换行分隔：一帧可能含多行 JSON
        for (const line of data.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            this.handleFrame(JSON.parse(trimmed))
          } catch (e) {
            warn('[ServeGateway] 无法解析帧:', trimmed.slice(0, 200), e)
          }
        }
      }

      ws.onclose = (ev) => {
        if (this.ws !== ws) return
        this.ws = null
        // 只失败普通 RPC（session/list、tools/list 等），**保留** in-flight 的
        // session/prompt。官方行为：WS 断开只是客户端掉线，Hermes 会把运行中
        // 的会话 detach 继续跑；重连后 session.resume 重绑 transport 恢复事件流，
        // 最终 run.completed 会正常 resolve 这个 prompt。若这里立刻 reject，
        // 前端会把一次瞬时断连当成 run 失败 → 丢失整个回复（显示"停止思考"）。
        // 连接彻底无法恢复时（网关重启/进程死亡），resumePendingPrompts 的
        // session.resume 会失败并 reject 这些 prompt，由前端收尾。
        this.failPendingRpcs(new Error(`网关连接断开 (code=${ev.code})`))
        if (this.disposed) return
        this.emit('gateway.disconnected', { code: ev.code })
        if (ev.code === 4401) {
          logError('[ServeGateway] token 鉴权失败 (4401)，停止重连')
          return
        }
        this.scheduleReconnect()
      }

      ws.onerror = () => {
        // onclose 会跟着触发，重连逻辑在那里
      }
    } catch (e) {
      logError('[ServeGateway] WS 创建失败:', e)
      this.scheduleReconnect()
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    try { this.ws?.close() } catch { /* noop */ }
    this.ws = null
    this.failAllPending(new Error('网关客户端已销毁'))
    this.listeners.clear()
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    this.reconnectAttempt++
    this.emit('gateway.retry', { attempt: this.reconnectAttempt, delay })
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      await this.refreshInfoFromMain() // 网关可能已重启换端口
      this.connect()
    }, delay)
  }

  private failPendingRpcs(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /** 全部失败（客户端销毁等确定性终止路径；prompt 一并 reject） */
  private failAllPending(err: Error): void {
    this.failPendingRpcs(err)
    for (const [, p] of this.pendingPrompts) p.reject(err)
    this.pendingPrompts.clear()
  }

  /**
   * 重连后恢复断连期间仍在运行的会话（对齐官方桌面端）。
   * WS 断开时 Hermes 把会话 detach 到 drop sentinel 继续执行；重连后必须
   * session.resume 把 transport 重绑回会话，事件流才恢复。对每个挂起的
   * session/prompt 逐会话 resume：
   * - running=true  → 会话仍在跑，保持 prompt 挂起，等 run.completed 收尾
   * - running=false → 断连期间已跑完，用返回的 messages 兜底正文并 resolve
   * - resume 报错   → 会话已不可恢复（网关重启/reap），reject 让前端收尾
   */
  private resumePendingPrompts(): void {
    const sessionIds = [...this.pendingPrompts.keys()]
    if (sessionIds.length === 0) return
    debug('[ServeGateway] 重连成功，resume 断连前在跑的会话:', sessionIds)
    for (const sessionId of sessionIds) {
      this.rpc('session.resume', { session_id: sessionId }, 20_000)
        .then((res: any) => {
          const pp = this.pendingPrompts.get(sessionId)
          if (!pp) return
          if (res?.running) {
            // 会话仍在跑：transport 已重绑，后续 run.completed 会正常 resolve
            debug('[ServeGateway] 会话仍在运行，等待事件流恢复:', sessionId)
            return
          }
          // 断连期间 run 已跑完（run.completed 发往 drop sink 丢失）。用 resume
          // 返回的完整 messages 兜底正文，经 run_complete 事件把完整回复交给前端，
          // 避免只显示断连前流出的半截内容。
          this.pendingPrompts.delete(sessionId)
          const text = lastAssistantText(res?.messages)
          this.emit('session/update', {
            session_id: sessionId,
            update: { sessionUpdate: 'run_complete', content: text },
          })
          pp.resolve({
            status: 'complete',
            usage: null,
            text,
            stopReason: 'end_turn',
          })
        })
        .catch((e: Error) => {
          const pp = this.pendingPrompts.get(sessionId)
          if (pp) {
            this.pendingPrompts.delete(sessionId)
            pp.reject(new Error(`会话恢复失败（${e?.message ?? '连接未能恢复'}）`))
          }
        })
    }
  }

  // ── JSON-RPC ──────────────────────────────────────────────

  /** 等待 WS 进入 OPEN（连接中/重连中最多等 waitMs），已连返回 true */
  private waitOpen(waitMs = 15_000): Promise<boolean> {
    if (this.connected) return Promise.resolve(true)
    if (this.disposed) return Promise.resolve(false)
    return new Promise((resolve) => {
      let done = false
      const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok) } }
      this.openWaiters.push(() => finish(true))
      setTimeout(() => finish(this.connected), waitMs)
    })
  }

  async rpc(method: string, params?: any, timeoutMs = RPC_TIMEOUT_MS): Promise<any> {
    // 修竞态：initServeGateway 在 connect() 发起后立即返回 client，此时 WS
    // 还在 CONNECTING；启动后第一批调用（session/new 等）若直接拒绝，会表现为
    // "模型不输出"。这里等 OPEN（含重连窗口）再发。
    if (!this.connected) {
      const ok = await this.waitOpen()
      if (!ok) throw new Error(`网关未连接，无法调用 ${method}`)
    }
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error(`网关未连接，无法调用 ${method}`))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        logError('[ServeGateway] ✗ rpc timeout', method, 'id=', id, `(${timeoutMs}ms)`)
        reject(new Error(`${method} 超时 (${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      debug('[ServeGateway] → rpc', method, 'id=', id)
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n')
    })
  }

  onEvent(cb: EventCallback): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private emit(event: string, params?: any): void {
    for (const cb of this.listeners) {
      try { cb(event, params) } catch (e) { warn('[ServeGateway] 事件回调异常:', event, e) }
    }
  }

  private handleFrame(msg: any): void {
    // 响应帧
    if (msg && msg.id !== undefined && msg.id !== null && !msg.method) {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message || 'RPC 错误'))
        else p.resolve(msg.result)
      }
      return
    }
    // 事件帧
    if (msg && msg.method === 'event' && msg.params) {
      const { type, session_id: sessionId, payload } = msg.params
      this.translateEvent(String(type || ''), sessionId, payload ?? {})
    }
  }

  // 解析一个挂起的 prompt promise。优先按 session_id 精确匹配；若上游结束事件
  // 漏带 session_id（serve 网关常见），且当前仅有唯一挂起 prompt，则模糊匹配，
  // 避免 done promise 永久挂起导致前端卡死在「停止」按钮。
  private resolvePending(sessionId: string | undefined, result: any): void {
    const exact = sessionId ? this.pendingPrompts.get(sessionId) : null
    if (exact) {
      this.pendingPrompts.delete(sessionId!)
      exact.resolve(result)
      return
    }
    if (!sessionId && this.pendingPrompts.size === 1) {
      const [key, pp] = [...this.pendingPrompts.entries()][0]
      this.pendingPrompts.delete(key)
      pp.resolve(result)
    }
  }

  // ── 事件翻译：serve 原生 → 原生直通 + ACP 合成双发 ─────────

  private translateEvent(type: string, sessionId: string | undefined, payload: any): void {
    const base = { session_id: sessionId, ...payload }

    switch (type) {
      case 'gateway.ready':
        this.emit('gateway.ready', base)
        return

      case 'message.start':
        this.emit('message.start', base)
        return

      case 'message.delta': {
        const text = payload?.text ?? ''
        this.emit('message.delta', base)
        if (text) {
          this.emit('session/update', {
            session_id: sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: text },
          })
        }
        return
      }

      case 'reasoning.delta':
      case 'thinking.delta': {
        const text = payload?.text ?? ''
        this.emit(type, base)
        if (text) {
          this.emit('session/update', {
            session_id: sessionId,
            update: { sessionUpdate: 'agent_thought_chunk', content: text },
          })
        }
        return
      }

      case 'reasoning.available':
        this.emit('reasoning.available', base)
        return

      case 'message.complete': {
        const usage = mapUsage(payload?.usage)
        if (sessionId) this.lastComplete.set(sessionId, payload)
        // 先发原生 + usage 事件，再 resolve pending prompt（顺序与 ACP 主进程一致）
        this.emit('message.complete', base)
        if (usage) this.emit('usage:prompt-complete', { session_id: sessionId, usage })
        this.emit('session/update', {
          session_id: sessionId,
          update: { sessionUpdate: 'run_complete', content: payload?.text ?? '' },
        })
        this.resolvePending(sessionId, {
          status: payload?.status ?? 'complete',
          usage,
          text: payload?.text,
          stopReason: payload?.status === 'interrupted' ? 'cancelled' : 'end_turn',
        })
        return
      }

      // ── serve 模式结束事件 ─────────────────────────────────────
      // Hermes 的 serve 运行以 run.completed / run.cancelled / run.failed 收尾，
      // 而非 ACP 的 message.complete。原先这里没有对应 case，结束事件被直接丢弃，
      // 前端永远收不到 run_complete，只能等 90s 兜底才结束（表现为"思考完还转 1 分多钟"）。
      case 'run.completed': {
        const text =
          payload?.output ?? payload?.text ?? payload?.final_response ?? payload?.delta ?? payload?.content ?? ''
        const usage = mapUsage(payload?.usage)
        if (usage) this.emit('usage:prompt-complete', { session_id: sessionId, usage })
        this.emit('session/update', {
          session_id: sessionId,
          update: { sessionUpdate: 'run_complete', content: text },
        })
        this.resolvePending(sessionId, { status: 'complete', usage, text, stopReason: 'end_turn' })
        return
      }
      case 'run.cancelled': {
        const text = payload?.output ?? payload?.text ?? payload?.final_response ?? ''
        this.emit('session/update', {
          session_id: sessionId,
          update: { sessionUpdate: 'run_complete', content: text },
        })
        this.resolvePending(sessionId, { status: 'interrupted', text, stopReason: 'cancelled' })
        return
      }
      case 'run.failed': {
        const err = payload?.error ?? payload?.message ?? '运行失败'
        this.emit('session/update', {
          session_id: sessionId,
          update: { sessionUpdate: 'run_complete', content: '' },
        })
        this.resolvePending(sessionId, { status: 'interrupted', text: '', stopReason: 'cancelled' })
        return
      }

      case 'tool.start':
      case 'tool.generating': {
        const toolId = payload?.tool_id ?? ''
        const name = payload?.name ?? ''
        this.emit(type, { ...base, tool_call_id: toolId, tool_name: name })
        if (type === 'tool.start') {
          this.emit('session/update', {
            session_id: sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: toolId,
              title: name || 'tool',
              kind: toolKindFromName(name),
              rawInput: payload?.args ?? payload?.args_text ?? {},
            },
          })
        }
        return
      }

      case 'tool.progress': {
        const toolId = payload?.tool_id ?? ''
        this.emit('tool.progress', { ...base, tool_call_id: toolId, tool_name: payload?.name ?? '' })
        return
      }

      case 'tool.complete': {
        const toolId = payload?.tool_id ?? ''
        const name = payload?.name ?? ''
        const resultText = typeof payload?.result_text === 'string' ? payload.result_text
          : typeof payload?.result === 'string' ? payload.result
          : payload?.summary ?? ''
        this.emit('tool.complete', { ...base, tool_call_id: toolId, tool_name: name })
        this.emit('session/update', {
          session_id: sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: toolId,
            status: payload?.is_error ? 'failed' : 'completed',
            content: resultText,
          },
        })
        return
      }

      case 'approval.request': {
        const approvalId = `gw-appr-${++this.approvalSeq}`
        this.emit('approval.request', { ...base, tool_name: payload?.pattern_key ?? '', request_id: approvalId })
        this.emit('session/update', {
          session_id: sessionId,
          update: {
            sessionUpdate: 'permission_request',
            toolCallId: approvalId,
            toolName: payload?.pattern_key || payload?.command || 'terminal',
            toolParams: { command: payload?.command ?? '', description: payload?.description ?? '' },
          },
        })
        return
      }

      case 'clarify.request': {
        // Hermes 的 clarify 工具阻塞等待用户输入。官方桌面端收到后渲染
        // ClarifyTool 浮动条，用户回应后发 `clarify.respond` 解锁后端。
        // 之前 Helix 没有此映射 → clarify.request 被静默丢弃 → run 永久挂起
        // （表现为"无浮动条却一直转"）。这里翻译成 ACP session/update，
        // 前端据此弹出 ClarifyDialog 并支持回应。
        const requestId = typeof payload?.request_id === 'string' && payload.request_id
          ? payload.request_id
          : `gw-clarify-${Date.now()}`
        this.emit('session/update', {
          session_id: sessionId,
          update: {
            sessionUpdate: 'clarify_request',
            requestId,
            question: typeof payload?.question === 'string' ? payload.question : (typeof payload?.text === 'string' ? payload.text : ''),
            choices: Array.isArray(payload?.choices) ? payload.choices.filter((c: unknown) => typeof c === 'string') : null,
          },
        })
        return
      }

      case 'session.info':
        this.emit('session.info', base)
        this.emit('session/info', base)
        return

      case 'session.title':
        this.emit('session/title', { session_id: sessionId, title: payload?.title ?? payload?.text ?? '' })
        return

      case 'status.update':
        this.emit('status.update', base)
        return

      case 'error': {
        this.emit('error', { session_id: sessionId, message: payload?.message ?? '未知网关错误' })
        const pp = sessionId ? this.pendingPrompts.get(sessionId) : null
        if (pp && sessionId) {
          this.pendingPrompts.delete(sessionId)
          pp.reject(new Error(payload?.message ?? '网关错误'))
        }
        return
      }

      default:
        // 其余事件（moa.* / subagent.* / skin.changed / review.summary ...）原样直通
        this.emit(type, base)
    }
  }

  // ── ACP 兼容门面方法 ─────────────────────────────────────

  /** ACP send(method, params) → serve RPC 翻译 */
  async send(method: string, params?: any): Promise<any> {
    switch (method) {
      case 'session/new': {
        debug('[ServeGateway] send session/new (modelSynced=', this.modelSynced, ', connected=', this.connected, ')')
        // 建会话前强制同步一次前端模型配置（本客户端生命周期内一次）。
        // 原因：聊天主路径（agent-flow-panel）直接 session/new，不经过
        // use-hermes 的 setHermesModel；而 HERMES_HOME 下 config.yaml 里
        // 可能残留旧 IPC 直写的 provider（如 'agnes-ai'），serve 的模型解析
        // 不认识 → base_url 被丢弃 → agent 构建 30s 超时 → error 事件。
        await this.ensureModelSynced()
        const res = await this.rpc('session.create', {
          cwd: params?.cwd,
          source: 'helix',
        })
        debug('[ServeGateway] ✓ session/new OK →', res?.session_id)
        return res // 已含 session_id，调用点的提取链兼容
      }

      case 'session/resume':
        return this.rpc('session.resume', { session_id: params?.session_id })

      case 'session/list':
        return this.rpc('session.list', { limit: params?.limit ?? 200 })

      case 'session/prompt': {
        const sessionId = String(params?.session_id ?? '')
        if (!sessionId) throw new Error('session/prompt 缺少 session_id')
        const text = promptBlocksToText(params?.prompt)
        // 桥接语义：ack 后挂起，等 message.complete / run.completed 才 resolve（带 usage）
        const done = new Promise<any>((resolve, reject) => {
          // 同一 session 的旧 pending（不应存在）直接顶掉
          const prev = this.pendingPrompts.get(sessionId)
          if (prev) prev.resolve({ status: 'superseded' })
          // 安全网：上游结束事件若丢失或 session_id 错位，done 会永久挂起 →
          // 前端 while 循环卡死在 await waitForItem，按钮永远停在「停止」。
          // 加硬超时（300s）兜底，超时按 interrupted 收尾，前端会用已流式缓冲的结果收尾。
          // 54000 太小会误杀长 agentic 任务（构建/多工具），此处仅用于彻底兜底「零事件」的坏情况。
          const timer = setTimeout(() => {
            const pp = this.pendingPrompts.get(sessionId)
            if (pp) {
              this.pendingPrompts.delete(sessionId)
              pp.resolve({ status: 'interrupted', text: '', stopReason: 'timeout', timedOut: true })
            }
          }, 300000)
          this.pendingPrompts.set(sessionId, {
            resolve: (v: any) => { clearTimeout(timer); resolve(v) },
            reject: (e: any) => { clearTimeout(timer); reject(e) },
          })
        })
        try {
          await this.rpc('prompt.submit', { session_id: sessionId, text })
        } catch (e) {
          this.pendingPrompts.delete(sessionId)
          throw e
        }
        return done
      }

      case 'session/cancel':
      case 'session/interrupt': {
        const sessionId = params?.session_id
        const res = await this.rpc('session.interrupt', { session_id: sessionId })
        // 中断后立刻 resolve pending prompt，避免调用点悬挂
        this.resolvePending(sessionId, { status: 'interrupted', stopReason: 'cancelled' })
        return res
      }

      case 'session/set_mode': {
        // serve 无 set_mode；审批策略拆成 config.set yolo
        const mode = params?.mode_id ?? params?.mode
        if (mode === 'dont_ask' || mode === 'accept_edits') {
          return this.rpc('config.set', { key: 'yolo', value: 'on', scope: 'session', session_id: params?.session_id })
            .catch((e) => { warn('[ServeGateway] config.set yolo 失败:', e); return {} })
        }
        return {}
      }

      case 'session/approve': {
        // FIFO 语义：忽略 toolCallId，按最旧一条解决
        return this.rpc('approval.respond', {
          session_id: params?.session_id,
          choice: params?.approve === false ? 'deny' : 'approve',
        })
      }

      case 'approval/respond': {
        const choice = ((): string => {
          switch (params?.choice) {
            case 'deny': return 'deny'
            case 'always': return 'always'
            case 'session': return 'approve'
            case 'once': default: return 'approve'
          }
        })()
        return this.rpc('approval.respond', { session_id: params?.session_id, choice })
      }

      case 'clarify/respond': {
        // 用户的澄清回答 → 解锁后端阻塞在 clarify.respond 上的 Python 侧。
        // 参数对齐官方桌面端（clarify-tool.tsx:344）：{ request_id, answer }。
        return this.rpc('clarify.respond', {
          session_id: params?.session_id,
          request_id: params?.request_id,
          answer: params?.answer ?? '',
        })
      }

      case 'command/dispatch': {
        const raw = String(params?.command ?? '').replace(/^[\\/]/, '')
        const sp = raw.indexOf(' ')
        const name = sp === -1 ? raw : raw.slice(0, sp)
        const arg = sp === -1 ? '' : raw.slice(sp + 1)
        return this.rpc('command.dispatch', { name, arg, session_id: params?.session_id })
      }

      case 'tools/list': {
        const res = await this.rpc('tools.list', { session_id: params?.session_id })
        // toolsets → 拍平成 ACP 期望的 { tools: [] }
        const tools: any[] = []
        for (const ts of res?.toolsets ?? []) {
          for (const t of ts?.tools ?? []) {
            tools.push(typeof t === 'string' ? { name: t, toolset: ts.name } : { ...t, toolset: ts.name })
          }
        }
        return { tools, toolsets: res?.toolsets ?? [] }
      }

      case 'session.context_breakdown':
      case 'session/context_breakdown':
        return null // 与 acp 模式主进程短路行为一致

      default:
        // 未映射方法：透传（serve 侧同名注册的直接可用）
        return this.rpc(method.replace(/\//g, '.'), params)
    }
  }

  /** ACP notify（无响应通知）→ serve 没有通知语义，转为 fire-and-forget RPC */
  notify(method: string, params?: any): void {
    this.send(method, params).catch((e) => warn('[ServeGateway] notify 失败:', method, e))
  }

  async interrupt(sessionId: string): Promise<any> {
    return this.send('session/interrupt', { session_id: sessionId })
  }

  async status(): Promise<{ connected: boolean }> {
    return { connected: this.connected }
  }

  // ── 模型同步 ──────────────────────────────────────────────

  /** 本客户端实例是否已向后端同步过前端模型配置 */
  private modelSynced = false
  private modelSyncPromise: Promise<void> | null = null

  /**
   * 确保后端模型配置与前端一致（每次 session/new 前都同步）。
   * 注意：绝不能依赖 modelSynced 短路。UI 切换 provider/模型有多个入口
   * （applyProfile 走 pushModelConfig；输入栏走 pushModelConfig；设置页保存走
   * hermes:setConfig，serve 下同样写 config.yaml），一旦某入口没触发 setModel，
   * modelSynced 会停留 true，网关将一直使用旧 config.yaml
   * （如 deepseek+Ling 错配 → 400 无输出）。
   * 因此每次都读取 store 的实时 apiConfig 写回，代价只是一次文件写。
   * 前端没配模型（无 apiConfig）时跳过——尊重后端自己的 config。
   * 同步失败不阻塞建会话：只告警，让后端用现有配置尝试（可能仍能工作）。
   */
  private ensureModelSynced(): Promise<void> {
    if (this.modelSyncPromise) {
      // 防御：若 setModel IPC 异常挂起，10s 后跳过预同步，避免 session/new 永久卡死
      return Promise.race([
        this.modelSyncPromise,
        new Promise<void>((resolve) => {
          setTimeout(() => { warn('[ServeGateway] ensureModelSynced 超时(10s)，跳过模型预同步'); resolve() }, 10000)
        }),
      ])
    }
    this.modelSyncPromise = (async () => {
      try {
        // serve 模式不再有默认端点兜底：只有用户在 UI 里配了有效的 baseUrl+model，
        // 才把模型同步给网关；否则尊重网关自身的 config（不强制任何端点）。
        const { useHelixStore } = await import('@/stores/helix-store')
        const cfg = useHelixStore.getState().apiConfig
        if (cfg?.baseUrl && cfg.model) {
          await this.setModel({
            provider: cfg.provider || 'custom',
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            model: cfg.model,
          })
          debug('[ServeGateway] 建会话前模型预同步完成:', cfg.model, cfg.baseUrl)
        } else {
          debug('[ServeGateway] 无有效模型配置，跳过预同步（尊重网关现有 config）')
        }
      } catch (e) {
        warn('[ServeGateway] 模型预同步失败（不阻塞建会话）:', e)
      } finally {
        this.modelSyncPromise = null
      }
    })()
    return this.modelSyncPromise
  }

  /**
   * 模型配置 → 通过 preload 的 hermes.setModel IPC 写回后端 config.yaml/.env。
   * 不走浏览器直接 fetch /api/model/set：渲染层跑在 localhost:3000，而 serve
   * 网关在 127.0.0.1:<port>，跨域请求会被浏览器 CORS 拦截 → "Failed to fetch"。
   * 走 IPC 是主进程侧发起，无此限制。主进程 hermes:setModel 内部已做 isBadConfig
   * 校验，死端点会被自动回落成 live（ant-ling），从根上杜绝"每次重启变回死配置"。
   * serve 模式下 restartGatewayDebounced 已被守卫短路，写盘后网关在下次
   * session.create 重读 config.yaml，无需重启。
   */
  async setModel(params: { model: string; baseUrl?: string; apiKey?: string; provider?: string }): Promise<any> {
    // 必须直取原始 IPC 桥（window.electron.hermes），绝不能经 getElectronAPI()：
    // serve 模式下它返回门面 Proxy，`.hermes` 会被分流回 routerFacade.setModel →
    // 再次调用本方法 → 无限递归（modelSynced 永不置位，首次 session/new 永久
    // 挂起在 ensureModelSynced，WS 零消息）。这里只需要主进程写 config.yaml
    // （hermes:setModel），serve 模式 restartGatewayDebounced 是 no-op，不会重启网关。
    const hermes = (typeof window !== 'undefined' ? (window as any).electron?.hermes : null) as any
    if (!hermes?.setModel) {
      // 纯浏览器（无 Electron 桥）：没有本地网关可写，静默跳过。
      debug('[ServeGateway] 无 Electron 桥，跳过 setModel（纯浏览器环境）')
      return { skipped: true }
    }
    const res = await hermes.setModel({
      model: params.model,
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      provider: params.baseUrl
        ? (params.provider && params.provider !== 'custom' ? params.provider : 'custom')
        : (params.provider || 'openai'),
    })
    this.modelSynced = true // 显式 setModel 成功后无需再预同步
    return res
  }
}

// ── 单例 + 门面 ────────────────────────────────────────────────────────

let client: ServeGatewayClient | null = null
let initPromise: Promise<ServeGatewayClient | null> | null = null
let routerFacade: any | null = null

export function isServeActive(): boolean {
  return !!client
}

/**
 * 网关模式探测（异步、缓存）。
 * 与 isServeActive 的关键区别：serve 冷启动期间（WS 未连上）isServeActive
 * 为 false，但 getGatewayInfo 从第一秒起就能返回 { mode:'serve', pending:true }。
 * 需要"按模式分流、而不是按连接状态分流"的调用方（如 pushModelConfig）用这个，
 * 避免启动期误落 IPC 链路（IPC setConfig 会直写 config.yaml + 重启网关）。
 */
let modePromise: Promise<'acp' | 'serve'> | null = null
export function getGatewayMode(): Promise<'acp' | 'serve'> {
  if (modePromise) return modePromise
  modePromise = (async () => {
    try {
      if (typeof window === 'undefined') return 'acp'
      const ipc = (window as any).electron?.hermes
      if (!ipc?.getGatewayInfo) return 'acp'
      const info = await ipc.getGatewayInfo()
      return info?.mode === 'serve' ? 'serve' : 'acp'
    } catch {
      return 'acp'
    }
  })()
  return modePromise
}

export function getServeClient(): ServeGatewayClient | null {
  return client
}

/**
 * 常驻路由器门面（与 window.electron.hermes 同形）。
 *
 * 关键设计：门面在**首次访问时立即存在**，不等 serve 握手完成——否则
 * 早期构造的订阅者（如 api-client 的 constructor）会拿到未分流的原始
 * IPC 对象，永久漏掉 WS 事件流。
 * - send/interrupt/status/setModel：先 await 初始化；serve → 网关，acp → 原 IPC
 * - onEvent：IPC 立即订阅（两种模式的 gateway 生命周期事件都来自主进程），
 *   serve 客户端就绪后自动补挂 WS 事件流
 * - 未覆盖方法（setConfig/setYamlKey/listPersonalities/... 配置面）→
 *   透传原 IPC（渐进迁移，任务65 处理）
 */
function buildRouterFacade(ipc: any): any {
  const ensure = () => initServeGateway()
  const overrides: Record<string, any> = {
    send: async (m: string, p?: any) => {
      const c = await ensure()
      return c ? c.send(m, p) : ipc.send(m, p)
    },
    notify: (m: string, p?: any) => {
      ensure()
        .then((c) => { if (c) c.notify(m, p); else ipc.notify?.(m, p) })
        .catch((e) => warn('[ServeGateway] notify 路由失败:', m, e))
    },
    interrupt: async (sid: string) => {
      const c = await ensure()
      return c ? c.interrupt(sid) : ipc.interrupt?.(sid)
    },
    status: async () => {
      const c = await ensure()
      return c ? c.status() : ipc.status()
    },
    setModel: async (p: any) => {
      const c = await ensure()
      if (c) {
        try {
          return await c.setModel(p)
        } catch (e) {
          // 千万不能回落 IPC：IPC setModel 会 restartGatewayDebounced 杀掉
          // 当前 serve 实例（WS 断、端口变、内存会话全灭）——比设置失败破坏大。
          logError('[ServeGateway] REST setModel 失败（不回落 IPC）:', e)
          return { success: false, error: String((e as Error)?.message ?? e) }
        }
      }
      return ipc.setModel?.(p)
    },
    onEvent: (cb: EventCallback) => {
      let cancelled = false
      let unWs: (() => void) | null = null
      let unIpc: (() => void) | null = null
      try { unIpc = ipc.onEvent?.(cb) ?? null } catch { /* noop */ }
      ensure()
        .then((c) => { if (c && !cancelled) unWs = c.onEvent(cb) })
        .catch(() => { /* noop */ })
      return () => {
        cancelled = true
        try { unIpc?.() } catch { /* noop */ }
        try { unWs?.() } catch { /* noop */ }
      }
    },
  }
  return new Proxy(overrides, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return ipc?.[prop]
    },
    has(target, prop: string) {
      return prop in target || (ipc && prop in ipc)
    },
  })
}

/**
 * 返回模式感知门面。Electron + 新 preload（有 getGatewayInfo）时恒返回
 * 路由器（acp 模式内部自动落回 IPC）；旧 preload / 浏览器返回 null。
 */
export function getServeHermesFacade(): any | null {
  if (typeof window === 'undefined') return null
  const ipc = (window as any).electron?.hermes
  if (!ipc?.getGatewayInfo) return null
  if (!routerFacade) routerFacade = buildRouterFacade(ipc)
  return routerFacade
}

/**
 * 幂等初始化（首次 RPC / use-hermes 挂载时触发）。
 * acp 模式立即 resolve null；serve 模式轮询 getGatewayInfo 直到握手完成，然后连 WS。
 */
export function initServeGateway(): Promise<ServeGatewayClient | null> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    if (typeof window === 'undefined') return null
    const ipc = (window as any).electron?.hermes
    if (!ipc?.getGatewayInfo) return null
    try {
      // serve 冷启动最长 90s：pending 时以 2s 间隔轮询
      for (let i = 0; i < 60; i++) {
        const info = await ipc.getGatewayInfo()
        if (!info || info.mode !== 'serve') return null // acp 模式
        if (!info.pending && info.wsUrl && info.baseUrl) {
          client = new ServeGatewayClient(info as any)
          client.connect()
          // 主进程每次 respawn serve 都会推 gateway.serveInfo（新端口）——
          // 订阅它保证网关重启后 WS 自动切到新地址，而不是死磕旧端口
          try {
            ipc.onEvent?.((event: string, params?: any) => {
              if (event === 'gateway.serveInfo' && params) client?.updateInfo(params)
            })
          } catch { /* noop */ }
          debug('[ServeGateway] serve 模式已激活, port=', info.port)
          return client
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
      warn('[ServeGateway] 等待 serve 握手超时（120s），保持 acp 回落')
      return null
    } catch (e) {
      logError('[ServeGateway] 初始化失败:', e)
      return null
    }
  })()
  return initPromise
}
