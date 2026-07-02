'use client'

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import {
  Send,
  Bot,
  User,
  Trash2,
  Loader2,
  Code2,
  Copy,
  Check,
  FileInput,
  FilePlus,
  FileCode,
  Zap,
  ChevronRight,
  ChevronDown,
  Terminal,
  Wrench,
  Search,
  FolderOpen,
  FileText,
  CheckCircle2,
  Circle,
  AlertCircle,
  Pencil,
  Eye,
} from 'lucide-react'
import { VoiceInput } from './voice-input'
import { StatusBar } from './status-bar'
import { AgentLog, type AgentLogEntry } from './agent-log'
import { ApprovalDialog, type ApprovalRequest } from './approval-dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useHelixStore, type ChatMessage } from '@/stores/helix-store'
import ReactMarkdown from 'react-markdown'
import { markdownComponents } from './markdown-components'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

function parseFileBlocks(content: string): { type: 'modify' | 'create'; path: string; code: string; startIdx: number; endIdx: number }[] {
  const blocks: { type: 'modify' | 'create'; path: string; code: string; startIdx: number; endIdx: number }[] = []
  const regex = /@@(file|create):([^\n]+)\n([\s\S]*?)(?=\n@@|\n*$)/g
  let match
  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      type: match[1] as 'modify' | 'create',
      path: match[2].trim(),
      code: match[3].trim(),
      startIdx: match.index,
      endIdx: match.index + match[0].length,
    })
  }
  return blocks
}

