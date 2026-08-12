/**
 * Conversation Worker — runs ONE Hermes serve conversation in an isolated JS
 * context (own V8 heap, own event loop). The main thread creates one Worker
 * per conversation tab; they never share state.
 *
 * The Worker connects directly to the Hermes serve WS gateway (no Electron
 * IPC needed) and handles:
 *  - session.create / prompt.submit / session.interrupt (JSON-RPC over WS)
 *  - Event parsing (session/update → text / thinking / tool_call / done)
 *  - Text + thinking + steps accumulation
 *  - Throttled state snapshots back to the main thread via postMessage
 *
 * Main thread → Worker messages:
 *   { type:'init', wsUrl:string, cwd:string }
 *   { type:'prompt', text:string }
 *   { type:'stop' }
 *   { type:'terminate' }
 *
 * Worker → main thread messages (throttled at ~20fps):
 *   { type:'ready', hermesSessionId:string }
 *   { type:'snapshot', textBuffer, thoughtBuffer, responseBlocks, steps, isRunning, thinkingStatus, toolLabel }
 *   { type:'done', finalText, usage }
 *   { type:'error', message }
 *   { type:'connection', state:'connected'|'disconnected' }
 */

// ── Types ────────────────────────────────────────────────────────────────

interface PendingRpc { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }
interface ToolStep {
  id: string
  type: 'tool_call'
  toolName: string
  toolKind: string
  content: string
  status: 'running' | 'completed' | 'failed'
  toolParams?: Record<string, unknown>
  toolCallId?: string
}
type ResponseBlock =
  | { type: 'thinking'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_group'; steps: ToolStep[] }
  | { type: 'done'; content: string }
  | { type: 'error'; content: string }

// ── State ────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null
let nextRpcId = 1
const pendingRpcs = new Map<number, PendingRpc>()
let hermesSessionId: string | null = null
let running = false
let seq = 0

// Accumulators
let textBuffer = ''
let thoughtBuffer = ''
let responseBlocks: ResponseBlock[] = []
let currentToolSteps: ToolStep[] = []
let thinkingStatus = ''
let toolLabel = ''

// Throttled snapshot
let dirty = false
let postTimer: ReturnType<typeof setTimeout> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

// ── RPC over WS ──────────────────────────────────────────────────────────

function rpc(method: string, params?: any, timeoutMs = 60_000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('WS not connected'))
      return
    }
    const id = nextRpcId++
    const timer = setTimeout(() => {
      pendingRpcs.delete(id)
      reject(new Error(`RPC timeout: ${method}`))
    }, timeoutMs)
    pendingRpcs.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

function notify(method: string, params?: any) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }
}

// ── Snapshot posting (throttled) ─────────────────────────────────────────

function markDirty() {
  dirty = true
  if (!postTimer) {
    postTimer = setTimeout(flushPost, 50)
  }
}

function flushPost() {
  postTimer = null
  if (!dirty) return
  dirty = false
  ;(postMessage as any)({
    type: 'snapshot',
    textBuffer,
    thoughtBuffer,
    responseBlocks: [...responseBlocks],
    steps: currentToolSteps.slice(),
    isRunning: running,
    thinkingStatus,
    toolLabel,
  })
}

// ── Idle timer (synthDone equivalent) ─────────────────────────────────────

function resetIdle(ms: number) {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (running) {
      finishRun('idle timeout')
    }
  }, ms)
}
function clearIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
}

// ── Run lifecycle ────────────────────────────────────────────────────────

function startRun() {
  running = true
  textBuffer = ''
  thoughtBuffer = ''
  responseBlocks = []
  currentToolSteps = []
  thinkingStatus = ''
  toolLabel = ''
  markDirty()
  resetIdle(120_000) // 2-minute idle fallback
}

function finishRun(reason: string) {
  clearIdle()
  running = false
  // Push a final done block so the UI knows the turn ended
  responseBlocks = [...responseBlocks, { type: 'done', content: textBuffer }]
  markDirty()
  ;(postMessage as any)({
    type: 'done',
    finalText: textBuffer,
    reason,
  })
}

function failRun(message: string) {
  clearIdle()
  running = false
  responseBlocks = [...responseBlocks, { type: 'error', content: message }]
  markDirty()
  ;(postMessage as any)({ type: 'error', message })
}

// ── Event handling ───────────────────────────────────────────────────────

