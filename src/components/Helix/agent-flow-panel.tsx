'use client'

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  Send,
  Brain,
  Wrench,
  Circle,
  AlertCircle,
  Code2,
  FileCode,
  FileText,
  BarChart3,
  Copy,
  Check,
  ChevronRight,
  ChevronDown,
  Terminal,
  Search,
  Folder,
  FolderOpen,
  Pencil,
  Eye,
  ArrowDown,
  ArrowUp,
  RotateCcw,
  X,
  Square,
  Plus,
  FolderPlus,
  Clock,
  Loader2,
  Hand,
  AlertTriangle,
  Monitor,
  GitBranch,
  Pause,
  Download,
  Trash,
  BookOpen,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { generateId, timeAgo, formatTokens } from '@/lib/format'
import { ContextUsageIndicator } from './context-usage'
import { decodeBase64Utf8, extractThinkTags, normalizeAcpContent, stripEmoji, safeMarkdownSource, stripSystemReminders } from '@/lib/text-utils'
import { getToolLabel, getToolIcon, getToolDisplayLabel, extractCommandSnippet, extractToolPath } from '@/lib/tool-display-utils'
import { extractScheduledTasks } from '@/lib/schedule-utils'
import { InlineToolGroup } from './inline-tool-group'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import { ApprovalDialog, type ApprovalRequest } from './approval-dialog'
import { useHelixStore, type ImageAttachment, type FileAttachment, type ExecutionStep, type StreamingResponseBlock } from '@/stores/helix-store'
import { useHermesStore } from '@/stores/hermes-store'
import { processClipboardImage, canAddMoreImages, blobToDataUrl } from '@/lib/image-utils'
import { isElectron, electronDialog, electronHermes, electronGit } from '@/lib/electron-bridge'
import ReactMarkdown from 'react-markdown'
import { markdownComponents, markdownPlugins } from './markdown-components'
import type { HermesTodo } from '@/stores/helix-types'

// ==== Types ============================================================================================



// ==== Interleaved response blocks (text -> tool groups) ====

type ResponseBlock = StreamingResponseBlock

// InlineToolGroup — extracted to ./inline-tool-group.tsx

// ==== Helpers ========================================================================================

function WaveLoader({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-[3px] ${className}`}>
      {[0, 1, 2, 3].map(i => (
        <span
          key={i}
          className="size-[4px] rounded-full bg-current"
          style={{ animation: `waveDot 0.9s ease-in-out ${i * 0.16}s infinite` }}
        />
      ))}
    </span>
  )
}

const TEXTUAL_MIME_RE = /^(text\/|application\/(json|xml|javascript|typescript|x-sh|csv|yaml|toml|x-www-form-urlencoded)|image\/(svg\+xml))/
const TEXTUAL_EXT = /\.(txt|md|markdown|mdx|json|yml|yaml|toml|csv|ts|tsx|js|jsx|py|java|c|cpp|h|hpp|go|rs|rb|php|sh|bash|zsh|sql|html|htm|css|scss|less|xml|log|env|gitignore|dockerfile|makefile|rst|tex)$/i

function isTextualFile(file: File): boolean {
  if (TEXTUAL_MIME_RE.test(file.type)) return true
  return TEXTUAL_EXT.test(file.name)
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

// Convert a dropped/picked File into a FileAttachment (reads image preview + base64).
async function fileToAttachment(file: File): Promise<FileAttachment> {
  const isImage = file.type.startsWith('image/')
  const dataUrl = await blobToDataUrl(file)
  return {
    id: generateId(),
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    kind: isImage ? 'image' : (isTextualFile(file) ? 'text' : 'file'),
    dataUrl: isImage ? dataUrl : undefined,
    base64: dataUrl.split(',')[1] || '',
    // Only available in Electron (File has a `path` prop injected by Chromium)
    path: (file as any).path,
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

// Export conversation as Markdown
function exportConversation(messages: any[], sessionLabel: string): void {
  const lines: string[] = []
  lines.push('# ' + (sessionLabel || 'Helix 对话'))
  lines.push('')
  lines.push('> 导出时间: ' + new Date().toLocaleString('zh-CN'))
  lines.push('')
  lines.push('---')
  lines.push('')
  for (const msg of messages) {
    if (msg.role === 'system') continue
    lines.push('## ' + (msg.role === 'user' ? '🧑 用户' : '🤖 助手'))
    lines.push('')
    if (msg.blocks && msg.blocks.length > 0) {
      for (const block of msg.blocks) {
        if (block.type === 'thinking') {
          lines.push('<details><summary>💭 思考</summary>')
          lines.push('')
          lines.push(block.content)
          lines.push('')
          lines.push('</details>')
          lines.push('')
        } else if (block.type === 'text') {
          lines.push(block.content)
          lines.push('')
        }
      }
    } else {
      lines.push(msg.content || '')
      lines.push('')
    }
    lines.push('---')
    lines.push('')
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = (sessionLabel || 'helix-conversation') + '-' + Date.now() + '.md'
  a.click()
  URL.revokeObjectURL(url)
}

// Export conversation as JSON
function exportConversationJSON(messages: any[], sessionLabel: string): void {
  const data = {
    label: sessionLabel || 'Helix 对话',
    exportedAt: new Date().toISOString(),
    messages: messages.filter(m => m.role !== 'system'),
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = (sessionLabel || 'helix-conversation') + '-' + Date.now() + '.json'
  a.click()
  URL.revokeObjectURL(url)
}

// Quick command templates
const QUICK_COMMANDS: { cmd: string; label: string; prompt: string }[] = [
  { cmd: '/review', label: '代码审查', prompt: '请审查当前代码变更，检查安全漏洞、性能问题、代码风格，并给出改进建议。' },
  { cmd: '/fix', label: '修复问题', prompt: '请分析并修复当前存在的问题。先定位根因，再给出最小改动方案。' },
  { cmd: '/test', label: '编写测试', prompt: '请为当前代码编写单元测试，覆盖主要功能路径和边界情况。' },
  { cmd: '/doc', label: '生成文档', prompt: '请为当前代码生成清晰的文档注释，包括函数说明、参数说明和示例。' },
  { cmd: '/refactor', label: '重构优化', prompt: '请重构当前代码，提高可读性、可维护性，消除重复代码，但不改变功能。' },
  { cmd: '/explain', label: '解释代码', prompt: '请详细解释当前代码的工作原理、设计思路和关键实现细节。' },
  { cmd: '/security', label: '安全审查', prompt: '请对当前代码进行安全审查，检查 OWASP Top 10 漏洞、输入验证、权限控制等。' },
  { cmd: '/optimize', label: '性能优化', prompt: '请分析当前代码的性能瓶颈，并给出具体的优化方案。' },
  { cmd: '/summary', label: '代码总结', prompt: '请总结当前代码的功能、架构和主要模块，给出一份简洁的概述。' },
]





const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi

// Schedule parsing — extracted to lib/schedule-utils.ts

function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      onClick={() => {
        // Strip markdown formatting for clean copy
        const cleanText = text
          .replace(/\*\*(.+?)\*\*/g, "$1")
          .replace(/\*(.+?)\*/g, "$1")
          .replace(/`{3}[\s\S]*?\n/g, "")
          .replace(/`(.+?)`/g, "$1")
          .replace(/^#{1,6}\s+/gm, "")
          .replace(/^>\s+/gm, "")
          .replace(/^[-*+]\s+/gm, "\u2022 ")
          .replace(/^\d+\.\s+/gm, "")
          .replace(/\[(.+?)\]\(.+?\)/g, "$1")
          .replace(/^---+$/gm, "")
          .trim()
        navigator.clipboard.writeText(cleanText)
        setTimeout(() => setCopied(false), 1500)
      }}
      className={`p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors ${className}`}
      title="复制"
    >
      {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
    </button>
  )
}

// Tool display utilities — extracted to lib/tool-display-utils.tsx


// ==== Empty State ====================================================================================

function EmptyState() {
  return null
}

// ==== Reasoning Effort Select ==================================================================

type ReasoningEffort = 'ultra_low' | 'low' | 'medium' | 'high' | 'ultra_high' | 'max'

const REASONING_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: 'ultra_low', label: '极低' },
  { value: 'low', label: '轻度' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'ultra_high', label: '极高' },
  { value: 'max', label: '最高' },
]

