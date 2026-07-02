'use client'

import React, { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Brain,
  Wrench,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Clock,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'

export interface AgentLogEntry {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'approval_request' | 'text' | 'error' | 'done'
  content: string
  toolName?: string
  toolParams?: Record<string, unknown>
  approvalId?: string
  timestamp: number
}

function getEventIcon(type: AgentLogEntry['type']) {
  switch (type) {
    case 'thinking':
      return <Brain className="size-3.5 text-blue-400" />
    case 'tool_call':
      return <Wrench className="size-3.5 text-amber-400" />
    case 'tool_result':
      return <CheckCircle2 className="size-3.5 text-green-400" />
    case 'approval_request':
      return <AlertCircle className="size-3.5 text-yellow-400" />
    case 'text':
      return <CheckCircle2 className="size-3.5 text-primary" />
    case 'error':
      return <AlertCircle className="size-3.5 text-red-400" />
    case 'done':
      return <CheckCircle2 className="size-3.5 text-green-500" />
    default:
      return null
  }
}

function getEventLabel(type: AgentLogEntry['type'], toolName?: string) {
  switch (type) {
    case 'thinking':
      return '思考'
    case 'tool_call':
      return `调用 ${toolName || 'tool'}`
    case 'tool_result':
      return `${toolName || 'tool'} 结果`
    case 'approval_request':
      return '等待审批'
    case 'text':
      return '回复'
    case 'error':
      return '错误'
    case 'done':
      return '完成'
    default:
      return type
  }
}

function LogEntry({ entry, isLatest }: { entry: AgentLogEntry; isLatest: boolean }) {
  const [expanded, setExpanded] = useState(isLatest)

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  return (
    <div className={`border-l-2 pl-3 py-2 ${
      entry.type === 'error' ? 'border-red-500/50' :
      entry.type === 'done' ? 'border-green-500/50' :
      isLatest ? 'border-primary/50' : 'border-border/50'
    }`}>
      <div
        className="flex items-center gap-2 cursor-pointer hover:bg-accent/30 rounded px-2 py-1 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {getEventIcon(entry.type)}
        <span className="text-[11px] font-medium text-foreground">
          {getEventLabel(entry.type, entry.toolName)}
        </span>
        <span className="text-[10px] text-muted-foreground ml-auto flex items-center gap-1">
          <Clock className="size-2.5" />
          {formatTime(entry.timestamp)}
        </span>
        {entry.content && (
          expanded ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />
        )}
      </div>

      {expanded && entry.content && (
        <div className="mt-1 px-2">
          {entry.type === 'tool_call' && entry.toolParams ? (
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground/60 uppercase">参数</div>
              <pre className="text-[11px] text-foreground/80 bg-muted/30 rounded p-2 overflow-x-auto font-mono">
                {JSON.stringify(entry.toolParams, null, 2)}
              </pre>
            </div>
          ) : entry.type === 'tool_result' ? (
            <pre className="text-[11px] text-foreground/80 bg-muted/30 rounded p-2 overflow-x-auto font-mono max-h-32 overflow-y-auto">
              {entry.content}
            </pre>
          ) : (
            <p className="text-[11px] text-foreground/80 whitespace-pre-wrap">
              {entry.content}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

interface AgentLogProps {
  entries: AgentLogEntry[]
  isRunning: boolean
}

export function AgentLog({ entries, isRunning }: AgentLogProps) {
  if (entries.length === 0 && !isRunning) {
    return null
  }

  return (
    <div className="border-t border-border bg-card">
      <div className="px-3 py-2 flex items-center gap-2">
        {isRunning && <Loader2 className="size-3 text-primary animate-spin" />}
        <span className="text-[11px] font-medium text-foreground">Agent 日志</span>
        <span className="text-[10px] text-muted-foreground">
          {entries.length} 步
        </span>
      </div>
      <ScrollArea className="max-h-48">
        <div className="px-3 pb-3 space-y-1">
          {entries.map((entry, i) => (
            <LogEntry
              key={`${entry.timestamp}-${i}`}
              entry={entry}
              isLatest={i === entries.length - 1 && isRunning}
            />
          ))}
          {isRunning && entries.length === 0 && (
            <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              启动中...
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