function handleEvent(method: string, params: any) {
  // RPC response
  if (params?.id !== undefined && pendingRpcs.has(params.id)) {
    const p = pendingRpcs.get(params.id)!
    pendingRpcs.delete(params.id)
    clearTimeout(p.timer)
    if (params.error) p.reject(new Error(params.error?.message || 'RPC error'))
    else p.resolve(params.result)
    return
  }

  // JSON-RPC response (has `id` at top level)
  const rawMsg = params
  if (rawMsg?.id !== undefined && pendingRpcs.has(rawMsg.id)) {
    const p = pendingRpcs.get(rawMsg.id)!
    pendingRpcs.delete(rawMsg.id)
    clearTimeout(p.timer)
    if (rawMsg.error) p.reject(new Error(rawMsg.error?.message || 'RPC error'))
    else p.resolve(rawMsg.result)
    return
  }

  // Event notification
  const sessionId = params?.session_id
  // Only process events for OUR session (if we have one)
  if (hermesSessionId && sessionId && sessionId !== hermesSessionId) return

  const payload = params?.payload ?? params

  switch (method) {
    case 'session/update':
    case 'session_update': {
      const u = params?.update ?? payload?.update ?? payload
      const su = u?.sessionUpdate ?? u?.type
      handleSessionUpdate(su, u, method)
      break
    }
    case 'usage:prompt-complete':
    case 'usage_prompt_complete': {
      // Token usage — pass through to main thread
      ;(postMessage as any)({ type: 'usage', usage: payload?.usage ?? params?.usage })
      break
    }
    case 'run.completed':
    case 'run_completed': {
      if (running) finishRun('completed')
      break
    }
    case 'run.cancelled':
    case 'run_cancelled': {
      if (running) finishRun('cancelled')
      break
    }
    case 'run.failed':
    case 'run_failed': {
      if (running) {
        const err = payload?.error?.message || payload?.message || '运行失败'
        failRun(err)
      }
      break
    }
    case 'message.complete':
    case 'message_complete': {
      if (running) finishRun('message.complete')
      break
    }
    case 'gateway.ready': {
      ;(postMessage as any)({ type: 'connection', state: 'connected' })
      break
    }
    case 'gateway.disconnected': {
      ;(postMessage as any)({ type: 'connection', state: 'disconnected' })
      break
    }
    case 'error': {
      const msg = payload?.message || params?.message || '未知错误'
      if (running) failRun(msg)
      else (postMessage as any)({ type: 'error', message: msg })
      break
    }
    default:
      // Other events (tool.start, tool.generating, tool.complete, etc.) —
      // they're also delivered as session/update in serve mode
      break
  }
}

function handleSessionUpdate(su: string, u: any, _method: string) {
  if (!running) return

  switch (su) {
    case 'agent_message_chunk': {
      const text = u?.content ?? ''
      if (text) {
        // Flush any pending tool steps first
        flushToolSteps()
        // Flush any pending thinking
        flushThinking()
        textBuffer += text
        // Update or append a text block
        const last = responseBlocks[responseBlocks.length - 1]
        if (last && last.type === 'text') {
          responseBlocks = [...responseBlocks.slice(0, -1), { type: 'text', content: textBuffer }]
        } else {
          responseBlocks = [...responseBlocks, { type: 'text', content: textBuffer }]
        }
        thinkingStatus = ''
        toolLabel = ''
        resetIdle(8_000)
        markDirty()
      }
      break
    }
    case 'agent_thought_chunk': {
      const text = u?.content ?? ''
      if (text) {
        thoughtBuffer += text
        thinkingStatus = '思考中...'
        toolLabel = ''
        resetIdle(8_000)
        markDirty()
      }
      break
    }
    case 'tool_call': {
      flushThinking()
      flushText()
      const title = u?.title || u?.name || 'tool'
      const kind = u?.kind || ''
      const toolCallId = u?.toolCallId || ''
      let args = u?.rawInput
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { /* keep raw */ } }
      const step: ToolStep = {
        id: `step-${++seq}`,
        type: 'tool_call',
        toolName: title,
        toolKind: typeof kind === 'string' ? kind : '',
        content: title,
        status: 'running',
        toolParams: (args && typeof args === 'object') ? args : { raw: args },
        toolCallId,
      }
      currentToolSteps = [...currentToolSteps, step]
      // Push/update tool_group block
      if (responseBlocks.length > 0 && responseBlocks[responseBlocks.length - 1].type === 'tool_group') {
        responseBlocks = [
          ...responseBlocks.slice(0, -1),
          { type: 'tool_group', steps: currentToolSteps },
        ]
      } else {
        responseBlocks = [...responseBlocks, { type: 'tool_group', steps: currentToolSteps }]
      }
      toolLabel = title
      thinkingStatus = ''
      resetIdle(15_000)
      markDirty()
      break
    }
    case 'tool_call_chunk':
    case 'tool_call_update': {
      const tcId = u?.toolCallId
      const status = u?.status
      const content = u?.content ?? ''
      if (tcId) {
        currentToolSteps = currentToolSteps.map(s =>
          s.toolCallId === tcId
            ? { ...s, status: (status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : s.status) as any, content: content || s.content }
            : s
        )
        // Update the tool_group block
        if (responseBlocks.length > 0 && responseBlocks[responseBlocks.length - 1].type === 'tool_group') {
          responseBlocks = [
            ...responseBlocks.slice(0, -1),
            { type: 'tool_group', steps: currentToolSteps },
          ]
        }
      }
      resetIdle(15_000)
      markDirty()
      break
    }
    case 'run_complete':
    case 'run_complete_': {
      if (running) finishRun('run_complete')
      break
    }
    case 'permission_request': {
      // Pass through to main thread for approval UI
      ;(postMessage as any)({ type: 'approval', data: u })
      break
    }
    default:
      // Other session updates (usage_update, session_info_update, etc.)
      // Pass usage_update through
      if (su === 'usage_update') {
        ;(postMessage as any)({ type: 'context_usage', size: u?.size, used: u?.used })
      }
      break
  }
}