export function FileCodeBlock({
  language,
  children,
  filePath,
  fileType,
}: {
  language: string
  children: string
  filePath?: string
  fileType?: 'modify' | 'create'
}) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const { showToast, createOrUpdateFile, addPendingChange, setShowDiffPreview } = useHelixStore()

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(children)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [children])

  const handleApplyToFile = useCallback(() => {
    if (!filePath) return
    const state = useHelixStore.getState()
    const existingFile = state.findFileByPath(filePath)

    if (existingFile) {
      const change = {
        fileId: existingFile.id,
        fileName: existingFile.name,
        filePath,
        oldContent: existingFile.content || '',
        newContent: children,
        language: existingFile.language || language,
      }
      state.addPendingChange(change)
      state.setShowDiffPreview(true)
    } else {
      state.createOrUpdateFile(filePath, children)
      showToast({ type: 'success', title: '文件已创建', description: filePath })
    }
  }, [filePath, children, language, showToast, createOrUpdateFile, addPendingChange, setShowDiffPreview])

  return (
    <div className="my-2 rounded-xl border border-border overflow-hidden font-mono text-[13px]">
      <div
        className="flex items-center justify-between px-3 py-1.5 bg-card cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" />
          )}
          {fileType === 'create' ? (
            <FilePlus className="size-3.5 text-primary" />
          ) : fileType === 'modify' ? (
            <Pencil className="size-3.5 text-yellow-400" />
          ) : (
            <Code2 className="size-3.5 text-muted-foreground" />
          )}
          <span className="text-xs text-muted-foreground">
            {filePath || language}
          </span>
          {fileType && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              fileType === 'create' ? 'bg-primary/10 text-primary' : 'bg-yellow-500/10 text-yellow-400'
            }`}>
              {fileType === 'create' ? 'create' : 'modify'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-1.5 py-1 rounded hover:bg-accent transition-colors"
          >
            {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
          </button>
          {filePath && (
            <button
              onClick={handleApplyToFile}
              className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 px-1.5 py-1 rounded hover:bg-primary/10 transition-colors"
            >
              <Zap className="size-3" />
              apply
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <SyntaxHighlighter
          style={oneDark}
          language={language}
          PreTag="div"
          customStyle={{
            margin: 0,
            borderRadius: 0,
            fontSize: '0.8125rem',
            maxHeight: '400px',
          }}
        >
          {children.replace(/\n$/, '')}
        </SyntaxHighlighter>
      )}
    </div>
  )
}

function ToolUseCard({ name, input, output }: { name: string; input?: string; output?: string }) {
  const [expanded, setExpanded] = useState(false)

  const getToolIcon = () => {
    if (name.includes('Read') || name.includes('read')) return <Eye className="size-3.5" />
    if (name.includes('Write') || name.includes('write') || name.includes('Edit')) return <Pencil className="size-3.5" />
    if (name.includes('Grep') || name.includes('grep') || name.includes('Search')) return <Search className="size-3.5" />
    if (name.includes('Bash') || name.includes('bash') || name.includes('Terminal')) return <Terminal className="size-3.5" />
    if (name.includes('Glob') || name.includes('glob')) return <FolderOpen className="size-3.3" />
    return <Wrench className="size-3.5" />
  }

  const getStatusIcon = () => {
    if (output?.includes('error') || output?.includes('Error')) return <AlertCircle className="size-3 text-red-400" />
    return <CheckCircle2 className="size-3 text-primary" />
  }

  return (
    <div className="my-1.5 rounded-xl border border-border overflow-hidden tool-card">
      <div
        className="flex items-center gap-2 px-3 py-2 bg-card cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-muted-foreground">{getToolIcon()}</span>
        <span className="text-xs font-mono text-foreground">{name}</span>
        {getStatusIcon()}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-border">
          {input && (
            <div className="px-3 py-2 bg-muted/20">
              <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">Input</div>
              <pre className="text-xs text-foreground/80 font-mono whitespace-pre-wrap break-all">{input}</pre>
            </div>
          )}
          {output && (
            <div className="px-3 py-2 bg-muted/10">
              <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">Output</div>
              <pre className="text-xs text-foreground/80 font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto">{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  const fileBlocks = useMemo(() => {
    if (isUser || isSystem) return []
    return parseFileBlocks(message.content)
  }, [message.content, isUser, isSystem])

  const renderContent = useCallback(() => {
    if (isUser) {
      return (
        <div className="flex items-start gap-2">
          <p className="whitespace-pre-wrap text-foreground">{message.content}</p>
        </div>
      )
    }

    const parts: React.ReactNode[] = []
    let lastIndex = 0
    const sorted = [...fileBlocks].sort((a, b) => a.startIdx - b.startIdx)

    for (let i = 0; i < sorted.length; i++) {
      const block = sorted[i]
      if (block.startIdx > lastIndex) {
        const textBefore = message.content.slice(lastIndex, block.startIdx).trim()
        if (textBefore) {
          parts.push(
            <div key={`text-${i}`} className="prose prose-sm prose-invert max-w-none">
              <ReactMarkdown components={markdownComponents}>
                {textBefore}
              </ReactMarkdown>
            </div>
          )
        }
      }

      const langFromPath = block.path.split('.').pop() || 'text'
      parts.push(
        <FileCodeBlock
          key={`file-${i}`}
          language={langFromPath}
          filePath={block.path}
          fileType={block.type}
        >
          {block.code}
        </FileCodeBlock>
      )

      lastIndex = block.endIdx
    }

    if (lastIndex < message.content.length) {
      const remaining = message.content.slice(lastIndex).trim()
      if (remaining) {
        parts.push(
          <div key="remaining" className="prose prose-sm prose-invert max-w-none">
            <ReactMarkdown components={markdownComponents}>
              {remaining}
            </ReactMarkdown>
          </div>
        )
      }
    }

    if (sorted.length === 0) {
      return (
        <div className="prose prose-sm prose-invert max-w-none">
          <ReactMarkdown components={markdownComponents}>
            {message.content}
          </ReactMarkdown>
        </div>
      )
    }

    return parts
  }, [message.content, isUser, fileBlocks])

  if (isSystem) {
    return (
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground">
        <Circle className="size-1.5" />
        {message.content}
      </div>
    )
  }

  return (
    <div className={`cli-message flex gap-3 px-4 py-2.5 ${isUser ? '' : ''}`}>
      <div className="shrink-0 mt-0.5">
        {isUser ? (
          <div className="w-5 h-5 rounded-lg bg-secondary flex items-center justify-center">
            <User className="size-3 text-foreground" />
          </div>
        ) : (
          <div className="w-5 h-5 rounded-lg bg-primary/20 flex items-center justify-center">
            <Bot className="size-3 text-primary" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[11px] font-mono font-medium text-muted-foreground">
            {isUser ? 'user' : 'assistant'}
          </span>
          {message.isStreaming && (
            <Loader2 className="size-3 text-primary animate-spin" />
          )}
          {fileBlocks.length > 0 && !message.isStreaming && (
            <span className="text-[10px] text-primary bg-primary/10 px-1.5 py-0.5 rounded font-mono">
              {fileBlocks.length} files
            </span>
          )}
        </div>
        <div className={`text-sm leading-relaxed font-mono ${message.isStreaming && message.content === '' ? 'streaming-cursor' : ''}`}>
          {renderContent()}
        </div>
      </div>
    </div>
  )
}

export function ChatPanel() {
  const {
    chatMessages,
    isChatLoading,
    addChatMessage,
    updateChatMessage,
    setChatMessageStreaming,
    clearChatAndPersist,
    setChatLoading,
    openTabs,
    addTask,
    addMemory,
    setGoal,
    showToast,
    spawnSubAgent,
    completeSubAgent,
    persistToStorage,
    saveCheckpointChat,
  } = useHelixStore()

  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [agentMode, setAgentMode] = useState(false)
  const [agentLogs, setAgentLogs] = useState<AgentLogEntry[]>([])
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null)

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      const viewport =
        scrollRef.current.querySelector('[data-radix-scroll-area-viewport]') ||
        scrollRef.current.querySelector('[data-slot="scroll-area-viewport"]')
      if (viewport) {
        requestAnimationFrame(() => {
          viewport.scrollTop = viewport.scrollHeight
        })
      }
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [chatMessages, scrollToBottom])

  // Auto-scroll during streaming
  useEffect(() => {
    if (isChatLoading) {
      const interval = setInterval(scrollToBottom, 100)
      return () => clearInterval(interval)
    }
  }, [isChatLoading, scrollToBottom])

  const getActiveFileContext = useCallback(() => {
    const state = useHelixStore.getState()
    if (state.openTabs.length === 0) return ''
    const activeTab = state.openTabs.find((t) => t.id === state.activeTabId)
    if (!activeTab) return ''

    const file = state.getFileById(activeTab.fileId)
    if (!file?.content) return ''

    const lines = file.content.split('\n')
    const lineCount = lines.length
    const previewLines = lines.slice(0, 50)
    const truncated = lineCount > 50 ? `\n... (${lineCount} lines total, showing first 50)` : ''

    return `\n\nCurrent file: ${file.name}\n\`\`\`${file.language}\n${previewLines.join('\n')}${truncated}\n\`\`\``
  }, [openTabs])

  const getAllFilesContext = useCallback(() => {
    const state = useHelixStore.getState()
    const allFiles = state.getAllFiles()
    if (allFiles.length === 0) return ''
    return '\n\nProject files:\n' + allFiles.map(f => `  ${state.getFilePath(f.id)}`).join('\n')
  }, [])

  const handleSlashCommand = useCallback((text: string): boolean => {
    const state = useHelixStore.getState()
    const trimmed = text.trim()

    if (trimmed.startsWith('/goal ')) {
      const goal = trimmed.slice(6).trim()
      if (goal) {
        state.setGoal(goal)
        addChatMessage({ role: 'system', content: `Goal set: ${goal}` })
      }
      return true
    }

    if (trimmed === '/task' || trimmed.startsWith('/task ')) {
      const label = trimmed === '/task' ? prompt('任务名称:') : trimmed.slice(6).trim()
      if (label?.trim()) {
        state.addTask(label.trim())
        addChatMessage({ role: 'system', content: `Task added: ${label.trim()}` })
      }
      return true
    }

    if (trimmed.startsWith('/memory ')) {
      const content = trimmed.slice(8).trim()
      if (content) {
        state.addMemory({ content, category: 'decision' })
        addChatMessage({ role: 'system', content: 'Memory saved' })
      }
      return true
    }

    if (trimmed === '/clear') {
      clearChatAndPersist()
      return true
    }

    if (trimmed === '/save') {
      state.saveCheckpoint()
      state.saveCheckpointChat()
      addChatMessage({ role: 'system', content: 'Checkpoint saved & persisted' })
      return true
    }

    if (trimmed === '/persist') {
      state.persistToStorage()
      addChatMessage({ role: 'system', content: 'Persisted to IndexedDB' })
      return true
    }

    if (trimmed === '/restore') {
      state.restoreFromStorage().then(() => {
        addChatMessage({ role: 'system', content: 'Restored from IndexedDB' })
      })
      return true
    }

    if (trimmed === '/settings') {
      state.toggleSettings()
      return true
    }

    return false
  }, [addChatMessage, clearChatAndPersist])

  const handleSend = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || isChatLoading) return

    if (handleSlashCommand(trimmed)) {
      setInput('')
      return
    }

    setInput('')
    addChatMessage({ role: 'user', content: trimmed })
    setChatLoading(true)

    const assistantId = addChatMessage({
      role: 'assistant',
      content: '',
      isStreaming: true,
    })

    try {
      const state = useHelixStore.getState()

      // Agent mode: use /api/agent/run
      if (agentMode) {
        setAgentLogs([])
        const response = await fetch('/api/agent/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: chatMessages
              .filter((m) => m.role !== 'system' && !m.isStreaming)
              .map((m) => ({ role: m.role, content: m.content })),
            apiConfig: state.apiConfig,
          }),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Request failed' }))
          throw new Error(errorData.error || `请求失败 (${response.status})`)
        }

        const reader = response.body?.getReader()
        const decoder = new TextDecoder()
        let accumulated = ''

        if (reader) {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const chunk = decoder.decode(value, { stream: true })
            const lines = chunk.split('\n')

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6)
                if (data === '[DONE]') continue
                try {
                  const parsed = JSON.parse(data)

                  if (parsed.type === 'text') {
                    accumulated += parsed.content
                    updateChatMessage(assistantId, accumulated)
                  } else if (parsed.type === 'tool_call') {
                    setAgentLogs(prev => [...prev, {
                      type: 'tool_call',
                      content: `调用 ${parsed.toolName}`,
                      toolName: parsed.toolName,
                      toolParams: parsed.toolParams,
                      timestamp: Date.now(),
                    }])
                  } else if (parsed.type === 'tool_result') {
                    setAgentLogs(prev => [...prev, {
                      type: 'tool_result',
                      content: parsed.content,
                      toolName: parsed.toolName,
                      timestamp: Date.now(),
                    }])
                  } else if (parsed.type === 'thinking') {
                    setAgentLogs(prev => [...prev, {
                      type: 'thinking',
                      content: parsed.content,
                      timestamp: Date.now(),
                    }])
                  } else if (parsed.type === 'error') {
                    setAgentLogs(prev => [...prev, {
                      type: 'error',
                      content: parsed.content,
                      timestamp: Date.now(),
                    }])
                    accumulated += `\n\n⚠️ ${parsed.content}`
                    updateChatMessage(assistantId, accumulated)
                  } else if (parsed.type === 'approval_request') {
                    setApprovalRequest({
                      id: parsed.approvalId,
                      toolName: parsed.toolName,
                      params: parsed.toolParams || {},
                      timestamp: Date.now(),
                    })
                  }
                } catch {
                  // skip
                }
              }
            }
          }
        }

        setChatMessageStreaming(assistantId, false)
        state.persistToStorage()
        return
      }

      // Regular chat mode
      const fileContext = getActiveFileContext()
      const allFilesContext = getAllFilesContext()
      const memoryContext = state.getMemoryContext()
      const taskContext = state.getTaskContext()

      const systemPrompt = `你是 Helix，一个专业的 AI 编程助手。请用中文回答。
当需要修改或创建文件时，请使用以下格式：
- 修改已有文件：@@file:路径/文件名.ext 后面跟代码内容
- 创建新文件：@@create:路径/文件名.ext 后面跟代码内容`

      const response = await fetch('/api/helix/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: systemPrompt + fileContext + allFilesContext + memoryContext + taskContext,
            },
            ...chatMessages
              .filter((m) => m.role !== 'system' && !m.isStreaming)
              .map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: trimmed },
          ],
          apiConfig: state.apiConfig,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(errorData.error || `请求失败 (${response.status})`)
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value, { stream: true })
          const lines = chunk.split('\n')

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6)
              if (data === '[DONE]') continue
              try {
                const parsed = JSON.parse(data)
                const content = parsed.choices?.[0]?.delta?.content || ''
                if (content) {
                  accumulated += content
                  updateChatMessage(assistantId, accumulated)
                }
              } catch {
                // skip
              }
            }
          }
        }
      }

      setChatMessageStreaming(assistantId, false)
      useHelixStore.getState().persistToStorage()
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接失败，请检查网络和 API 设置'
      updateChatMessage(assistantId, `错误: ${message}`)
      setChatMessageStreaming(assistantId, false)
    } finally {
      setChatLoading(false)
    }
  }, [input, isChatLoading, chatMessages, addChatMessage, updateChatMessage, setChatMessageStreaming, setChatLoading, getActiveFileContext, getAllFilesContext])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend, input]
  )

  const slashCommands = [
    { cmd: '/goal', desc: '设置目标' },
    { cmd: '/task', desc: '添加任务' },
    { cmd: '/memory', desc: '保存记忆' },
    { cmd: '/clear', desc: '清空对话' },
    { cmd: '/settings', desc: '打开设置' },
  ]

  const showSlashHints = input.startsWith('/') && !input.includes(' ')
  const matchedCommands = showSlashHints
    ? slashCommands.filter(c => c.cmd.startsWith(input.toLowerCase()))
    : []

  const apiConfig = useHelixStore(s => s.apiConfig)
  const toggleSettings = useHelixStore(s => s.toggleSettings)
  const hasApiKey = !!apiConfig.apiKey

  const handleApproval = useCallback(async (approvalId: string, approved: boolean) => {
    try {
      await fetch('/api/agent/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId, action: approved ? 'approve' : 'reject' }),
      })
      setApprovalRequest(null)
    } catch (err) {
      console.error('Approval error:', err)
    }
  }, [])

  return (
    <div className="h-full flex bg-background font-mono">
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Messages */}
        <ScrollArea ref={scrollRef} className="flex-1 min-h-0">
          <div className="max-w-3xl mx-auto flex flex-col py-4">
            {chatMessages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 px-4">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                  <Bot className="size-5 text-primary" />
                </div>
                <h2 className="text-base font-semibold text-foreground mb-1">Helix</h2>
                <p className="text-xs text-muted-foreground text-center max-w-sm">
                  AI 编程助手。输入消息或使用 / 命令。
                </p>
                <div className="mt-6 text-[11px] text-muted-foreground/60 space-y-1 text-center">
                  <p>Tab — switch mode &middot; / — commands &middot; Enter — send</p>
                </div>
              </div>
            )}

            {chatMessages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
          </div>
        </ScrollArea>

        {/* API config warning */}
        {!hasApiKey && (
          <div className="mx-3 mb-2 px-3 py-2 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-xs text-yellow-600 dark:text-yellow-400 flex items-center justify-between">
            <span>尚未配置 API Key，请先在设置中配置模型提供商</span>
            <button
              onClick={toggleSettings}
              className="ml-2 px-2 py-0.5 bg-yellow-500/20 hover:bg-yellow-500/30 rounded-lg text-[10px] font-medium transition-colors"
            >
              打开设置
            </button>
          </div>
        )}

        {/* Input area - CLI style */}
        <div className="border-t border-border bg-card">
          <div className="max-w-3xl mx-auto p-3 relative">
            {/* Slash command hints */}
            {matchedCommands.length > 0 && (
              <div className="absolute bottom-full left-3 right-3 mb-2 bg-popover border border-border rounded-xl shadow-xl py-1 z-10">
                {matchedCommands.map(c => (
                  <button
                    key={c.cmd}
                    onClick={() => { setInput(c.cmd + ' '); inputRef.current?.focus() }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono hover:bg-accent/50 transition-colors"
                  >
                    <span className="text-primary">{c.cmd}</span>
                    <span className="text-muted-foreground">{c.desc}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-end gap-2 bg-background rounded-xl border border-border focus-within:border-primary/50 px-3 py-2 transition-colors">
              <VoiceInput
                onResult={(text) => setInput(prev => prev ? prev + ' ' + text : text)}
                disabled={isChatLoading}
              />
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入消息..."
                rows={1}
                className="flex-1 resize-none bg-transparent text-sm font-mono outline-none placeholder:text-muted-foreground/40 min-h-[24px] max-h-[120px]"
                style={{
                  height: 'auto',
                  overflow: 'hidden',
                }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement
                  target.style.height = 'auto'
                  target.style.height = Math.min(target.scrollHeight, 120) + 'px'
                }}
              />
              <div className="flex items-center gap-1">
                <Button
                  size="icon"
                  className="size-7 shrink-0 rounded bg-primary hover:bg-primary/90"
                  onClick={handleSend}
                  disabled={!input.trim() || isChatLoading}
                >
                  {isChatLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Send className="size-3.5" />
                  )}
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between mt-2 px-1">
              <button
                onClick={() => setAgentMode(!agentMode)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-medium transition-colors ${
                  agentMode
                    ? 'bg-primary/20 text-primary border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
              >
                <Wrench className="size-3" />
                Agent 模式
              </button>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground/40 font-mono">
                <span>/ — commands</span>
              </div>
            </div>
          </div>
        </div>

        {/* Agent Log */}
        {agentMode && agentLogs.length > 0 && (
          <AgentLog entries={agentLogs} isRunning={isChatLoading} />
        )}
      </div>

      {/* Status Bar */}
      <StatusBar />

      {/* Approval Dialog */}
      {approvalRequest && (
        <ApprovalDialog
          request={approvalRequest}
          onApprove={(id) => handleApproval(id, true)}
          onReject={(id) => handleApproval(id, false)}
        />
      )}
    </div>
  )
}
