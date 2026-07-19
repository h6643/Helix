// API 客户端 —— 走 Hermes 后端（Electron IPC → 网关子进程），而非直连 LLM。
//
// 与直连相比，Hermes 后端是「有状态」的：认证信息在 session 创建时快照进后端进程，
// 之后该 session 一直用这套 key。这正是「切换 Provider 后 401」的根因 ——
// 切换只是把新配置写进了 config.yaml，但正在跑的旧 session 仍握着旧 key，
// 而 config.yaml 只在「session 创建」时被 reload。
//
// 本文件用两套机制彻底消除这个问题（对应你的两条需求）：
//
// 机制① 切换 Provider 时主动 invalidate
//   - 用「即将写入 config.yaml 的认证配置」算 sessionConfigHash：
//       baseUrl || apiKey || model || providerName
//     （这四个字段就是 setModel 写进 config.yaml 的认证段，hash 等价于基于 config.yaml 内容计算）
//   - 每次发请求前对比：若与「当前 session 创建时」的 hash 不同 ⇒ 说明 Provider/Key 变了 ⇒
//     主动 invalidate 当前 session，下一次请求自然重建（reload 新 key）。
//
// 机制② 401 错误监听 + 自动重建 + 重试
//   - 监听 Hermes 的 `error` 事件，匹配 /401|unauthorized|.../ 即判定为认证失败。
//   - 命中后：invalidate session（丢弃旧 key 快照）→ 用最新配置重建 → 用同一句 prompt 重试 1 次。
//   - 全程在客户端内部完成，用户无感知（不会看到 401 报错，输出流无缝续上）。
'use client'

import type { ResolvedModel, ChatMessage } from './types'
import { getElectronAPI, electronHermes } from '@/lib/electron-bridge'
import { normalizeAcpContent } from '@/lib/text-utils'
import { warn, error as logError, debug } from '@/lib/logger'

/** 认证类错误匹配（与 use-hermes.ts 保持一致） */
const AUTH_RE = /401|unauthorized|incorrect.*api.?key|invalid.*token|认证|令牌|授权/i

export function isAuthError(msg?: string | null): boolean {
  return !!msg && AUTH_RE.test(msg)
}

/**
 * 基于「即将写入 config.yaml 的认证配置」计算 hash。
 * 这四个字段就是 setModel 写进 Hermes config.yaml 的认证段，
 * 因此 hash 等价于「基于 config.yaml 内容」计算的会话指纹。
 */
export function configHashOf(cfg: ResolvedModel): string {
  return `${cfg.baseUrl}||${cfg.apiKey}||${cfg.model}||${cfg.providerName}`
}

export interface StreamHandlers {
  onToken: (delta: string) => void
  onDone: () => void
  onError: (err: ChatError) => void
}

export interface ChatError {
  status?: number
  message: string
  /** 是否认证类错误（用于 UI 提示检查 API Key） */
  isAuth: boolean
}

export interface SendOptions {
  system?: string
  temperature?: number
  maxTokens?: number
}

export interface HermesClientOptions {
  /** 返回「当前模型」对应的 Provider 配置；每次请求都会重新调用。 */
  getConfig: () => ResolvedModel | null
  /** 工作目录（传给 session/new）。默认 process.cwd()。 */
  getCwd?: () => string
}

/** 取得 Hermes IPC 句柄（浏览器模式下为 null）。 */
function hermes(): any {
  return getElectronAPI()?.hermes as any
}

export class HermesChatClient {
  // ── session 状态 ──
  private sessionId: string | null = null
  /** 当前 session 创建时所用的 config hash；与最新 hash 不一致 ⇒ 已切换 Provider ⇒ 作废 */
  private sessionConfigHash: string | null = null

  // ── 在途请求状态 ──
  private inFlight = false
  private recovering = false
  private retryCount = 0
  private pendingText: string | null = null
  private pendingHandlers: StreamHandlers | null = null
  private pendingOptions: SendOptions | null = null

  private unsubscribe: (() => void) | null = null
  private readonly getConfig: () => ResolvedModel | null
  private readonly getCwd: () => string

  constructor(opts: HermesClientOptions) {
    this.getConfig = opts.getConfig
    this.getCwd = opts.getCwd ?? (() => (typeof process !== 'undefined' ? process.cwd() : ''))
    const h = hermes()
    if (h?.onEvent) {
      this.unsubscribe = h.onEvent((event: string, params?: any) => this.handleEvent(event, params))
    }
  }

  /** 组件卸载时调用，移除事件监听。 */
  dispose() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  // ──────────────────────────────────────────────────────────────────
  // 公开 API
  // ──────────────────────────────────────────────────────────────────

