/**
 * useHermes hook - React hook for interacting with Hermes backend
 * 
 * Provides methods to send prompts, handle events, and manage sessions.
 * Uses the Electron IPC bridge to communicate with the Hermes subprocess.
 */

'use client'

import { useEffect, useCallback, useRef } from 'react'
import { useHermesStore } from '@/stores/hermes-store'
import { useHelixStore } from '@/stores/helix-store'
import { electronHermes } from '@/lib/electron-bridge'
import { debug, warn, error as logError } from '@/lib/logger'

// ── Types ───────────────────────────────────────────────────────────────────

export type HermesEvent =
  | 'gateway.ready'
  | 'gateway.disconnected'
  | 'gateway.retry'
  | 'gateway.sessionInvalidated'
  | 'gateway.sessionReplaced'
  | 'session/update'
  | 'session/request_permission'
  | 'error'

export interface HermesEventParams {
  session_id?: string
  content?: string
  tool_name?: string
  tool_call_id?: string
  request_id?: string
  message?: string
  newId?: string
  oldId?: string
  phase?: string
  attempt?: number
  total?: number
  [key: string]: unknown
}

export interface HermesToolStartParams {
  session_id: string
  tool_name: string
  tool_call_id: string
  args?: Record<string, unknown>
}

export interface HermesToolCompleteParams {
  session_id: string
  tool_name: string
  tool_call_id: string
  result?: string
  error?: string
}

