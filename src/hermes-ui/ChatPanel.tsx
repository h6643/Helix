// 对话界面示例 —— 演示 ModelSelector + useChat 的组合。
'use client'

import { useState, type FormEvent } from 'react'
import { useChat } from './use-chat'
import { ModelSelector } from './ModelSelector'

export function ChatPanel() {
  const { messages, streaming, error, send, switchModel } = useChat('You are a helpful assistant.')
  const [input, setInput] = useState('')

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!input.trim() || streaming) return
    send(input)
    setInput('')
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部：模型下拉（扁平展示所有 Provider 的模型） */}
      <div className="flex items-center gap-2 p-2 border-b">
        <span className="text-sm text-muted-foreground">模型</span>
        <ModelSelector onChange={switchModel} className="border p-1 rounded" />
      </div>

      {/* 消息流 */}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
            <div
              className={`inline-block max-w-[80%] rounded px-3 py-2 whitespace-pre-wrap ${
                m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
              }`}
            >
              {m.content || (streaming && i === messages.length - 1 ? '…' : '')}
            </div>
          </div>
        ))}
        {error && <div className="text-red-500 text-sm">⚠️ {error}</div>}
      </div>

      {/* 输入区 */}
      <form onSubmit={onSubmit} className="flex gap-2 p-2 border-t">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入消息…"
          className="flex-1 border p-2 rounded"
          disabled={streaming}
        />
        <button type="submit" disabled={streaming} className="bg-primary text-primary-foreground px-4 rounded">
          {streaming ? '生成中…' : '发送'}
        </button>
      </form>
    </div>
  )
}
