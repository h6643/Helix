'use client'

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import {
  Send,
  Loader2,
  Brain,
  Wrench,
  CheckCircle2,
  AlertCircle,
  Code2,
  FileCode,
  FileText,
  BarChart3,
  Copy,
  ChevronRight,
  ChevronDown,
  Terminal,
  Search,
  FolderOpen,
  Pencil,
  Eye,
  ArrowDown,
  Sparkles,
  RotateCcw,
  Folder,
  X,
  Zap,
  Square,
  Plus,
  FolderPlus,
  Briefcase,
  Mic,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import { ApprovalDialog, type ApprovalRequest } from './approval-dialog'
import { useHelixStore, type ImageAttachment } from '@/stores/helix-store'
import { processClipboardImage, canAddMoreImages } from '@/lib/helix/image-utils'
import { getModels } from '@/lib/helix/providers'
import { isElectron, electronDialog } from '@/lib/electron-bridge'
import ReactMarkdown from 'react-markdown'
import { markdownComponents } from './markdown-components'

// ── Types ──────────────────────────────────────────────

interface FlowStep {
  id: string
  type: 'task' | 'thinking' | 'reasoning' | 'tool_call' | 'tool_result' | 'text' | 'error' | 'done' | 'plan' | 'usage' | 'compact' | 'file_change'
  content: string
  toolName?: string
  toolParams?: Record<string, unknown>
  fileChanges?: Array<{ path: string; type: 'add' | 'modify' | 'delete'; diff: string }>
  timestamp: number
  expanded?: boolean
  planText?: string
  taskLabel?: string
  taskId?: string
  finishReason?: string
}

// ── Interleaved response blocks (text -> tool groups) ──

type ResponseBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_group'; steps: FlowStep[] }

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

const TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  list_directory: '读取目录',
  glob: '搜索文件',
  grep: '搜索内容',
  run_bash: '执行命令',
  bash: '执行命令',
  webfetch: '获取网页',
  websearch: '搜索网页',
  web_extractor: '获取网页',
  question: '提问',
  run_task: '执行任务',
  apply_patch: '应用补丁',
  create_artifact: '创建制品',
  spawn_agent: '启动子代理',
  get_sub_agent_result: '获取子代理结果',
  memory_add: '添加记忆',
  memory_read: '读取记忆',
  git_status: '查看状态',
  git_diff: '查看差异',
  git_log: '查看日志',
  git_branch: '查看分支',
  git_commit: '提交代码',
  plan_enter: '进入计划',
  plan_exit: '退出计划',
  task_create: '创建任务',
  task_update: '更新任务',
  task_complete: '完成任务',
  todo_write: '写入待办',
  skill: '执行技能',
  browser_navigate: '浏览器导航',
  browser_click: '浏览器点击',
  browser_type: '浏览器输入',
  browser_screenshot: '浏览器截图',
  browser_get_html: '获取页面HTML',
}

function getToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] || toolName
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

// WorkBuddy-style helpers
function extractToolPath(step: FlowStep): string {
  if (step.toolParams?.path && typeof step.toolParams.path === 'string') {
    return step.toolParams.path as string
  }
  if (step.toolParams?.file_path && typeof step.toolParams.file_path === 'string') {
    return step.toolParams.file_path as string
  }
  // Try to parse content as JSON
  try {
    const parsed = JSON.parse(step.content)
    if (typeof parsed.path === 'string') return parsed.path
    if (typeof parsed.file_path === 'string') return parsed.file_path
    if (typeof parsed.filePath === 'string') return parsed.filePath
  } catch {}
  // Fallback: extract first absolute-looking path from content
  const match = step.content.match(/[A-Za-z]:\\[^\s]+|(?:\/[^\s]+)+/)
  return match ? match[0] : ''
}

function extractDiffStats(step: FlowStep): { add: number; del: number } | undefined {
  if (step.fileChanges && step.fileChanges.length > 0) {
    const total = step.fileChanges.reduce((acc, change) => {
      if (change.diff) {
        const lines = change.diff.split('\n')
        acc.add += lines.filter(l => l.startsWith('+')).length
        acc.del += lines.filter(l => l.startsWith('-')).length
      }
      return acc
    }, { add: 0, del: 0 })
    return total
  }
  if (step.content) {
    const lines = step.content.split('\n')
    const add = lines.filter(l => l.startsWith('+')).length
    const del = lines.filter(l => l.startsWith('-')).length
    if (add > 0 || del > 0) return { add, del }
  }
  return undefined
}

function extractLineRange(step: FlowStep): string {
  try {
    const parsed = JSON.parse(step.content)
    if (parsed.offset !== undefined && parsed.limit !== undefined) {
      const start = parsed.offset + 1
      const end = parsed.offset + parsed.limit
      return `L${start}-${end}`
    }
  } catch {}
  return ''
}

// ── Deep Thinking Block (WorkBuddy style) ──────────────

