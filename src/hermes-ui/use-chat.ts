'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { HermesChatClient, respondApproval, clearPendingApproval, type ApprovalLevel, type ToolCallInfo } from './api-client'
import { useProviderStore } from './provider-store'
import type { ChatMessage } from './types'

export interface ToolCallEntry {
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

export function useChat(systemPrompt?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reasoning, setReasoning] = useState('')
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([])
  const [pendingApproval, setPendingApproval] = useState<{
    toolName: string
    args?: Record<string, unknown>
    toolCallId: string
    command?: string
    allowPermanent?: boolean
  } | null>(null)

  const clientRef = useRef<HermesChatClient | null>(null)
  const activeModel = useProviderStore((s) => s.activeModel)
  const setActiveModel = useProviderStore((s) => s.setActiveModel)
  const textAccRef = useRef('')
  const reasoningAccRef = useRef('')
  const reasoningReplaceRef = useRef(false)

  if (!clientRef.current) {
    clientRef.current = new HermesChatClient({
      getConfig: () => useProviderStore.getState().resolveActiveModel(),
      getCwd: () => (typeof process !== 'undefined' ? process.cwd() : ''),
    })
  }

  // Cleanup on unmount: cancel in-flight streams to prevent state updates on unmounted component
  useEffect(() => {
    return () => { clientRef.current?.cancel() }
  }, [])

  const send = useCallback(
    async (text: string) => {
      const content = text.trim()
      if (!content || streaming) return

      const history: ChatMessage[] = [...messages, { role: 'user', content }]
      setMessages([...history, { role: 'assistant', content: '' }])
      setStreaming(true)
      setError(null)
      setReasoning('')
      setToolCalls([])
      setPendingApproval(null)

      textAccRef.current = ''
      reasoningAccRef.current = ''
      reasoningReplaceRef.current = false

      await clientRef.current!.streamChat(
        content,
        {
          onToken: (delta) => {
            textAccRef.current += delta
            setMessages((prev) => {
              const copy = [...prev]
              copy[copy.length - 1] = { role: 'assistant', content: textAccRef.current }
              return copy
            })
          },
          onReasoningDelta: (delta, replace) => {
            if (replace) {
              // reasoning.available: replace entire reasoning blob
              reasoningAccRef.current = delta
              reasoningReplaceRef.current = true
            } else {
              reasoningAccRef.current += delta
            }
            setReasoning(reasoningAccRef.current)
          },
          onToolStart: (info: ToolCallInfo) => {
            setToolCalls((prev) => [...prev, {
              toolCallId: info.toolCallId,
              toolName: info.toolName,
              args: info.args,
              status: 'running',
              startedAt: info.startedAt,
            }])
          },
          onToolProgress: (info) => {
            setToolCalls((prev) => prev.map((t) =>
              t.toolCallId === info.toolCallId
                ? {
                    ...t,
                    ...(info.args ? { args: { ...t.args, ...info.args } } : {}),
                    result: info.result ?? t.result,
                    summary: info.summary ?? t.summary,
                    status: 'running' as const,
                  }
                : t
            ))
          },
          onToolComplete: (info) => {
            setToolCalls((prev) => prev.map((t) =>
              t.toolCallId === info.toolCallId
                ? {
                    ...t,
                    ...(info.args ? { args: { ...t.args, ...info.args } } : {}),
                    result: info.result ?? t.result,
                    inlineDiff: info.inlineDiff,
                    summary: info.summary ?? t.summary,
                    duration_s: info.duration_s ?? t.duration_s,
                    isError: info.isError,
                    status: 'complete' as const,
                    finishedAt: info.finishedAt,
                  }
                : t
            ))
          },
          onWorkspaceChanged: () => {
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('helix:workspace-changed'))
            }
          },
          onSessionTitle: (title) => {
            // Update session title in sidebar
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('helix:session-title', { detail: { title } }))
            }
          },
          onTodoUpdate: (todos) => {
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('helix:todo-update', { detail: { todos } }))
            }
          },
          onDone: () => {
            setStreaming(false)
            setPendingApproval(null)
          },
          onError: (err) => {
            setError(err.message)
            setStreaming(false)
            setPendingApproval(null)
          },
        },
        { system: systemPrompt },
      )
    },
    [messages, streaming, systemPrompt],
  )

  const switchModel = useCallback(
    (model: string) => {
      setActiveModel(model)
      clientRef.current?.onModelSwitched()
      setStreaming(false)
    },
    [setActiveModel],
  )

  const approveToolCall = useCallback((level: ApprovalLevel) => {
    setPendingApproval(null)
    respondApproval(level)
  }, [])

  const interrupt = useCallback(() => {
    clientRef.current?.cancel()
    setStreaming(false)
    setPendingApproval(null)
  }, [])

  return {
    messages,
    streaming,
    error,
    reasoning,
    toolCalls,
    pendingApproval,
    send,
    switchModel,
    activeModel,
    approveToolCall,
    interrupt,
    client: clientRef.current,
  }
}