export interface HermesApprovalRequestParams {
  session_id: string
  request_id: string
  tool_name: string
  args: Record<string, unknown>
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useHermes() {
  const {
    hermesConnected,
    hermesSessionId,
    hermesError,
    setHermesConnected,
    setHermesSessionId,
    setHermesError,
    addChatMessage,
    setChatMessageStreaming,
    clearChat,
    isChatLoading,
  } = useHermesStore()
  const workDirEpoch = useHelixStore(s => s.workDirEpoch)

  const currentMessageIdRef = useRef<string | null>(null)
  const eventHandlerRef = useRef<((event: HermesEvent, params?: HermesEventParams) => void) | null>(null)
  // Mirrors hermesSessionId so auth-error recovery can reset it synchronously.
  const hermesSessionIdRef = useRef<string | null>(null)
  // Track which config was used to create the current session, so we can detect
  // when the user switches providers and force-recreate the session.
  const sessionConfigHashRef = useRef<string | null>(null)
  // 401-seamless-retry bookkeeping: remember the last prompt so we can re-send
  // it once after rebuilding the session, and guard against double-retry.
  const lastPromptRef = useRef<string>('')
  const authRetryRef = useRef<boolean>(false)
  const sendPromptRef = useRef<((text: string) => void) | null>(null)

  // Check if running in Electron
  const isElectron = typeof window !== 'undefined' && window.electron?.isElectron

  // Listen for Hermes events — only connection/error state; streaming & permissions
  // are handled by agent-flow-panel.tsx which owns the responseBlocks UI.
  useEffect(() => {
    if (!isElectron) return

    const unsubscribe = window.electron.hermes.onEvent((event: HermesEvent, params?: HermesEventParams) => {
      debug('[Hermes Event]', event, params)

      switch (event) {
        case 'gateway.ready':
          setHermesConnected(true)
          setHermesError(null)
          // CRITICAL: bump epoch on every (re)start so handleRun can tell a
          // brand-new gateway apart from the one that created its session.
          useHermesStore.getState().bumpGatewayEpoch()
          useHelixStore.getState().setConnectionNotice(null)
          break

        case 'gateway.disconnected':
          setHermesConnected(false)
          // Only surface a notice for UNEXPECTED drops (process crashed), not
          // for the routine "going down for a restart" signal we emit on every
          // provider switch — that one is followed immediately by gateway.ready
          // and would otherwise flash a scary "已断开" error to the user.
          if (params?.expected !== true) {
            useHelixStore.getState().setConnectionNotice({
              phase: 'error',
              message: '网关进程已退出，连接已断开',
              ts: Date.now(),
            })
          }
          break

        case 'gateway.sessionInvalidated':
          // The gateway restarted (e.g. provider switch) and ALL sessions were
          // destroyed server-side. Drop the cached session id so the next prompt
          // recreates a fresh one instead of replaying a stale id that the
          // backend rejects. The in-flight handleRun (if any) listens for this
          // same event in agent-flow-panel.tsx and aborts itself, so clearing
          // here is safe — there is no live backend session to keep alive.
          debug('[useHermes] gateway restarted — invalidating cached session id')
          setHermesSessionId(null)
          hermesSessionIdRef.current = null
          sessionConfigHashRef.current = null
          break

        case 'gateway.sessionReplaced':
          // main.js auto-recovered a stale session by creating a new one and
          // replaying the prompt. Sync our cached id so subsequent messages use it.
          if (params?.newId) {
            debug('[useHermes] session replaced (recovered):', params.newId)
            setHermesSessionId(params.newId as string)
            hermesSessionIdRef.current = params.newId as string
          }
          break

        case 'gateway.retry': {
          const phase = (params?.phase as 'error' | 'retrying' | 'recovered') || 'error'
          useHelixStore.getState().setConnectionNotice({
            phase,
            attempt: typeof params?.attempt === 'number' ? params.attempt : undefined,
            total: typeof params?.total === 'number' ? params.total : undefined,
            message: params?.message || '网关连接不稳定，正在重试…',
            ts: Date.now(),
          })
          // Auto-clear recovered notice after 3 seconds
          if (phase === 'recovered') {
            setTimeout(() => {
              const cur = useHelixStore.getState().connectionNotice
              if (cur?.phase === 'recovered') {
                useHelixStore.getState().setConnectionNotice(null)
              }
            }, 3000)
          }
          break
        }

        case 'error': {
          const msg = params?.message || 'Unknown error'
          const isAuthError = /401|unauthorized|incorrect.*api.?key|invalid.*token|认证|令牌|授权/i.test(msg)
          if (isAuthError) {
            // Seamless 401 recovery: on the first auth failure, invalidate the
            // (stale-key) session and re-send the SAME prompt once — the user
            // sees no error and the stream simply continues on the new session.
            if (!authRetryRef.current && lastPromptRef.current) {
              warn('[useHermes] 401 detected → rebuild session + retry once (seamless)')
              authRetryRef.current = true
              setHermesError(null)
              setHermesSessionId(null)
              hermesSessionIdRef.current = null
              useHelixStore.getState().setConnectionNotice(null)
              sendPromptRef.current?.(lastPromptRef.current)
            } else {
              // Retry also failed → surface to the user (check API Key / model).
              warn('[useHermes] Auth retry failed, surfacing error:', msg)
              setHermesSessionId(null)
              hermesSessionIdRef.current = null
              setHermesError(msg)
              useHermesStore.setState({ isChatLoading: false })
              useHelixStore.getState().setConnectionNotice({
                phase: 'error',
                message: '认证失败，请在设置中检查 API Key 是否正确，或重新选择模型',
                ts: Date.now(),
              })
            }
          } else {
            setHermesError(msg)
            useHermesStore.setState({ isChatLoading: false })
          }
          break
        }
      }

        // Call custom event handler if registered
        eventHandlerRef.current?.(event, params)
    })

    return () => {
      unsubscribe()
    }
  }, [isElectron])

  // Check Hermes status on mount (handles case where gateway.ready fired before useEffect)
  useEffect(() => {
    if (!isElectron) return
    debug('[useHermes] Checking status on mount...')
    window.electron.hermes.status().then((status: { connected: boolean }) => {
      debug('[useHermes] Status:', status)
      if (status.connected) {
        setHermesConnected(true)
        setHermesError(null)
      }
    }).catch((err: any) => {
      debug('[useHermes] Status check failed:', err)
    })
  }, [isElectron])

  // When the working directory changes, the cached Hermes session still has the
  // old cwd. Drop it so the next prompt recreates the session in the new project.
  useEffect(() => {
    if (workDirEpoch === 0) return
    setHermesSessionId(null)
  }, [workDirEpoch, setHermesSessionId])

  // Push the frontend-selected model into Hermes config.yaml so the next session
  // (which reloads config on creation) actually uses it. No-op when the user hasn't
  // configured a provider in the frontend (empty apiKey) — Hermes keeps its own model.
  const setHermesModel = useCallback(async () => {
    if (!isElectron) return
    try {
      const cfg = useHelixStore.getState().apiConfig
      if (!cfg || !cfg.model) return
      debug('[useHermes] setHermesModel → pushing to backend:',
        JSON.stringify({
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          provider: cfg.provider,
          apiKey: cfg.apiKey ? cfg.apiKey.substring(0, 6) + '…' : '(empty)',
        }))
      await window.electron.hermes.setModel({
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        provider: cfg.provider,
      })
    } catch (err) {
      logError('[Hermes] Failed to set model:', err)
    }
  }, [isElectron])

  // Wait for the gateway to be ready (up to timeoutMs). Returns true if ready.
  const waitForGatewayReady = useCallback((timeoutMs = 8000): Promise<boolean> => {
    return new Promise((resolve) => {
      if (useHermesStore.getState().hermesConnected) {
        resolve(true)
        return
      }
      const unsubscribe = window.electron.hermes.onEvent((event: HermesEvent) => {
        if (event === 'gateway.ready') {
          cleanup()
          resolve(true)
        }
      })
      const cleanup = () => {
        try { unsubscribe?.() } catch {}
      }
      // Timeout fallback
      setTimeout(() => {
        cleanup()
        // Still resolve — let session/new attempt; Hermes may be ready but
        // the ready event was missed (e.g. gateway was already up).
        resolve(useHermesStore.getState().hermesConnected)
      }, timeoutMs)
    })
  }, [])

  // Send a prompt to Hermes
  const sendPrompt = useCallback(async (text: string) => {
    if (!isElectron) {
      logError('Not running in Electron')
      return
    }

    // Bookkeeping for the 401 seamless-retry: a fresh user message starts a new
    // attempt (reset retry flag) and remembers the prompt text to re-send.
    authRetryRef.current = false
    lastPromptRef.current = text

    // Add user message to chat
    addChatMessage({ role: 'user', content: text })
    useHermesStore.setState({ isChatLoading: true })
    currentMessageIdRef.current = null

    try {
      // Read session ID from the store directly (NOT from the useCallback closure)
      // to avoid stale values when the user switches models and sends quickly.
      let activeSessionId = useHermesStore.getState().hermesSessionId
      // Build a hash of the current config to detect provider switches.
      const cfg = useHelixStore.getState().apiConfig
      const configHash = `${cfg.baseUrl}||${cfg.apiKey}||${cfg.model}`
      debug('[useHermes] sendPrompt config snapshot:',
        JSON.stringify({
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          configHash,
          sessionExists: !!activeSessionId,
          sessionHash: sessionConfigHashRef.current,
          willRebuild: !!activeSessionId && sessionConfigHashRef.current !== configHash,
        }))

      // If a session exists but was created with a different config (provider
      // switched), invalidate it so we get a fresh session with the new key.
      if (activeSessionId && sessionConfigHashRef.current !== configHash) {
        warn('[useHermes] Config changed since session was created, invalidating session')
        activeSessionId = null
        useHermesStore.getState().setHermesSessionId(null)
        hermesSessionIdRef.current = null
      }

      if (!activeSessionId) {
        // Push the current model config into Hermes before creating a new session.
        // This is needed when the session was invalidated (e.g. after a model switch)
        // and ensures the backend uses the correct model/provider/apiKey.
        await setHermesModel()
        // Wait for the gateway to be ready after model config update. Without this,
        // session/new may hit a restarting gateway and produce 401 errors.
        await waitForGatewayReady()
        const cwd = useHelixStore.getState().selectedWorkDir || (typeof process !== 'undefined' ? process.cwd() : '')
        const result = await window.electron.hermes.send('session/new', {
          cwd,
          mcpServers: [],
        }) as any
        debug('[useHermes] session/new result:', JSON.stringify(result).substring(0, 500))
        // Extract session_id from ACP response structure
        // Format: { _meta: { hermes: { sessionProvenance: { acpSessionId: "..." } } } }
        activeSessionId = result?._meta?.hermes?.sessionProvenance?.acpSessionId
          || result?.session_id
          || result?.sessionID
          || (typeof result === 'string' ? result : null)
        debug('[useHermes] Extracted session_id:', activeSessionId)
        if (activeSessionId && typeof activeSessionId === 'string') {
          setHermesSessionId(activeSessionId)
          sessionConfigHashRef.current = configHash
        } else {
          logError('[useHermes] Failed to extract session_id from:', result)
        }
      }

      if (!activeSessionId) {
        logError('[useHermes] No session ID available, cannot send prompt')
        setHermesError('无法创建会话')
        useHermesStore.setState({ isChatLoading: false })
        return
      }

      debug('[useHermes] Sending session/prompt with session_id:', activeSessionId)
      // Don't await - ACP prompt is blocking, events come via notifications
      // ACP expects prompt as a list of content blocks, not a plain string
      window.electron.hermes.send('session/prompt', {
        session_id: activeSessionId,
        prompt: [{ type: 'text', text }],
      }).then((result: any) => {
        debug('[useHermes] session/prompt completed:', result)
        // Record real token usage from the prompt response.
        const usage = result?.usage
        if (usage && typeof usage === 'object') {
          const model = useHelixStore.getState().apiConfig.model || 'unknown'
          useHelixStore.getState().addSessionUsageStats(model, {
            totalTokens: Number(usage.totalTokens) || undefined,
            inputTokens: Number(usage.inputTokens) || undefined,
            outputTokens: Number(usage.outputTokens) || undefined,
            thoughtTokens: Number(usage.thoughtTokens) || undefined,
            cachedReadTokens: Number(usage.cachedReadTokens) || undefined,
            cachedWriteTokens: Number(usage.cachedWriteTokens) || undefined,
          })
        }
        // Final response received - mark loading complete
        useHermesStore.setState({ isChatLoading: false })
      }).catch((err: any) => {
        logError('[useHermes] session/prompt error:', err)
        // Don't set error here - events are still coming via notifications
      })
    } catch (err) {
      logError('[Hermes] Failed to send prompt:', err)
      const errMsg = err instanceof Error ? err.message : 'Failed to send prompt'
      const isAuth = /401|unauthorized|incorrect.*api.?key|invalid.*token|认证|令牌|授权/i.test(errMsg)
      if (isAuth) {
        // Auth failures are handled by the `error` event (seamless retry-once);
        // here we only invalidate the stale session so the retry rebuilds clean.
        setHermesSessionId(null)
        hermesSessionIdRef.current = null
        setHermesError(null)
        useHermesStore.setState({ isChatLoading: false })
      } else {
        setHermesError(errMsg)
        useHermesStore.setState({ isChatLoading: false })
      }
    }
  }, [isElectron, hermesSessionId])

  // Keep a live ref to sendPrompt so the `error` event handler can re-invoke the
  // latest closure (with the current store state) during a seamless 401 retry.
  sendPromptRef.current = sendPrompt

  // Interrupt current operation
  const interrupt = useCallback(async () => {
    if (!isElectron || !hermesSessionId) return

    try {
      // session/cancel is a Hermes *notification* (no response), so send it
      // via notify, not send (which issues a request and gets "Method not found").
      electronHermes.notify('session/cancel', { session_id: hermesSessionId })
      if (currentMessageIdRef.current) {
        setChatMessageStreaming(currentMessageIdRef.current, false)
        currentMessageIdRef.current = null
      }
      useHermesStore.setState({ isChatLoading: false })
    } catch (err) {
      logError('[Hermes] Failed to interrupt:', err)
    }
  }, [isElectron, hermesSessionId])

  // Create a new session
  const newSession = useCallback(async () => {
    if (!isElectron) return

    try {
      await setHermesModel()
      // Wait for the gateway to be ready after model config update
      await waitForGatewayReady()
      const cwd = useHelixStore.getState().selectedWorkDir || (typeof process !== 'undefined' ? process.cwd() : '')
      const sessionId = await window.electron.hermes.send('session/new', { cwd, mcpServers: [] }) as string
      if (sessionId) {
        setHermesSessionId(sessionId)
      }
      clearChat()
    } catch (err) {
      logError('[Hermes] Failed to create session:', err)
    }
  }, [isElectron])

  // Dispatch a slash command
  const dispatchCommand = useCallback(async (command: string) => {
    if (!isElectron) return

    try {
      await window.electron.hermes.send('command/dispatch', { command, session_id: hermesSessionId })
    } catch (err) {
      logError('[Hermes] Failed to dispatch command:', err)
    }
  }, [isElectron, hermesSessionId])

  // Apply a personality by writing agent.system_prompt into Hermes config.yaml
  const setHermesPersonality = useCallback(async (name: string, prompt?: string) => {
    if (!isElectron) return
    try {
      await window.electron.hermes.setPersonality({ name, prompt })
    } catch (err) {
      logError('[Hermes] Failed to set personality:', err)
    }
  }, [isElectron])

  // Register a custom event handler
  const onEvent = useCallback((handler: (event: HermesEvent, params?: HermesEventParams) => void) => {
    eventHandlerRef.current = handler
    return () => {
      eventHandlerRef.current = null
    }
  }, [])

  return {
    // State
    connected: hermesConnected,
    sessionId: hermesSessionId,
    error: hermesError,
    isLoading: isChatLoading,

    // Actions
    sendPrompt,
    interrupt,
    newSession,
    dispatchCommand,
    setHermesPersonality,
    setHermesModel,
    onEvent,
  }
}