  /** 发起一轮对话（流式）。text 为最新一条用户消息。 */
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
    await this.runAttempt(text, handlers, options)
  }

  /**
   * ★ 切换模型/Provider 时由调用方触发。
   * 1) 中断在途输出（session/cancel），让用户立刻看到切换生效；
   * 2) 用「新配置」的 hash 与当前 session 比对，仅在真正变化时 invalidate，
   *    避免同 Provider 内切换模型也白白重建 session。
   * 注意：必须在 setActiveModel 之后调用，这样 getConfig() 才能拿到新配置。
   */
  onModelSwitched() {
    const cfg = this.getConfig()
    if (this.sessionId) {
      electronHermes.notify('session/cancel', { session_id: this.sessionId })
    }
    this.inFlight = false
    this.recovering = false
    if (cfg) {
      const hash = configHashOf(cfg)
      if (this.sessionId && this.sessionConfigHash !== hash) {
        warn('[HermesChatClient] 模型/Provider 切换 → config 变化，invalidate 当前 session')
        this.invalidateSession()
      }
    }
  }

  /** 仅中断在途输出，不丢弃 session（配置未变时可复用）。 */
  cancel() {
    if (this.sessionId) electronHermes.notify('session/cancel', { session_id: this.sessionId })
    this.inFlight = false
  }

  // ──────────────────────────────────────────────────────────────────
  // 内部：请求 / session 生命周期
  // ──────────────────────────────────────────────────────────────────

  private invalidateSession() {
    debug('[HermesChatClient] invalidateSession:', this.sessionId)
    this.sessionId = null
    this.sessionConfigHash = null
  }

  /** 确保存在一个「配置与当前一致」的 session；不一致则重建。 */
  private async ensureSession(): Promise<void> {
    const cfg = this.getConfig()
    if (!cfg) throw new Error('未找到当前模型对应的 Provider 配置，请检查设置')
    if (!cfg.apiKey) throw new Error('当前 Provider 的 API Key 为空，请先在设置中填写')

    const hash = configHashOf(cfg)

    // 机制①：hash 不一致 ⇒ 旧 session 仍握着旧 key ⇒ 主动作废（切换 Provider / 改 Key）
    if (this.sessionId && this.sessionConfigHash !== hash) {
      warn('[HermesChatClient] config 变化（Provider 切换），invalidate 当前 session')
      this.invalidateSession()
    }

    if (!this.sessionId) {
      const h = hermes()
      // 把当前模型配置写入 config.yaml（后端在 session 创建时 reload 这套 key）
      await h.setModel({
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        provider: cfg.providerName,
      })
      // setModel 可能触发网关重启，等其就绪再建 session，否则会命中重启中的网关 → 401
      await this.waitForGatewayReady()
      const result: any = await h.send('session/new', {
        cwd: this.getCwd(),
        mcpServers: [],
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
      handlers.onError({ message: e?.message || '无法创建会话', isAuth: false })
      return
    }
    this.inFlight = true
    try {
      await this.dispatchPrompt(text)
      this.inFlight = false
      handlers.onDone()
    } catch (e: any) {
      this.inFlight = false
      if (isAuthError(e?.message)) {
        this.handleAuthFailure(e.message) // 机制②：401 重试
      } else {
        handlers.onError({ message: e?.message || '请求失败', isAuth: false })
      }
    }
  }

  private dispatchPrompt(text: string): Promise<void> {
    const h = hermes()
    if (!h || !this.sessionId) return Promise.reject(new Error('session 未就绪'))
    return new Promise<void>((resolve, reject) => {
      // ACP 的 prompt 是阻塞调用，真正的流式内容通过 session/update 事件回来
      h.send('session/prompt', {
        session_id: this.sessionId,
        prompt: [{ type: 'text', text }],
      })
        .then(() => resolve())
        .catch((err: any) => reject(err))
    })
  }

  /**
   * 机制②核心：认证失败的统一入口。
   * - 仅在「有在途请求」时响应，避免把主流程/其它 session 的错误误判为我们的 401；
   * - 首次：invalidate → 用最新配置重建 → 同一句 prompt 重试 1 次（用户无感知）；
   * - 重试仍 401：上抛最终错误，由 UI 提示检查 API Key。
   */
  private handleAuthFailure(msg: string) {
    if (!this.inFlight || this.recovering) return
    this.recovering = true
    this.inFlight = false

    if (this.retryCount >= 1) {
      this.pendingHandlers?.onError({ message: msg || '认证失败（401）', isAuth: true })
      return
    }
    warn('[HermesChatClient] 401 检测 → invalidate + 重建 session + 重试 1 次（用户无感知）')
    this.retryCount = 1
    this.invalidateSession()
    void this.runAttempt(this.pendingText!, this.pendingHandlers!, this.pendingOptions!)
  }

  // ──────────────────────────────────────────────────────────────────
  // 内部：事件总线
  // ──────────────────────────────────────────────────────────────────

  private handleEvent(event: string, params?: any) {
    // 只处理属于「本客户端 session」的事件，避免与主流程串扰
    if (this.sessionId && params?.session_id && params.session_id !== this.sessionId) return

    switch (event) {
      case 'session/update': {
        const raw = params?.content
        if (typeof raw === 'string' && raw && this.pendingHandlers && this.inFlight) {
          const delta = normalizeAcpContent(raw)
          if (delta) this.pendingHandlers.onToken(delta)
        }
        break
      }
      case 'error': {
        // 仅在我们有在途请求时，才把 auth 错误当成「本次会话的 401」处理
        const msg = params?.message || ''
        if (isAuthError(msg)) this.handleAuthFailure(msg)
        break
      }
    }
  }

  /** 等待网关就绪（setModel 可能触发重启）。超时也放行，让 session/new 自行尝试。 */
  private waitForGatewayReady(timeoutMs = 8000): Promise<boolean> {
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
        try {
          unsub?.()
        } catch {
          /* noop */
        }
      }
      setTimeout(() => finish(true), timeoutMs)
    })
  }
}

export type { ChatMessage }
