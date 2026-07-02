'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import {
  Send,
  Loader2,
  Brain,
  Wrench,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Terminal,
  Search,
  FileText,
  FolderOpen,
  Pencil,
  Eye,
  ArrowDown,
  Sparkles,
  RotateCcw,
  Folder,
  X,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ApprovalDialog, type ApprovalRequest } from './approval-dialog'
import { useHelixStore, PROVIDER_PRESETS } from '@/stores/helix-store'

// ── Types ──────────────────────────────────────────────

interface FlowStep {
  id: string
  type: 'task' | 'thinking' | 'tool_call' | 'tool_result' | 'text' | 'error' | 'done'
  content: string
  toolName?: string
  toolParams?: Record<string, unknown>
  timestamp: number
  expanded?: boolean
}

// ── Helpers ────────────────────────────────────────────

function generateId(): string {
  return Math.random().toString(36).substr(2, 9)
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function getToolIcon(toolName: string) {
  const name = toolName.toLowerCase()
  if (name.includes('read') || name.includes('view')) return <Eye className="size-3.5" />
  if (name.includes('write') || name.includes('create')) return <Pencil className="size-3.5" />
  if (name.includes('edit') || name.includes('modify')) return <Pencil className="size-3.5" />
  if (name.includes('grep') || name.includes('search')) return <Search className="size-3.5" />
  if (name.includes('bash') || name.includes('shell') || name.includes('terminal')) return <Terminal className="size-3.5" />
  if (name.includes('glob') || name.includes('list')) return <FolderOpen className="size-3.5" />
  return <Wrench className="size-3.5" />
}

// ── Step Card ──────────────────────────────────────────

function StepCard({
  step,
  isLast,
  isRunning,
}: {
  step: FlowStep
  isLast: boolean
  isRunning: boolean
}) {
  const [expanded, setExpanded] = useState(step.type === 'tool_call' || step.type === 'tool_result')

  // Color scheme per type
  const config = {
    task: {
      bg: 'bg-blue-50',
      border: 'border-blue-300',
      dot: 'bg-blue-500',
      icon: <Sparkles className="size-4 text-blue-600" />,
      label: '任务',
      labelColor: 'text-blue-700',
      line: 'border-blue-200',
    },
    thinking: {
      bg: 'bg-gray-50',
      border: 'border-[#F0ECE4]',
      dot: 'bg-gray-400',
      icon: <Brain className="size-4 text-[#1C1A16]/40" />,
      label: '思考',
      labelColor: 'text-[#1C1A16]/50',
      line: 'border-[#F0ECE4]',
    },
    tool_call: {
      bg: 'bg-green-50',
      border: 'border-green-300',
      dot: 'bg-green-500',
      icon: getToolIcon(step.toolName || ''),
      label: step.toolName || '工具调用',
      labelColor: 'text-green-700',
      line: 'border-green-200',
    },
    tool_result: {
      bg: 'bg-sky-50',
      border: 'border-sky-300',
      dot: 'bg-sky-500',
      icon: <CheckCircle2 className="size-4 text-sky-600" />,
      label: `${step.toolName || 'tool'} 结果`,
      labelColor: 'text-sky-700',
      line: 'border-sky-200',
    },
    text: {
      bg: 'bg-emerald-50',
      border: 'border-emerald-300',
      dot: 'bg-emerald-500',
      icon: <CheckCircle2 className="size-4 text-emerald-600" />,
      label: '回复',
      labelColor: 'text-emerald-700',
      line: 'border-emerald-200',
    },
    error: {
      bg: 'bg-red-50',
      border: 'border-red-300',
      dot: 'bg-red-500',
      icon: <AlertCircle className="size-4 text-red-500" />,
      label: '错误',
      labelColor: 'text-red-600',
      line: 'border-red-200',
    },
    done: {
      bg: 'bg-emerald-50',
      border: 'border-emerald-300',
      dot: 'bg-emerald-500',
      icon: <CheckCircle2 className="size-4 text-emerald-600" />,
      label: '完成',
      labelColor: 'text-emerald-700',
      line: 'border-emerald-200',
    },
  }[step.type]

  const hasContent = step.content && step.content.trim().length > 0
  const showExpandToggle = step.type === 'tool_call' || step.type === 'tool_result' || (step.type === 'thinking' && hasContent)

  return (
    <div className="relative flex gap-3">
      {/* Timeline dot + line */}
      <div className="flex flex-col items-center shrink-0 pt-2">
        <div className={`w-8 h-8 rounded-full ${config.bg} ${config.border} border-2 flex items-center justify-center`}>
          {config.icon}
        </div>
        {/* Connecting line */}
        {!isLast && (
          <div className={`w-0.5 flex-1 mt-1 mb-1 ${config.line} border-l-2 min-h-[16px]`} />
        )}
        {isLast && isRunning && (
          <div className="w-0.5 flex-1 mt-1 mb-1 border-l-2 border-dashed border-[#F0ECE4] min-h-[16px]" />
        )}
      </div>

      {/* Card content */}
      <div className={`flex-1 mb-2 rounded-xl ${config.bg} ${config.border} border overflow-hidden`}>
        {/* Header */}
        <div
          className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-black/[0.02] transition-colors ${showExpandToggle ? '' : 'cursor-default'}`}
          onClick={() => showExpandToggle && setExpanded(!expanded)}
        >
          <div className={`w-1.5 h-1.5 rounded-full ${config.dot} shrink-0`} />
          <span className={`text-[11px] font-semibold ${config.labelColor}`}>
            {config.label}
          </span>
          {step.type === 'tool_call' && step.toolParams && Object.keys(step.toolParams).length > 0 && (
            <span className="text-[10px] text-[#1C1A16]/40 font-mono bg-[#F0ECE4] px-1.5 py-0.5 rounded">
              {Object.keys(step.toolParams).length} 参数
            </span>
          )}
          <span className="text-[10px] text-[#1C1A16]/40 ml-auto font-mono">
            {formatTime(step.timestamp)}
          </span>
          {showExpandToggle && (
            expanded
              ? <ChevronDown className="size-3 text-[#1C1A16]/40 shrink-0" />
              : <ChevronRight className="size-3 text-[#1C1A16]/40 shrink-0" />
          )}
        </div>

        {/* Expanded content */}
        {expanded && (
          <div className="px-3 pb-2.5 pt-0">
            {/* Task content */}
            {step.type === 'task' && (
              <p className="text-sm text-gray-800 leading-relaxed">{step.content}</p>
            )}

            {/* Thinking content */}
            {step.type === 'thinking' && hasContent && (
              <p className="text-xs text-[#1C1A16]/50 leading-relaxed italic">{step.content}</p>
            )}

            {/* Tool call params */}
            {step.type === 'tool_call' && step.toolParams && (
              <div className="space-y-1.5">
                {Object.entries(step.toolParams).map(([key, value]) => (
                  <div key={key} className="flex flex-col">
                    <span className="text-[10px] text-[#1C1A16]/40 font-medium uppercase tracking-wide">{key}</span>
                    <pre className="text-[11px] text-[#1C1A16]/70 bg-white/60 rounded px-2 py-1.5 overflow-x-auto font-mono border border-[#F0ECE4]/50">
                      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            )}

            {/* Tool result */}
            {step.type === 'tool_result' && hasContent && (
              <pre className="text-[11px] text-[#1C1A16]/70 bg-white/60 rounded p-2 overflow-x-auto font-mono max-h-48 overflow-y-auto border border-[#F0ECE4]/50 whitespace-pre-wrap break-all">
                {step.content}
              </pre>
            )}

            {/* Text response */}
            {(step.type === 'text' || step.type === 'done') && hasContent && (
              <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{step.content}</p>
            )}

            {/* Error */}
            {step.type === 'error' && hasContent && (
              <pre className="text-[11px] text-red-600 bg-red-50 rounded p-2 overflow-x-auto font-mono whitespace-pre-wrap break-all">
                {step.content}
              </pre>
            )}
          </div>
        )}

        {/* Non-expandable content (task, text, error when not expanded) */}
        {!expanded && !showExpandToggle && hasContent && (
          <div className="px-3 pb-2.5">
            {step.type === 'task' && (
              <p className="text-sm text-gray-800 leading-relaxed">{step.content}</p>
            )}
            {(step.type === 'text' || step.type === 'done') && (
              <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{step.content}</p>
            )}
            {step.type === 'error' && (
              <pre className="text-[11px] text-red-600 bg-red-50 rounded p-2 overflow-x-auto font-mono whitespace-pre-wrap break-all">
                {step.content}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Empty State ────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center h-full px-4 pt-[81px]">
      <div className="w-12 h-12 rounded-xl bg-black flex items-center justify-center mb-4 overflow-hidden">
        <svg viewBox="0 0 32 32" className="size-8" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* 耳朵 */}
          <rect x="5" y="2" width="6" height="4" fill="#f87171" />
          <rect x="21" y="2" width="6" height="4" fill="#f87171" />
          <rect x="6" y="3" width="4" height="2" fill="#fecaca" />
          <rect x="22" y="3" width="4" height="2" fill="#fecaca" />

          {/* 脸部外框 */}
          <rect x="4" y="6" width="24" height="18" rx="1" fill="#facc15" />

          {/* 眼睛 */}
          <rect x="8" y="11" width="5" height="5" fill="#1c1917" />
          <rect x="19" y="11" width="5" height="5" fill="#1c1917" />
          <rect x="9" y="12" width="2" height="2" fill="#ffffff" />
          <rect x="20" y="12" width="2" height="2" fill="#ffffff" />

          {/* 腮红 */}
          <rect x="5" y="17" width="4" height="2" fill="#f87171" opacity="0.7" />
          <rect x="23" y="17" width="4" height="2" fill="#f87171" opacity="0.7" />

          {/* 鼻子 */}
          <rect x="14" y="16" width="4" height="2" fill="#1c1917" />

          {/* 嘴 */}
          <rect x="13" y="20" width="2" height="1" fill="#1c1917" />
          <rect x="17" y="20" width="2" height="1" fill="#1c1917" />
          <rect x="15" y="18" width="2" height="2" fill="#1c1917" />
        </svg>
      </div>
      <h2 className="text-base font-semibold mb-1">Helix</h2>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────

export function AgentFlowPanel() {
  const [steps, setSteps] = useState<FlowStep[]>([])
  const [input, setInput] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [showSkillDropdown, setShowSkillDropdown] = useState(false)
  const [skillFilter, setSkillFilter] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const savedSessionRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)
  const skillDropdownRef = useRef<HTMLDivElement>(null)

  const { apiConfig, availableModels, skills, showToast, toggleSettings, toggleSkillPanel, addExecutionStep, addAccessedDirectory, agentExecutionSteps, chatMessages, clearExecutionFlow, notifySessionSaved, setApiConfig } = useHelixStore()
  const hasApiKey = !!apiConfig.apiKey

  // Get available models - use store's availableModels first, fallback to presets
  const getAvailableModels = useCallback(() => {
    if (availableModels.length > 0) {
      return availableModels
    }
    const provider = apiConfig.provider
    if (provider === 'custom') return []
    const preset = PROVIDER_PRESETS[provider]
    return preset?.models || []
  }, [availableModels, apiConfig.provider])

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setShowModelDropdown(false)
      }
    }
    if (showModelDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showModelDropdown])

  // Handle model selection
  const handleModelSelect = useCallback((model: string) => {
    setApiConfig({ model })
    setShowModelDropdown(false)
  }, [setApiConfig])

  // Handle skill selection
  const handleSkillSelect = useCallback((skill: typeof skills[0]) => {
    setInput(skill.prompt)
    setShowSkillDropdown(false)
    setSkillFilter('')
    inputRef.current?.focus()
  }, [])

  // Debug: Log chatMessages changes
  useEffect(() => {
    console.log('chatMessages updated:', chatMessages.length, chatMessages.map(m => ({ role: m.role, content: m.content?.slice(0, 50) })))
  }, [chatMessages])

  // Debug: Log steps changes
  useEffect(() => {
    console.log('steps updated:', steps.length, steps.map(s => ({ type: s.type, content: s.content?.slice(0, 50) })))
  }, [steps])

  // Filter skills based on input
  const filteredSkills = skills.filter(skill => 
    skill.name.toLowerCase().includes(skillFilter.toLowerCase()) ||
    skill.description.toLowerCase().includes(skillFilter.toLowerCase())
  )

  // Handle input change for skill detection
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInput(value)
    
    // Show skill dropdown when typing /
    if (value === '/') {
      setShowSkillDropdown(true)
      setSkillFilter('')
    } else if (value.startsWith('/')) {
      setShowSkillDropdown(true)
      setSkillFilter(value.slice(1))
    } else {
      setShowSkillDropdown(false)
    }
  }, [])

  // Close skill dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (skillDropdownRef.current && !skillDropdownRef.current.contains(event.target as Node)) {
        setShowSkillDropdown(false)
      }
    }
    if (showSkillDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showSkillDropdown])

  // Auto-scroll to bottom
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
  }, [steps, scrollToBottom])

  useEffect(() => {
    if (isRunning) {
      const interval = setInterval(scrollToBottom, 200)
      return () => clearInterval(interval)
    }
  }, [isRunning, scrollToBottom])

  // Sync local steps when store execution flow is cleared externally (e.g. New task)
  useEffect(() => {
    if (agentExecutionSteps.length === 0 && steps.length > 0) {
      setSteps([])
      savedSessionRef.current = false
    }
  }, [agentExecutionSteps.length, steps.length])

  // Reset save ref when chat is cleared
  const prevMsgLen = useRef(chatMessages.length)
  useEffect(() => {
    // Detect clear: messages went from many to few (welcome message)
    if (prevMsgLen.current > 2 && chatMessages.length <= 1) {
      savedSessionRef.current = false
    }
    prevMsgLen.current = chatMessages.length
  }, [chatMessages.length])

  // Clear flow
  const handleClear = useCallback(() => {
    setSteps([])
    clearExecutionFlow()
  }, [clearExecutionFlow])

  // Stop running agent
  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setIsRunning(false)
  }, [])

  // File picker handler
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    const paths: string[] = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      // webkitRelativePath gives the full relative path inside a selected folder
      paths.push(f.webkitRelativePath || f.name)
    }
    setSelectedFiles(prev => [...new Set([...prev, ...paths])])
  }, [])

  const removeFile = useCallback((path: string) => {
    setSelectedFiles(prev => prev.filter(p => p !== path))
  }, [])

  // Run agent task
  const handleRun = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || isRunning) return

    // Check API key
    if (!hasApiKey) {
      showToast({ type: 'warning', title: '请先配置 API Key', description: '在设置中配置模型提供商' })
      toggleSettings()
      return
    }

    setInput('')
    setIsRunning(true)

    // Add user message to store
    const storeState = useHelixStore.getState()
    storeState.addChatMessage({ role: 'user', content: trimmed })

    // Add task step
    const taskStep: FlowStep = {
      id: generateId(),
      type: 'task',
      content: trimmed,
      timestamp: Date.now(),
    }
    setSteps(prev => [...prev, taskStep])

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const state = useHelixStore.getState()
      const systemPrompt = `你是 Helix，一个专业的 AI 编程助手。请用中文回答。
当需要修改或创建文件时，请使用以下格式：
- 修改已有文件：@@file:路径/文件名.ext 后面跟代码内容
- 创建新文件：@@create:路径/文件名.ext 后面跟代码内容`

      const response = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: trimmed }],
          apiConfig: state.apiConfig,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(errorData.error || `请求失败 (${response.status})`)
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

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

                if (parsed.type === 'thinking') {
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'thinking', content: parsed.content, timestamp: Date.now() }])
                  addExecutionStep({ type: 'thinking' })
                } else if (parsed.type === 'tool_call') {
                  // Extract file paths from tool params to track directories
                  const params = parsed.toolParams || {}
                  let filePath = ''
                  if (params.path) {
                    filePath = String(params.path)
                    const dir = filePath.split('/').slice(0, -1).join('/') || '/'
                    addAccessedDirectory(dir)
                  } else if (params.command && typeof params.command === 'string') {
                    // Track bash commands that reference paths
                    const match = params.command.match(/[`'"]?([\w/.-]+(?:\.\w+)+)[`'"]?/g)
                    if (match) {
                      match.forEach(p => {
                        const dir = p.replace(/[`'"]/g, '').split('/').slice(0, -1).join('/')
                        if (dir) addAccessedDirectory(dir)
                      })
                    }
                  }
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'tool_call', content: `调用 ${parsed.toolName}`, toolName: parsed.toolName, toolParams: params, timestamp: Date.now() }])
                  addExecutionStep({ type: 'tool_call', toolName: parsed.toolName, path: filePath || undefined })
                } else if (parsed.type === 'tool_result') {
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'tool_result', content: parsed.content, toolName: parsed.toolName, timestamp: Date.now() }])
                  addExecutionStep({ type: 'tool_result', toolName: parsed.toolName })
                } else if (parsed.type === 'text') {
                  console.log('Received text response:', parsed.content)
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'text', content: parsed.content, timestamp: Date.now() }])
                  addExecutionStep({ type: 'text' })
                  // Also save to chat history
                  const curState = useHelixStore.getState()
                  curState.addChatMessage({ role: 'assistant', content: parsed.content })
                  console.log('Added assistant message to chatMessages')
                } else if (parsed.type === 'error') {
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'error', content: parsed.content, timestamp: Date.now() }])
                  addExecutionStep({ type: 'error' })
                } else if (parsed.type === 'done') {
                  addExecutionStep({ type: 'done' })
                } else if (parsed.type === 'approval_request') {
                  setApprovalRequest({
                    id: parsed.approvalId,
                    toolName: parsed.toolName,
                    params: parsed.toolParams || {},
                    timestamp: Date.now(),
                  })
                }
              } catch {
                // skip non-JSON lines
              }
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setSteps(prev => [...prev, {
          id: generateId(),
          type: 'error',
          content: '用户取消了执行',
          timestamp: Date.now(),
        }])
      } else {
        const message = error instanceof Error ? error.message : '连接失败，请检查网络和 API 设置'
        setSteps(prev => [...prev, {
          id: generateId(),
          type: 'error',
          content: message,
          timestamp: Date.now(),
        }])
      }
    } finally {
      setIsRunning(false)
      abortRef.current = null
      // Save conversation to persisted sessions (once per conversation)
      if (!savedSessionRef.current) {
        const state = useHelixStore.getState()
        if (state.chatMessages.length > 1) {
          try {
            const { persistence } = await import('@/lib/persist')
            const firstUser = state.chatMessages.find(m => m.role === 'user')
            const label = firstUser ? firstUser.content.slice(0, 50) : '对话 ' + new Date().toLocaleDateString()
            await persistence.saveSession({
              label,
              goal: state.goal,
              memories: state.memories.map(m => ({
                id: m.id,
                content: m.content,
                category: m.category,
                createdAt: m.createdAt,
              })),
              tasks: state.tasks.map(t => ({
                id: t.id,
                label: t.label,
                status: t.status,
                children: t.children as any,
              })),
              notes: state.notes,
              checkpoints: state.checkpoints.map(c => ({
                id: c.id,
                label: c.label,
                timestamp: c.timestamp,
                taskIds: c.taskIds,
                memorySnapshot: c.memorySnapshot,
              })),
              chatMessages: state.chatMessages.map(m => ({
                id: m.id,
                sessionId: 'session-' + Date.now(),
                role: m.role,
                content: m.content,
                timestamp: m.timestamp,
                isStreaming: false,
              })),
              files: [],
            })
            savedSessionRef.current = true
            notifySessionSaved()
          } catch (e) {
            console.error('Failed to auto-save session:', e)
          }
        }
      }
    }
  }, [input, isRunning, hasApiKey, showToast, toggleSettings])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleRun()
      }
    },
    [handleRun]
  )

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

  // Stats
  const thinkingCount = steps.filter(s => s.type === 'thinking').length
  const toolCallCount = steps.filter(s => s.type === 'tool_call').length
  const hasSteps = steps.length > 0

  return (
    <div className="h-full flex flex-col bg-transparent text-[#1C1A16]">
      {/* Header bar */}
      <div className="flex items-center justify-end px-4 py-2 shrink-0">
        <div className="flex items-center gap-1">
          {hasSteps && (
            <div className="flex items-center gap-2 text-[10px] text-[#1C1A16]/50">
              {thinkingCount > 0 && (
                <span className="flex items-center gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                  {thinkingCount} 思考
                </span>
              )}
              {toolCallCount > 0 && (
                <span className="flex items-center gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  {toolCallCount} 调用
                </span>
              )}
            </div>
          )}
          {hasSteps && (
            <button
              onClick={handleClear}
              className="flex items-center gap-1 px-2 py-1 text-[10px] text-[#1C1A16]/50 hover:text-[#1C1A16] hover:bg-[#F0ECE4] rounded-lg transition-colors ml-2"
            >
              <RotateCcw className="size-3" />
              清空
            </button>
          )}
        </div>
      </div>

      {/* Flow area */}
      <ScrollArea ref={scrollRef} className="flex-1 min-h-0">
        <div className="max-w-3xl mx-auto px-4 py-4 pb-0">
          {chatMessages.length === 0 && !hasSteps ? (
            <EmptyState />
          ) : (
            <div className="space-y-0">
              {/* Chat messages (input/output) */}
              {chatMessages.map(msg => (
                <div key={msg.id} className="flex gap-3 mb-2">
                  <div className="shrink-0 mt-0.5">
                    <div className={msg.role === 'user'
                      ? 'w-8 h-8 rounded-full bg-[#F0ECE4] border border-[#F0ECE4]/70 flex items-center justify-center'
                      : 'w-8 h-8 rounded-full bg-green-100 border border-green-200 flex items-center justify-center'
                    }>
                      {msg.role === 'user' ? (
                        <span className="text-xs font-medium text-[#1C1A16]/60">U</span>
                      ) : (
                        <span className="text-xs font-medium text-green-600">H</span>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 pt-1">
                    <div className="text-[11px] text-[#1C1A16]/50 font-medium mb-0.5">
                      {msg.role === 'user' ? 'You' : 'Helix'}
                    </div>
                    <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">
                      {msg.content}
                    </p>
                  </div>
                </div>
              ))}
              {/* Execution steps (thinking, tool calls, etc.) */}
              {steps.map((step, i) => (
                <StepCard
                  key={step.id}
                  step={step}
                  isLast={i === steps.length - 1}
                  isRunning={isRunning}
                />
              ))}
              {isRunning && (
                <div className="flex items-center gap-2 pl-11 py-2">
                  <Loader2 className="size-3.5 text-green-500 animate-spin" />
                  <span className="text-[11px] text-[#1C1A16]/40">执行中...</span>
                </div>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* API key warning */}
      {!hasApiKey && (
        <div className="mx-4 mb-2 px-3 py-2 bg-amber-50/80 border border-amber-200 rounded-xl text-xs text-amber-700 flex items-center justify-between">
          <span>尚未配置 API Key</span>
          <button
            onClick={toggleSettings}
            className="ml-2 px-2 py-0.5 bg-yellow-200 hover:bg-yellow-300 rounded text-[10px] font-medium transition-colors"
          >
            打开设置
          </button>
        </div>
      )}

      {/* Bottom input */}
      <div className="bg-transparent shrink-0 mb-4">
        <div className="max-w-4xl mx-auto px-6 -translate-y-[60px]">
          <div className="bg-[#FCFBF9] rounded-[12px] border border-[#F0ECE4] focus-within:border-green-400/50 transition-colors shadow-sm">
            {/* Textarea - first row */}
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="输入需求或 / 调用技能..."
              rows={3}
              className="w-full resize-none bg-transparent text-sm text-left placeholder:text-left placeholder:text-[#1C1A16]/30 outline-none min-h-[56px] max-h-[200px] leading-relaxed px-4 pt-3"
              style={{
                height: 'auto',
                overflow: 'hidden',
              }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement
                target.style.height = 'auto'
                target.style.height = Math.min(target.scrollHeight, 200) + 'px'
              }}
            />

            {/* Icons and send button - second row */}
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="p-1.5 text-[#1C1A16]/40 hover:text-[#1C1A16]/70 hover:bg-[#F0ECE4] rounded-lg transition-colors"
                  title="选择文件或目录"
                >
                  <Folder className="size-4" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  webkitdirectory=""
                  className="hidden"
                  onChange={handleFileSelect}
                />
                {/* Skill selector */}
                <div className="relative" ref={skillDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setShowSkillDropdown(!showSkillDropdown)}
                    className="p-1.5 text-[#1C1A16]/40 hover:text-[#1C1A16]/70 hover:bg-[#F0ECE4] rounded-lg transition-colors"
                    title="技能 (输入 / 触发)"
                  >
                    <Zap className="size-4" />
                  </button>
                  {showSkillDropdown && (
                    <div className="absolute bottom-full left-0 mb-1 w-64 bg-white rounded-xl border border-[#F0ECE4] shadow-lg py-1 z-50">
                      <div className="px-3 py-1.5 text-[10px] text-[#1C1A16]/40 border-b border-[#F0ECE4]">
                        选择技能或输入 / 触发
                      </div>
                      {filteredSkills.map(skill => (
                        <button
                          key={skill.id}
                          type="button"
                          onClick={() => handleSkillSelect(skill)}
                          className="w-full text-left px-3 py-2 hover:bg-[#F0ECE4] transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <span>{skill.icon || '⚡'}</span>
                            <span className="text-[11px] font-medium text-[#1C1A16]">{skill.name}</span>
                          </div>
                          <p className="text-[10px] text-[#1C1A16]/50 ml-6">{skill.description}</p>
                        </button>
                      ))}
                      {filteredSkills.length === 0 && (
                        <div className="px-3 py-2 text-[11px] text-[#1C1A16]/40">
                          没有找到匹配的技能
                        </div>
                      )}
                      <div className="border-t border-[#F0ECE4] mt-1 pt-1">
                        <button
                          type="button"
                          onClick={() => {
                            setShowSkillDropdown(false)
                            toggleSkillPanel()
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-[#F0ECE4] transition-colors text-[11px] text-primary"
                        >
                          管理技能...
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                {/* Model selector */}
                {hasApiKey && (
                  <div className="relative" ref={modelDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setShowModelDropdown(!showModelDropdown)}
                      className="flex items-center gap-1.5 text-[10px] text-[#1C1A16]/60 hover:text-[#1C1A16]/80 hover:bg-[#F0ECE4] px-2 py-1 rounded-lg transition-colors"
                    >
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                      <span className="font-mono">{apiConfig.model || '选择模型'}</span>
                      <ChevronDown className="size-3" />
                    </button>
                    {showModelDropdown && (
                      <div className="absolute bottom-full left-0 mb-1 w-48 bg-white rounded-xl border border-[#F0ECE4] shadow-lg py-1 z-50">
                        {getAvailableModels().map(model => (
                          <button
                            key={model}
                            type="button"
                            onClick={() => handleModelSelect(model)}
                            className={`w-full text-left px-3 py-1.5 text-[11px] font-mono hover:bg-[#F0ECE4] transition-colors ${
                              apiConfig.model === model ? 'text-blue-600 bg-blue-50' : 'text-[#1C1A16]/70'
                            }`}
                          >
                            {model}
                          </button>
                        ))}
                        {getAvailableModels().length === 0 && (
                          <div className="px-3 py-1.5 text-[11px] text-[#1C1A16]/40">
                            请在设置中配置
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center">
                {isRunning ? (
                  <Button
                    size="icon"
                    className="size-7 rounded-lg bg-red-500 hover:bg-red-600"
                    onClick={handleStop}
                  >
                    <div className="w-2.5 h-2.5 bg-white rounded-sm" />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    className="size-7 rounded-lg bg-green-600 hover:bg-green-700"
                    onClick={handleRun}
                    disabled={!input.trim()}
                  >
                    <Send className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Selected files */}
          {selectedFiles.length > 0 && (
            <div className="mt-2 px-1 flex flex-wrap gap-1">
              {selectedFiles.slice(0, 10).map(f => (
                <div key={f} className="flex items-center gap-1 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded-lg text-[10px] text-blue-700 font-mono">
                  <FileText className="size-2.5" />
                  <span className="truncate max-w-[160px]">{f.split('/').pop() || f}</span>
                  <button onClick={() => removeFile(f)} className="hover:text-red-500 ml-0.5">
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
              {selectedFiles.length > 10 && (
                <span className="text-[10px] text-[#1C1A16]/40 self-center">+{selectedFiles.length - 10} 个文件</span>
              )}
            </div>
          )}

        </div>
      </div>

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
