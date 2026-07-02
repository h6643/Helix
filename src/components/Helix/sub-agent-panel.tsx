'use client'

import React, { useState, useRef, useEffect, useMemo } from 'react'
import {
  Bot,
  Cpu,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  X,
  ExternalLink,
} from 'lucide-react'
import { useHelixStore, type SubAgent } from '@/stores/helix-store'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { timeAgoShort } from '@/lib/format'

const STATUS_STYLE: Record<SubAgent['status'], { icon: React.ElementType; color: string; label: string; bg: string }> = {
  running: { icon: Loader2, color: 'text-blue-400', label: '执行中', bg: 'bg-blue-500/10 border-blue-500/20' },
  completed: { icon: CheckCircle2, color: 'text-emerald-400', label: '已完成', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  failed: { icon: XCircle, color: 'text-red-400', label: '失败', bg: 'bg-red-500/10 border-red-500/20' },
  cancelled: { icon: XCircle, color: 'text-gray-400', label: '已取消', bg: 'bg-gray-500/10 border-gray-500/20' },
}

function SubAgentCard({ agent }: { agent: SubAgent }) {
  const [expanded, setExpanded] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const cfg = STATUS_STYLE[agent.status]
  const StatusIcon = cfg.icon
  const isAnimated = agent.status === 'running'

  return (
    <div className={`border rounded-lg ${cfg.bg} transition-all duration-300`}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/20 rounded-lg transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon className={`size-3.5 ${cfg.color} ${isAnimated ? 'animate-spin' : ''}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium truncate">{agent.name}</span>
            <span className="text-[10px] text-muted-foreground">{timeAgoShort(agent.createdAt)}</span>
          </div>
          {agent.description && (
            <p className="text-[11px] text-muted-foreground truncate mt-0.5">{agent.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${cfg.bg} ${cfg.color} font-medium`}>
            {cfg.label}
          </span>
          {expanded ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/30 px-3 py-2 space-y-2">
          {/* Agent metadata */}
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            {agent.parentId && (
              <span className="flex items-center gap-0.5">
                <Cpu className="size-2.5" />
                子任务
              </span>
            )}
            {agent.result && agent.status === 'completed' && (
              <span className="flex items-center gap-0.5 text-emerald-400">
                <CheckCircle2 className="size-2.5" />
                成功
              </span>
            )}
          </div>

          {/* Agent output / result preview */}
          {agent.result && (
            <div className="bg-background/50 rounded-md p-2 max-h-32 overflow-auto">
              <p className="text-[11px] text-foreground/80 whitespace-pre-wrap line-clamp-6 font-mono leading-relaxed">
                {agent.result.length > 500 ? agent.result.slice(0, 500) + '...' : agent.result}
              </p>
            </div>
          )}

          {/* Files modified */}
          {agent.filesModified && agent.filesModified.length > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground mb-1">修改的文件:</p>
              <div className="flex flex-wrap gap-1">
                {agent.filesModified.map((f, i) => (
                  <span key={i} className="text-[10px] bg-muted/50 px-1.5 py-0.5 rounded font-mono">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-1 pt-1">
            {agent.status === 'running' && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] text-red-400 hover:text-red-300"
                onClick={(e) => {
                  e.stopPropagation()
                  useHelixStore.getState().cancelSubAgent(agent.id)
                }}
              >
                <X className="size-3 mr-1" />
                取消
              </Button>
            )}
            {agent.chatMessageId && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px]"
                onClick={(e) => {
                  e.stopPropagation()
                  // Scroll to the chat message
                  const el = document.querySelector(`[data-message-id="${agent.chatMessageId}"]`)
                  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }}
              >
                <ExternalLink className="size-3 mr-1" />
                查看对话
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function SubAgentPanel() {
  const { subAgents, clearCompletedSubAgents } = useHelixStore()

  const runningCount = subAgents.filter(a => a.status === 'running').length
  const completedCount = subAgents.filter(a => a.status === 'completed').length
  const failedCount = subAgents.filter(a => a.status === 'failed').length

  const sortedAgents = useMemo(() => {
    return [...subAgents].sort((a, b) => {
      // Running first, then by creation time desc
      if (a.status === 'running' && b.status !== 'running') return -1
      if (a.status !== 'running' && b.status === 'running') return 1
      return b.createdAt - a.createdAt
    })
  }, [subAgents])

  return (
    <div className="h-full flex flex-col bg-card">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Cpu className="size-3.5 text-purple-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            子 Agent
          </span>
          {runningCount > 0 && (
            <span className="text-[10px] text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded-full animate-pulse">
              {runningCount} 运行中
            </span>
          )}
        </div>
        {(completedCount > 0 || failedCount > 0) && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={clearCompletedSubAgents}
            title="清除已完成"
          >
            <X className="size-3" />
          </Button>
        )}
      </div>

      {/* Stats bar */}
      {subAgents.length > 0 && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border/50 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            {runningCount} 运行中
          </span>
          <span className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            {completedCount} 完成
          </span>
          {failedCount > 0 && (
            <span className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-red-400" />
              {failedCount} 失败
            </span>
          )}
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-2">
          {sortedAgents.map(agent => (
            <SubAgentCard key={agent.id} agent={agent} />
          ))}

          {subAgents.length === 0 && (
            <div className="px-4 py-8 text-center">
              <Bot className="size-8 text-muted-foreground/15 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">暂无子 Agent</p>
              <p className="text-[10px] text-muted-foreground/60 mt-1">
                在 Compose 模式下，AI 会自动拆分复杂任务为子 Agent
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}