function DeepThinkingBlock({ steps, isRunning, inline = false }: { steps: FlowStep[]; isRunning: boolean; inline?: boolean }) {
  const [open, setOpen] = useState(true)

  const actions = useMemo(() => {
    const list: Array<{
      id: string
      type: 'thinking' | 'read' | 'edit' | 'tool' | 'error' | 'usage'
      icon: React.ReactNode
      label: string
      path?: string
      range?: string
      diff?: { add: number; del: number }
    }> = []

    for (const step of steps) {
      if (step.type === 'thinking' || step.type === 'reasoning') {
        list.push({ id: step.id, type: 'thinking', icon: <Sparkles className="size-3.5 text-foreground/50" />, label: '深度思考' })
      } else if (step.type === 'error') {
        list.push({ id: step.id, type: 'error', icon: <AlertCircle className="size-3.5 text-red-500" />, label: '失败' })
      } else if (step.type === 'usage' && step.content) {
        list.push({ id: step.id, type: 'usage', icon: <BarChart3 className="size-3.5 text-foreground/50" />, label: '已消耗', path: step.content })
      } else if (step.type === 'tool_call' || step.type === 'tool_result') {
        const toolName = (step.toolName || '').toLowerCase()
        const path = extractToolPath(step)
        if (toolName.includes('read') || toolName.includes('view')) {
          list.push({ id: step.id, type: 'read', icon: <Eye className="size-3.5 text-blue-500" />, label: '已读取', path, range: extractLineRange(step) })        } else if (toolName.includes('write') || toolName.includes('edit') || toolName.includes('create') || toolName.includes('apply')) {
          list.push({ id: step.id, type: 'edit', icon: <Pencil className="size-3.5 text-green-500" />, label: '编辑', path, diff: extractDiffStats(step) })
        } else {
          list.push({ id: step.id, type: 'tool', icon: getToolIcon(step.toolName || ''), label: getToolLabel(step.toolName || ''), path })
        }
      }
    }
    return list
  }, [steps])

  const totalTokens = useMemo(() => {
    return steps
      .filter(s => s.type === 'usage' && s.content)
      .reduce((acc, s) => acc + (parseInt(s.content.replace(/\D/g, '')) || 0), 0)
  }, [steps])

  const callCount = useMemo(() => {
    return steps.filter(s => s.type === 'tool_call').length
  }, [steps])

  const thinkingCountForBlock = useMemo(() => {
    return steps.filter(s => s.type === 'thinking' || s.type === 'reasoning').length
  }, [steps])

  return (
    <div className={inline ? 'border-b border-border/50 last:border-b-0' : 'border border-border/70 rounded-xl bg-card/50 overflow-hidden'}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center justify-between hover:bg-accent/20 transition-colors ${inline ? 'px-0 py-2' : 'px-4 py-2.5'}`}
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Sparkles className="size-4 text-foreground/50" />
          <span>深度思考</span>
        </div>
        <ChevronRight className={`size-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      </button>
      <div className={`overflow-hidden transition-all duration-300 ease-in-out ${open ? 'max-h-[1000px] opacity-100' : 'max-h-0 opacity-0'}`}>
        <div className={`pt-0 ${inline ? 'px-0 pb-3' : 'px-4 pb-3'}`}>
          <div className="space-y-1.5">
            {actions.map(action => (
              <div key={action.id} className="flex items-center gap-2 text-sm py-0.5">
                {action.icon}
                <span className="text-muted-foreground">{action.label}</span>
                {action.path && (
                  <span className="text-primary truncate max-w-[300px]">{action.path}</span>
                )}
                {action.range && (
                  <span className="text-xs text-muted-foreground">{action.range}</span>
                )}
                {action.diff && (action.diff.add > 0 || action.diff.del > 0) && (
                  <span className="text-xs">
                    <span className="text-green-500">+{action.diff.add}</span>
                    <span className="text-red-500 ml-1">-{action.diff.del}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mt-3 pt-2 border-t border-border/50 text-xs text-muted-foreground">
            <div className="flex items-center gap-3">
              {isRunning ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  <span>等待模型响应</span>
                </>
              ) : (
                <span>已完成</span>
              )}
            </div>
            {totalTokens > 0 && (
              <div className="flex items-center gap-2">
                <span>已消耗◇ {totalTokens}K</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface TaskGroup {
  task: FlowStep | null
  label: string
  steps: FlowStep[]
}

function TimelineGroup({
  group,
  isFirst,
  isLast,
  isRunning,
  defaultOpen = false,
}: {
  group: TaskGroup
  isFirst: boolean
  isLast: boolean
  isRunning: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const isActive = isRunning && isLast

  // 当前任务执行时自动展开，执行完成后自动关闭
  useEffect(() => {
    setOpen(isActive)
  }, [isActive])

  const hasErrors = group.steps.some(s => s.type === 'error')
  const hasToolCalls = group.steps.some(s => s.type === 'tool_call')
  const hasPlan = group.task?.type === 'plan'

  // 合并连续的 tool_call + tool_result 为同一个步骤
  const mergedSteps = useMemo(() => {
    const result: FlowStep[] = []
    for (let i = 0; i < group.steps.length; i++) {
      const current = group.steps[i]
      const next = group.steps[i + 1]
      if (current.type === 'tool_call' && next?.type === 'tool_result' && current.toolName === next.toolName) {
        result.push({ ...current, content: next.content, type: 'tool_call' })
        i++ // 跳过下一个 tool_result
      } else {
        result.push(current)
      }
    }
    return result
  }, [group.steps])

  const icon = hasErrors
    ? <AlertCircle className="size-4" />
    : hasToolCalls
    ? <Search className="size-4" />
    : hasPlan
    ? <Sparkles className="size-4" />
    : <CheckCircle2 className="size-4" />

  const colorClass = hasErrors
    ? 'text-red-500 border-red-500/20 bg-red-500/5'
    : hasToolCalls
    ? 'text-foreground/70 border-border bg-muted'
    : hasPlan
    ? 'text-blue-500 border-blue-500/20 bg-blue-500/5'
    : 'text-emerald-500 border-emerald-500/20 bg-emerald-500/5'

  return (
    <div className="relative flex gap-3 group">
      {/* Timeline node + line */}
      <div className="flex flex-col items-center shrink-0">
        <div className={`w-7 h-7 rounded-full border flex items-center justify-center ${colorClass}`}>
          {icon}
        </div>
        {!isLast && (
          <div className="w-px flex-1 bg-border/50 min-h-[20px] mt-1" />
        )}
      </div>

      {/* Group content */}
      <div className="flex-1 min-w-0 pb-4">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 text-sm font-medium text-foreground hover:text-foreground/80 transition-colors"
        >
          <span className="truncate">{group.label}</span>
          {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
        </button>

        {open && (
          <div className="mt-2 space-y-0.5">
            {mergedSteps.map((substep, si) => (
              <SubStepItem key={substep.id} step={substep} isLast={si === mergedSteps.length - 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Step Card ────────────────────────────────────────────

function StepCard({
  step,
  isLast,
  isRunning,
  selected,
  onSelect,
}: {
  step: FlowStep
  isLast: boolean
  isRunning: boolean
  selected?: boolean
  onSelect?: () => void
}) {
  const [expanded, setExpanded] = useState(step.type === 'tool_call' || step.type === 'tool_result' || step.type === 'thinking')

  // Color scheme per type — refined for dark mode
  const config = {
    task: {
      bg: 'bg-blue-500/5',
      border: 'border-blue-500/20',
      dot: 'bg-blue-500',
      icon: <Sparkles className="size-4 text-blue-500" />,
      label: '任务',
      labelColor: 'text-blue-500',
      line: 'border-blue-500/10',
    },
    plan: {
      bg: 'bg-blue-500/5',
      border: 'border-blue-500/20',
      dot: 'bg-blue-500',
      icon: <Sparkles className="size-4 text-blue-500" />,
      label: '计划',
      labelColor: 'text-blue-500',
      line: 'border-blue-500/10',
    },
    thinking: {
      bg: 'bg-foreground/5',
      border: 'border-border/50',
      dot: 'bg-foreground/30',
      icon: <Brain className="size-4 text-foreground/40" />,
      label: '思考',
      labelColor: 'text-foreground/50',
      line: 'border-border/50',
    },
    tool_call: {
      bg: 'bg-emerald-500/5',
      border: 'border-emerald-500/20',
      dot: 'bg-emerald-500',
      icon: getToolIcon(step.toolName || ''),
      label: getToolLabel(step.toolName || ''),
      labelColor: 'text-emerald-500',
      line: 'border-emerald-500/10',
    },
    tool_result: {
      bg: 'bg-emerald-500/5',
      border: 'border-emerald-500/20',
      dot: 'bg-emerald-400',
      icon: <CheckCircle2 className="size-4 text-emerald-500" />,
      label: `${getToolLabel(step.toolName || '')} 结果`,
      labelColor: 'text-emerald-500',
      line: 'border-emerald-500/10',
    },
    text: {
      bg: 'bg-foreground/5',
      border: 'border-border/50',
      dot: 'bg-foreground/30',
      icon: <CheckCircle2 className="size-4 text-foreground/40" />,
      label: '回复',
      labelColor: 'text-foreground/50',
      line: 'border-border/50',
    },
    error: {
      bg: 'bg-red-500/5',
      border: 'border-red-500/20',
      dot: 'bg-red-500',
      icon: <AlertCircle className="size-4 text-red-500" />,
      label: '错误',
      labelColor: 'text-red-500',
      line: 'border-red-500/10',
    },
    done: {
      bg: 'bg-emerald-500/5',
      border: 'border-emerald-500/20',
      dot: 'bg-emerald-500',
      icon: <CheckCircle2 className="size-4 text-emerald-500" />,
      label: '完成',
      labelColor: 'text-emerald-500',
      line: 'border-emerald-500/10',
    },
    usage: {
      bg: 'bg-amber-500/5',
      border: 'border-amber-500/20',
      dot: 'bg-amber-500',
      icon: <Terminal className="size-4 text-amber-500" />,
      label: '用量',
      labelColor: 'text-amber-500',
      line: 'border-amber-500/10',
    },
    compact: {
      bg: 'bg-violet-500/5',
      border: 'border-violet-500/20',
      dot: 'bg-violet-500',
      icon: <RotateCcw className="size-4 text-violet-500" />,
      label: '压缩',
      labelColor: 'text-violet-500',
      line: 'border-violet-500/10',
    },
    reasoning: {
      bg: 'bg-orange-500/5',
      border: 'border-orange-500/20',
      dot: 'bg-orange-500',
      icon: <Brain className="size-4 text-orange-500" />,
      label: '推理',
      labelColor: 'text-orange-500',
      line: 'border-orange-500/10',
    },
    file_change: {
      bg: 'bg-teal-500/5',
      border: 'border-teal-500/20',
      dot: 'bg-teal-500',
      icon: <Pencil className="size-4 text-teal-500" />,
      label: '文件变化',
      labelColor: 'text-teal-500',
      line: 'border-teal-500/10',
    },
  }[step.type]

  const hasContent = step.content && step.content.trim().length > 0
  const showExpandToggle = step.type === 'tool_call' || step.type === 'tool_result' || step.type === 'plan' || (step.type === 'thinking' && hasContent)

  return (
    <div className={`relative flex gap-3 group step-enter`} onClick={() => onSelect?.()}>
      {/* Timeline dot + line */}
      <div className="flex flex-col items-center shrink-0 pt-2">
        <div className={`w-8 h-8 rounded-full ${config.bg} ${config.border} border-2 flex items-center justify-center ${isLast && isRunning ? 'step-dot-running' : ''}`}>
          <span className={isLast && isRunning && step.type === 'tool_call' ? 'tool-spinning' : ''}>
            {config.icon}
          </span>
        </div>
        {/* Connecting line */}
        {!isLast && (
          <div className={`w-0.5 flex-1 mt-1 mb-1 ${config.line} border-l-2 min-h-[16px]`} />
        )}
        {isLast && isRunning && (
          <div className={`w-0.5 flex-1 mt-1 mb-1 min-h-[16px] line-active ${config.dot.replace('bg-', 'text-')}`} />
        )}
      </div>

      {/* Card content */}
      <div className={`flex-1 mb-2 rounded-xl ${config.bg} ${config.border} border overflow-hidden transition-all duration-150 shadow-sm ${selected ? 'ring-2 ring-primary/30' : 'hover:ring-1 hover:ring-foreground/10'}`}>
        {/* Header */}
        <div
          className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${showExpandToggle ? '' : 'cursor-default'}`}
          onClick={(e) => { e.stopPropagation(); showExpandToggle && setExpanded(!expanded) }}
        >
          <div className={`w-1.5 h-1.5 rounded-full ${config.dot} shrink-0`} />
          <span className={`text-[11px] font-semibold ${config.labelColor}`}>
            {config.label}
          </span>
          {step.type === 'tool_call' && step.toolParams && Object.keys(step.toolParams).length > 0 && (
            <span className="text-[10px] text-foreground/40 font-mono bg-muted px-1.5 py-0.5 rounded">
              {Object.keys(step.toolParams).length} 参数
            </span>
          )}
          <span className="text-[10px] text-foreground/40 ml-auto font-mono">
            {formatTime(step.timestamp)}
          </span>
          {showExpandToggle && (
            expanded
              ? <ChevronDown className="size-3 text-foreground/40 shrink-0" />
              : <ChevronRight className="size-3 text-foreground/40 shrink-0" />
          )}
        </div>

        {/* Expanded content */}
        {expanded && (
          <div className="px-3 pb-2.5 pt-0">
            {/* Task content */}
            {step.type === 'task' && (
              <p className="text-sm text-foreground/80 leading-relaxed">{step.taskLabel || step.content}</p>
            )}

            {/* Plan content */}
            {step.type === 'plan' && (
              <div className="space-y-2">
                <p className="text-[11px] text-primary font-medium">模型规划</p>
                <pre className="text-[11px] text-foreground/70 bg-card/50 rounded p-2 overflow-x-auto font-mono max-h-48 overflow-y-auto border border-border/50 whitespace-pre-wrap break-all">
                  {step.planText || step.content}
                </pre>
              </div>
            )}

            {/* Thinking content */}
            {step.type === 'thinking' && hasContent && (
              <p className="text-xs text-foreground/50 leading-relaxed italic">{step.content}</p>
            )}

            {/* Tool call params */}
            {step.type === 'tool_call' && step.toolParams && (
              <div className="space-y-1.5">
                {Object.entries(step.toolParams).map(([key, value]) => (
                  <div key={key} className="flex flex-col">
                    <span className="text-[10px] text-foreground/40 font-medium uppercase tracking-wide">{key}</span>
                    <pre className="text-[11px] text-foreground/70 bg-card/50 rounded px-2 py-1.5 overflow-x-auto font-mono border border-border/50">
                      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            )}

            {/* Tool result */}
            {step.type === 'tool_result' && hasContent && (
              <pre className="text-[11px] text-foreground/70 bg-card/50 rounded p-2 overflow-x-auto font-mono max-h-48 overflow-y-auto border border-border/50 whitespace-pre-wrap break-all">
                {step.content}
              </pre>
            )}

            {/* Text response */}
            {(step.type === 'text' || step.type === 'done') && hasContent && (
              <div>
                <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">{step.content}</p>
                {step.type === 'done' && step.finishReason && (
                  <p className="text-[10px] text-muted-foreground mt-1 font-mono">finish_reason: {step.finishReason}</p>
                )}
              </div>
            )}

            {/* Reasoning */}
            {step.type === 'reasoning' && hasContent && (
              <div className="rounded-lg p-2 bg-orange-500/5 border border-orange-500/10">
                <p className="text-[10px] text-orange-500 font-medium mb-1">推理过程</p>
                <p className="text-xs text-foreground/60 leading-relaxed italic">{step.content}</p>
              </div>
            )}

            {/* File changes */}
            {step.type === 'file_change' && step.fileChanges && step.fileChanges.length > 0 && (
              <div className="space-y-1.5">
                {step.fileChanges.map((fc, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className={`text-[10px] px-1 py-0.5 rounded font-mono ${
                      fc.type === 'add' ? 'bg-green-500/10 text-green-500' :
                      fc.type === 'delete' ? 'bg-red-500/10 text-red-500' :
                      'bg-yellow-500/10 text-yellow-500'
                    }`}>
                      {fc.type === 'add' ? 'ADD' : fc.type === 'delete' ? 'DEL' : 'MOD'}
                    </span>
                    <span className="font-mono text-foreground/70">{fc.path}</span>
                  </div>
                ))}
                {step.content && (
                  <p className="text-xs text-foreground/50 mt-1">{step.content}</p>
                )}
              </div>
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
              <p className="text-sm text-foreground/80 leading-relaxed">{step.taskLabel || step.content}</p>
            )}
            {step.type === 'plan' && (
              <p className="text-xs text-purple-700/70 line-clamp-2">{step.planText || step.content}</p>
            )}
            {(step.type === 'text' || step.type === 'done') && (
              <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">{step.content}</p>
            )}
            {step.type === 'error' && (
              <pre className="text-[11px] text-red-500 bg-red-500/10 rounded p-2 overflow-x-auto font-mono whitespace-pre-wrap break-all">
                {step.content}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}


// ── Tool Group Block (inline collapsible) ──────────────

function ToolGroupBlock({ steps, isRunning }: { steps: FlowStep[]; isRunning?: boolean }) {
  const [open, setOpen] = useState(false)
  const readCount = steps.filter(s => {
    const name = (s.toolName || '').toLowerCase()
    return s.type === 'tool_call' && (name.includes('read') || name.includes('view') || name.includes('list') || name.includes('glob') || name.includes('grep'))
  }).length
  const editCount = steps.filter(s => {
    const name = (s.toolName || '').toLowerCase()
    return s.type === 'tool_call' && (name.includes('write') || name.includes('edit') || name.includes('create') || name.includes('apply'))
  }).length
  const otherCount = steps.filter(s => s.type === 'tool_call').length - readCount - editCount

  // Check if this tool group has any pending tool calls (tool_call without matching tool_result)
  const hasPendingCalls = useMemo(() => {
    const toolCallIds = new Set(steps.filter(s => s.type === 'tool_call').map(s => s.toolName))
    const completedTools = new Set(steps.filter(s => s.type === 'tool_result').map(s => s.toolName))
    // If there are more tool_calls than tool_results, some are still pending
    return steps.filter(s => s.type === 'tool_call').length > steps.filter(s => s.type === 'tool_result').length
  }, [steps])

  // Only show running state if global isRunning AND this group has pending calls
  const showRunning = isRunning && hasPendingCalls

  let label = '工具调用'
  if (readCount > 0 && editCount === 0 && otherCount === 0) label = 'Read ' + readCount + ' file' + (readCount > 1 ? 's' : '')
  else if (editCount > 0 && readCount === 0 && otherCount === 0) label = 'Edit ' + editCount + ' file' + (editCount > 1 ? 's' : '')
  else {
    const parts: string[] = []
    if (readCount > 0) parts.push('Read ' + readCount)
    if (editCount > 0) parts.push('Edit ' + editCount)
    if (otherCount > 0) parts.push('Other ' + otherCount)
    label = parts.join(', ')
  }

  const merged = useMemo(() => {
    const result: FlowStep[] = []
    for (let i = 0; i < steps.length; i++) {
      const current = steps[i]
      const next = steps[i + 1]
      if (current.type === 'tool_call' && next?.type === 'tool_result' && current.toolName === next.toolName) {
        result.push({ ...current, content: next.content, type: 'tool_call' })
        i++
      } else {
        result.push(current)
      }
    }
    return result
  }, [steps])

  return (
    <div className="border border-border/40 rounded-xl bg-card/50 overflow-hidden my-3 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3.5 py-2 transition-colors hover:bg-accent/20"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground/80">
          {showRunning ? (
            <Loader2 className="size-3.5 text-foreground/40 animate-spin" />
          ) : (
            <CheckCircle2 className="size-3.5 text-emerald-500" />
          )}
          <span>{label}</span>
          {showRunning && (
            <span className="text-[10px] text-muted-foreground/50 font-normal">执行中...</span>
          )}
        </div>
        <ChevronRight className={`size-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      </button>
      <div className={`overflow-hidden transition-all duration-300 ease-in-out ${open ? 'max-h-[600px] opacity-100' : 'max-h-0 opacity-0'}`}>
        <div className="px-3.5 pb-3 pt-0 space-y-1">
          {merged.map(step => (
            <div key={step.id} className="flex items-start gap-2 text-xs text-foreground/60">
              <span className="text-muted-foreground/50 mt-0.5">{getToolIcon(step.toolName || '')}</span>
              <div className="flex-1 min-w-0">
                <span className="font-medium">{getToolLabel(step.toolName || '')}</span>
                {extractToolPath(step) && (
                  <span className="text-primary truncate ml-1.5">{extractToolPath(step)}</span>
                )}
                {step.content && (
                  <p className="text-[10px] text-foreground/40 mt-0.5 line-clamp-2">{step.content}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Sub Step Item (inside AccordionContent) ────────────

const subStepConfig: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  thinking:     { icon: <Brain className="size-3" />, color: 'text-foreground/50', label: '思考' },
  reasoning:    { icon: <Brain className="size-3" />, color: 'text-orange-500', label: '推理' },
  tool_call:    { icon: <Wrench className="size-3" />, color: 'text-emerald-500', label: '工具调用' },
  tool_result:  { icon: <FileCode className="size-3" />, color: 'text-emerald-500', label: '执行结果' },
  text:         { icon: <CheckCircle2 className="size-3" />, color: 'text-foreground/50', label: '回复' },
  error:        { icon: <AlertCircle className="size-3" />, color: 'text-red-500', label: '错误' },
  done:         { icon: <CheckCircle2 className="size-3" />, color: 'text-emerald-500', label: '完成' },
  compact:      { icon: <FolderOpen className="size-3" />, color: 'text-amber-500', label: '压缩' },
  usage:        { icon: <BarChart3 className="size-3" />, color: 'text-foreground/40', label: '用量' },
  file_change:  { icon: <FileCode className="size-3" />, color: 'text-teal-500', label: '文件变更' },
}

function SubStepItem({ step, isLast }: { step: FlowStep; isLast: boolean }) {
  const [expanded, setExpanded] = useState(true)
  let icon = subStepConfig[step.type]?.icon
  let label = subStepConfig[step.type]?.label
  let color = subStepConfig[step.type]?.color

  if (step.type === 'tool_call') {
    icon = getToolIcon(step.toolName || '')
    label = getToolLabel(step.toolName || '')
    color = 'text-emerald-600/70'
  }
  if (step.type === 'tool_result') {
    icon = <CheckCircle2 className="size-3" />
    label = `${getToolLabel(step.toolName || '')} 完成`
    color = 'text-emerald-500/70'
  }

  const isCancelled = step.type === 'error' && step.content?.includes('取消')
  const isError = step.type === 'error' && !isCancelled

  return (
    <div className="relative flex items-start gap-2.5 py-1.5 px-2 rounded-md hover:bg-accent/20 transition-colors group step-enter">
      {/* Left border line */}
      <div className={`flex shrink-0 flex-col items-center gap-0.5 ${isLast ? 'h-5' : 'self-stretch'}`}>
        <span className={`${color}`}>{icon}</span>
        {!isLast && <div className="w-px flex-1 bg-border/50 min-h-[12px]" />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pt-px">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-left w-full"
        >
          <span className={`text-[10px] font-medium ${color} truncate`}>{label}</span>
          {expanded ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
          {step.toolName && step.type === 'tool_call' && (
            <span className="text-[10px] text-muted-foreground">{getToolLabel(step.toolName)}</span>
          )}
          {step.toolName && step.type === 'tool_result' && (
            <span className="text-[10px] text-muted-foreground">{getToolLabel(step.toolName)}</span>
          )}
          {isCancelled && (
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full font-medium">已取消</span>
          )}
          {isError && (
            <span className="text-[10px] text-red-500 bg-red-50 dark:bg-red-950/40 px-1.5 py-0.5 rounded-full font-medium">失败</span>
          )}
        </button>

        {/* Content text */}
        {expanded && step.content && !isCancelled && (
          <p className="text-[11px] text-foreground/60 leading-relaxed mt-0.5 line-clamp-3 group-hover:line-clamp-none transition-all text-left">
            {step.content}
          </p>
        )}
        {expanded && isCancelled && (
          <p className="text-[11px] text-muted-foreground italic mt-0.5 text-left">用户已取消</p>
        )}
      </div>
    </div>
  )
}

// ── Empty State ──────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return n.toLocaleString()
}

function ContextUsageRing({ used, total = 128000 }: { used: number; total?: number }) {
  const percentage = Math.min(Math.max((used / total) * 100, 0), 100)
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference - (percentage / 100) * circumference
  const colorClass = percentage > 90 ? 'text-red-500' : percentage > 70 ? 'text-amber-500' : 'text-primary'

  return (
    <div className="relative size-5 flex items-center justify-center">
      <svg className="size-4 -rotate-90" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2.5" />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          className={`${colorClass} transition-all duration-300`}
        />
      </svg>
    </div>
  )
}

interface ContextBreakdown {
  label: string
  tokens: number
  color: string
}

function ContextUsagePanel({ used, total, breakdown, onClose }: { used: number; total: number; breakdown: ContextBreakdown[]; onClose: () => void }) {
  const percentage = Math.min(Math.max((used / total) * 100, 0), 100)
  const color = percentage > 90 ? 'bg-red-500' : percentage > 70 ? 'bg-amber-500' : 'bg-primary'

  return (
    <div className="absolute bottom-full right-0 mb-2 w-64 bg-card border border-border/60 rounded-xl shadow-lg p-3 z-50">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-baseline gap-1">
          <span className="text-sm font-semibold text-foreground">~{formatTokens(used)}</span>
          <span className="text-[10px] text-muted-foreground">/ {formatTokens(total)}</span>
          <span className={`text-[10px] font-medium ${percentage > 70 ? 'text-amber-500' : 'text-emerald-500'}`}>
            {percentage.toFixed(1)}% 上下文已用
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
        >
          <X className="size-3" />
        </button>
      </div>
      <div className="h-1 w-full bg-muted rounded-full overflow-hidden mb-2">
        <div className={`h-full ${color} transition-all duration-300`} style={{ width: `${percentage}%` }} />
      </div>
      <div className="space-y-1.5">
        {breakdown.map(item => (
          <div key={item.label} className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-sm ${item.color}`} />
              <span className="text-xs text-foreground">{item.label}</span>
            </div>
            <span className="text-xs text-muted-foreground">~{formatTokens(item.tokens)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ContextUsageIndicator() {
  const [open, setOpen] = useState(false)
  const chatMessages = useHelixStore(s => s.chatMessages)
  const customInstructions = useHelixStore(s => s.customInstructions)
  const mcpServers = useHelixStore(s => s.mcpServers)
  const skills = useHelixStore(s => s.skills)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Estimate tokens per category (chars / 3.5 as rough approximation)
  const estimate = (text: string) => Math.max(0, Math.round(text.length / 3.5))

  // System prompt (hardcoded estimate ~8K tokens for typical agent profile)
  const systemTokens = 8000 + estimate(customInstructions)

  // Tools & sub-agents estimate (~400 tokens per tool)
  const toolsTokens = 30 * 400

  // Conversation messages
  const messagesText = chatMessages.map(m => m.content || '').join('\n')
  const messagesTokens = estimate(messagesText)

  // MCP
  const mcpCount = Object.values(mcpServers).filter(s => s.enabled !== false).length
  const mcpTokens = mcpCount * 30

  // Skills
  const skillsText = skills.map(s => `${s.name}: ${s.description || ''}`).join('\n')
  const skillsTokens = estimate(skillsText)

  const total = 128000
  const used = systemTokens + toolsTokens + messagesTokens + mcpTokens + skillsTokens

  const breakdown: ContextBreakdown[] = [
    { label: '系统提示词', tokens: systemTokens, color: 'bg-gray-500' },
    { label: '工具及子智能体', tokens: toolsTokens, color: 'bg-purple-500' },
    { label: '对话消息', tokens: messagesTokens, color: 'bg-orange-500' },
    { label: '连接器及MCP', tokens: mcpTokens, color: 'bg-pink-500' },
    { label: '技能', tokens: skillsTokens, color: 'bg-sky-500' },
  ]

  if (used === 0) return null

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="size-9 rounded-lg flex items-center justify-center text-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
        title="上下文使用情况"
      >
        <ContextUsageRing used={used} total={total} />
      </button>
      {open && <ContextUsagePanel used={used} total={total} breakdown={breakdown} onClose={() => setOpen(false)} />}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center w-full px-4 py-16">
      <img src="/kirin.png" alt="Helix" className="w-20 h-20 mb-4 opacity-80 mt-[15px]" />
      <h2 className="text-lg font-semibold text-foreground/70 text-center mb-1 -mt-[5px]">有什么可以帮你？</h2>
    </div>
  )
}

// ── Main Component ──────────────────────────────────────

export function AgentFlowPanel() {
  const [steps, setSteps] = useState<FlowStep[]>([])
  const [input, setInput] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null)
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0)
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)

  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [showSkillDropdown, setShowSkillDropdown] = useState(false)
  const [showFolderDropdown, setShowFolderDropdown] = useState(false)
  const [showNewProjectForm, setShowNewProjectForm] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [fileSkills, setFileSkills] = useState<Array<{ name: string; description: string }>>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const savedSessionRef = useRef(false)
  const textBufferRef = useRef<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const skillUploadRef = useRef<HTMLInputElement>(null)
  const uploadFileInputRef = useRef<HTMLInputElement>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)
  const skillDropdownRef = useRef<HTMLDivElement>(null)
  const folderDropdownRef = useRef<HTMLDivElement>(null)

  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([])

  const [responseBlocks, setResponseBlocks] = useState<ResponseBlock[]>([])

  const { apiConfig, availableModels, skills, showToast, toggleSettings, toggleSkillPanel, addExecutionStep, addAccessedDirectory, agentExecutionSteps, chatMessages, currentSessionId, clearExecutionFlow, clearSelectedFiles, notifySessionSaved, setApiConfig, transcriptFontSize, selectedWorkDir, setSelectedWorkDir } = useHelixStore()
  const hasApiKey = !!apiConfig.apiKey

  // Get available models - combine current model, fetched models, and provider presets
  const getAvailableModels = useCallback(() => {
    const provider = apiConfig.provider
    const current = apiConfig.model
    const presets = getModels(provider) || []
    const merged = [current, ...availableModels, ...presets].filter((m): m is string => !!m && m.length > 0)
    const unique = merged.filter((m, i) => merged.indexOf(m) === i)
    if (unique.length === 0) {
      return ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'deepseek-chat']
    }
    return unique
  }, [apiConfig.provider, apiConfig.model, availableModels])

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setShowModelDropdown(false)
      }
      if (skillDropdownRef.current && !skillDropdownRef.current.contains(event.target as Node)) {
        setShowSkillDropdown(false)
      }
      if (folderDropdownRef.current && !folderDropdownRef.current.contains(event.target as Node)) {
        setShowFolderDropdown(false)
      }
    }
    if (showModelDropdown || showSkillDropdown || showFolderDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showModelDropdown, showSkillDropdown, showFolderDropdown])

  // Handle model selection
  const handleModelSelect = useCallback((model: string) => {
    setApiConfig({ model })
    useHelixStore.getState().persistToStorage()
    setShowModelDropdown(false)
  }, [setApiConfig])

  // Handle skill selection
  const handleSkillSelect = useCallback((skill: { name: string; description?: string }) => {
    setInput(`/${skill.name} `)
    inputRef.current?.focus()
  }, [])

  // Fetch file-based skills on mount
  useEffect(() => {
    if (fileSkills.length === 0) {
      fetch('/api/skills')
        .then(r => r.json())
        .then(data => { if (data.skills) setFileSkills(data.skills) })
        .catch(() => {})
    }
  }, [fileSkills.length])

  // Reset execution-related local states when switching sessions
  useEffect(() => {
    setIsRunning(false)
    setResponseBlocks([])
    setSteps([])
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
  }, [currentSessionId])

  // Reset when chat is cleared
  useEffect(() => {
    if (chatMessages.length === 0) {
      setResponseBlocks([])
      setSteps([])
      setInput('')
    }
  }, [chatMessages.length])

  // Filter skills based on input
  const allSkills = [
    ...skills.map(s => ({ name: s.name, description: s.description, id: s.id, icon: s.icon })),
    ...fileSkills.map(s => ({ name: s.name, description: s.description, id: s.name, icon: undefined })),
  ]
  const showSlashSkills = input.startsWith('/')
  const slashQuery = showSlashSkills ? input.slice(1).toLowerCase() : ''
  const filteredSkills = showSlashSkills
    ? allSkills.filter(s => s.name.toLowerCase().includes(slashQuery))
    : allSkills

  // Handle input change for skill detection
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInput(value)
  }, [])

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
    clearSelectedFiles()
    setSelectedWorkDir(null)
    clearExecutionFlow()
  }, [clearExecutionFlow, clearSelectedFiles])

  // Select project directory (also clears current session to keep sidebar in sync)
  const selectWorkDir = useCallback((dir: string | null) => {
    useHelixStore.setState({ currentSessionId: null })
    setSelectedWorkDir(dir)
  }, [setSelectedWorkDir])

  // Stop running agent
  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setIsRunning(false)
  }, [])

  // File picker handler
  const addSelectedFile = useHelixStore(s => s.addSelectedFile)
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return

    // Electron: skip file input, directly open native directory dialog
    if (isElectron()) {
      e.target.value = ''
      const dir = await electronDialog.openDirectory()
      if (dir) {
        selectWorkDir(dir)
      }
      return
    }

    // Browser: extract relative paths, let user type the full workdir manually
    let rootDir: string | null = null
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const relativePath = f.webkitRelativePath || f.name
      addSelectedFile(relativePath)
      if (!rootDir && relativePath.includes('/')) {
        rootDir = relativePath.split('/')[0]
      }
    }
    // Pre-fill with folder name as hint
    if (rootDir && !selectedWorkDir) {
      selectWorkDir(rootDir)
    }

    // Reset input so selecting the same folder again triggers onChange
    e.target.value = ''
  }, [addSelectedFile])

  // Handle skill file upload
  const handleSkillUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/skills', { method: 'POST', body: form })
      if (!res.ok) throw new Error('上传失败')
      showToast({ type: 'success', title: '技能添加成功' })
    } catch (err) {
      showToast({ type: 'error', title: '技能上传失败', description: String(err) })
    }
    e.target.value = ''
  }, [showToast])

  // Handle new project creation
  const handleCreateProject = useCallback(async () => {
    if (!newProjectName.trim()) {
      showToast({ type: 'warning', title: '请输入项目名称' })
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
          showToast({ type: 'success', title: '项目已创建', description: projectPath })
        } catch (err) {
          showToast({ type: 'error', title: '创建失败', description: String(err) })
        }
      }
    } else {
      // Browser mode: just set the project name as work dir hint
      selectWorkDir(newProjectName.trim())
      setShowNewProjectForm(false)
      setNewProjectName('')
      showToast({ type: 'success', title: '项目已设置', description: newProjectName.trim() })
    }
  }, [newProjectName, showToast])

  // Resolve /command -> skill name + user query
  const resolveCommand = useCallback((text: string): { skillName: string; query: string } | null => {
    const match = text.match(/^\/(\S+)\s*([\s\S]*)$/)
    if (!match) return null
    const cmd = match[1].toLowerCase()
    const rest = match[2].trim()
    const skill = skills.find(s => s.id === cmd || s.name.toLowerCase() === cmd)
    if (!skill) return null
    return { skillName: skill.id, query: rest || text }
  }, [skills])

  // Run agent task
  const handleRun = useCallback(async () => {
    const cmd = resolveCommand(input.trim())
    const trimmed = input.trim()
    if (!trimmed) return

    // If already running, abort current request first
    if (isRunning && abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
      setIsRunning(false)
    }

    // Check API key
    if (!hasApiKey) {
      showToast({ type: 'warning', title: '请先配置 API Key', description: '在设置中配置模型提供商' })
      toggleSettings()
      return
    }

    setInput('')
    setIsRunning(true)
    setResponseBlocks([])
    setSteps([])

    // Add user message to store with images
    const storeState = useHelixStore.getState()
    storeState.addChatMessage({
      role: 'user',
      content: trimmed,
      images: pendingImages.length > 0 ? [...pendingImages] : undefined,
    })
    setPendingImages([])

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const state = useHelixStore.getState()

      const response = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: state.chatMessages.map(m => {
            if (m.images && m.images.length > 0) {
              return {
                role: m.role,
                content: [
                  ...m.images.map(img => ({
                    type: 'image_url',
                    image_url: { url: img.dataUrl }
                  })),
                  { type: 'text', text: m.content }
                ]
              }
            }
            return { role: m.role, content: m.content }
          }),
          apiConfig: state.apiConfig,
          workDir: selectedWorkDir || undefined,
          skillName: cmd?.skillName,
          agentType: trimmed.match(/^\/review\b/) ? 'review' : undefined,
          mcpServers: state.mcpServers,
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

                if (parsed.type === 'tool_call') {
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
                  const step: FlowStep = { id, type: 'tool_call', content: getToolLabel(parsed.toolName), toolName: parsed.toolName, toolParams: params, timestamp: Date.now() }
                  setSteps(prev => [...prev, step])
                  addExecutionStep({ type: 'tool_call', toolName: parsed.toolName, path: filePath || undefined, toolParams: params })
                  setResponseBlocks(prev => {
                    const last = prev[prev.length - 1]
                    if (last?.type === 'tool_group') {
                      return [...prev.slice(0, -1), { type: 'tool_group', steps: [...last.steps, step] }]
                    }
                    return [...prev, { type: 'tool_group', steps: [step] }]
                  })
                } else if (parsed.type === 'thinking') {
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'thinking', content: parsed.content, timestamp: Date.now() }])
                } else if (parsed.type === 'reasoning') {
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'reasoning', content: parsed.content, timestamp: Date.now() }])
                } else if (parsed.type === 'file_change') {
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'file_change', content: parsed.content, fileChanges: parsed.fileChanges, timestamp: Date.now() }])
                } else if (parsed.type === 'tool_result') {
                  const id = generateId()
                  const step: FlowStep = { id, type: 'tool_result', content: parsed.content, toolName: parsed.toolName, timestamp: Date.now() }
                  setSteps(prev => [...prev, step])
                  addExecutionStep({ type: 'tool_result', toolName: parsed.toolName })
                  setResponseBlocks(prev => {
                    const last = prev[prev.length - 1]
                    if (last?.type === 'tool_group') {
                      return [...prev.slice(0, -1), { type: 'tool_group', steps: [...last.steps, step] }]
                    }
                    return [...prev, { type: 'tool_group', steps: [step] }]
                  })
                } else if (parsed.type === 'text') {
                  textBufferRef.current += parsed.content
                  setResponseBlocks(prev => {
                    const last = prev[prev.length - 1]
                    if (last?.type === 'text') {
                      return [...prev.slice(0, -1), { type: 'text', content: last.content + parsed.content }]
                    }
                    return [...prev, { type: 'text', content: parsed.content }]
                  })
                } else if (parsed.type === 'done') {
                  const content = textBufferRef.current
                  textBufferRef.current = ''
                  if (content) {
                    const curState = useHelixStore.getState()
                    const id = curState.addChatMessage({ role: 'assistant', content })
                    curState.setChatMessageStreaming(id, false)
                  }
                  setResponseBlocks([])
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'done', content: parsed.content, finishReason: parsed.finishReason, timestamp: Date.now() }])
                } else if (parsed.type === 'error') {
                  const content = textBufferRef.current
                  textBufferRef.current = ''
                  if (content) {
                    const curState = useHelixStore.getState()
                    const id = curState.addChatMessage({ role: 'assistant', content })
                    curState.setChatMessageStreaming(id, false)
                  }
                  setResponseBlocks([])
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'error', content: parsed.content, timestamp: Date.now() }])
                  addExecutionStep({ type: 'error' })
                } else if (parsed.type === 'plan') {
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'plan', content: '模型规划了以下步骤', planText: parsed.planText || parsed.content, timestamp: Date.now() }])
                  addExecutionStep({ type: 'plan' })
                } else if (parsed.type === 'task') {
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'task', content: parsed.content, taskLabel: parsed.taskLabel, taskId: parsed.taskId, timestamp: Date.now() }])
                  addExecutionStep({ type: 'task' })
                } else if (parsed.type === 'compact') {
                  const id = generateId()
                  setSteps(prev => [...prev, { id, type: 'compact', content: parsed.content, timestamp: Date.now() }])
                } else if (parsed.type === 'usage' && parsed.content) {
                  // Parse model usage: "Tokens: X total | Cost: $Y | Model: Z"
                  const modelMatch = parsed.content.match(/Model:\s*(.+)/)
                  const tokenMatch = parsed.content.match(/Tokens:\s*(\d+)/)
                  const costMatch = parsed.content.match(/Cost:\s*\$([\d.]+)/)
                  if (modelMatch && tokenMatch) {
                    const model = modelMatch[1].trim()
                    const total = parseInt(tokenMatch[1]) || 0
                    const cost = costMatch ? parseFloat(costMatch[1]) : 0
                    const prompt = Math.round(total * 0.6)
                    const completion = Math.round(total * 0.4)
                    addExecutionStep({ type: 'usage', content: parsed.content })
                    useHelixStore.getState().addModelUsage(model, {
                      prompt,
                      completion,
                      total,
                      cost,
                    })
                    useHelixStore.getState().addCurrentSessionTokens({ prompt, completion, total })
                  }
                } else if (parsed.type === 'approval_request') {
                  setApprovalRequest({
                    id: parsed.approvalId,
                    toolName: parsed.toolName,
                    params: parsed.toolParams || {},
                    timestamp: Date.now(),
                  })
                  setPendingApprovalCount(prev => prev + 1)
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
      // Debounced full-session persist handles saving; mark as saved
      if (!savedSessionRef.current) {
        savedSessionRef.current = true
        notifySessionSaved()
      }
    }
  }, [input, isRunning, hasApiKey, showToast, toggleSettings, resolveCommand])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlashSkills && filteredSkills.length > 0) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          handleSkillSelect(filteredSkills[0])
          return
        }
        if (e.key === 'Escape') {
          setInput('')
          return
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleRun()
      }
    },
    [handleRun, showSlashSkills, filteredSkills, handleSkillSelect]
  )

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items)
    const imageItems = items.filter(item => item.type.startsWith('image/'))

    if (imageItems.length === 0) return // Let normal text paste happen

    e.preventDefault()

    if (!canAddMoreImages(pendingImages.length, imageItems.length)) {
      showToast({ type: 'warning', title: `最多粘贴 5 张图片` })
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
  }, [pendingImages.length, showToast])

  const removePendingImage = useCallback((id: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== id))
  }, [])

  const handleApproval = useCallback(async (approvalId: string, approved: boolean, cacheDecision?: boolean) => {
    try {
      await fetch('/api/agent/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalId,
          action: approved ? 'approve' : 'reject',
          ...(cacheDecision ? { cache: true } : {}),
        }),
      })
      setApprovalRequest(null)
      setPendingApprovalCount(prev => Math.max(0, prev - 1))
    } catch (err) {
      console.error('Approval error:', err)
    }
  }, [])

  const handleApproveAll = useCallback(async () => {
    if (!approvalRequest) return
    try {
      await fetch('/api/agent/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: approvalRequest.id, action: 'approve', approveAll: true }),
      })
      setApprovalRequest(null)
      setPendingApprovalCount(0)
    } catch (err) {
      console.error('Approve all error:', err)
    }
  }, [approvalRequest])

  // Stats
  const thinkingCount = steps.filter(s => s.type === 'thinking').length
  const toolCallCount = steps.filter(s => s.type === 'tool_call').length
  const hasSteps = steps.length > 0
  const hasErrors = steps.some(s => s.type === 'error')

  // ── Group steps into task groups ──────────────────────
  interface TaskGroup2 {
    task: FlowStep | null
    label: string
    steps: FlowStep[]
  }

  const taskGroups: TaskGroup2[] = steps.reduce<TaskGroup2[]>((acc, step) => {
    if (step.type === 'task' || step.type === 'plan') {
      acc.push({
        task: step,
        label: step.taskLabel || step.content || (step.type === 'plan' ? '模型规划' : '任务'),
        steps: [],
      })
    } else if (acc.length > 0) {
      acc[acc.length - 1].steps.push(step)
    } else {
      // Steps before any task -> create a default group
      acc.push({ task: null, label: '执行流程', steps: [step] })
    }
    return acc
  }, [])
  // If steps exist but no groups created (no task separator)
  if (steps.length > 0 && taskGroups.length === 0) {
    taskGroups.push({ task: null, label: '执行流程', steps: [...steps] })
  }

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

  const renderChatInput = () => (
    <div className="bg-muted border border-border transition-all rounded-lg relative">
            {/* Textarea handles sizing + input */}
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="输入需求或 / 调用技能..."
              rows={4}
              className="w-full resize-none bg-transparent text-transparent caret-foreground text-sm text-left placeholder:text-left placeholder:text-muted-foreground outline-none min-h-[84px] max-h-[300px] leading-relaxed px-4 pt-2 relative z-10"
              style={{
                overflow: 'hidden',
                height: '84px',
              }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement
                target.style.height = '84px'
                const ch = target.scrollHeight
                if (ch > 84) {
                  target.style.height = Math.min(ch, 300) + 'px'
                }
              }}
            />

            {/* Highlighted display layer - behind transparent textarea */}
            <div
              className="absolute inset-0 p-4 pt-2 text-sm leading-relaxed whitespace-pre-wrap break-words pointer-events-none select-none z-0 overflow-hidden"
              aria-hidden="true"
            >
              {highlightedInput}
            </div>

            {/* Slash-triggered skill dropdown */}
            {showSlashSkills && filteredSkills.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 mb-1 mx-4 bg-background rounded-xl border border-border shadow-lg z-50 max-h-[200px] overflow-y-auto">
                {filteredSkills.map(skill => (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => handleSkillSelect(skill)}
                    className="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors flex items-center gap-2.5"
                  >
                    <FileText className="size-4 text-foreground/40 shrink-0" />
                            <span className="text-[13px] text-foreground block truncate">{skill.name}</span>
                    {skill.description && (
                      <span className="text-[11px] text-foreground/40 truncate ml-auto">{skill.description}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Image preview area */}
            {pendingImages.length > 0 && (
              <div className="flex gap-2 px-4 py-2 overflow-x-auto border-t border-border/30">
                {pendingImages.map(img => (
                  <div key={img.id} className="relative shrink-0 group">
                    <img
                      src={img.dataUrl}
                      alt={img.name}
                      className="w-20 h-20 rounded-lg object-cover border border-border/50"
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

            {/* Icons and send button - second row */}
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="flex items-center gap-2">
                <div className="relative" ref={folderDropdownRef}>
                  <button
                    type="button"
                    onClick={() => { setShowFolderDropdown(!showFolderDropdown) }}
                    className="p-2 text-foreground/40 hover:text-foreground/70 hover:bg-muted rounded-lg transition-colors"
                    title="项目目录"
                  >
                    <Folder className="size-4" />
                  </button>
                  {showFolderDropdown && (
                    <div className="absolute bottom-full left-0 mb-2 w-48 bg-background rounded-xl border border-border shadow-lg py-1 z-50">
                      <button
                        onClick={async () => {
                          setShowFolderDropdown(false)
                          if (isElectron()) {
                          const dir = await electronDialog.openDirectory()
                          if (dir) selectWorkDir(dir)
                          } else {
                            fileInputRef.current?.click()
                          }
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
                      >
                        <FolderOpen className="size-4 text-muted-foreground" />
                        选择已有目录
                      </button>
                      <button
                        onClick={() => { setShowNewProjectForm(true); setShowFolderDropdown(false) }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
                      >
                        <Plus className="size-4 text-muted-foreground" />
                        新建项目
                      </button>
                    </div>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  {...{ webkitdirectory: '' } as any}
                  className="hidden"
                  onChange={handleFileSelect}
                />
                {/* Skill selector - button + scrollable dropdown */}
                <div className="relative" ref={skillDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setShowSkillDropdown(!showSkillDropdown)}
                    className="relative p-2 text-foreground/40 hover:text-foreground/70 hover:bg-muted rounded-lg transition-colors"
                    title="技能"
                  >
                    <Zap className="size-4" />
                  </button>
                  {showSkillDropdown && (
                    <div className="absolute bottom-full left-0 mb-1 w-56 bg-background rounded-xl border border-border shadow-lg z-50">
                      <div className="max-h-[260px] overflow-y-auto py-1">
                        {filteredSkills.length > 0 ? filteredSkills.map(skill => (
                          <button
                            key={skill.id}
                            type="button"
                            onClick={() => { handleSkillSelect(skill); setShowSkillDropdown(false) }}
                            className="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors flex items-center gap-2.5"
                          >
                            <FileText className="size-4 text-foreground/40 shrink-0" />
                    <span className="text-[13px] text-foreground block truncate">{skill.name}</span>
                          </button>
                        )) : (
                          <div className="px-3 py-2 text-[11px] text-foreground/40">暂无技能</div>
                        )}
                      </div>
                      <div className="border-t border-border py-1">
                        <button
                          type="button"
                          onClick={() => { setShowSkillDropdown(false); toggleSkillPanel() }}
                          className="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors flex items-center gap-2.5 text-[13px] text-foreground"
                        >
                          <Briefcase className="size-4 text-foreground/50 shrink-0" />
                          <span>Manage skills</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => { setShowSkillDropdown(false); skillUploadRef.current?.click() }}
                          className="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors flex items-center gap-2.5 text-[13px] text-foreground"
                        >
                          <Plus className="size-4 text-foreground/50 shrink-0" />
                          <span>Add skill</span>
                        </button>
                      </div>
                    </div>
                  )}
                  <input
                    ref={skillUploadRef}
                    type="file"
                    accept=".md"
                    className="hidden"
                    onChange={handleSkillUpload}
                  />
                </div>

                {/* Model selector */}
                {hasApiKey && (
                  <div className="relative" ref={modelDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setShowModelDropdown(!showModelDropdown)}
                      className="flex items-center gap-1.5 text-xs text-foreground/60 hover:text-foreground/80 hover:bg-muted px-2.5 py-1.5 rounded-lg transition-colors"
                    >
                      <span className="font-mono">{apiConfig.model || '选择模型'}</span>
                      <ChevronDown className="size-3.5" />
                    </button>
                    {showModelDropdown && (
                      <div className="absolute bottom-full left-0 mb-1 w-48 bg-background rounded-xl border border-border shadow-lg py-1 z-50">
                        {getAvailableModels().map(model => (
                          <button
                            key={model}
                            type="button"
                            onClick={() => handleModelSelect(model)}
                            className={`w-full text-left px-3 py-1.5 text-[11px] font-mono hover:bg-muted transition-colors ${
                              apiConfig.model === model ? 'text-primary bg-primary/10' : 'text-foreground/70'
                            }`}
                          >
                            {model}
                          </button>
                        ))}
                        {getAvailableModels().length === 0 && (
                          <div className="px-3 py-1.5 text-[11px] text-foreground/40">
                            请在设置中配置
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  ref={uploadFileInputRef}
                  type="file"
                  className="hidden"
                  multiple
                  onChange={handleFileSelect}
                />
                <ContextUsageIndicator />
                <button
                  type="button"
                  onClick={() => uploadFileInputRef.current?.click()}
                  className="size-9 rounded-lg border border-border/60 bg-transparent hover:bg-muted transition-all flex items-center justify-center"
                  title="上传文件"
                >
                  <Plus className="size-4 text-foreground/40" />
                </button>
                {isRunning && (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="size-9 rounded-lg border border-red-500/20 bg-red-500/10 hover:bg-red-500/20 transition-all flex items-center justify-center"
                    title="停止"
                  >
                    <Square className="size-3.5 text-red-500" fill="currentColor" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleRun}
                  disabled={!input.trim()}
                  className={`size-9 rounded-lg border transition-all flex items-center justify-center ${
                    isRunning
                      ? 'border-amber-500/20 bg-amber-500/10 hover:bg-amber-500/20'
                      : 'border-emerald-500/20 bg-emerald-500/10 hover:bg-emerald-500/20'
                  } ${!input.trim() ? 'opacity-30 pointer-events-none' : ''}`}
                  title={isRunning ? '发送新消息（中断当前）' : '发送'}
                >
                  {isRunning ? <Loader2 className="size-4 text-amber-500 animate-spin" /> : <Send className="size-4 text-emerald-500" />}
                </button>
              </div>
            </div>
          </div>
  )

  return (
    <div className="h-full flex flex-col bg-transparent text-foreground">
      {/* Header bar - removed */}

      {/* Flow area */}
      <ScrollArea ref={scrollRef} className="flex-1 min-h-0" hideScrollbar={chatMessages.length === 0 && !hasSteps}>
        <div className="max-w-[700px] mx-auto py-4 pb-4 min-h-full">
          {chatMessages.length === 0 && !hasSteps ? (
            <div className="flex flex-col items-center justify-start min-h-[calc(100vh-200px)] w-full" style={{ paddingTop: 'calc(30vh - 250px)' }}>
              <EmptyState />
              <div className="mt-0 w-full max-w-[700px] mx-auto">
                {renderChatInput()}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Chat messages (input/output)  – completed messages only */}
              {chatMessages.map(msg => (
                <div key={msg.id} className={`flex w-full step-enter ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' ? (
                    <div className="group w-full max-w-[80%] ml-[30px]">
                      <div className="flex-1 min-w-0">
                        <div className="bg-card border border-border/50 rounded-xl px-4 py-3 text-foreground shadow-sm">
                          <div className="prose prose-sm prose-invert prose-code:before:content-none prose-code:after:content-none max-w-none">
                            <ReactMarkdown components={markdownComponents}>
                              {msg.content}
                            </ReactMarkdown>
                          </div>
                        </div>
                        {/* Copy button */}
                        <div className="flex opacity-0 group-hover:opacity-100 transition-opacity pt-1 px-1">
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(msg.content)
                              showToast({ type: 'success', title: '已复制' })
                            }}
                            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                            title="复制"
                          >
                            <Copy className="size-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="group max-w-[80%] mr-[30px]">
                      <div className="px-4 py-2.5 rounded-2xl bg-primary text-primary-foreground rounded-br-md shadow-sm">
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
                        {msg.content && (
                          <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                        )}
                      </div>
                      {/* Copy button below message */}
                      <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(msg.content || '')
                            showToast({ type: 'success', title: '已复制' })
                          }}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                          title="复制"
                        >
                          <Copy className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* Streaming assistant message – placed AFTER all completed messages */}
              {(isRunning || responseBlocks.length > 0) && (
                <div className="flex w-full justify-start transition-all duration-300 opacity-100">
                  <div className={`w-full max-w-[80%] ml-[30px] bg-card rounded-xl px-4 py-3 text-foreground transition-all duration-300 shadow-sm ${
                    isRunning
                      ? 'border border-primary/30 animate-pulse-glow'
                      : 'border border-border/50'
                  }`}>
                    {/* Running indicator */}
                    {isRunning && (
                      <div className="flex items-center gap-2 mb-2 text-xs text-primary/60">
                        模型正在执行
                      </div>
                    )}

                    {/* Interleaved response blocks (text -> tool groups) */}
                    {responseBlocks.length > 0 ? (
                      <div className="prose prose-sm prose-invert prose-code:before:content-none prose-code:after:content-none max-w-none">
                        {responseBlocks.map((block, idx) =>
                          block.type === 'text' ? (
                            <div key={idx}>
                              <ReactMarkdown components={markdownComponents}>
                                {block.content}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <ToolGroupBlock key={idx} steps={block.steps} isRunning={isRunning} />
                          )
                        )}
                      </div>
                    ) : steps.length > 0 && isRunning ? (
                      /* No text yet, only tool calls – show dynamic status while running */
                      steps.filter(s => s.type === 'tool_call').length > 0 && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground animate-pulse">
                          <Loader2 className="size-3.5 animate-spin" />
                          <span>正在读取 <span className="font-mono text-foreground/60">{steps.filter(s => s.type === 'tool_call').length}</span> 个文件<span className="inline-block animate-bounce" style={{ animationDelay: '0ms' }}>.</span><span className="inline-block animate-bounce" style={{ animationDelay: '150ms' }}>.</span><span className="inline-block animate-bounce" style={{ animationDelay: '300ms' }}>.</span></span>
                        </div>
                      )
                    ) : null}
                  </div>
                </div>
              )}

              {/* End of flow area – no summary */}

              {/* End of flow area – no summary */}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* API key warning */}
      {!hasApiKey && (
        <div className="mx-4 mb-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-500 flex items-center justify-between">
          <span>尚未配置 API Key</span>
          <button
            onClick={toggleSettings}
            className="ml-2 px-2 py-0.5 bg-amber-500/20 hover:bg-amber-500/30 rounded text-[10px] font-medium transition-colors"
          >
            打开设置
          </button>
        </div>
      )}

      {/* New project form */}
      {showNewProjectForm && (
        <div className="max-w-[700px] mx-auto mb-2 p-3 bg-card rounded-xl border border-border/50 shadow-sm">
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
              className="flex-1 px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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
      {chatMessages.length > 0 && (
        <div className="bg-transparent shrink-0 mb-2 mt-2 w-full">
          <div className="w-full max-w-[700px] mx-auto">
            {renderChatInput()}
            <p className="text-xs text-foreground/30 text-center mt-2 select-none">内容由 AI 生成，请核实重要信息</p>
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