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
import { installTauriBridge } from '@/lib/tauri-bridge'

// ── PROBE v2: WS 接收层原始字节记录（临时调试，验证后删除）──
// 记录 onmessage 拿到的每个文本事件帧完整字节，用于对比：
//   客户端 onmessage 原始字节 vs state.db 真源 vs IndexedDB 快照
// 判定「serve 写出坏 / 传输层丢 / 客户端内部处理坏」三层归属。
const PROBE_KEY = 'helix-ws-bytes-v2'
function probeWsBytes(data: string): void {
  try {
    for (const line of data.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let obj: any
      try { obj = JSON.parse(trimmed) } catch { continue }
      const t = obj?.params?.type
      if (t !== 'message.delta' && t !== 'message.complete' && t !== 'run.completed' && t !== 'message.start' && t !== 'run.cancelled') continue
      const text = obj?.params?.payload?.text ?? obj?.params?.payload?.output ?? ''
      const sid = obj?.params?.session_id ?? ''
      const rec = { at: Date.now(), kind: t, sid: String(sid).slice(-6), len: typeof text === 'string' ? text.length : -1, body: typeof text === 'string' ? text : null }
      let buf: any[] = []
      try { const b = JSON.parse(localStorage.getItem(PROBE_KEY) || '[]'); if (Array.isArray(b)) buf = b } catch { buf = [] }
      buf.push(rec)
      if (buf.length > 400) buf.splice(0, buf.length - 400)
      try { localStorage.setItem(PROBE_KEY, JSON.stringify(buf)) } catch { buf.splice(0, Math.floor(buf.length / 2)); try { localStorage.setItem(PROBE_KEY, JSON.stringify(buf)) } catch { /* noop */ } }
    }
  } catch { /* noop */ }
}

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
    totalTokens: num(u, 'totalTokens', 'total_tokens', 'total'),
    inputTokens: num(u, 'inputTokens', 'input_tokens', 'prompt_tokens', 'input', 'prompt'),
    outputTokens: num(u, 'outputTokens', 'output_tokens', 'completion_tokens', 'output', 'completion'),
    thoughtTokens: num(u, 'thoughtTokens', 'thought_tokens', 'reasoning_tokens', 'reasoning'),
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
 * 归一化用于判重比较（与 agent-flow-panel.normalizeForCompare 等价：去空白+标点+小写）。
 * Hermes 全文重发时经常带微小差异（"CLI和配置" vs "CLI 和配置"），不归一化直接比会判为不同。
 */
function normText(s: string): string {
  return s.replace(/[\s\p{P}]/gu, '').toLowerCase()
}

/**
 * 权威全文自愈判定：权威版（session.resume / state.db 同源，字节完好）是否覆盖事件版。
 * 内容一致性看归一化（去空白+标点+小写：相等 / 包含 / 被包含），长度保护看**原始字节**：
 * 权威版不显著短于事件版（≥90%）才覆盖——坏文本只是丢空白（字节略短 ~1-3%），
 * 截断/中断版则明显短（≥10%），拒绝覆盖防截断吞全文。仅替换为原文，不猜补空格，
 * 绝不会改坏正常文本。
 */