function flushThinking() {
  if (thoughtBuffer.trim()) {
    responseBlocks = [...responseBlocks, { type: 'thinking', content: thoughtBuffer }]
    thoughtBuffer = ''
  }
}

function flushText() {
  // Text is accumulated in textBuffer and already in a text block;
  // nothing extra to flush — the text block IS the live buffer.
}

function flushToolSteps() {
  // Tool steps are kept in currentToolSteps and pushed as tool_group blocks
  // already. When text arrives after tools, start a fresh tool group for the
  // next tool call.
  if (currentToolSteps.length > 0) {
    currentToolSteps = [] // next tool_call starts a new group
  }
}

// ── WS message handler ───────────────────────────────────────────────────

function handleWSMessage(ev: MessageEvent) {
  const raw = typeof ev.data === 'string' ? ev.data : ''
  if (!raw) return

  // Serve gateway sends newline-delixed JSON-RPC
  const lines = raw.split('\n').filter(Boolean)
  for (const line of lines) {
    let msg: any
    try { msg = JSON.parse(line) } catch { continue }

    // RPC response (has `id` and no `method`)
    if (msg.id !== undefined && !msg.method) {
      const p = pendingRpcs.get(msg.id)
      if (p) {
        pendingRpcs.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error?.message || 'RPC error'))
        else p.resolve(msg.result)
      }
      continue
    }

    // Event notification (has `method`)
    if (msg.method) {
      handleEvent(msg.method, msg.params || {})
    }
  }
}

// ── Main thread message handler ──────────────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data

  switch (msg.type) {
    case 'init': {
      // Connect WS
      if (ws) { try { ws.close() } catch {} ws = null }
      ws = new WebSocket(msg.wsUrl)
      ws.onmessage = handleWSMessage
      ws.onerror = () => { (postMessage as any)({ type: 'error', message: 'WS 连接错误' }) }
      ws.onclose = () => { (postMessage as any)({ type: 'connection', state: 'disconnected' }) }

      // Wait for open
      await new Promise<void>((resolve, reject) => {
        if (!ws) return reject(new Error('WS null'))
        if (ws.readyState === WebSocket.OPEN) return resolve()
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('WS 连接失败'))
        setTimeout(() => reject(new Error('WS 连接超时')), 15_000)
      })

      // Create Hermes session
      try {
        const res = await rpc('session.create', { cwd: msg.cwd, source: 'helix' }, 120_000)
        hermesSessionId = res?.session_id || res?._meta?.hermes?.sessionProvenance?.acpSessionId || null
        if (!hermesSessionId) throw new Error('无法创建会话')
        ;(postMessage as any)({ type: 'ready', hermesSessionId })
      } catch (err: any) {
        ;(postMessage as any)({ type: 'error', message: err?.message || '创建会话失败' })
      }
      break
    }

    case 'prompt': {
      if (!hermesSessionId || !ws || ws.readyState !== WebSocket.OPEN) {
        ;(postMessage as any)({ type: 'error', message: '会话未就绪' })
        return
      }
      startRun()
      try {
        // prompt.submit returns immediately (ack) in serve mode
        await rpc('prompt.submit', { session_id: hermesSessionId, text: msg.text }, 30_000)
        // Events stream in via handleWSMessage → handleEvent
      } catch (err: any) {
        failRun(err?.message || '发送失败')
      }
      break
    }

    case 'stop': {
      clearIdle()
      if (hermesSessionId) {
        notify('session.interrupt', { session_id: hermesSessionId })
      }
      if (running) finishRun('stopped')
      break
    }

    case 'terminate': {
      clearIdle()
      if (postTimer) clearTimeout(postTimer)
      if (hermesSessionId && ws?.readyState === WebSocket.OPEN) {
        try { notify('session.interrupt', { session_id: hermesSessionId }) } catch {}
      }
      try { ws?.close() } catch {}
      ws = null
      self.close()
      break
    }
  }
}

// Notify main thread that the worker script has loaded
;(postMessage as any)({ type: 'loaded' })