function ReasoningEffortControl({ value, onChange }: { value: ReasoningEffort; onChange: (v: ReasoningEffort) => void }) {
  const idx = REASONING_OPTIONS.findIndex(o => o.value === value)
  const safeIdx = idx < 0 ? 2 : idx
  const current = REASONING_OPTIONS[safeIdx]

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = () => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect()
      const panelWidth = 192 // w-48
      let left = r.left + r.width / 2 - panelWidth / 2
      left = Math.max(8, Math.min(left, window.innerWidth - panelWidth - 8))
      setPanelStyle({
        position: 'fixed',
        left,
        bottom: window.innerHeight - r.top + 8,
        zIndex: 50,
      })
    }
    setOpen(v => !v)
  }

  const trackRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const handlePos = useCallback((clientX: number) => {
    if (!trackRef.current) return
    const r = trackRef.current.getBoundingClientRect()
    const x = Math.min(Math.max(clientX - r.left, 0), r.width)
    const ratio = x / r.width
    const max = REASONING_OPTIONS.length - 1
    const nextIdx = Math.max(0, Math.min(max, Math.round(ratio * max)))
    const nextValue = REASONING_OPTIONS[nextIdx].value
    if (nextValue !== value) onChange(nextValue)
  }, [value, onChange])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
    handlePos(e.clientX)
  }, [handlePos])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return
    handlePos(e.clientX)
  }, [isDragging, handlePos])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setIsDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
  }, [])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className="text-xs font-medium text-foreground/70 hover:text-foreground px-2.5 py-1.5 rounded-lg border border-border/60 bg-muted/40 hover:bg-muted/70 transition-colors min-w-12 text-center"
      >
        {current.label}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          style={panelStyle}
          className="p-2 bg-popover border border-border/40 rounded-xl shadow-2xl flex flex-col gap-1 w-48 select-none animate-scale-in"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground/60">推理强度</span>
            <span className="text-xs font-medium text-primary">{current.label}</span>
          </div>
          <div className="flex items-center justify-between text-[10px] text-foreground/40 leading-none">
            <span>更快</span>
            <span>更聪明</span>
          </div>
          <div
            ref={trackRef}
            className="relative h-2.5 rounded-full bg-muted/60 cursor-pointer touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            {REASONING_OPTIONS.map((o, i) => {
              const active = i === safeIdx
              return (
                <div
                  key={o.value}
                  className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-200 ${active ? 'size-2.5 bg-primary' : 'size-1.5 bg-foreground/20'}`}
                  style={{ left: `${(i / (REASONING_OPTIONS.length - 1)) * 100}%` }}
                />
              )
            })}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

// ==== Main Component ============================================================================

export function AgentFlowPanel() {
  const [steps, setSteps] = useState<ExecutionStep[]>([])
  useEffect(() => { stepsRef.current = steps }, [steps])
  const [input, setInput] = useState('')
  // Per-session streaming drafts let the running thinking/steps survive
  // conversation switches. `isRunning` is derived from the current session's draft.
  const streamingDrafts = useHelixStore(s => s.streamingDrafts)
  const setStreamingDraft = useHelixStore(s => s.setStreamingDraft)
  const clearStreamingDraft = useHelixStore(s => s.clearStreamingDraft)
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([])
  const approvalRequest = approvalQueue[0] || null
  const pendingApprovalCount = approvalQueue.length
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)

  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [showFolderDropdown, setShowFolderDropdown] = useState(false)
  const [showApprovalModeDropdown, setShowApprovalModeDropdown] = useState(false)
  const [approvalMode, setApprovalMode] = useState<'default' | 'accept_edits' | 'dont_ask'>('accept_edits')
  const [showNewProjectForm, setShowNewProjectForm] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [fileSkills, setFileSkills] = useState<Array<{ name: string; description: string }>>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const inputValueRef = useRef(input)
  const setInputSynced = useCallback((value: string) => {
    setInput(value)
    inputValueRef.current = value
  }, [])

  // Reset input height to default
  const resetInputHeight = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.style.height = '48px'
    }
  }, [])

  const abortRef = useRef<AbortController | null>(null)
  const doneProcessedRef = useRef(false)
  const synthDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedSessionRef = useRef(false)
  const textBufferRef = useRef<string>('')
  const thoughtTokensRef = useRef<number>(0)
  const usageReceivedRef = useRef(false)
  const thoughtBufferRef = useRef<string>('')
  const thinkingStartTimeRef = useRef<number>(0)
  const thinkingDurationRef = useRef<number>(0)
  const promptSentAtRef = useRef<number>(0)
  const runStartedAtRef = useRef<number>(0)
  const firstContentAtRef = useRef<number>(0)
  const stepsRef = useRef<ExecutionStep[]>([])
  const hermesSessionIdRef = useRef<string | null>(null)
  // The gateway epoch (bumped on every restart) at the moment our current
  // hermesSessionIdRef was created. If the live epoch is higher, the gateway
  // restarted since → the cached session is dead and must be recreated even
  // though hermesConnected may already be true again.
  const sessionEpochRef = useRef<number>(0)
  const runningSessionIdRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const skillUploadRef = useRef<HTMLInputElement>(null)
  const uploadFileInputRef = useRef<HTMLInputElement>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)
  const folderDropdownRef = useRef<HTMLDivElement>(null)
  const approvalModeDropdownRef = useRef<HTMLDivElement>(null)

  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([])
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([])
  const [isDraggingFile, setIsDraggingFile] = useState(false)

  const [responseBlocks, setResponseBlocks] = useState<ResponseBlock[]>([])
  const responseBlocksRef = useRef<ResponseBlock[]>(responseBlocks)
  responseBlocksRef.current = responseBlocks
  const [streamThinking, setStreamThinking] = useState<string>('')
  const [streamThinkingDuration, setStreamThinkingDuration] = useState<number>(0)
  // Anchors the live timer to the moment the USER sends a question, so it keeps
  // ticking across any sub-runs (agent tool loops) instead of resetting per run.
  const [questionStartTs, setQuestionStartTs] = useState<number>(0)
  const [streamThoughtTokens, setStreamThoughtTokens] = useState<number>(0)

  const rafPendingRef = useRef(false)
  const pendingTextRef = useRef<string | null>(null)
  const pendingThinkingRef = useRef<string | null>(null)
  const flushStreamRender = useCallback(() => {
    rafPendingRef.current = false
    if (pendingTextRef.current !== null) {
      const t = pendingTextRef.current
      pendingTextRef.current = null
      setResponseBlocks(prev => {
        const last = prev[prev.length - 1]
        if (last?.type === 'text') return [...prev.slice(0, -1), { type: 'text', content: t }]
        return [...prev, { type: 'text', content: t }]
      })
    }
    if (pendingThinkingRef.current !== null) {
      const th = pendingThinkingRef.current
      pendingThinkingRef.current = null
      setStreamThinking(th)
    }
  }, [setResponseBlocks, setStreamThinking])
  const scheduleStreamRender = useCallback(() => {
    if (rafPendingRef.current) return
    rafPendingRef.current = true
    requestAnimationFrame(flushStreamRender)
  }, [flushStreamRender])

  const apiConfig = useHelixStore(s => s.apiConfig)
  const skills = useHelixStore(s => s.skills)
  const availableCommands = useHelixStore(s => s.availableCommands)
  const agentExecutionSteps = useHelixStore(s => s.agentExecutionSteps)
  const chatMessages = useHelixStore(s => s.chatMessages)
  const currentSessionId = useHelixStore(s => s.currentSessionId)
  const sessionMessages = useMemo(() => {
    if (!currentSessionId) return chatMessages
    return chatMessages.filter(m => !m.sessionId || m.sessionId === currentSessionId)
  }, [chatMessages, currentSessionId])
  const isRunning = useMemo(() => {
    // Only show running state if viewing the running session
    if (runningSessionIdRef.current && runningSessionIdRef.current === currentSessionId) {
      return !!streamingDrafts[runningSessionIdRef.current]?.isAgentRunning
    }
    return false
  }, [streamingDrafts, currentSessionId])
  const isChatLoading = useHermesStore(s => s.isChatLoading)
  // Check if the last message indicates a queued state
  const hasQueuedMessage = useMemo(() => {
    const lastMsg = sessionMessages[sessionMessages.length - 1]
    return lastMsg && lastMsg.content && /queued|排队/i.test(lastMsg.content)
  }, [sessionMessages])
  const isBusy = isRunning || isChatLoading || hasQueuedMessage
  const isRunningSession = currentSessionId === runningSessionIdRef.current
  const displaySteps = useMemo(() => {
    // Only show live state if viewing the running session
    if (isRunningSession) return steps
    return streamingDrafts[currentSessionId || '']?.steps || []
  }, [isRunningSession, steps, streamingDrafts, currentSessionId])
  const displayResponseBlocks = useMemo(() => {
    // Only show live state if viewing the running session
    if (isRunningSession) return responseBlocks
    return streamingDrafts[currentSessionId || '']?.responseBlocks || []
  }, [isRunningSession, responseBlocks, streamingDrafts, currentSessionId])
  const displayStreamThinking = useMemo(() => {
    // Only show live state if viewing the running session
    if (isRunningSession) return streamThinking
    return streamingDrafts[currentSessionId || '']?.streamThinking || ''
  }, [isRunningSession, streamThinking, streamingDrafts, currentSessionId])
  // Currently-running tool calls, shown in the top status bar as
  // "正在执行工具：read xxx / bash xxx" instead of a bare "正在思考".
  const runningToolLabels = useMemo(() => {
    if (!isRunning) return [] as string[]
    const labels: string[] = []
    for (const block of displayResponseBlocks) {
      if (block.type !== 'tool_group') continue
      const walk = (steps: ExecutionStep[]) => {
        for (const step of steps) {
          if (step.type === 'tool_call' && step.status === 'running') {
            labels.push(getToolDisplayLabel(step.toolName || '', step.toolKind, undefined, step.toolParams))
          }
          if (step.subSteps && step.subSteps.length > 0) walk(step.subSteps)
        }
      }
      walk(block.steps)
    }
    // De-duplicate while preserving order
    return labels.filter((l, i, a) => a.indexOf(l) === i)
  }, [isRunning, displayResponseBlocks])
  const isThinkingEnded = useMemo(() => {
    const blocks = displayResponseBlocks
    let lastThinkingIdx = -1
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === 'thinking') { lastThinkingIdx = i; break }
    }
    if (lastThinkingIdx < 0) return true
    for (let i = lastThinkingIdx + 1; i < blocks.length; i++) {
      if (blocks[i].type === 'text') return true
    }
    return false
  }, [displayResponseBlocks])

  const transcriptFontSize = useHelixStore(s => s.transcriptFontSize)
  const selectedWorkDir = useHelixStore(s => s.selectedWorkDir)
  const activeProviderId = useHelixStore(s => s.activeProviderId)
  const activeModel = useHelixStore(s => s.activeModel)
  const temperature = useHelixStore(s => s.temperature)
  const reasoningEffort = useHelixStore(s => s.reasoningEffort)
  const personality = useHelixStore(s => s.personality)
  const providers = useHelixStore(s => s.providers)
  const availableModels = useHelixStore(s => s.availableModels)
  const providerModels = useHelixStore(s => s.providerModels)
  const [currentBranch, setCurrentBranch] = useState('main')
  // Stable action references — these never change so getState() is safe
  const connectionNotice = useHelixStore(s => s.connectionNotice)
  const storeActions = useMemo(() => useHelixStore.getState(), [])
  // Clear stale connection notices on mount
  useEffect(() => {
    const notice = useHelixStore.getState().connectionNotice
    if (notice && notice.ts && Date.now() - notice.ts > 60000) {
      useHelixStore.getState().setConnectionNotice(null)
    }
  }, [])
  // Drop the cached Hermes ACP session when the project directory changes so the
  // next prompt opens a fresh session rooted at the new cwd.
  useEffect(() => {
    hermesSessionIdRef.current = null
  }, [selectedWorkDir])


  // Clear Hermes session when switching conversations to prevent cross-session pollution
  useEffect(() => {
    hermesSessionIdRef.current = null
    sessionEpochRef.current = -1
  }, [currentSessionId])

  // When the gateway restarts (e.g. provider switch), ALL Hermes ACP sessions
  // are destroyed server-side. Clear our cached session id DIRECTLY on the
  // event (not via a store-effect indirection) so the very next handleRun
  // unconditionally recreates a fresh session. The store-effect approach was
  // unreliable: handleRun only wrote hermesSessionIdRef (never the store), so
  // the store stayed null and the [hermesSessionId] effect never re-fired on a
  // second restart — leaving a stale id in the ref and causing prompts to hit a
  // dead session with no output.
  useEffect(() => {
    const unsub = window.electron?.hermes?.onEvent?.((event: string) => {
      if (event === 'gateway.sessionInvalidated') {
        hermesSessionIdRef.current = null
        // Force the next run to re-verify the gateway is fully up (it may still
        // be recycling) rather than trusting hermesConnected which is already
        // true after a prior restart.
        sessionEpochRef.current = -1
      }
    })
    return () => { try { unsub?.() } catch {} }
  }, [])
  // Resolve current git branch for the empty-state breadcrumb.
  useEffect(() => {
    if (!selectedWorkDir || !isElectron()) return
    let cancelled = false
    electronGit.branchList().then((res: { ok: boolean; branches?: string[]; error?: string }) => {
      if (cancelled) return
      const branches = res.ok && res.branches ? res.branches : []
      const main = branches.find(b => b === 'main' || b === 'master') || branches[0] || 'main'
      setCurrentBranch(main)
    }).catch(() => {
      if (!cancelled) setCurrentBranch('main')
    })
    return () => { cancelled = true }
  }, [selectedWorkDir])

  const hasApiKey = !!apiConfig.apiKey

  // Live running-time timer — anchored to the user's question, NOT to each run.
  // It ticks across the whole question (including agent tool-loop sub-runs) and
  // only resets when a brand-new question is sent (questionStartTs changes).
  useEffect(() => {
    if (!isRunning || !questionStartTs) { return }
    const tick = () => {
      setStreamThinkingDuration(Math.round((Date.now() - questionStartTs) / 1000))
    }
    tick()
    const id = setInterval(tick, 200)
    return () => clearInterval(id)
  }, [isRunning, questionStartTs])

  // Resolve the provider that owns the current backend endpoint.
  // Primary key: apiConfig.baseUrl (what Hermes actually calls — never drifts).
  // Fallback: activeProviderId (internal state, can desync after profile switches
  // or setActiveModel silent-fails when a model isn't in any declared list).
  const activeProvider = useMemo(
    () => {
      // 1) Match by the actual backend URL — this is the source of truth.
      if (apiConfig?.baseUrl) {
        const byUrl = providers.find((p) => p.baseUrl === apiConfig.baseUrl)
        if (byUrl) return byUrl
      }
      // 2) Fall back to activeProviderId (may point to wrong provider).
      return providers.find((p) => p.id === activeProviderId) || null
    },
    [providers, activeProviderId, apiConfig?.baseUrl],
  )
  // Model list for the dropdown — always scoped to the provider whose endpoint
  // matches apiConfig.baseUrl so the list never shows a different supplier's
  // models even when activeProviderId drifts out of sync.
  const modelList = useMemo(() => {
    const pid = activeProvider?.id
    if (pid && providerModels[pid]?.length) {
      return [...new Set(providerModels[pid].filter(Boolean))]
    }
    if (activeProvider?.models?.length) {
      return [...new Set(activeProvider.models.filter(Boolean))]
    }
    return []
  }, [activeProvider, providerModels])

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setShowModelDropdown(false)
      }
      if (folderDropdownRef.current && !folderDropdownRef.current.contains(event.target as Node)) {
        setShowFolderDropdown(false)
      }
      if (approvalModeDropdownRef.current && !approvalModeDropdownRef.current.contains(event.target as Node)) {
        setShowApprovalModeDropdown(false)
      }
    }
    if (showModelDropdown || showFolderDropdown || showApprovalModeDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showModelDropdown, showFolderDropdown, showApprovalModeDropdown])

  // Auto-correct a stale apiConfig.model — but ONLY when the model is genuinely
  // orphaned (belongs to NO provider at all).  If the user just clicked a history
  // entry whose endpoint doesn't have a pre-built ProviderConfig yet, the click
  // handler creates one on-the-fly; we must not race against that and revert
  // the selection back to the previous provider's first model.
  useEffect(() => {
    if (modelList.length === 0) return
    const store = useHelixStore.getState()
    const current = store.apiConfig.model
    const active = store.activeModel
    // If activeModel matches current, the user (or a click handler) explicitly
    // set this model — never second-guess it even if it's not in the scoped
    // list yet (the provider entry may have just been created).
    if (current && current === active) return
    // Also skip if the model lives in ANY provider's fetched/declared pool —
    // it's valid, just scoped to a different provider right now.
    const allModels = new Set<string>(
      store.providers.flatMap((p) => [
        ...(p.models || []),
        ...(store.providerModels?.[p.id] || []),
      ]),
    )
    if (current && allModels.has(current)) return
    // Truly orphaned — snap to the current list's first model.
    if (!current || !modelList.includes(current)) {
      const fixed = modelList[0]
      useHelixStore.getState().setActiveModel(fixed)
    }
  }, [modelList, apiConfig.model])

  // Shared tail for a model switch. Cancels the in-flight session, invalidates
  // the cached session id, then pushes the freshly-resolved config to the
  // backend. The ordering here is what prevents the swap-401: `cacheConfig`
  // must run BEFORE `setConfig`, because on restart Hermes reads the cache via
  // applyActiveProfileCache — so the cache must already hold the NEW key when
  // setConfig restarts the gateway.
  const syncConfigToBackend = useCallback(async () => {
    // 1) Cancel any in-flight session FIRST (while the id is still valid).
    const currentSid = hermesSessionIdRef.current
    if (isElectron() && currentSid) {
      try { window.electron?.hermes?.notify?.('session/cancel', { session_id: currentSid }) } catch {}
    }
    // 2) Invalidate the session so the next prompt rebuilds it from config.yaml.
    useHermesStore.getState().setHermesSessionId(null)
    hermesSessionIdRef.current = null
    // 3) Push the resolved config (provider+baseUrl+apiKey+model) to the backend.
    if (isElectron()) {
      const store = useHelixStore.getState()
      const cfg = store.apiConfig
      // Use the ACTIVE provider's stored key. We must NOT fall back to a stale
      // in-memory apiConfig.apiKey: after a reload it can be empty/stale, and
      // pushing it would send the PREVIOUS provider's key — the classic swap-401.
      // When the resolved key is genuinely empty, push '' and let the backend
      // (main.js) fall back to the target provider's own key stored in
      // config.yaml's custom_providers block (which is correct on disk).
      const provider = store.activeProviderId
        ? store.providers.find((p) => p.id === store.activeProviderId)
        : undefined
      const resolvedKey = provider?.apiKey || cfg.apiKey || ''
      const push = {
        model: cfg.model,
        provider: cfg.provider && cfg.provider !== '__custom__' ? cfg.provider : 'custom',
        baseUrl: cfg.baseUrl,
        apiKey: resolvedKey,
      }
      console.warn(`[config-switch] → provider=${push.provider} baseUrl=${push.baseUrl} model=${push.model} apiKey=${resolvedKey ? resolvedKey.substring(0, 6) + '…' : '(EMPTY → backend falls back to target provider stored key)'}`)
      const hermes = window.electron?.hermes
      const profile = window.electron?.profile
      try {
        if (profile?.cacheConfig) await profile.cacheConfig(push).catch(() => {})
        if (hermes?.setConfig) await hermes.setConfig(push).catch(() => {})
      } catch {}
    }
  }, [])

  // Handle model selection within the ACTIVE provider. The provider itself is
  // switched only on the settings page; the input bar lists just the active
  // provider's models, so this always resolves cleanly via setActiveModel
  // (which mirrors the resolved config into apiConfig). Shares the full
  // cancel + invalidate + push tail so a model switch also rebuilds the
  // session from config.yaml — never a stale key.
  const handleModelSelect = useCallback(async (model: string) => {
    useHelixStore.getState().setActiveModel(model)
    setShowModelDropdown(false)
    await syncConfigToBackend()
  }, [syncConfigToBackend])

  // Model selector for the active provider only. Rendered in BOTH input-bar
  // layouts (empty-state and active-conversation) via this helper so the
  // markup isn't duplicated.
  //
  // Display source of truth: `apiConfig.model`. This is what the Hermes backend
  // reads and what every mutation path (click handler / applyProfile /
  // handleSaveApi / handleModelSelect) writes. Using `activeModel` as the
  // display source caused persistent drift because auto-correct effects and
  // stale fallback chains could leave the button showing a PREVIOUS supplier's
  // model name while the backend was already on the new one.
  const renderModelSelector = () => {
    const displayName = apiConfig.model || activeModel || (modelList[0] || null) || '选择模型'
    return (
    <>
      {/* Model selector — wide button matching settings page style */}
      <div className="relative" ref={modelDropdownRef}>
        <button
          type="button"
          onClick={() => setShowModelDropdown(!showModelDropdown)}
          className="flex items-center justify-between gap-2 min-w-[140px] max-w-[220px] px-3 py-1.5 bg-muted/30 border border-border/30 rounded-lg text-[13px] text-foreground hover:bg-muted/30 hover:border-border/30 transition-all duration-200 font-mono"
        >
          <span className="truncate">{displayName}</span>
          <svg className={`size-3.5 text-muted-foreground transition-transform shrink-0 ${showModelDropdown ? 'rotate-180' : ''}`} xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        {showModelDropdown && (
          <div className="absolute bottom-full right-0 mb-2 min-w-[200px] max-w-[320px] max-h-56 overflow-y-auto bg-popover border border-border/40 rounded-xl shadow-xl z-50 p-1 animate-scale-in">
            {modelList.map(m => (
              <button
                key={m}
                type="button"
                onClick={() => handleModelSelect(m)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm font-mono transition-colors ${
                  m === displayName
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'text-foreground/70 hover:bg-muted'
                }`}
              >
                {m}
              </button>
            ))}
            {modelList.length === 0 && (
              <div className="px-3 py-2 text-sm text-foreground/40">
                暂无可用模型
              </div>
            )}
          </div>
        )}
      </div>
    </>
    )
  }

  // Handle skill selection
  const handleSkillSelect = useCallback((skill: { name: string; description?: string }) => {
    setInputSynced(`/${skill.name} `)
    inputRef.current?.focus()
  }, [setInputSynced])

  // Fetch file-based skills on mount (via Hermes skills bridge — no backend)
  useEffect(() => {
    if (fileSkills.length > 0) return
    if (typeof window === 'undefined' || !window.electron?.hermesSkills) return
    window.electron.hermesSkills.listSkills()
      .then((list: any) => {
        if (Array.isArray(list)) {
          setFileSkills(list.map((s: any) => ({ name: s.name, description: s.description || '' })))
        }
      })
      .catch(() => {})
  }, [fileSkills.length])

  // Sync the running session's local streaming state to its per-session draft
  // so it survives conversation switches.
  useEffect(() => {
    const sid = runningSessionIdRef.current
    if (!sid) return
    setStreamingDraft(sid, {
      responseBlocks,
      steps,
      streamThinking,
      textBuffer: textBufferRef.current,
      thoughtBuffer: thoughtBufferRef.current,
    })
  }, [steps, responseBlocks, streamThinking, setStreamingDraft])

  // Reset when chat is cleared
  useEffect(() => {
    if (chatMessages.length === 0) {
      setResponseBlocks([])
      setSteps([])
      setInputSynced('')
      setApprovalQueue([])
    }
  }, [chatMessages.length, setInputSynced])

  // Filter skills based on input (exclude unwanted system/prompt skills)
  const SKILL_DENYLIST = useMemo(() => new Set(['项目里面有什么']), [])
  const allSkills = useMemo(() => [
    ...skills.map(s => ({ name: s.name, description: s.description, id: s.id, icon: s.icon })).filter(s => !SKILL_DENYLIST.has(s.name)),
    ...fileSkills.map(s => ({ name: s.name, description: s.description, id: s.name, icon: undefined })).filter(s => !SKILL_DENYLIST.has(s.name)),
  ], [skills, fileSkills, SKILL_DENYLIST])

  // Built-in slash commands handled on the client side (not sent to Hermes as
  // regular prompts).  These show up in the "/" autocomplete picker alongside
  // skills, Hermes commands, and shell commands.
  const BUILTIN_COMMANDS = useMemo(() => [
    { name: 'compact', description: '压缩上下文，重置对话窗口', action: 'compact' as const },
    { name: 'clear', description: '清空当前对话', action: 'clear' as const },
    { name: 'reset', description: '重置会话（清空对话+上下文）', action: 'reset' as const },
    { name: 'mcp', description: '管理 MCP 服务器', action: 'mcp' as const },
    { name: 'model', description: '切换到模型选择设置', action: 'model' as const },
    { name: 'skill', description: '打开技能管理面板', action: 'skill' as const },
  ], [])

  // Common CLI commands surfaced in the "/" picker (filled into the input,
  // executed as a normal shell command through Hermes).
  const CLI_COMMANDS: { name: string; description: string; command: string }[] = useMemo(() => [
    { name: 'ls', description: '列出当前目录文件', command: 'ls' },
    { name: 'cd', description: '切换工作目录', command: 'cd' },
    { name: 'pwd', description: '显示当前目录路径', command: 'pwd' },
    { name: 'mkdir', description: '新建目录', command: 'mkdir' },
    { name: 'rm', description: '删除文件或目录', command: 'rm' },
    { name: 'cp', description: '复制文件或目录', command: 'cp' },
    { name: 'mv', description: '移动/重命名文件', command: 'mv' },
    { name: 'cat', description: '查看文件内容', command: 'cat' },
    { name: 'grep', description: '在文件中搜索文本', command: 'grep' },
    { name: 'find', description: '查找文件', command: 'find' },
    { name: 'echo', description: '输出文本', command: 'echo' },
    { name: 'touch', description: '新建空文件', command: 'touch' },
    { name: 'head', description: '查看文件开头', command: 'head' },
    { name: 'tail', description: '查看文件末尾/实时日志', command: 'tail' },
    { name: 'wc', description: '统计行数/词数', command: 'wc' },
    { name: 'git status', description: '查看 Git 工作区状态', command: 'git status' },
    { name: 'git add', description: '暂存改动', command: 'git add' },
    { name: 'git commit', description: '提交改动', command: 'git commit' },
    { name: 'git push', description: '推送到远程仓库', command: 'git push' },
    { name: 'git pull', description: '拉取远程更新', command: 'git pull' },
    { name: 'python', description: '运行 Python 脚本', command: 'python' },
    { name: 'pip install', description: '安装 Python 包', command: 'pip install' },
    { name: 'node', description: '运行 Node 脚本', command: 'node' },
    { name: 'npm install', description: '安装 npm 依赖', command: 'npm install' },
    { name: 'code', description: '用 VS Code 打开', command: 'code' },
  ], [])

  // Merge local skills with Hermes slash commands
  const allSlashItems = useMemo(() => {
    const builtinCmds = BUILTIN_COMMANDS.map(c => ({
      name: c.name,
      description: c.description,
      id: 'builtin:' + c.name,
      icon: undefined as string | undefined,
      isBuiltinCommand: true,
      action: c.action,
    }))
    const hermesCmds = (availableCommands || []).map(cmd => ({
      name: cmd.name,
      description: cmd.description || '',
      id: '/' + cmd.name,
      icon: undefined as string | undefined,
      isHermesCommand: true,
    }))
    const cliCmds = CLI_COMMANDS.map(c => ({
      name: c.name,
      description: c.description,
      id: 'cli:' + c.command,
      icon: undefined as string | undefined,
      isCliCommand: true,
      command: c.command,
    }))
    return [...builtinCmds, ...allSkills, ...hermesCmds, ...cliCmds]
  }, [allSkills, availableCommands, BUILTIN_COMMANDS, CLI_COMMANDS])

  const filteredSkills = useMemo(() => {
    if (input.startsWith('/')) {
      const query = input.slice(1).toLowerCase()
      return allSlashItems.filter(s => s.name.toLowerCase().includes(query))
    }
    return allSlashItems
  }, [allSlashItems, input])
  const slashCmd = input.startsWith('/') ? input.slice(1).split(' ')[0].toLowerCase() : ''
  const matchedQuickCmds = slashCmd ? QUICK_COMMANDS.filter(c => c.cmd.slice(1).startsWith(slashCmd)) : []
  const showSlashSkills = input.startsWith('/') && filteredSkills.length > 0
  const showQuickCmds = input.startsWith('/') && matchedQuickCmds.length > 0 && !input.includes(' ')
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0)

  // Handle input change for skill detection
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInputSynced(value)
    setSelectedSkillIndex(0) // Reset selection when input changes
  }, [setInputSynced])

  // Auto-scroll to bottom (stop when user scrolls up)
  const userScrolledUpRef = useRef(false)
  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current || userScrolledUpRef.current) return
    const viewport =
      scrollRef.current.querySelector('[data-radix-scroll-area-viewport]') ||
      scrollRef.current.querySelector('[data-slot="scroll-area-viewport"]')
    if (viewport) {
      requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight
      })
    }
  }, [])

  useEffect(() => {
    const viewport =
      scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') ||
      scrollRef.current?.querySelector('[data-slot="scroll-area-viewport"]')
    if (!viewport) return
    const handleScroll = () => {
      const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 100
      userScrolledUpRef.current = !atBottom
    }
    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    if (!userScrolledUpRef.current) scrollToBottom()
  }, [steps, scrollToBottom])

  // When switching to / loading a conversation, jump straight to the latest
  // message (bottom) instead of showing it from the top.
  useEffect(() => {
    userScrolledUpRef.current = false
    const viewport =
      scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') ||
      scrollRef.current?.querySelector('[data-slot="scroll-area-viewport"]')
    if (!viewport) return
    // Two rAFs to ensure the newly loaded messages are laid out first.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId])

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
    storeActions.clearSelectedFiles()
    storeActions.setSelectedWorkDir(null)
    storeActions.clearExecutionFlow()
  }, [storeActions.clearExecutionFlow, storeActions.clearSelectedFiles])

  // Select project directory. Must go through setWorkDir (not just
  // setSelectedWorkDir) so the Electron main process workDir is synced AND
  // workDirEpoch bumps — otherwise useHermes keeps reusing the stale Hermes
  // session rooted at the old cwd, so the UI shows the new dir while Hermes
  // actually operates in the old one.
  const selectWorkDir = useCallback(async (dir: string | null) => {
    if (!dir) {
      storeActions.setSelectedWorkDir(null)
      return
    }
    useHelixStore.getState().setCurrentSessionId(null)
    await storeActions.setWorkDir(dir)
  }, [storeActions.setWorkDir, storeActions.setSelectedWorkDir])

  // Stop running agent
  const handleStop = useCallback(() => {
    if (synthDoneTimerRef.current) {
      clearTimeout(synthDoneTimerRef.current)
      synthDoneTimerRef.current = null
    }
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    const sid = runningSessionIdRef.current
    if (sid) {
      setStreamingDraft(sid, { isAgentRunning: false })
    }
    // Notify Hermes to cancel the session using the proper interrupt handler
    try {
      const sessionId = hermesSessionIdRef.current || sid || currentSessionId
      if (sessionId && isElectron()) {
        // Use the interrupt IPC handler which sends session/cancel as a notification
        window.electron.hermes.interrupt(sessionId)
      }
    } catch (e) {
      console.error('[handleStop] Failed to interrupt Hermes:', e)
    }
    // Don't clear runningSessionIdRef here - let the finally block in handleRun do it
    // to avoid race conditions with the event handler cleanup
  }, [setStreamingDraft, currentSessionId])

  // File picker handler
  const addSelectedFile = useHelixStore(s => s.addSelectedFile)
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return

    // Upload selected files as pending attachments
    const attachments = await Promise.all(
      Array.from(files).map(f => fileToAttachment(f).catch(() => null))
    )
    const valid = attachments.filter((a): a is FileAttachment => a !== null)
    if (valid.length > 0) setPendingFiles(prev => [...prev, ...valid])

    // Reset input so selecting the same file again triggers onChange
    e.target.value = ''
  }, [])

  // Handle skill file upload
  const handleSkillUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/skills', { method: 'POST', body: form })
      if (!res.ok) throw new Error('上传失败')
    } catch (err) {
      storeActions.showToast({ type: 'error', title: '技能上传失败', description: String(err) })
    }
    e.target.value = ''
  }, [storeActions.showToast])

  // Handle new project creation
  const handleCreateProject = useCallback(async () => {
    if (!newProjectName.trim()) {
      return
    }

    if (isElectron()) {
      // Use Electron to create directory
      const dir = await electronDialog.openDirectory()
      if (dir) {
        const projectPath = `${dir}/${newProjectName.trim()}`
        try {
        await (window as any).electron?.fs?.write(`${projectPath}/.gitkeep`, '')
        selectWorkDir(projectPath)
          setShowNewProjectForm(false)
          setNewProjectName('')
          storeActions.showToast({ type: 'success', title: '项目已创建', description: projectPath })
        } catch (err) {
          storeActions.showToast({ type: 'error', title: '创建失败', description: String(err) })
        }
      }
    } else {
      // Browser mode: just set the project name as work dir hint
      selectWorkDir(newProjectName.trim())
      setShowNewProjectForm(false)
      setNewProjectName('')
      storeActions.showToast({ type: 'success', title: '项目已设置', description: newProjectName.trim() })
    }
  }, [newProjectName, storeActions.showToast])

  // Resolve /command -> skill name + user query
  const resolveCommand = useCallback((text: string): { skillName: string; name: string; query: string } | null => {
    const match = text.match(/^\/(\S+)\s*([\s\S]*)$/)
    if (!match) return null
    const cmd = match[1].toLowerCase()
    const rest = match[2].trim()
    const skill = skills.find(s => s.id === cmd || s.name.toLowerCase() === cmd)
    if (skill) return { skillName: skill.id, name: skill.name, query: rest || text }
    const fileSkill = fileSkills.find(s => s.name.toLowerCase() === cmd)
    if (fileSkill) return { skillName: fileSkill.name, name: fileSkill.name, query: rest || text }
    return null
  }, [skills, fileSkills])

  // Run agent task
  const handleRun = useCallback(async () => {
    const currentInput = inputValueRef.current
    const cmd = resolveCommand(currentInput.trim())
    const trimmed = currentInput.trim()
    if (!trimmed && pendingImages.length === 0 && pendingFiles.length === 0) return

    // --- Built-in slash commands (handled client-side, never sent to Hermes) ---
    const builtinMatch = trimmed.match(/^\/(\S+)/)
    if (builtinMatch) {
      const builtin = BUILTIN_COMMANDS.find(c => c.name === builtinMatch[1].toLowerCase())
      if (builtin) {
        setInputSynced('')
        resetInputHeight()
        switch (builtin.action) {
          case 'compact':
          case 'reset':
            hermesSessionIdRef.current = null
            storeActions.clearChat()
            storeActions.showToast({ type: 'success', title: builtin.action === 'compact' ? '上下文已压缩' : '会话已重置' })
            break
          case 'clear':
            storeActions.clearChat()
            break
          case 'mcp':
            storeActions.toggleSettings('mcp')
            break
          case 'model':
            storeActions.toggleSettings('api')
            break
        }
        return
      }
    }

    // Track skill invocation count
    if (cmd) {
      window.electron?.hermesSkills?.trackSkillCall(cmd.name).catch?.(() => {})
    }

    // If already running, stop current request
    if (isBusy) {
      handleStop()
      return
    }

    // Check API key
    if (!hasApiKey) {
      storeActions.toggleSettings('api')
      return
    }

    setInputSynced('')
    resetInputHeight()
    runStartedAtRef.current = Date.now()
    setQuestionStartTs(runStartedAtRef.current)
    let activeSessionId = currentSessionId
    doneProcessedRef.current = false
    if (!activeSessionId) {
      activeSessionId = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
      useHelixStore.getState().setCurrentSessionId(activeSessionId)
      useHelixStore.getState().pushNavigation({ type: 'chat', sessionId: activeSessionId })
      useHelixStore.getState().persistToStorage()
    }
    runningSessionIdRef.current = activeSessionId
    setStreamingDraft(activeSessionId, {
      isAgentRunning: true,
      responseBlocks: [],
      steps: [],
      streamThinking: '',
      textBuffer: '',
      thoughtBuffer: '',
    })
    setResponseBlocks([])
    setSteps([])
    stepsRef.current = []
    setStreamThinking('')
    textBufferRef.current = ''
    thoughtBufferRef.current = ''
    thinkingStartTimeRef.current = 0
    thinkingDurationRef.current = 0
    promptSentAtRef.current = 0
    setStreamThoughtTokens(0)
    setStreamThinkingDuration(0)
    firstContentAtRef.current = 0
    usageReceivedRef.current = false
    // A fresh question starts a new todo scope — drop any stale list from the
    // previous run so the header button hides until Hermes streams a new one.
    useHelixStore.getState().clearHermesTodos()
    // Add user message to store with images
    const imagesSnapshot = pendingImages.length > 0 ? [...pendingImages] : undefined
    const filesSnapshot = pendingFiles.length > 0 ? [...pendingFiles] : undefined

    const storeState = useHelixStore.getState()
    storeState.addChatMessage({
      role: 'user',
      content: trimmed,
      images: imagesSnapshot,
      files: filesSnapshot,
      sessionId: activeSessionId,
    })
    setPendingImages([])
    setPendingFiles([])

    const controller = new AbortController()
    abortRef.current = controller

    let unsubscribe: (() => void) | null = null
    try {
      const state = useHelixStore.getState()
      const isElectron = typeof window !== 'undefined' && !!window.electron?.isElectron

      if (!isElectron) {
        throw new Error('当前环境无法连接 Hermes，与 Electron 界面端通信失败')
      }

      // Config is synced by handleModelSelect (setConfig) and by handleProfileSelect
      // (profile:cacheConfig) — both already restart Hermes if needed.  Calling
      // setModel AGAIN here would race with those restarts and corrupt .env.
      // session/new will pick up whatever config.yaml has on disk, so skip it.

      // Wait for the gateway to be ready (alive AND not mid-restart) before
      // creating a session. After a model switch the gateway may already report
      // hermesConnected=true yet still be recycling — we must wait for the
      // *fresh* gateway.ready that follows this switch's restart.
      const hermesStore = useHermesStore.getState()
      const liveEpoch = hermesStore.gatewayEpoch
      const epochStale = liveEpoch > sessionEpochRef.current
      if (!hermesStore.hermesConnected || epochStale) {
        // If the cached session is from a previous gateway generation, drop it
        // now so we don't send a prompt to a dead session.
        if (epochStale) {
          hermesSessionIdRef.current = null
        }
        await new Promise<boolean>((resolve) => {
          const startEpoch = useHermesStore.getState().gatewayEpoch
          const check = () => {
            if (useHermesStore.getState().hermesConnected && useHermesStore.getState().gatewayEpoch > startEpoch) {
              cleanup()
              resolve(true)
            }
          }
          const unsub = window.electron.hermes.onEvent((event: string) => {
            if (event === 'gateway.ready') {
              cleanup()
              resolve(true)
            }
          })
          const cleanup = () => {
            try { unsub?.() } catch {}
          }
          check()
          if (!(useHermesStore.getState().hermesConnected && useHermesStore.getState().gatewayEpoch > startEpoch)) {
            setTimeout(() => { cleanup(); resolve(useHermesStore.getState().hermesConnected) }, 10000)
          }
        })
      }

      // Create a Hermes ACP session if we don't already have one for this conversation.
      let sessionId = hermesSessionIdRef.current
      if (!sessionId) {
        const cwd = selectedWorkDir || state.selectedWorkDir || (typeof process !== 'undefined' ? process.cwd() : '')
        const res = await window.electron.hermes.send('session/new', {
          cwd,
          mcpServers: [],
        }) as any
        sessionId = res?._meta?.hermes?.sessionProvenance?.acpSessionId
          || res?.session_id
          || res?.sessionID
          || (typeof res === 'string' ? res : null)
        if (!sessionId) {
          throw new Error('无法创建 Hermes 会话：session/new 缺少 session_id')
        }
        hermesSessionIdRef.current = sessionId
        sessionEpochRef.current = useHermesStore.getState().gatewayEpoch
        // Keep the store in sync so external invalidation (profile switch,
        // gateway restart) can reliably clear this ref via its own effect.
        try { useHermesStore.getState().setHermesSessionId(sessionId) } catch {}
        // Auto-approve edits for this session (no manual approval UI): switch
        // Hermes into "don't ask" mode. Hermes has no `session/approve` RPC — it
        // waits for an approval response to a permission_request, so the only
        // way to skip manual approval is to set the session mode here.
        try {
          await window.electron.hermes.send('session/set_mode', {
            session_id: sessionId,
            mode_id: approvalMode,
          })
        } catch (e) {
          console.warn('[Helix] set_mode(' + approvalMode + ') failed:', e)
        }
      }

      // Stop button -> ask Hermes to cancel the current run.
      // session/cancel is a Hermes *notification* (no response), so send it
      // via notify (not send, which issues a request and gets "Method not found").
      controller.signal.addEventListener('abort', () => {
        if (sessionId) {
          electronHermes.notify('session/cancel', { session_id: sessionId })
        }
        queueDone = true
        if (queueWaiter) { const w = queueWaiter; queueWaiter = null; w() }
      })

      // Tracks whether this run has already streamed real text/thinking, so a
      // trailing session_info_update can be dropped quietly instead of as text.
      let streamedContent = false
      // Translate Hermes ACP notifications into the UI event shape the parser expects.
      const mapHermesEvent = (method: string, params: any): any => {
        if (method === 'usage:prompt-complete') {
          return { type: 'usage_prompt_complete', usage: params?.usage || null }
        }
        if (method === 'session/update') {
          const u = params?.update || params
          const su = u?.sessionUpdate
          switch (su) {
            case 'agent_message_chunk':
              return { type: 'text', content: normalizeAcpContent(u.content) }
            case 'agent_thought_chunk':
              return { type: 'thinking', content: normalizeAcpContent(u.content) }
            case 'tool_call': {
              const title = typeof u.title === 'string' ? u.title : ''
              const kind = typeof u.kind === 'string' ? u.kind : ''
              const toolCallId = typeof u.toolCallId === 'string' ? u.toolCallId : ''
              let args = u.rawInput
              if (typeof args === 'string') {
                try { args = JSON.parse(args) } catch { /* keep raw */ }
              }
              return {
                type: 'tool_call',
                toolName: title || 'tool',
                toolKind: kind,
                toolCallId,
                toolParams: (args && typeof args === 'object') ? args : { raw: args },
              }
            }
            case 'tool_call_chunk':
              return { type: 'tool_result', toolName: '', content: normalizeAcpContent(u.content) }
            case 'tool_call_update': {
              const tcId = typeof u.toolCallId === 'string' ? u.toolCallId : ''
              // Sub-agent root completion: update the parent delegate_task step status
              if (tcId.startsWith('sa-') && tcId.endsWith('-root')) {
                const status = u.status === 'failed' ? 'failed' : 'completed'
                const content = normalizeAcpContent(u.content)
                setSteps(prev => {
                  const next = [...prev]
                  for (let i = next.length - 1; i >= 0; i--) {
                    if (next[i].type === 'tool_call' && next[i].toolName?.startsWith('SubAgent')) {
                      next[i] = { ...next[i], status, content: content || next[i].content }
                      break
                    }
                  }
                  return next
                })
                return null
              }
              // Streaming output delta: forward content to the latest tool_call step
              if (u.status === 'in_progress' && u.content) {
                return { type: 'tool_output_delta', toolCallId: tcId, content: normalizeAcpContent(u.content) }
              }
              return null
            }
            case 'permission_request':
              // Forward as approval_request so the ApprovalDialog shows up
              return {
                type: 'approval_request',
                approvalId: (typeof u.toolCallId === 'string' ? u.toolCallId : '') || `approval-${Date.now()}`,
                toolName: u.toolName || u.title || 'unknown',
                toolParams: u.toolParams || u.params || {},
              }
            case 'run_complete':
              return { type: 'done', content: textBufferRef.current }
            case 'usage_update':
              return { type: 'usage_update', size: Number(u.size) || 0, used: Number(u.used) || 0 }
            case 'available_commands_update':
              return { type: 'available_commands', commands: u.commands || u.availableCommands || u.available_commands || [] }
            case 'session_info_update': {
              // Backends sometimes carry errors, notices, or even the final
              // reply inside session_info_update. We used to silently drop it
              // (default: return null), which produced a blank UI with no clue.
              // Now we ALWAYS dump the raw payload (no DEV gate — production
              // builds strip import.meta.env, which is exactly why we went
              // blind before) and surface any error/text we can find.
              const rawSiup = (() => { try { return JSON.stringify(u) } catch { return String(u) } })()
              const err = u.error || u.errorMessage || u.err
              if (err) {
                return { type: 'error', content: typeof err === 'string' ? err : JSON.stringify(err) }
              }
              if (u.status === 'error' || u.status === 'failed') {
                const m = u.message || u.reason || u.detail || (typeof u.content === 'string' ? u.content : '')
                return { type: 'error', content: m || '会话返回错误状态' }
              }
              const msg = (typeof u.content === 'string' && u.content.trim()) ? u.content
                : (typeof u.message === 'string' && u.message.trim()) ? u.message
                : (typeof u.text === 'string' && u.text.trim()) ? u.text
                : null
              if (msg) return { type: 'text', content: msg }
              // Couldn't classify this as error/text. If the run already
              // streamed real content, a stray session_info_update is just
              // trailing metadata — drop it quietly (raw already logged).
              // If it's the ONLY thing we got, surface the raw payload so the
              // UI is never left blank and we can see what the backend said.
              if (!streamedContent) {
                return { type: 'text', content: '⚠️ 该模型未返回文本流，网关仅回传了 session_info_update。原始内容：\n' + rawSiup.slice(0, 2000) }
              }
              return null
            }
            default:
              return null
          }
        }
        if (method === 'session/complete' || method === 'session/end') {
          return { type: 'done', content: textBufferRef.current }
        }
        if (method === 'error') {
          return { type: 'error', content: params?.message || 'Hermes 错误' }
        }
        return null
      }

      // ── Hermes todo-list extraction ──────────────────────────────────────
      // Hermes carries an in-session todo list and streams it via session/update
      // events whose sessionUpdate name includes "todo"/"task"/"plan" (per the
      // user: "独立 session/update 事件"). It may also surface the full list
      // inside a `todo_write` tool result. We try both, tolerate unknown field
      // shapes, and normalize every item to { id, content, status, activeForm }.
      // The captured list is pushed to the store so the header button can show
      // it; an empty/garbage payload is ignored (button stays hidden).
      const STATUS_MAP: Record<string, 'pending' | 'in_progress' | 'completed' | 'cancelled'> = {
        pending: 'pending',
        todo: 'pending',
        not_started: 'pending',
        queued: 'pending',
        in_progress: 'in_progress',
        inprogress: 'in_progress',
        doing: 'in_progress',
        running: 'in_progress',
        active: 'in_progress',
        completed: 'completed',
        done: 'completed',
        finished: 'completed',
        cancelled: 'cancelled',
        canceled: 'cancelled',
        abandoned: 'cancelled',
      }
      const parseTodoItem = (raw: any): HermesTodo | null => {
        if (!raw || typeof raw !== 'object') return null
        const content =
          raw.content ?? raw.title ?? raw.text ?? raw.label ?? raw.name ?? raw.task ?? ''
        const statusRaw = String(raw.status ?? raw.state ?? 'pending').toLowerCase()
        const status = STATUS_MAP[statusRaw] || 'pending'
        if (typeof content !== 'string' || !content.trim()) return null
        return {
          id: typeof raw.id === 'string' && raw.id ? raw.id : 'todo-' + Math.abs(hashString(content + status)).toString(36),
          content: content.trim(),
          status,
          activeForm: typeof raw.activeForm === 'string' ? raw.activeForm : undefined,
        }
      }
      const extractTodoList = (payload: any): HermesTodo[] | null => {
        if (!payload || typeof payload !== 'object') return null
        // session/update wraps the list in `.update` (or `.params.update`)
        const u = payload.update ?? payload.params?.update ?? payload
        // Direct array on the event? ACP's native plan update uses `entries`
        // (PlanEntry[] with content/priority/status) — see acp.schema.AgentPlanUpdate.
        // Also accept the legacy todos/items/taskList/list field names.
        const arr =
          u?.entries ?? u?.todos ?? u?.items ?? u?.taskList ?? u?.list ??
          u?.update?.entries ?? u?.update?.todos ?? u?.update?.items ??
          payload?.entries ?? payload?.todos ?? payload?.items
        if (Array.isArray(arr)) {
          const items = arr.map(parseTodoItem).filter(Boolean) as HermesTodo[]
          return items.length ? items : null
        }
        // tool_call with name todo_write/TodoWrite may carry `todos` in rawInput
        const toolName = String(u?.title ?? u?.toolName ?? payload?.title ?? '').toLowerCase()
        if (/todo_write|todowrite|todo_update|task_create|task_update/.test(toolName)) {
          const ri = u?.rawInput
          let parsedInput = ri
          if (typeof ri === 'string') { try { parsedInput = JSON.parse(ri) } catch { parsedInput = null } }
          const inner = Array.isArray(parsedInput?.todos) ? parsedInput.todos
            : Array.isArray(parsedInput?.items) ? parsedInput.items
            : Array.isArray(parsedInput?.taskList) ? parsedInput.taskList
            : Array.isArray(parsedInput?.list) ? parsedInput.list
            : null
          if (Array.isArray(inner)) {
            const items = inner.map(parseTodoItem).filter(Boolean) as HermesTodo[]
            return items.length ? items : null
          }
        }
        return null
      }
      const pushTodos = (list: HermesTodo[] | null) => {
        if (list && list.length) {
          useHelixStore.getState().setHermesTodos(list)
        }
      }

      // Simple stable string hash (for deriving todo ids when the backend
      // doesn't supply one). Defined before the todo parser uses it.
      function hashString(s: string): number {
        let h = 0
        for (let i = 0; i < s.length; i++) {
          h = (h << 5) - h + s.charCodeAt(i)
          h |= 0
        }
        return h
      }

      // Event-driven async queue — no polling. Producers push items and
      // wake the consumer immediately via a resolver.
      const queue: string[] = []
      let queueDone = false
      let queueWaiter: (() => void) | null = null
      function enqueue(item: string) {
        queue.push(item)
        if (queueWaiter) { const w = queueWaiter; queueWaiter = null; w() }
      }
      function dequeue(): string | null {
        return queue.length > 0 ? queue.shift()! : null
      }
      async function waitForItem(): Promise<boolean> {
        if (queue.length > 0 || queueDone) return true
        return new Promise<boolean>(resolve => {
          queueWaiter = () => resolve(true)
        })
      }

      // Fallback done timer: Hermes doesn't always emit a run_complete/session/complete
      // for short text replies. If no real completion event arrives, synthesize one after
      // the stream has been idle for a short while. Each real content chunk resets the timer.
      const scheduleSynthDone = (delay: number) => {
        if (synthDoneTimerRef.current) clearTimeout(synthDoneTimerRef.current)
        synthDoneTimerRef.current = setTimeout(() => {
          if (!queueDone) {
            enqueue('data: ' + JSON.stringify({ type: 'done', content: textBufferRef.current }))
            queueDone = true
          }
          synthDoneTimerRef.current = null
        }, delay)
      }

      unsubscribe = window.electron.hermes.onEvent(async (method: string, params: any) => {
        const now = Date.now()
        // Track time to first token on first meaningful event
        if (method === 'session/update' && (
          params?.update?.sessionUpdate === 'agent_message_chunk' ||
          params?.update?.sessionUpdate === 'agent_thought_chunk'
        )) {
          if (promptSentAtRef.current && !firstContentAtRef.current) {
            firstContentAtRef.current = now
          }
        }
        try {
          // When Hermes starts retrying after a connection error, clear the
          // accumulated text/thinking buffers so the retry response replaces
          // (not appends to) the partial content from the failed attempt.
          if (method === 'gateway.retry') {
            const phase = params?.phase as string | undefined
            if (phase === 'error') {
              textBufferRef.current = ''
              thoughtBufferRef.current = ''
              pendingTextRef.current = ''
              pendingThinkingRef.current = ''
              // Strip trailing thinking/text blocks so re-streamed content
              // replaces (not appends to) the in-progress response blocks, preventing
              // duplicate thinking/text output after reconnect.
              setResponseBlocks(prev => {
                const nb = prev.slice()
                while (nb.length > 0) {
                  const last = nb[nb.length - 1]
                  if (last.type === 'thinking' || last.type === 'text') nb.pop()
                  else break
                }
                return nb
              })
              setStreamThinking('')
              useHelixStore.getState().setConnectionNotice({ phase: 'error', message: '连接中断', ts: Date.now() })
            } else if (phase === 'retrying') {
              textBufferRef.current = ''
              thoughtBufferRef.current = ''
              pendingTextRef.current = ''
              pendingThinkingRef.current = ''
              setStreamThinking('')
              // Strip trailing thinking/text blocks so re-streamed content
              // replaces (not appends to) the in-progress response blocks, preventing
              // duplicate thinking/text output after reconnect.
              setResponseBlocks(prev => {
                const nb = prev.slice()
                while (nb.length > 0) {
                  const last = nb[nb.length - 1]
                  if (last.type === 'thinking' || last.type === 'text') nb.pop()
                  else break
                }
                return nb
              })
              const attempt = params?.attempt ?? 1
              const total = params?.total ?? 3
              useHelixStore.getState().setConnectionNotice({ phase: 'retrying', attempt, total, message: '连接中断，正在重连... (' + attempt + '/' + total + ')', ts: Date.now() })
            } else if (phase === 'recovered') {
              useHelixStore.getState().setConnectionNotice({ phase: 'recovered', message: '连接已恢复', ts: Date.now() })
              setTimeout(() => useHelixStore.getState().setConnectionNotice(null), 2000)
            }
            // Safety: clear stale retrying notices after 30 seconds
            if (phase === 'retrying') {
              setTimeout(() => {
                const cur = useHelixStore.getState().connectionNotice
                if (cur?.phase === 'retrying') {
                  useHelixStore.getState().setConnectionNotice(null)
                }
              }, 30000)
            }
          }
          const parsed = mapHermesEvent(method, params)
          if (parsed) {
            enqueue('data: ' + JSON.stringify(parsed))
          }
          // Capture Hermes's in-session todo list from dedicated todo/plan
          // session/update events (or todo_write tool results) so the header
          // button can surface it. Silently ignored when no list is present.
          if (method === 'session/update') {
            const su = params?.update?.sessionUpdate || params?.update?.type || ''
            if (/todo|task|plan/i.test(String(su))) {
              pushTodos(extractTodoList(params))
            }
          }
          if (parsed && (parsed.type === 'done' || parsed.type === 'error')) queueDone = true
          if (parsed && (parsed.type === 'text' || parsed.type === 'thinking' || parsed.type === 'tool_call' || parsed.type === 'tool_result')) {
            streamedContent = true
            if (!firstContentAtRef.current) firstContentAtRef.current = Date.now()
            scheduleSynthDone(2000)
          }
          // A real text chunk (or tool result) means the gateway is delivering again →
          // clear any transient "reconnecting" notice so it doesn't linger.
          if (parsed && (parsed.type === 'text' || parsed.type === 'tool_result')) {
            const cur = useHelixStore.getState().connectionNotice
            if (cur && cur.phase !== 'recovered') {
              useHelixStore.getState().setConnectionNotice(null)
            }
          }
        } catch (e) {
          console.error('[Helix] event handling error', e)
        }
      })

      // Build a multimodal prompt: inline text files + image attachments,
      // then the user's text. Lets the Agent actually process dropped files.
      const promptItems: Array<Record<string, any>> = []
      const allImages = [
        ...(imagesSnapshot || []).map(i => i.dataUrl).filter(Boolean),
        ...(filesSnapshot || [])
          .filter(f => f.kind === 'image' && f.dataUrl)
          .map(f => f.dataUrl as string),
      ]
      for (const url of allImages) {
        promptItems.push({ type: 'image_url', image_url: { url } })
      }
      let fileContext = ''
      for (const f of filesSnapshot || []) {
        if (f.kind === 'text' && f.base64) {
          try {
            const content = decodeBase64Utf8(f.base64)
            fileContext += `\n\n--- 文件 ${f.name} 的内容 ---\n${content}`
          } catch { /* skip undecodable */ }
        } else if (f.kind === 'file') {
          fileContext += `\n\n[已附加文件: ${f.name} (${formatBytes(f.size)})]`
          // Inject the absolute path so the model can read it using Read tool
          if (f.path) {
            const normalizedPath = f.path.replace(/\\/g, '/')
            fileContext += ` 文件路径: ${normalizedPath}`
          }
        }
      }
      const promptText = (trimmed + fileContext).trim() || trimmed
      promptItems.push({ type: 'text', text: promptText })

      // Fire the prompt — events stream back via onEvent (don't await the promise itself).
      // ACP expects prompt as a list of content blocks, not a plain string
      promptSentAtRef.current = Date.now()
      window.electron.hermes.send('session/prompt', {
        session_id: sessionId,
        prompt: [{ type: 'text', text: promptText }],
      }).then((result: any) => {
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
          thoughtTokensRef.current = Number(usage.thoughtTokens) || 0
          setStreamThoughtTokens(thoughtTokensRef.current)
          usageReceivedRef.current = true
        }
        // Some providers return the entire reply in the session/prompt response
        // instead of streaming it as agent_message_chunk (e.g. non-streaming
        // backends). If we received no streamed text, surface that reply so the
        // user isn't left with a blank UI.
        const direct = result?.content || result?.message || result?.response || result?.text
        if (typeof direct === 'string' && direct.trim() && !textBufferRef.current) {
          enqueue('data: ' + JSON.stringify({ type: 'text', content: direct }))
          enqueue('data: ' + JSON.stringify({ type: 'done', content: direct }))
        }
        // Hermes finished the turn (stopReason comes back via the prompt
        // response). It does NOT always emit a separate run_complete /
        // session/complete notification, so synthesize a `done` event so the
        // assistant reply actually gets persisted into chatMessages. Without
        // this the reply lives only in the in-memory responseBlocks and is
        // lost when switching conversations.
        //
        // NOTE: session/prompt IPC returns immediately (fire-and-forget), so
        // this .then() fires BEFORE any session/update notifications arrive.
        //
        // CRITICAL: this timer starts from the prompt ack, NOT from first token.
        // Slow providers (e.g. agnes: ~5-6s of metadata probes + ~10s to first
        // chunk) deliver their first chunk well after 8s. If synth-done fires
        // first, the consumer loop `break`s and `finally` unsubscribes the
        // onEvent handler — so every real chunk that arrives afterwards is
        // dropped (symptom: event count {} while the terminal shows 36 chunks
        // forwarded). Therefore the PRE-FIRST-TOKEN fallback must be much longer
        // than any provider's time-to-first-token. Once the first chunk arrives,
        // the per-chunk `scheduleSynthDone(2000)` at line ~1449 takes over and
        // provides the quick idle flush for short replies / dropped run_complete.
        scheduleSynthDone(90000)
      }).catch((err: any) => {
        console.error('[Helix] session/prompt error', err)
        enqueue('data: ' + JSON.stringify({ type: 'error', content: err?.message || '请求失败' }))
        queueDone = true
      })

      // Process the event queue using the existing UI parser (unchanged below).
      while (true) {
        const line = dequeue()
        if (!line) {
          if (queueDone) break
          await waitForItem()
          continue
        }
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)

            if (parsed.type === 'tool_call') {
              const toolCallId = parsed.toolCallId || ''
              const isSubAgentTool = typeof toolCallId === 'string' && toolCallId.startsWith('sa-')

              // Sub-agent tool calls: append as sub-step to the last delegate_task step
              if (isSubAgentTool) {
                const subStep: ExecutionStep = {
                  id: generateId(), type: 'tool_call',
                  content: getToolDisplayLabel(parsed.toolName, parsed.toolKind, undefined, parsed.toolParams),
                  toolName: parsed.toolName,
                  toolKind: parsed.toolKind,
                  toolParams: parsed.toolParams,
                  timestamp: Date.now(),
                }
                setSteps(prev => {
                  const next = [...prev]
                  // Find the last delegate_task step (running)
                  for (let i = next.length - 1; i >= 0; i--) {
                    if (next[i].type === 'tool_call' && next[i].toolName?.startsWith('SubAgent')) {
                      next[i] = { ...next[i], subSteps: [...(next[i].subSteps || []), subStep] }
                      break
                    }
                  }
                  return next
                })
                return
              }

              // Extract file paths from tool params to track directories
              const params = parsed.toolParams || {}
              const pathKeys = ['path', 'file_path', 'filepath', 'filePath', 'file', 'filename']
              let filePath = ''
              for (const k of pathKeys) {
                if (params[k] && typeof params[k] === 'string') {
                  filePath = String(params[k])
                  break
                }
              }
              if (!filePath && params.raw && typeof params.raw === 'string') {
                try {
                  const raw = JSON.parse(params.raw)
                  for (const k of pathKeys) {
                    if (raw[k] && typeof raw[k] === 'string') {
                      filePath = String(raw[k])
                      break
                    }
                  }
                } catch {}
              }
              if (filePath) {
                const dir = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '/'
                storeActions.addAccessedDirectory(dir)
              } else if (params.command && typeof params.command === 'string') {
                // Track bash commands that reference paths
                const match = params.command.match(/[`'"]?([\w/.-]+(?:\.\w+)+)[`'"]?/g)
                if (match) {
                  match.forEach(p => {
                    const dir = p.replace(/[`'"]/g, '').split('/').slice(0, -1).join('/')
                    if (dir) storeActions.addAccessedDirectory(dir)
                  })
                }
              }
              const id = generateId()
              const isDelegateTask = parsed.toolName?.startsWith('Delegating')
              // All tool_calls start as 'running' so the top status bar can surface
              // "正在执行工具：read xxx / bash xxx". They'll be marked
              // completed/failed when a matching tool_result or error arrives.
              const step: ExecutionStep = {
                id, type: 'tool_call',
                content: getToolDisplayLabel(parsed.toolName, parsed.toolKind, filePath, params),
                toolName: parsed.toolName,
                toolKind: parsed.toolKind,
                toolParams: params,
                timestamp: Date.now(),
                status: 'running',
                subSteps: isDelegateTask ? [] : undefined,
              }
              setSteps(prev => [...prev, step])
              storeActions.addExecutionStep({ type: 'tool_call', toolName: parsed.toolName, toolKind: parsed.toolKind, path: filePath || undefined, toolParams: params })

              // 修改文件时（write_file / patch）把改动写入 pendingChanges，
              // 触发 DiffPreview 弹窗显示 diff（实现「修改文件时显示 diff」）。
              // 注意：Hermes 的 tool_call 事件里 toolName 是人类可读标题（如 "write: …"），
              // 不是工具原始名，所以不能用 === 'write_file' 判断。Hermes 把这两个文件工具
              // 的 kind 都映射成 'edit'（见 acp_adapter/tools.py 的 TOOL_KIND_MAP），
              // 因此用 toolKind==='edit' + 文件路径 + 内容参数来判定文件修改。
              if (filePath && parsed.toolKind === 'edit') {
                const p = params as Record<string, any>
                let oldContent = ''
                let newContent = ''
                const os = p.old_string ?? p.old_text
                const ns = p.new_string ?? p.new_text
                if (os !== undefined || ns !== undefined) {
                  oldContent = String(os ?? '')
                  newContent = String(ns ?? '')
                } else if (p.content !== undefined) {
                  newContent = String(p.content)
                } else if (p.patch !== undefined) {
                  newContent = String(p.patch)
                }
                if (oldContent || newContent) {
                  const fileName = filePath.split(/[/\\]/).pop() || filePath
                  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
                  const langMap: Record<string, string> = {
                    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
                    py: 'python', md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml',
                    css: 'css', html: 'html', sh: 'bash',
                  }
                  storeActions.addPendingChange({
                    fileId: filePath,
                    fileName,
                    filePath,
                    oldContent,
                    newContent,
                  language: langMap[ext] || 'plaintext',
                })
                }
              }

              // 每个工具调用独立成块，不再与上一个 tool_group 合并，
              // 这样连续多个工具调用也会各自独立、可与文本交叉显示。
              setResponseBlocks(prev => [...prev, { type: 'tool_group', steps: [step] }])
            } else if (parsed.type === 'thinking') {
              if (!thinkingStartTimeRef.current) thinkingStartTimeRef.current = Date.now()
              const inc = normalizeAcpContent(parsed.content)
              const cur = thoughtBufferRef.current
              const curTrim = cur.trim()
              const incTrim = inc.trim()
              const isCumulative = curTrim && incTrim.startsWith(curTrim)
              
              if (isCumulative) {
                // Hermes sent cumulative content - replace, don't append
                thoughtBufferRef.current = inc
              } else {
                // Hermes sent incremental content - append
                thoughtBufferRef.current = cur + inc
              }
              pendingThinkingRef.current = thoughtBufferRef.current
              
              // Update responseBlocks - replace if cumulative, append if incremental
              setResponseBlocks(prev => {
                const last = prev.length > 0 ? prev[prev.length - 1] : null
                if (last && last.type === 'thinking') {
                  const nb = prev.slice()
                  if (isCumulative) {
                    // Replace with full content
                    nb[nb.length - 1] = { type: 'thinking', content: inc }
                  } else {
                    // Append incremental content
                    nb[nb.length - 1] = { type: 'thinking', content: last.content + inc }
                  }
                  return nb
                }
                // Create a new thinking block
                return [...prev, { type: 'thinking', content: inc }]
              })
              scheduleStreamRender()
            } else if (parsed.type === 'reasoning') {
              const id = generateId()
              setSteps(prev => [...prev, { id, type: 'reasoning', content: normalizeAcpContent(parsed.content), timestamp: Date.now() }])
            } else if (parsed.type === 'file_change') {
              const id = generateId()
              setSteps(prev => [...prev, { id, type: 'file_change', content: parsed.content, fileChanges: parsed.fileChanges, timestamp: Date.now() }])
            } else if (parsed.type === 'tool_result') {
              const id = generateId()
              const step: ExecutionStep = { id, type: 'tool_result', content: parsed.content, toolName: parsed.toolName, timestamp: Date.now() }
              setSteps(prev => [...prev, step])
              storeActions.addExecutionStep({ type: 'tool_result', toolName: parsed.toolName })
              // Mark the matching tool_call step as completed so the top status
              // bar stops showing it in "正在执行工具". We match by the last
              // unfinished tool_call (serial execution) or any running one.
              setSteps(prev => {
                const next = [...prev]
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].type === 'tool_call' && next[i].status === 'running') {
                    next[i] = { ...next[i], status: 'completed' as const }
                    break
                  }
                }
                return next
              })
              // tool_result 归到第一个尚未收到结果的 tool_group 块
              // （串行时即当前块；并行时按调用顺序依次填充，避免全堆到最后一块）。
              setResponseBlocks(prev => {
                const idx = prev.findIndex(b => {
                  if (b.type !== 'tool_group') return false
                  return !b.steps.some(s => s.type === 'tool_result' || s.type === 'error')
                })
                if (idx !== -1) {
                  const cur = prev[idx] as Extract<ResponseBlock, { type: 'tool_group' }>
                  const nb = prev.slice()
                  nb[idx] = { type: 'tool_group', steps: [...cur.steps, step] }
                  return nb
                }
                return [...prev, { type: 'tool_group', steps: [step] }]
              })
            } else if (parsed.type === 'tool_output_delta') {
              // Streaming output chunk from a running tool — append to the
              // latest tool_call step's content so the user sees output in real time.
              const delta = normalizeAcpContent(parsed.content)
              if (!delta) return
              setSteps(prev => {
                const next = [...prev]
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].type === 'tool_call' && next[i].status !== 'completed' && next[i].status !== 'failed') {
                    next[i] = { ...next[i], content: (next[i].content || '') + delta }
                    break
                  }
                }
                return next
              })
              // Also append to the corresponding tool_group in responseBlocks
              setResponseBlocks(prev => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  const block = prev[i]
                  if (block.type !== 'tool_group') continue
                  const lastToolCall = [...block.steps].reverse().find(s => s.type === 'tool_call' && s.status !== 'completed' && s.status !== 'failed')
                  if (lastToolCall) {
                    const nb = prev.slice()
                    nb[i] = { ...block, steps: block.steps.map(s => s.id === lastToolCall.id ? { ...s, content: (s.content || '') + delta } : s) }
                    return nb
                  }
                }
                return prev
              })
            } else if (parsed.type === 'text') {
              // Hermes streams the reply as word/token chunks and ALSO re-sends
              // the full final_response as another agent_message_chunk at the
              // end (acp.update_agent_message_text). If the incoming chunk is the
              // complete text, replace instead of appending — kills duplication.
              // Also detect retry-duplicated content: when Hermes retries after an
              // MCP failure, the model regenerates similar text which should
              // replace (not append to) the existing buffer.
              const incRaw = normalizeAcpContent(parsed.content)
              const cur = textBufferRef.current
              const curTrim = cur.trim()
              const incTrim = incRaw.trim()
              let newText: string
              if (!curTrim) {
                newText = incRaw
              } else if (incTrim.startsWith(curTrim)) {
                // New text is a superset of accumulated text (Hermes full resend)
                newText = incRaw
              } else if (curTrim.startsWith(incTrim)) {
                // Incoming is a subset of accumulated (retry sent shorter text) — keep the
                // more complete accumulated buffer to avoid truncation.
                newText = cur
              } else {
                // Check for content overlap to avoid duplication on partial resends.
                // For streaming tokens (chunk < 100 chars), skip expensive overlap scan —
                // the overhead isn't worth it for normal token-by-token delivery.
                let overlap = 0
                if (incTrim.length < 100) {
                  // Small chunk: just append (normal streaming path)
                  overlap = 0
                } else {
                  // Large chunk (full resend / retry): check overlap but cap at
                  // min(incoming, 500) chars to bound worst-case cost.
                  const maxCheck = Math.min(incTrim.length, 500)
                  for (let len = maxCheck; len > 1; len--) {
                    if (curTrim.endsWith(incTrim.substring(0, len))) {
                      overlap = len
                      break
                    }
                  }
                }
                newText = overlap > 0 ? cur + incRaw.slice(overlap) : cur + incRaw
              }
              textBufferRef.current = newText
              pendingTextRef.current = newText

              // If the model embeds its reasoning inside <think:ID>...</think:ID> tags
              // instead of emitting a separate thinking stream, surface it as the thinking block.
              if (!thoughtBufferRef.current) {
                const { content: cleaned, reasoning } = extractThinkTags(newText)
                if (reasoning) {
                  thoughtBufferRef.current = reasoning
                  pendingThinkingRef.current = reasoning
                  setStreamThinking(reasoning)
                  // If all text was inside <think:ID> tags (e.g. DeepSeek-style
                  // output), fall back to showing reasoning as visible content
                  // rather than leaving the message empty.
                  textBufferRef.current = cleaned || reasoning
                  pendingTextRef.current = cleaned || reasoning
                }
              }

              scheduleStreamRender()
            } else if (parsed.type === 'done') {
              if (doneProcessedRef.current) { queueDone = true; return }
              // Wait for usage data if not received yet (max 500ms)
              if (!usageReceivedRef.current) {
                await new Promise(r => setTimeout(r, 500))
              }
              doneProcessedRef.current = true
              let content = textBufferRef.current
              let reasoning = thoughtBufferRef.current
              const completedSteps = stepsRef.current
              textBufferRef.current = ''
              thoughtBufferRef.current = ''
              pendingTextRef.current = null
              pendingThinkingRef.current = null
              rafPendingRef.current = false
              setStreamThinking('')
              if (content || reasoning || completedSteps.length > 0 || responseBlocksRef.current.length > 0) {
                // Some models place reasoning inside <think:ID>...</think:ID> tags as part of the final text.
                if (!reasoning) {
                  const extracted = extractThinkTags(content)
                  if (extracted.reasoning) {
                    reasoning = extracted.reasoning
                    content = extracted.content || extracted.reasoning
                  }
                }
                // If the model only emitted thinking tokens and no visible text,
                // surface the reasoning as the message content so the user sees
                // something useful instead of a blank reply.
                if (!content && reasoning) {
                  content = reasoning
                  reasoning = ''
                }
                // Auto-create scheduled tasks the assistant embedded as ```scheduled-task blocks.
                const extracted = extractScheduledTasks(content)
                content = extracted.cleaned
                if (extracted.created.length > 0) {
                  const st = useHelixStore.getState()
                  st.showToast({ type: 'success', title: `已创建定时任务：${extracted.created.join('、')}` })
                  if (!st.showScheduledTasksPanel) st.toggleScheduledTasksPanel()
                }
                const curState = useHelixStore.getState()
                const endTs = Date.now()
                let thinkingSecs = thinkingStartTimeRef.current
                  ? Math.round((endTs - thinkingStartTimeRef.current) / 1000)
                  : (firstContentAtRef.current && promptSentAtRef.current
                      ? Math.round((firstContentAtRef.current - promptSentAtRef.current) / 1000)
                      : 0)
                // 极短思考（<0.5s 取整为 0）但有思考迹象时，至少记为 1s，避免"有思考却不显示"
                if (thinkingSecs === 0 && (thinkingStartTimeRef.current || firstContentAtRef.current)) thinkingSecs = 1
                thinkingDurationRef.current = thinkingSecs
                // If responseBlocks only has thinking (no text block) but content
                // is non-empty, discard blocks so the renderer falls back to
                // rendering msg.content — prevents "only thinking, no result".
                let finalBlocks = responseBlocksRef.current.length ? responseBlocksRef.current : undefined
                if (finalBlocks && content && !finalBlocks.some(b => b.type === 'text')) {
                  finalBlocks = undefined
                }
                const msgId = curState.addChatMessage({ role: 'assistant', content, reasoning: reasoning || undefined, steps: completedSteps.length ? completedSteps : undefined, blocks: finalBlocks, sessionId: runningSessionIdRef.current || undefined, thoughtTokens: thoughtTokensRef.current || undefined, thinkingTime: thinkingDurationRef.current || undefined })
                thoughtTokensRef.current = 0
                setStreamThoughtTokens(0)
                thinkingStartTimeRef.current = 0
                thinkingDurationRef.current = 0
                curState.setChatMessageStreaming(msgId, false)
              } else {
                // 防御性兜底：run 结束但无任何可见内容（根因已修复，极少触发）。
                const st = useHelixStore.getState()
                const mid = st.addChatMessage({ role: 'assistant', content: '⚠️ 本轮运行已结束，但模型未返回任何可见内容。', sessionId: runningSessionIdRef.current || undefined })
                st.setChatMessageStreaming(mid, false)
              }
              // Hermes' ACP adapter only emits a `tool_call` (tool.started) event
              // and NOT a matching completion/failure event (see backend
              // _tool_progress: `if event_type != "tool.started": return`). So a
              // tool_call step we created as `running` would otherwise stay stuck
              // in "正在执行工具" forever. On done, flush any lingering running
              // tool calls to completed so the status bar clears and the tool
              // card shows a finished state.
              setSteps(prev => {
                const next = prev.map(s =>
                  s.type === 'tool_call' && s.status === 'running'
                    ? { ...s, status: 'completed' as const }
                    : s
                )
                return [...next, { id: generateId(), type: 'done', content: parsed.content, finishReason: parsed.finishReason, timestamp: Date.now() }]
              })
              setResponseBlocks([])
            } else if (parsed.type === 'error') {
              const content = textBufferRef.current
              const reasoning = thoughtBufferRef.current
              const errorSteps = stepsRef.current
              textBufferRef.current = ''
              thoughtBufferRef.current = ''
              pendingTextRef.current = null
              pendingThinkingRef.current = null
              rafPendingRef.current = false
              setStreamThinking('')
              if (content || reasoning || errorSteps.length > 0 || responseBlocks.length > 0) {
                const curState = useHelixStore.getState()
                const msgId = curState.addChatMessage({ role: 'assistant', content, reasoning: reasoning || undefined, steps: errorSteps.length ? errorSteps : undefined, blocks: responseBlocksRef.current.length ? responseBlocksRef.current : undefined, sessionId: runningSessionIdRef.current || undefined })
                curState.setChatMessageStreaming(msgId, false)
              } else if (parsed.content) {
                // Pure error with no streamed content — surface it as an assistant message
                const curState = useHelixStore.getState()
                const msgId = curState.addChatMessage({ role: 'assistant', content: '⚠️ ' + parsed.content, sessionId: runningSessionIdRef.current || undefined })
                curState.setChatMessageStreaming(msgId, false)
              }
              setResponseBlocks([])
              // Mark all running tool_calls as failed so they disappear from the
              // "正在执行工具" status bar.
              const errId = generateId()
              setSteps(prev => {
                const next = prev.map(s =>
                  s.type === 'tool_call' && s.status === 'running'
                    ? { ...s, status: 'failed' as const }
                    : s
                )
                return [...next, { id: errId, type: 'error', content: parsed.content, timestamp: Date.now() }]
              })
              storeActions.addExecutionStep({ type: 'error' })
            } else if (parsed.type === 'plan') {
              const id = generateId()
              setSteps(prev => [...prev, { id, type: 'plan', content: '模型已规划以下步骤', planText: parsed.planText || parsed.content, timestamp: Date.now() }])
              storeActions.addExecutionStep({ type: 'plan' })
            } else if (parsed.type === 'task') {
              const id = generateId()
              setSteps(prev => [...prev, { id, type: 'task', content: parsed.content, taskLabel: parsed.taskLabel, taskId: parsed.taskId, timestamp: Date.now() }])
              storeActions.addExecutionStep({ type: 'task' })
            } else if (parsed.type === 'compact') {
              const id = generateId()
              setSteps(prev => [...prev, { id, type: 'compact', content: parsed.content, timestamp: Date.now() }])
            } else if (parsed.type === 'usage_update') {
              useHelixStore.getState().setContextUsage(parsed.size, parsed.used)
            } else if (parsed.type === 'usage_prompt_complete') {
              const u = parsed.usage
              if (u && typeof u === 'object') {
                const model = useHelixStore.getState().apiConfig.model || 'unknown'
                useHelixStore.getState().addSessionUsageStats(model, {
                  totalTokens: Number(u.totalTokens) || undefined,
                  inputTokens: Number(u.inputTokens) || undefined,
                  outputTokens: Number(u.outputTokens) || undefined,
                  thoughtTokens: Number(u.thoughtTokens) || undefined,
                  cachedReadTokens: Number(u.cachedReadTokens) || undefined,
                  cachedWriteTokens: Number(u.cachedWriteTokens) || undefined,
                })
                usageReceivedRef.current = true
                thoughtTokensRef.current = Number(u.thoughtTokens) || 0
                setStreamThoughtTokens(thoughtTokensRef.current)
              }
            } else if (parsed.type === 'available_commands') {
              useHelixStore.getState().setAvailableCommands(parsed.commands)
            } else if (parsed.type === 'approval_request') {
              setApprovalQueue(prev => [...prev, {
                id: parsed.approvalId,
                toolName: parsed.toolName,
                params: parsed.toolParams || {},
                timestamp: Date.now(),
              }])
            }
          } catch {
            // skip non-JSON lines
          }
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Save partial response before showing error
        if (textBufferRef.current) {
          const partialContent = textBufferRef.current
          const partialReasoning = thoughtBufferRef.current || undefined
          const msgId = useHelixStore.getState().addChatMessage({
            role: 'assistant',
            content: partialContent + '\n\n*[执行已中断]*',
            reasoning: partialReasoning,
            sessionId: runningSessionIdRef.current || undefined,
          })
          useHelixStore.getState().setChatMessageStreaming(msgId, false)
        }
        pendingTextRef.current = null
        pendingThinkingRef.current = null
        rafPendingRef.current = false
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
      // Always unsubscribe to prevent duplicate event handlers
      try { if (unsubscribe) unsubscribe() } catch {}
      
      // Cancel any pending synthetic-done timer so it can't fire after the run
      // ended (e.g. on abort / unmount) and call setState on a dead context.
      if (synthDoneTimerRef.current) {
        clearTimeout(synthDoneTimerRef.current)
        synthDoneTimerRef.current = null
      }
      const sid = runningSessionIdRef.current
      if (sid) {
        setStreamingDraft(sid, { isAgentRunning: false })
        // Once the reply is persisted, the draft is no longer needed; clear it
        // on the next tick so any render this cycle still sees the final steps.
        setTimeout(() => clearStreamingDraft(sid), 0)
      }
      runningSessionIdRef.current = null
      abortRef.current = null
      useHermesStore.setState({ isChatLoading: false })

      // Git auto-commit/push after agent completes
      if (isElectron() && sid) {
        const { gitAutoCommit, gitAutoPush, gitCommitTemplate } = useHelixStore.getState()
        if (gitAutoCommit) {
          try {
            const stageResult = await window.electron.git.stage()
            if (stageResult?.ok) {
              const msg = gitCommitTemplate || 'chore: auto-commit changes'
              await window.electron.git.commit(msg)
              if (gitAutoPush) {
                await window.electron.git.push()
              }
            }
          } catch (e) {
            console.error('[GitAutoCommit] Failed:', e)
          }
        }
      }

      // Debounced full-session persist handles saving; mark as saved
      if (!savedSessionRef.current) {
        savedSessionRef.current = true
        storeActions.notifySessionSaved()
      }
    }
  }, [input, isBusy, hasApiKey, currentSessionId, setStreamingDraft, clearStreamingDraft, storeActions, resolveCommand, BUILTIN_COMMANDS, setInputSynced, handleStop])


  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlashSkills && filteredSkills.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedSkillIndex(prev => Math.min(prev + 1, filteredSkills.length - 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedSkillIndex(prev => Math.max(prev - 1, 0))
          return
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          e.preventDefault()
          const idx = Math.min(selectedSkillIndex, filteredSkills.length - 1)
          const selected = filteredSkills[idx] as any
          if (!selected) return
          // Built-in / Hermes commands: send directly through handleRun
          if (selected.isHermesCommand || selected.isBuiltinCommand) {
            setInputSynced(`/${selected.name}`)
            setTimeout(() => {
              if (isBusy) {
                handleStop()
              } else {
                handleRun()
              }
            }, 0)
          } else if (selected.isCliCommand) {
            setInputSynced(selected.command || selected.name)
            inputRef.current?.focus()
          } else {
            handleSkillSelect(selected)
          }
          return
        }
        if (e.key === 'Escape') {
          setInputSynced('')
          return
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (isBusy) {
          handleStop()
        } else {
          handleRun()
        }
      }
    },
    [handleRun, handleStop, isBusy, showSlashSkills, filteredSkills, handleSkillSelect, selectedSkillIndex, setInputSynced]
  )

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items)
    const imageItems = items.filter(item => item.type.startsWith('image/'))

    if (imageItems.length === 0) return // Let normal text paste happen

    e.preventDefault()

    if (!canAddMoreImages(pendingImages.length, imageItems.length)) {
      storeActions.showToast({ type: 'warning', title: `最多粘贴 5 张图片` })
      return
    }

    const newImages: ImageAttachment[] = []
    for (const item of imageItems) {
      const blob = item.getAsFile()
      if (!blob) continue

      const attachment = await processClipboardImage(blob)
      if (attachment) newImages.push(attachment)
    }

    if (newImages.length > 0) {
      setPendingImages(prev => [...prev, ...newImages])
    }
  }, [pendingImages.length, storeActions.showToast])

  const removePendingImage = useCallback((id: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== id))
  }, [])

  // Turn a FileList (dropped or picked) into pending file attachments.
  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    if (files.length === 0) return
    const attachments = await Promise.all(files.map(f => fileToAttachment(f).catch(() => null)))
    const valid = attachments.filter((a): a is FileAttachment => a !== null)
    if (valid.length > 0) setPendingFiles(prev => {
      // Deduplicate by name + size to prevent duplicates
      const existing = new Set(prev.map(f => `${f.name}:${f.size}`))
      const newOnes = valid.filter(f => !existing.has(`${f.name}:${f.size}`))
      if (newOnes.length === 0) return prev
      return [...prev, ...newOnes]
    })
  }, [])

  const removePendingFile = useCallback((id: string) => {
    setPendingFiles(prev => prev.filter(f => f.id !== id))
  }, [])

  const handleApproval = useCallback(async (approvalId: string, approved: boolean, cacheDecision?: boolean) => {
    try {
      const sid = hermesSessionIdRef.current
      if (sid) {
        await window.electron.hermes.send('session/approve', {
          session_id: sid,
          toolCallId: approvalId,
          approve: approved,
        })
      }
      setApprovalQueue(prev => prev.filter(r => r.id !== approvalId))
    } catch (err) {
      console.error('Approval error:', err)
    }
  }, [])

  const handleApproveAll = useCallback(async () => {
    if (approvalQueue.length === 0) return
    try {
      const sid = hermesSessionIdRef.current
      if (sid) {
        for (const req of approvalQueue) {
          await window.electron.hermes.send('session/approve', {
            session_id: sid,
            toolCallId: req.id,
            approve: true,
          })
        }
      }
      setApprovalQueue([])
    } catch (err) {
      console.error('Approve all error:', err)
    }
  }, [approvalQueue])

  // Listen for keyboard shortcut approve/decline events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (approvalQueue.length === 0) return
      const first = approvalQueue[0]
      handleApproval(first.id, detail.approved)
    }
    window.addEventListener('helix:approve-request', handler)
    return () => window.removeEventListener('helix:approve-request', handler)
  }, [approvalQueue, handleApproval])

  // Stats
  const hasSteps = steps.length > 0

  
  // Highlight /command patterns in input
  const highlightedInput = useMemo(() => {
    if (!input) return null
    const parts = input.split(/(\/\w[\w-]*)/g)
    return parts.map((part, i) => {
      if (part.startsWith('/') && part.length > 1) {
        return <span key={i} className="text-primary font-medium">{part}</span>
      }
      return <span key={i}>{part}</span>
    })
  }, [input])

  const renderChatInput = ({ isEmpty }: { isEmpty?: boolean } = {}) => {
    const projectName = selectedWorkDir ? (selectedWorkDir.split(/[/\\]/).pop() || selectedWorkDir) : '选择项目'
    const approvalModeButton = (
      <div className="relative" ref={approvalModeDropdownRef}>
        <button
          type="button"
          onClick={() => setShowApprovalModeDropdown(!showApprovalModeDropdown)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all duration-200 bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/60"
          title="审批模式"
        >
          {approvalMode === 'default' && <Hand className="size-3.5" />}
          {approvalMode === 'accept_edits' && <Clock className="size-3.5" />}
          {approvalMode === 'dont_ask' && <AlertTriangle className="size-3.5" />}
          <span>
            {approvalMode === 'default' && '请求批准'}
            {approvalMode === 'accept_edits' && '替我审批'}
            {approvalMode === 'dont_ask' && '完全访问权限'}
          </span>
          <ChevronDown className="size-3" />
        </button>
        {showApprovalModeDropdown && (
          <div className="absolute bottom-full left-0 mb-2 w-72 bg-popover rounded-xl border border-border/40 shadow-xl py-1 z-50 animate-scale-in">
            {[
              {
                id: 'default' as const,
                icon: Hand,
                title: '请求批准',
                desc: '编辑外部文件和使用互联网时始终询问',
              },
              {
                id: 'accept_edits' as const,
                icon: Clock,
                title: '替我审批',
                desc: '仅对检测到的风险操作请求批准',
              },
              {
                id: 'dont_ask' as const,
                icon: AlertTriangle,
                title: '完全访问权限',
                desc: '可不受限制地访问互联网和您电脑上的任何文件',
              },
            ].map((mode) => {
              const Icon = mode.icon
              const active = approvalMode === mode.id
              return (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => {
                    setApprovalMode(mode.id)
                    setShowApprovalModeDropdown(false)
                    // Immediately apply to current session if one exists
                    const currentSessionId = hermesSessionIdRef.current
                    if (currentSessionId) {
                      window.electron?.hermes?.send('session/set_mode', {
                        session_id: currentSessionId,
                        mode_id: mode.id,
                      }).catch((e: any) => {
                        console.warn('[Helix] set_mode(' + mode.id + ') failed:', e)
                      })
                    }
                  }}
                  className={`w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-muted transition-colors ${active ? 'bg-primary/5' : ''}`}
                >
                  <div className="mt-0.5 shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center">
                    <Icon className="size-4 text-foreground/70" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground">{mode.title}</div>
                    <div className="text-xs text-muted-foreground leading-relaxed">{mode.desc}</div>
                  </div>
                  {active && (
                    <div className="mt-1 shrink-0">
                      <Check className="size-4 text-primary" />
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
    return (
    <div
      className={`border transition-all duration-200 relative bg-background/90 backdrop-blur-md border-border/40 rounded-2xl shadow-lg shadow-black/5 ${isDraggingFile ? 'border-primary/40' : 'hover:border-border/60 focus-within:border-primary/30'}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!isDraggingFile) setIsDraggingFile(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDraggingFile(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDraggingFile(false)
        if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
      }}
    >
            {/* Drag-over hint */}
            {isDraggingFile && (
              <div className={`absolute inset-0 z-30 flex items-center justify-center pointer-events-none bg-primary/10 text-sm font-medium text-primary rounded-2xl`}>
                松开以添加附件
              </div>
            )}
            {/* Textarea handles sizing + input */}
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={isEmpty ? "随心输入..." : "要求后续变更..."}
              rows={2}
              className={`chat-input w-full resize-none bg-transparent text-transparent caret-foreground text-left placeholder:text-left placeholder:text-muted-foreground/60 outline-none focus-visible:outline-none relative z-10 text-sm min-h-[52px] max-h-[300px] px-4 pt-3.5 pb-1 leading-relaxed`}
              style={{
                overflow: 'hidden',
                height: '52px',
              }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement
                target.style.height = '52px'
                const ch = target.scrollHeight
                const min = 52
                if (ch > min) {
                  target.style.height = Math.min(ch, 300) + 'px'
                }
              }}
            />

            {/* Highlighted display layer - behind transparent textarea */}
            <div
              className={`absolute inset-0 whitespace-pre-wrap break-words pointer-events-none select-none z-0 overflow-hidden px-4 pt-3.5 pb-1 text-sm leading-relaxed`}
              aria-hidden="true"
            >
              {highlightedInput}
            </div>

            {/* Slash-triggered skill dropdown */}
            {showSlashSkills && filteredSkills.length > 0 && (
              <div className={`absolute bottom-full left-0 right-0 mb-2 bg-background/95 backdrop-blur-sm rounded-2xl border border-border/30 shadow-xl shadow-black/10 z-50 max-h-[200px] overflow-y-auto mx-3`}>
                {filteredSkills.map((skill, index) => (
                  <button
                    key={skill.id}
                    type="button"
                    ref={index === selectedSkillIndex ? (el) => { if (el) el.scrollIntoView({ block: 'nearest' }) } : undefined}
                    onClick={() => {
                      if ((skill as any).isHermesCommand || (skill as any).isBuiltinCommand) {
                        setInputSynced(`/${skill.name}`)
                        setTimeout(() => {
                          if (isBusy) {
                            handleStop()
                          } else {
                            handleRun()
                          }
                        }, 0)
                      } else if ((skill as any).isCliCommand) {
                        setInputSynced((skill as any).command || skill.name)
                        inputRef.current?.focus()
                      } else {
                        handleSkillSelect(skill)
                      }
                    }}
                    className={`w-full text-left px-3 py-2 transition-colors flex items-center gap-2.5 first:rounded-t-2xl last:rounded-b-2xl ${
                      index === selectedSkillIndex
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-muted/30'
                    }`}
                  >
                    {(skill as any).isCliCommand
                      ? <Terminal className="size-4 text-emerald-500/70 shrink-0" />
                      : (skill as any).isBuiltinCommand
                        ? <Circle className="size-3.5 text-amber-500/70 shrink-0" fill="currentColor" />
                        : <FileText className="size-4 text-foreground/40 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <span className="text-[13px] text-foreground block truncate">{skill.name}</span>
                      {skill.description && (
                        <span className="text-[11px] text-muted-foreground block truncate">{skill.description}</span>
                      )}
                    </div>
                    {(skill as any).isCliCommand && (
                      <span className="text-[10px] text-emerald-500/70 shrink-0">CLI</span>
                    )}
                    {(skill as any).isBuiltinCommand && (
                      <span className="text-[10px] text-amber-500/70 shrink-0">CMD</span>
                    )}
                    {(skill as any).isHermesCommand && (
                      <span className="text-[10px] text-muted-foreground/60 shrink-0">Hermes</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Quick commands dropdown */}
            {showQuickCmds && (
              <div className="absolute bottom-full left-0 right-0 mb-2 bg-background/95 backdrop-blur-sm rounded-2xl border border-border/30 shadow-xl shadow-black/10 z-50 max-h-[200px] overflow-y-auto mx-3">
                <p className="px-3 pt-2 pb-1 text-[10px] font-semibold text-muted-foreground/30 uppercase tracking-wider">快捷指令</p>
                {matchedQuickCmds.map((qc, idx) => (
                  <button
                    key={qc.cmd}
                    type="button"
                    onClick={() => {
                      setInputSynced(qc.prompt)
                      inputRef.current?.focus()
                    }}
                    className="w-full text-left px-3 py-2 transition-colors flex items-center gap-2.5 last:rounded-b-2xl hover:bg-muted/30"
                  >
                    <code className="text-[12px] font-mono text-primary/70 shrink-0">{qc.cmd}</code>
                    <div className="min-w-0 flex-1">
                      <span className="text-[13px] text-foreground block">{qc.label}</span>
                      <span className="text-[11px] text-muted-foreground block truncate">{qc.prompt}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {pendingFiles.length > 0 && (
              <div className={`flex flex-wrap gap-2 border-t border-border/20 px-4 py-2`}>
                {pendingFiles.map(f => (
                  <div
                    key={f.id}
                    className="relative flex items-center gap-2 max-w-[220px] px-2.5 py-1.5 rounded-xl border border-border/30 bg-muted/20 hover:bg-muted/40 hover:border-border/30 transition-all duration-200 group"
                  >
                    {f.kind === 'image' && f.dataUrl ? (
                      <img src={f.dataUrl} alt={f.name} className="size-7 rounded-lg object-cover shrink-0" />
                    ) : (
                      <FileText className="size-4 text-muted-foreground shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{f.name}</p>
                      <p className="text-[10px] text-muted-foreground/60">{formatBytes(f.size)}</p>
                    </div>
                    <button
                      onClick={() => removePendingFile(f.id)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Image preview area */}
            {pendingImages.length > 0 && (
              <div className={`flex gap-2 overflow-x-auto border-t border-border/30 px-4 py-2`}>
                {pendingImages.map(img => (
                  <div key={img.id} className="relative shrink-0 group">
                    <img
                      src={img.dataUrl}
                      alt={img.name}
                      className="w-20 h-20 rounded-lg object-cover border border-border/30"
                    />
                    <button
                      onClick={() => removePendingImage(img.id)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Input toolbar */}
            <div className={`flex items-center justify-between px-3 pb-2.5 pt-0.5`}>
              {isEmpty ? (
                <>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => uploadFileInputRef.current?.click()}
                      className="p-2 rounded-xl text-muted-foreground/50 hover:text-foreground hover:bg-muted/40 transition-all duration-200"
                      title="上传附件"
                    >
                      <Plus className="size-4" />
                    </button>
                    {approvalModeButton}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {hasApiKey ? (
                      renderModelSelector()
                    ) : (
                      <button
                        type="button"
                        onClick={() => storeActions.toggleSettings('api')}
                        className="text-xs text-foreground/50 hover:text-foreground hover:bg-muted/60 px-2.5 py-1.5 rounded-lg transition-colors"
                      >
                        设置模型
                      </button>
                    )}
                    <ContextUsageIndicator />
                    <ReasoningEffortControl value={reasoningEffort} onChange={(v) => storeActions.setReasoningEffort(v)} />
                    <button
                      type="button"
                      onClick={isBusy ? handleStop : handleRun}
                      disabled={!isBusy && !input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
                      className={`size-9 shrink-0 rounded-xl transition-all duration-200 flex items-center justify-center ${
                        isBusy
                          ? 'bg-destructive hover:bg-destructive/90 shadow-md shadow-destructive/20'
                          : 'bg-primary hover:bg-primary/90 shadow-md shadow-primary/20'
                      }`}
                      title={isBusy ? '停止' : '发送'}
                    >
                      {isBusy ? <Square className="size-3 text-white fill-white" /> : <ArrowUp className="size-4 text-primary-foreground" />}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => uploadFileInputRef.current?.click()}
                      className="p-2 rounded-xl text-muted-foreground/60 hover:text-foreground hover:bg-muted/30 transition-all"
                      title="上传文件"
                    >
                      <Plus className="size-4" />
                    </button>
                    {approvalModeButton}
                    <input
                      ref={uploadFileInputRef}
                      type="file"
                      className="hidden"
                      multiple
                      onChange={handleFileSelect}
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    {hasApiKey && renderModelSelector()}
                    <ContextUsageIndicator />
                    <ReasoningEffortControl value={reasoningEffort} onChange={(v) => storeActions.setReasoningEffort(v)} />
                    <button
                      type="button"
                      onClick={isBusy ? handleStop : handleRun}
                      disabled={!isBusy && !input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
                      className={`size-9 shrink-0 rounded-xl transition-all duration-200 flex items-center justify-center ${
                        isBusy
                          ? 'bg-destructive hover:bg-destructive/90 shadow-md shadow-destructive/20'
                          : 'bg-primary hover:bg-primary/90 shadow-md shadow-primary/20'
                      }`}
                      title={isBusy ? '停止' : '发送'}
                    >
                      {isBusy ? <Square className="size-3 text-white fill-white" /> : <ArrowUp className="size-4 text-primary-foreground" />}
                    </button>
                  </div>
                </>
              )}
            </div>
      </div>
  )}

  const renderEmptyBreadcrumb = () => {
    const projectName = selectedWorkDir ? (selectedWorkDir.split(/[\/\\]/).pop() || selectedWorkDir) : '选择项目'
    return (
      <div className="flex items-center justify-start gap-1 mb-3">
        <button
          type="button"
          onClick={async () => {
            if (!isElectron()) {
              return
            }
            const dir = await electronDialog.openDirectory()
            if (dir) selectWorkDir(dir)
          }}
          className="flex items-center gap-1.5 text-[12px] text-foreground/60 hover:text-foreground hover:bg-accent/50 px-2 py-1 rounded-lg transition-colors"
          title={selectedWorkDir || '选择项目目录'}
        >
          <Folder className="size-3.5 text-amber-500" />
          <span className="max-w-[160px] truncate">{projectName}</span>
        </button>
        <button
          type="button"
          className="flex items-center gap-1.5 text-[12px] text-foreground/60 hover:text-foreground hover:bg-accent/50 px-2 py-1 rounded-lg transition-colors"
        >
          <Monitor className="size-3.5 text-primary" />
          <span>本地</span>
        </button>
        <button
          type="button"
          onClick={() => storeActions.showToast({ type: 'info', title: `当前分支：${currentBranch}` })}
          className="flex items-center gap-1.5 text-[12px] text-foreground/60 hover:text-foreground hover:bg-accent/50 px-2 py-1 rounded-lg transition-colors"
        >
          <GitBranch className="size-3.5 text-emerald-500" />
          <span>{currentBranch}</span>
        </button>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-transparent text-foreground">
      {/* Header bar - removed */}

      {/* Flow area */}
      <ScrollArea ref={scrollRef} className="flex-1 min-h-0" hideScrollbar={sessionMessages.length === 0 && !hasSteps}>
        <div className="max-w-[700px] mx-auto py-4 pb-4 min-h-full">
          {sessionMessages.length === 0 && !hasSteps ? (
            <div className="flex flex-col items-center w-full pt-[22vh]">
              <div className="w-full max-w-[700px] mx-auto">
                <img src="/kirin.png" alt="Helix" className="w-14 h-14 opacity-70 mx-auto mb-4" />
                <p className="text-[15px] font-normal text-foreground/50 text-center mb-6 tracking-tight">有什么可以帮你的？</p>
                {renderEmptyBreadcrumb()}
                {renderChatInput({ isEmpty: true })}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Chat messages (input/output)  — completed messages only */}
              {sessionMessages.map(msg => (
                <div key={msg.id} className={`flex w-full step-enter ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' ? (
                    <div className="group w-full">
                      <div className="flex-1 min-w-0">
                        {/* Inline thinking block (collapsible) — skip if blocks already contain thinking (prevents duplicate) */}
                        {msg.reasoning && msg.reasoning.trim().length > 0 && !(msg.blocks && msg.blocks.some(b => b.type === 'thinking')) && (
                          <details className="mb-2 group/details">
                            <summary className="text-xs font-medium text-foreground/35 cursor-pointer hover:text-foreground/55 select-none flex items-center gap-1 list-none transition-colors">
                              <svg className="size-3.5 transition-transform group-open/details:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                              <span>思考</span>
                            </summary>
                            <div className="mt-1 pl-4 text-xs text-foreground/50 whitespace-pre-wrap break-all leading-relaxed">
                              {stripEmoji(normalizeAcpContent(msg.reasoning))}
                            </div>
                          </details>
                        )}
                        {/* Interleaved blocks: thinking, text, and tool groups in chronological order */}
                        {(msg.blocks && msg.blocks.length > 0) ? (
                          <div className="helix-md" style={{ fontSize: transcriptFontSize }}>
                            {msg.blocks.map((block, idx) =>
                              block.type === 'thinking' ? (
                                <details key={idx} className="mb-2 group/details">
                                  <summary className="text-xs font-medium text-foreground/35 cursor-pointer hover:text-foreground/55 select-none flex items-center gap-1 list-none transition-colors">
                                    <svg className="size-3.5 transition-transform group-open/details:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                                    <span>思考</span>
                                  </summary>
                                  <div className="mt-1 pl-4 text-xs text-foreground/50 whitespace-pre-wrap break-all leading-relaxed">
                                    {stripEmoji(normalizeAcpContent(block.content))}
                                  </div>
                                </details>
                              ) : block.type === 'text' ? (
                                <ReactMarkdown
                                  key={idx}
                                  components={markdownComponents}
                                  remarkPlugins={markdownPlugins.remarkPlugins}
                                >
                                  {safeMarkdownSource(stripEmoji(normalizeAcpContent(block.content)))}
                                </ReactMarkdown>
                              ) : (
                                <InlineToolGroup key={idx} steps={block.steps} isRunning={false} />
                              )
                            )}
                          </div>
                        ) : (
                          <div className="helix-md" style={{ fontSize: transcriptFontSize }}>
                            <ReactMarkdown
                              components={markdownComponents}
                              remarkPlugins={markdownPlugins.remarkPlugins}
                            >
                              {safeMarkdownSource(stripEmoji(normalizeAcpContent(msg.content)))}
                            </ReactMarkdown>
                          </div>
                        )}
                        {/* Copy button */}
                        <div className="flex opacity-0 group-hover:opacity-100 transition-opacity pt-1 px-1 gap-0.5">
                          <CopyButton text={stripEmoji(normalizeAcpContent(msg.content))} />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="group max-w-[80%]">
                      <div className="px-4 py-2.5 rounded-2xl rounded-br-md bg-muted/30 text-foreground shadow-sm border border-border/20">
                        {msg.images && msg.images.length > 0 && (
                          <div className="flex flex-wrap gap-2 mb-2">
                            {msg.images.map(img => (
                              <img
                                key={img.id}
                                src={img.dataUrl}
                                alt={img.name || 'pasted image'}
                                className="rounded-lg max-h-[300px] max-w-full object-contain"
                              />
                            ))}
                          </div>
                        )}
                        {msg.files && msg.files.length > 0 && (
                          <div className="flex flex-wrap gap-2 mb-2">
                            {msg.files.map(f => (
                              <div
                                key={f.id}
                                className="flex items-center gap-2 max-w-[240px] px-2.5 py-1.5 rounded-lg border border-border/30 bg-muted/20 hover:bg-muted/40 hover:border-border/30 transition-all duration-200"
                              >
                                {f.kind === 'image' && f.dataUrl ? (
                                  <img src={f.dataUrl} alt={f.name} className="size-8 rounded object-cover shrink-0" />
                                ) : (
                                  <FileText className="size-4 text-foreground/50 shrink-0" />
                                )}
                                <div className="min-w-0">
                                  <p className="text-xs font-medium text-foreground truncate">{f.name}</p>
                                  <p className="text-[10px] text-muted-foreground/70">{formatBytes(f.size)}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {normalizeAcpContent(msg.content) && (
                          <div className="whitespace-pre-wrap leading-normal" style={{ fontSize: transcriptFontSize }}>{normalizeAcpContent(msg.content)}</div>
                        )}
                      </div>
                      {/* Action buttons below user message */}
                      <div className="flex justify-end items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
                        <CopyButton text={normalizeAcpContent(msg.content)} />
                        <button
                          onClick={() => {
                            const newContent = window.prompt('编辑消息', normalizeAcpContent(msg.content))
                            if (newContent !== null && newContent.trim()) {
                              useHelixStore.getState().updateChatMessage(msg.id, newContent)
                              // Remove all messages after this one
                              const msgs = useHelixStore.getState().chatMessages
                              const idx = msgs.findIndex(m => m.id === msg.id)
                              if (idx >= 0) {
                                const kept = msgs.slice(0, idx + 1)
                                useHelixStore.setState({ chatMessages: kept })
                                // Resend
                                setTimeout(() => {
                                  const el = document.querySelector('[data-send-btn]') as HTMLButtonElement
                                  el?.click()
                                }, 100)
                              }
                            }
                          }}
                          className="p-1 rounded-lg text-muted-foreground/40 hover:text-foreground hover:bg-muted/30 transition-colors"
                          title="编辑并重发"
                        >
                          <Pencil className="size-3" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* Streaming assistant message — placed AFTER all completed messages */}
              {(isRunning || displayResponseBlocks.length > 0) && (
                <div className="flex w-full justify-start transition-all duration-300 opacity-100">
                  <div className="w-full px-1 py-1 text-foreground transition-all duration-300">
                    {/* Loading placeholder when the model is running but has not emitted any content yet */}
                    {isRunning && displayResponseBlocks.length === 0 && !displayStreamThinking && (
                      <div className="flex items-center my-1 text-sm text-foreground/50">
                        <span className="thinking-breath">正在<span className="thinking-breath">思考</span></span>
                      </div>
                    )}

                    {/* Top status bar: when a tool is actively running, surface it here
                        instead of a bare "正在思考", so the user can tell the agent
                        is working (read / bash / search / write) rather than idling. */}
                    {isRunning && runningToolLabels.length > 0 && (
                      <div className="flex items-center gap-1.5 my-1 text-sm text-foreground/70 min-w-0">
                        <Loader2 className="size-3.5 animate-spin text-primary/60 shrink-0" />
                        <span className="text-foreground/50 shrink-0">正在执行</span>
                        <span className="font-medium text-foreground/80 truncate" title={runningToolLabels.join(' / ')}>
                          {runningToolLabels.slice(0, 2).join(' / ')}{runningToolLabels.length > 2 ? ` …+${runningToolLabels.length - 2}` : ''}
                        </span>
                      </div>
                    )}

                    {/* Show thinking content if available */}
                    {isRunning && displayStreamThinking && (
                      <div className="my-1 p-3 rounded-xl bg-muted/20 border border-border/30 shadow-sm thinking-card">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="text-xs font-medium text-muted-foreground">思考中</span>
                          <span className="text-xs text-muted-foreground/50">{streamThinkingDuration > 0 ? `· ${streamThinkingDuration}s` : ''}</span>
                        </div>
                        <p className="text-xs text-foreground/60 whitespace-pre-wrap break-all leading-relaxed max-h-32 overflow-y-auto">
                          {displayStreamThinking}
                        </p>
                      </div>
                    )}

                    {/* Inline thinking block (collapsible) — kept for completed messages */}

                    {/* Interleaved response blocks: thinking, text, and tool groups in chronological order */}
                    {displayResponseBlocks.length > 0 && (() => {
                      const hasText = displayResponseBlocks.some(b => b.type === 'text')
                      const filtered = displayResponseBlocks.filter(b => !isThinkingEnded || b.type !== 'thinking')
                      return (
                        <div className="helix-md" style={{ fontSize: transcriptFontSize }}>
                          {filtered.map((block, idx) =>
                            block.type === 'thinking' ? (
                              hasText ? (
                                <details key={idx} className="mb-2 group/details">
                                  <summary className="text-xs font-medium text-foreground/35 cursor-pointer hover:text-foreground/55 select-none flex items-center gap-1 list-none transition-colors">
                                    <svg className="size-3.5 transition-transform group-open/details:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                                    <span className={isThinkingEnded ? '' : 'thinking-breath'}>思考</span>
                                  </summary>
                                  <div className="mt-1 pl-4 text-xs text-foreground/50 whitespace-pre-wrap break-all leading-relaxed">
                                    {stripEmoji(normalizeAcpContent(block.content))}
                                  </div>
                                </details>
                              ) : (
                                <div key={idx} className="text-sm text-foreground/70 whitespace-pre-wrap break-all leading-relaxed mb-2">
                                  <span className="text-xs text-foreground/40 mr-2">思考</span>
                                  {stripEmoji(normalizeAcpContent(block.content))}
                                </div>
                              )
                            ) : block.type === 'text' ? (
                            <div key={idx}>
                              <ReactMarkdown
                                components={markdownComponents}
                                remarkPlugins={markdownPlugins.remarkPlugins}
                              >
                                {safeMarkdownSource(stripEmoji(normalizeAcpContent(block.content)))}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <InlineToolGroup key={idx} steps={block.steps} isRunning={isRunning} />
                          )
                          )}
                      </div>
                      )
                    })()}

                    {/* Live thinking duration */}
                    {isRunning && (
                      <div className="text-xs text-foreground/30 tabular-nums mt-1 ml-3">
                        {streamThinkingDuration > 0 ? formatDuration(streamThinkingDuration) : '0s'}{streamThoughtTokens > 0 ? ` · ${streamThoughtTokens} tokens` : ''}
                      </div>
                    )}

                  </div>
                </div>
              )}




              {/* End of flow area — no summary */}

              {/* End of flow area — no summary */}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* API key warning */}

      {/* Connection notice */}
      {connectionNotice && (
        <div className="mx-4 mb-2 px-3 py-2.5 rounded-xl text-xs flex items-center gap-2 border cursor-pointer hover:opacity-80 transition-all duration-200 shadow-sm" style={{
          backgroundColor: connectionNotice.phase === 'recovered' ? 'oklch(0.65 0.15 145 / 0.1)' : 'oklch(0.70 0.15 65 / 0.1)',
          borderColor: connectionNotice.phase === 'recovered' ? 'oklch(0.65 0.15 145 / 0.25)' : 'oklch(0.70 0.15 65 / 0.25)',
          color: connectionNotice.phase === 'recovered' ? 'oklch(0.65 0.15 145)' : 'oklch(0.70 0.15 65)',
        }} onClick={() => useHelixStore.getState().setConnectionNotice(null)}>
          {connectionNotice.phase !== 'recovered' && (
            <div className="animate-spin size-3 border-2 border-current border-t-transparent rounded-full shrink-0" />
          )}
          <span className="flex-1">{connectionNotice.message}</span>
          <span className="text-[10px] opacity-60">点击关闭</span>
        </div>
      )}

      {/* New project form */}
      {showNewProjectForm && (
        <div className="max-w-[700px] mx-auto mb-2 p-3 bg-card/30 rounded-xl border border-border/30 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <FolderPlus className="size-4 text-primary" />
            <span className="text-sm font-medium text-foreground">新建项目</span>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateProject() }}
              placeholder="输入项目名称..."
              className="flex-1 px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40 transition-all duration-200"
              autoFocus
            />
            <Button size="sm" onClick={handleCreateProject} className="px-3">
              创建
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowNewProjectForm(false); setNewProjectName('') }}>
              取消
            </Button>
          </div>
        </div>
      )}

      {/* Bottom input */}
      {sessionMessages.length > 0 && (
        <div className="bg-transparent shrink-0 mb-2 mt-2 w-full">
          <div className="w-full max-w-[700px] mx-auto">
            {renderChatInput()}
            <p className="text-xs text-foreground/50 text-center mt-3 mb-1.5 select-none">AI不是万能的，需要有自己的判断</p>
          </div>
        </div>
      )}

      {/* Approval Dialog */}
      {approvalRequest && (
        <ApprovalDialog
          request={approvalRequest}
          pendingCount={pendingApprovalCount}
          onApprove={(id, cache) => handleApproval(id, true, cache)}
          onReject={(id, cache) => handleApproval(id, false, cache)}
          onApproveAll={handleApproveAll}
        />
      )}
    </div>
  )
}