function authoritativeOverrides(authoritative: string, eventText: string): boolean {
  const na = normText(authoritative)
  const ne = normText(eventText)
  if (!na || !ne) return false
  if (!(na === ne || na.includes(ne) || ne.includes(na))) return false
  return authoritative.length >= eventText.length * 0.9
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

// Hermes ships the terminal-styled inline diff with ANSI SGR codes around every
// line (see agent/display.py _render_inline_unified_diff). Strip them so the
// renderer can consume plain text.
function stripAnsi(s: unknown): string {
  if (typeof s !== 'string') return ''
  return s.replace(/\u001b\[[0-9;]*m/g, '')
}

// ── 网关客户端 ──────────────────────────────────────────────────────────

const RPC_TIMEOUT_MS = 60_000
const RECONNECT_DELAYS = [1000, 2000, 5000, 10_000]

export class ServeGatewayClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<string | number, PendingRpc>()
  /** Sessions with an in-flight prompt (ack-only model): tracked solely so a WS
   *  reconnect can session.resume them to restore the event stream. */
  private inflightSessions = new Set<string>()
  private listeners = new Set<EventCallback>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private approvalSeq = 0
  /** 等待 WS 首次 OPEN 的挂起者（修 CONNECTING 窗口内 rpc 被误拒的竞态） */
  private openWaiters: Array<() => void> = []
  /** 已把哪个阻塞式输入请求（clarify/sudo/secret）映射为 clarify_request 浮条。
   *  值为此请求解锁后端需调用的 RPC 方法名（clarify.respond / sudo.respond /
   *  secret.respond）。前端回应经 clarify/respond 到达时据此路由。 */
  private inputRoutes = new Map<string, 'clarify.respond' | 'sudo.respond' | 'secret.respond'>()

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
        this.resumeInflightSessions()
        this.emit('gateway.reconnected', {})
        // gateway.ready 由服务端主动推，不在这里合成
      }

      ws.onmessage = (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : ''
        probeWsBytes(data) // PROBE: 接收层原始字节
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

  /** 全部失败（客户端销毁等确定性终止路径）。ack-only 模型下 prompt 已即时 ack，
   *  无挂起 Promise 可 reject；只需清掉 in-flight 追踪。监听者已随销毁移除，无需 emit。 */
  private failAllPending(err: Error): void {
    this.failPendingRpcs(err)
    this.inflightSessions.clear()
  }

  /**
   * 重连后恢复断连期间仍在运行的会话（对齐官方桌面端）。
   * WS 断开时 Hermes 把会话 detach 到 drop sentinel 继续执行；重连后必须
   * session.resume 把 transport 重绑回会话，事件流才恢复。对每个 in-flight 会话：
   * - running=true  → 会话仍在跑，transport 已重绑，后续 run.completed 事件正常到达
   * - running=false → 断连期间已跑完（run.completed 发往 drop sink 丢失），用返回的
   *                   messages 兜底正文，合成 run_complete 事件交给前端
   * - resume 报错   → 会话已不可恢复（网关重启/reap），合成空 run_complete 让前端收尾，
   *                   否则前端循环会挂起（ack-only 下没有挂起 Promise 可 reject）
   */
  private resumeInflightSessions(): void {
    const sessionIds = [...this.inflightSessions]
    if (sessionIds.length === 0) return
    debug('[ServeGateway] 重连成功，resume 断连前在跑的会话:', sessionIds)
    const finish = (sessionId: string, text: string) => {
      this.inflightSessions.delete(sessionId)
      this.emit('session/update', {
        session_id: sessionId,
        update: { sessionUpdate: 'run_complete', content: text },
      })
    }
    for (const sessionId of sessionIds) {
      this.rpc('session.resume', { session_id: sessionId }, 20_000)
        .then((res: any) => {
          if (!this.inflightSessions.has(sessionId)) return
          if (res?.running) {
            debug('[ServeGateway] 会话仍在运行，等待事件流恢复:', sessionId)
            return
          }
          finish(sessionId, lastAssistantText(res?.messages))
        })
        .catch((e: Error) => {
          debug('[ServeGateway] 会话恢复失败，合成结束事件:', sessionId, e?.message)
          finish(sessionId, '')
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
        if (msg.error) {
          // "session not found" 等 RPC 错误：防御性兜底。正常并发下后端不挤
          // 会话，但网关重启/会话被回收时旧 id 会失效，这里 warn 后正常 reject，
          // 调用方（session/prompt 的 catch）会自动重建会话并重放 prompt。
          const errMsg = msg.error.message || 'RPC 错误'
          if (/session.*not.*found|not found/i.test(errMsg)) {
            warn('[ServeGateway] RPC session 错误:', errMsg)
          }
          p.reject(new Error(errMsg))
        } else {
          p.resolve(msg.result)
        }
      }
      return
    }
    // 事件帧
    if (msg && msg.method === 'event' && msg.params) {
      const { type, session_id: sessionId, payload } = msg.params
      this.translateEvent(String(type || ''), sessionId, payload ?? {})
    }
  }

  /** 完成事件（run.completed/cancelled/failed/message.complete）到达时把该会话从
   *  in-flight 集合移除。ack-only 模型下完成由 translateEvent 发出的 run_complete 事件
   *  驱动，这里只做清理——不再有挂起 Promise 要 resolve。 */
  private resolvePending(sessionId: string | undefined, _result?: any): void {
    if (sessionId) this.inflightSessions.delete(sessionId)
  }

  // ── 事件翻译：serve 原生 → 原生直通 + ACP 合成双发 ─────────

  private translateEvent(type: string, sessionId: string | undefined, payload: any): void {
    const base = { session_id: sessionId, ...payload }
    // ── 并发串台诊断日志（临时）：记录事件帧所属 sid ──
    if (type === 'message.start' || type === 'message.delta' || type === 'message.complete'
        || type === 'run.completed' || type === 'run.cancelled' || type === 'run.failed') {
      console.log('[ServeEvent]', JSON.stringify({ type, sid: sessionId }))
    }

    switch (type) {
      case 'gateway.ready':
        this.emit('gateway.ready', base)
        return

      case 'message.start':
        this.emit('message.start', base)
        return

      case 'message.delta':
      case 'message.interim': {
        // message.interim = the agent's interim commentary (text alongside tool
        // calls, or the attempted final answer before a verify-on-stop nudge).
        // The official gateway finalizes it as its own sealed bubble so
        // message.complete doesn't wipe the already-streamed deltas. Helix's
        // renderer accumulates every text delta into one in-progress message,
        // so interim comments are surfaced the same way as message.delta — the
        // text streams in and the authoritative run_complete still finalizes it.
        //
        // CRITICAL dedup: the backend sets `already_streamed=true` when this
        // interim text has ALREADY been rendered via message.delta for the same
        // message (see agent/codex_runtime.py: "The gateway's already_streamed
        // check dedupes against any text the stream-delta callback already
        // rendered for the same message"). Blindly appending it as another
        // agent_message_chunk makes the same paragraph render TWICE — the
        // "内容重复两次" bug. Skip the injection for already-streamed text;
        // only surface interim comments that never flowed through delta
        // (already_streamed=false).
        const alreadyStreamed = payload?.already_streamed === true
        this.emit(type, base)
        const text = payload?.text ?? ''
        if (text && !alreadyStreamed) {
          this.emit('session/update', {
            session_id: sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: text },
          })
        }
        return
      }

      case 'reasoning.delta': {
        const text = payload?.text ?? ''
        this.emit('reasoning.delta', base)
        if (text) {
          this.emit('session/update', {
            session_id: sessionId,
            update: { sessionUpdate: 'agent_thought_chunk', content: text },
          })
        }
        return
      }

      case 'reasoning.available': {
        // 官方语义：带 replace 的最终推理正文（一次性完整段，替换而非追加）。
        // 前端月面已有的 agent_thought_chunk 分支按 "完整文本是否为已缓冲超集"
        // 自动判别追加/替换（isCumulative），因此把完整富文本也注入该流即可，
        // 无需额外 replace 标记。此前只 emit 原生事件，前端 default 丢弃 → 最终推理丢失。
        const text = payload?.text ?? ''
        this.emit('reasoning.available', base)
        if (text) {
          this.emit('session/update', {
            session_id: sessionId,
            update: { sessionUpdate: 'agent_thought_chunk', content: text },
          })
        }
        return
      }

      case 'thinking.delta':
        // 官方语义：thinking.delta 携带的是 kawaii 旋转指示状态（face + verb），
        // 并非真实推理。官方桌面端明确忽略它，避免在推理折页上方出现重复的
        // "Thinking" 指示器。Helix 与官方对齐——只透传原生产，不再把它当作
        // 思考内容注入 agent_thought_chunk 流（否则会把 spinner 文案当文本渲染）。
        this.emit('thinking.delta', base)
        return

      case 'message.complete': {
        const usage = mapUsage(payload?.usage)
        // Official protocol carries the final text in payload.text with
        // payload.rendered as a rendered-fallback — accept both like the
        // official frontend (coerceGatewayText(payload.text) || rendered).
        const text = payload?.text ?? payload?.rendered ?? ''
        // 先发原生 + usage 事件，再 resolve pending prompt（顺序与 ACP 主进程一致）
        this.emit('message.complete', base)
        if (usage) this.emit('usage:prompt-complete', { session_id: sessionId, usage })
        // 权威全文自愈（与 run.completed 同模式）：事件正文可能携带流式链损坏，
        // 用 session.resume 拉权威正文（state.db 同源）归一化判定后覆盖。
        const emitComplete = (content: string) => {
          this.emit('session/update', {
            session_id: sessionId,
            update: { sessionUpdate: 'run_complete', content },
          })
          this.resolvePending(sessionId, {
            status: payload?.status ?? 'complete',
            usage,
            text: content,
            stopReason: payload?.status === 'interrupted' ? 'cancelled' : 'end_turn',
          })
        }
        if (sessionId && text) {
          this.rpc('session.resume', { session_id: sessionId }, 5_000)
            .then((res: any) => {
              const authoritative = lastAssistantText(res?.messages)
              if (authoritative && authoritative.trim() && authoritativeOverrides(authoritative, text)) {
                debug('[ServeGateway] message.complete 权威全文覆盖事件文本:', text.length, '→', authoritative.length)
                emitComplete(authoritative)
              } else {
                emitComplete(text)
              }
            })
            .catch(() => emitComplete(text))
        } else {
          emitComplete(text)
        }
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
        // 权威全文自愈（观测案例 absent/corrupt）：事件 payload 的最终文本可能携带
        // 流式链损坏（"##当前实时验证\n\n" 黏成 "##当前实时验证"），而前端 done 分支的
        // 归一化覆盖依赖 done 事件自带正文——它没到/也坏时自愈不触发。这里用
        // session.resume 从网关拉一次权威正文（与 state.db 持久化同源，字节完好），
        // authoritativeOverrides 判定后以权威为准。resume 对已结束会话是幂等只读
        // 操作（同 resumeInflightSessions 模式）；本地网关 RPC 通常 <50ms，前端有
        // 90s 兜底不受延迟影响，失败时回退事件版。
        const emitComplete = (content: string) => {
          this.emit('session/update', {
            session_id: sessionId,
            update: { sessionUpdate: 'run_complete', content },
          })
          this.resolvePending(sessionId, { status: 'complete', usage, text: content, stopReason: 'end_turn' })
        }
        if (sessionId && text) {
          this.rpc('session.resume', { session_id: sessionId }, 5_000)
            .then((res: any) => {
              const authoritative = lastAssistantText(res?.messages)
              if (authoritative && authoritative.trim() && authoritativeOverrides(authoritative, text)) {
                debug('[ServeGateway] run.completed 权威全文覆盖事件文本:', text.length, '→', authoritative.length)
                emitComplete(authoritative)
              } else {
                emitComplete(text)
              }
            })
            .catch(() => emitComplete(text))
        } else {
          emitComplete(text)
        }
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
              // Hermes `tool.start` never carries raw `args` — only a
              // display `context` preview (e.g. "foo.ts 1-50" for read_file,
              // a summarized command for terminal). Fall back to it so the
              // frontend can show what the tool actually operated on.
              rawInput: payload?.args ?? payload?.args_text ?? (payload?.context ? { context: payload.context } : {}),
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
        const inlineDiff = stripAnsi(payload?.inline_diff)
        this.emit('tool.complete', { ...base, tool_call_id: toolId, tool_name: name, inline_diff: inlineDiff })
        this.emit('session/update', {
          session_id: sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: toolId,
            status: payload?.is_error ? 'failed' : 'completed',
            content: resultText,
            inlineDiff,
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
            toolParams: {
              command: payload?.command ?? '',
              description: payload?.description ?? '',
              // 前端审批分流用：pattern_key 区分危险命令/插件规则，reason 是后端解释，
              // choices/smart_denied 供审批条渲染可选项（once/session/always/deny）。
              pattern_key: payload?.pattern_key ?? '',
              reason: payload?.reason ?? payload?.description ?? '',
              choices: Array.isArray(payload?.choices) ? payload.choices : null,
              smart_denied: !!payload?.smart_denied,
            },
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
        this.inputRoutes.set(requestId, 'clarify.respond')
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

      // sudo.request / secret.request — 模型阻塞等待密码/密钥输入（terminal
      // sudo 提权、skills 凭据）。官方桌面端各自弹独立输入框（sudo.respond
      // /secret.respond）。Helix 无专用输入框，复用 clarify_request 浮条
      // （可自由文本/选择 + 回应），问题文案带上上下文；respond 时按
      // respondMethod 路由到 sudo.respond / secret.respond 解锁后端。
      case 'sudo.request':
      case 'secret.request': {
        const requestId = typeof payload?.request_id === 'string' && payload.request_id
          ? payload.request_id
          : `gw-${type}-${Date.now()}`
        const isSudo = type === 'sudo.request'
        const envVar = typeof payload?.env_var === 'string' ? payload.env_var : ''
        const promptText = typeof payload?.prompt === 'string' ? payload.prompt : ''
        const question = isSudo
          ? '需要 sudo 密码才能继续执行该命令，请在下方输入密码。'
          : (promptText || `需要 ${envVar || '环境变量'} 密钥才能继续执行技能，请在下方输入。`)
        this.emit(type, base)
        this.inputRoutes.set(requestId, isSudo ? 'sudo.respond' : 'secret.respond')
        this.emit('session/update', {
          session_id: sessionId,
          update: {
            sessionUpdate: 'clarify_request',
            requestId,
            respondMethod: isSudo ? 'sudo/' : 'secret/',
            question,
            choices: null,
          },
        })
        return
      }

      case 'background.complete':
        // Informational: 后台（非活跃）会话的远端 turn 已结束。Helix 前端
        // 只渲染活跃会话流，此事件原样透传（default 分支兜底），不注入正文。
        this.emit(type, base)
        return

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
        // error 事件本身已 emit（前端 error→queueDone 收尾）。ack-only 下无挂起 Promise，只清理 in-flight。
        if (sessionId) this.inflightSessions.delete(sessionId)
        return
      }

      default:
        // 其余事件（moa.* / subagent.* / skin.changed / review.summary ...）原样直通
        this.emit(type, base)
    }
  }

  // ── ACP 兼容门面方法 ─────────────────────────────────────

  /**
   * 建会话（session/new 与「session not found 自动重试」共用）。
   * 后端 serve 网关按会话独立管理（session.create 纯新增，不挤旧会话；
   * 会话并发上限由 max_concurrent_sessions 控制，默认无限制）。因此创建
   * 新会话**不驱逐**其他 in-flight 会话——多对话并行时各自保持独立的
   * 事件流，由前端按 session_id 过滤路由（agent-flow-panel.tsx 的
   * "true-concurrency" 设计）。断连重连后 resumeInflightSessions 会逐个
   * 恢复所有 in-flight 会话的事件流。
   */
  private async createSession(params?: any): Promise<any> {
    await this.ensureModelSynced()
    // 常规「增强 Find 和 Grep」：显式传入的 search_engine 优先（'' = 用默认
    // 引擎），未传时（如「session not found」自动重建路径）回退到当前设置值。
    let searchEngine = params?.search_engine
    if (searchEngine === undefined) {
      const { useHelixStore } = await import('@/stores/helix-store')
      searchEngine = useHelixStore.getState().enhancedFindGrep ? 'rg' : ''
    }
    // 常规「集成终端 Shell」：仅新会话生效（未传时回退到当前设置值）。
    let terminalShell = params?.terminal_shell
    if (terminalShell === undefined) {
      const { useHelixStore } = await import('@/stores/helix-store')
      terminalShell = useHelixStore.getState().terminalShell
    }
    const res = await this.rpc('session.create', {
      source: 'helix',
      // serve 模式的工作目录是 per-session 的（见 main.rs setWorkDir 注释：
      // "serve mode: cwd applied per-session via explicit_cwd"）。前端选中的项目
      // 必须随 session.create 传给后端，否则会话 cwd 落到配置/TERMINAL_CWD/
      // 启动目录，模型读到的目录和界面显示的项目脱节。
      ...(params?.cwd ? { cwd: params.cwd } : {}),
      ...(searchEngine ? { search_engine: searchEngine } : {}),
      ...(terminalShell ? { terminal_shell: terminalShell } : {}),
    })
    return res
  }

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
        const res = await this.createSession(params)
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
        // 官方语义：prompt.submit 只回 ack（{"status":"streaming"}），真正的回复走事件流
        // （message.delta → … → run.completed）。这里不再挂起 Promise、不再设超时——完成
        // 由 run.completed/cancelled/failed 事件驱动（translateEvent 发 run_complete 事件，
        // agent-flow-panel 据此收尾）。只把 session 记为 in-flight，供 WS 断连重连后
        // session.resume 恢复事件流（见 resumeInflightSessions）。
        try {
          // ── 并发串台诊断日志（临时） ──
          console.log('[ServePrompt]', JSON.stringify({ sid: sessionId, text: text.slice(0, 50) }))
          await this.rpc('prompt.submit', { session_id: sessionId, text })
        } catch (err) {
          // "session not found" 的自动恢复兜底（对齐主进程 ACP 路径）。正常
          // 并发下后端不挤会话，但网关重启/会话回收会让旧 id 失效。这里自动
          // 重建会话并重放 prompt，尽力让该对话也跑完；返回新 session_id 让
          // 前端把 conversation→session 映射改绑。
          const msg = (err as Error)?.message || ''
          if (/session.*not.*found|not found|no such session|unknown session/i.test(msg)) {
            warn('[ServeGateway] session not found on prompt — recreating session and retrying')
            const res = await this.createSession({})
            const newId = res?.session_id
            if (newId) {
              debug('[ServeGateway] recreated session for retry:', newId)
              this.emit('gateway.sessionReplaced', { oldId: sessionId, newId })
              await this.rpc('prompt.submit', { session_id: newId, text })
              this.inflightSessions.add(newId)
              return { status: 'streaming', session_id: newId }
            }
          }
          throw err
        }
        this.inflightSessions.add(sessionId)
        return { status: 'streaming' }
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
        // serve 无 set_mode；审批策略拆成 config.set yolo。
        // 语义（审批分流版）：
        // - dont_ask（完全访问权限）→ yolo on：后端不发 approval.request，全部自动批。
        // - default / accept_edits（请求批准 / 替我审批）→ yolo off：后端发 approval.request，
        //   前端 classifyApproval 分流——项目内文件修改自动批，危险命令/项目外文件/敏感文件/
        //   上传外发弹窗。分流只在 yolo off 时才有物可分。
        const mode = params?.mode_id ?? params?.mode
        if (mode === 'dont_ask') {
          return this.rpc('config.set', { key: 'yolo', value: 'on', scope: 'session', session_id: params?.session_id })
            .catch((e) => { warn('[ServeGateway] config.set yolo 失败:', e); return {} })
        }
        // yolo off：确保默认/替我审批模式下后端会发审批请求。
        return this.rpc('config.set', { key: 'yolo', value: 'off', scope: 'session', session_id: params?.session_id })
          .catch((e) => { warn('[ServeGateway] config.set yolo(off) 失败:', e); return {} })
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
        // sudo.request / secret.request 也复用该浮条；其 request_id 已登记在
        // inputRoutes，此处路由到 sudo.respond / secret.respond 解锁对应端点。
        const rid = params?.request_id
        const route = typeof rid === 'string' ? this.inputRoutes.get(rid) : undefined
        if (route && route !== 'clarify.respond') {
          this.inputRoutes.delete(rid)
          return this.rpc(route, {
            session_id: params?.session_id,
            request_id: rid,
            ...(route === 'sudo.respond' ? { password: params?.answer ?? '' } : { value: params?.answer ?? '' }),
          })
        }
        if (typeof rid === 'string') this.inputRoutes.delete(rid)
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

      default:
        // 未映射方法：透传（serve 侧同名注册的直接可用）。
        // session.context_breakdown 由 tui_gateway/methods_session.py 实现，
        // 不再短路，直接透传给后端取真实分类占比。
        return this.rpc(method.replace(/\//g, '.'), params)
    }
  }

  /** ACP notify（无响应通知）→ serve 没有通知语义，转为 fire-and-forget RPC */
  notify(method: string, params?: any): void {
    this.send(method, params).catch((e) => {
      // session/cancel on a run that already finished is a benign race (the
      // session is gone server-side); don't log it as a scary failure.
      const msg = String((e as Error)?.message ?? e)
      if (method === 'session/cancel' && /not found/i.test(msg)) return
      warn('[ServeGateway] notify 失败:', method, e)
    })
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
      installTauriBridge() // 惰性桥：先装再读，避免误判 acp
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
  // 确保 Tauri invoke 桥已装好（window.electron 是惰性安装的）。若模块加载
  // 顺序导致本函数先于任何 isElectron()/installTauriBridge() 执行，直接读
  // window.electron 会拿到 undefined → 错误地走 acp/null 分支。
  installTauriBridge()
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
    // 惰性桥竞态修复：window.electron 由 installTauriBridge() 惰性安装。
    // 若 use-hermes 的 useEffect 先于任何 isElectron() 触发 initServeGateway，
    // 直接读 window.electron 会得到 undefined → 提前 return null 且被
    // initPromise 永久缓存 → 之后桥装好也不重试 → serve 网关永不连接。
    // 这里先强制装桥（幂等），保证下面能读到 getGatewayInfo。
    installTauriBridge()
    const ipc = (window as any).electron?.hermes
    if (!ipc?.getGatewayInfo) return null
    try {
      // serve 冷启动最长 90s：pending 时以 2s 间隔轮询
      for (let i = 0; i < 60; i++) {
        const info = await ipc.getGatewayInfo()
        if (!info || info.mode !== 'serve') {
          return null // acp 模式
        }
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
