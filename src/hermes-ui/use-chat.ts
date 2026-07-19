// 对话 Hook —— 串联 Provider Store + HermesChatClient（走 Hermes 后端）。
//
// 关键行为：
// - send()：把最新一条用户消息发给 Hermes 后端，流式回显。
// - switchModel()：先更新 activeModel（store 立即生效），再调用
//   client.onModelSwitched()（基于 config hash 判断是否需要 invalidate session）。
//   这保证了「切换 Provider 时取消在途请求 + 下次请求自动重建 session」，
//   且 401 由 client 内部监听并自动重试，用户无感知。
'use client'

import { useCallback, useRef, useState } from 'react'
import { HermesChatClient } from './api-client'
import type { ChatMessage } from './types'
import { useProviderStore } from './provider-store'

export function useChat(systemPrompt?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clientRef = useRef<HermesChatClient | null>(null)
  const activeModel = useProviderStore((s) => s.activeModel)
  const setActiveModel = useProviderStore((s) => s.setActiveModel)

  // 懒初始化 client：getConfig 永远从 store 实时解析当前模型配置
  if (!clientRef.current) {
    clientRef.current = new HermesChatClient({
      getConfig: () => useProviderStore.getState().resolveActiveModel(),
      getCwd: () => (typeof process !== 'undefined' ? process.cwd() : ''),
    })
  }

  const send = useCallback(
    async (text: string) => {
      const content = text.trim()
      if (!content || streaming) return

      const history: ChatMessage[] = [...messages, { role: 'user', content }]
      setMessages([...history, { role: 'assistant', content: '' }])
      setStreaming(true)
      setError(null)

      let acc = ''
      await clientRef.current!.streamChat(
        content,
        {
          onToken: (delta) => {
            acc += delta
            setMessages((prev) => {
              const copy = [...prev]
              copy[copy.length - 1] = { role: 'assistant', content: acc }
              return copy
            })
          },
          onDone: () => setStreaming(false),
          onError: (err) => {
            setError(err.message)
            setStreaming(false)
          },
        },
        { system: systemPrompt },
      )
    },
    [messages, streaming, systemPrompt],
  )

  // ★ 切换模型：先更新选中模型，再让 client 基于 config hash 决定是否 invalidate session
  const switchModel = useCallback(
    (model: string) => {
      setActiveModel(model) // 先更新 store（同步生效），onModelSwitched 才能读到新配置
      clientRef.current?.onModelSwitched() // 中断在途 + 必要时 invalidate
      setStreaming(false)
    },
    [setActiveModel],
  )

  return { messages, streaming, error, send, switchModel, activeModel }
}
