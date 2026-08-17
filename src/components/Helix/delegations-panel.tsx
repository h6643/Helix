'use client'

import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  RefreshCw,
  Terminal,
  Users,
  X,
  XCircle,
} from 'lucide-react'
import React, { useState, useEffect, useCallback } from 'react'
import { isElectron } from '@/lib/electron-bridge'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useHelixStore } from '@/stores/helix-store'
import type { SubAgent, ToolCallEntry } from '@/stores/helix-types'

interface DelegationTask {
  name: string
  path: string
  size: number
  modified: number
  preview: string
  goal?: string
  status?: string
}

interface Delegation {
  id: string
  path: string
  tasks: DelegationTask[]
}

interface DelegationsPanelProps {
  onClose?: () => void
}

// ── 实时子代理卡片（来自 store.subAgents，由 subagent.* 事件驱动）──────
function statusMeta(status: SubAgent['status']) {
  switch (status) {
    case 'running':
      return { icon: Loader2, cls: 'text-primary', label: '进行中', spin: true }
    case 'completed':
      return { icon: CheckCircle2, cls: 'text-emerald-500', label: '已完成', spin: false }
    case 'failed':
      return { icon: XCircle, cls: 'text-destructive', label: '失败', spin: false }
    case 'cancelled':
      return { icon: X, cls: 'text-muted-foreground', label: '已取消', spin: false }
  }
}

function LiveSubAgentCard({ agent }: { agent: SubAgent }) {
  const meta = statusMeta(agent.status)
  const Icon = meta.icon
  const toolCalls: ToolCallEntry[] = agent.toolCalls || []
  return (
    <div className="border border-border/30 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-muted/20 flex items-start gap-2">
        <Icon className={cn('size-4 mt-0.5 shrink-0', meta.spin && 'animate-spin', meta.cls)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/90 truncate">
              {agent.description || agent.name}
            </span>
            <span className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
              {meta.label}
            </span>
          </div>
          <div className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground mt-0.5 truncate font-mono">
            {agent.name}
          </div>
        </div>
      </div>

      {toolCalls.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border/30 space-y-0.5">
          {toolCalls.slice(-8).map((tc, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[calc(var(--helix-transcript-size)*0.7857)]">
              <span className="text-primary shrink-0">▸</span>
              <span className="text-foreground/70 font-mono shrink-0">{tc.toolName}</span>
              {tc.params && (
                <span className="text-muted-foreground truncate min-w-0 flex-1">{tc.params}</span>
              )}
              <span
                className={cn(
                  'ml-auto shrink-0',
                  tc.status === 'error'
                    ? 'text-destructive'
                    : tc.status === 'success'
                      ? 'text-emerald-500'
                      : 'text-muted-foreground'
                )}
              >
                {tc.status === 'running' ? '…' : tc.status === 'success' ? '✓' : '✗'}
              </span>
            </div>
          ))}
        </div>
      )}

      {agent.result && (
        <div className="px-3 py-1.5 border-t border-border/30">
          <div className="text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/70 whitespace-pre-wrap break-words line-clamp-3">
            {agent.result}
          </div>
        </div>
      )}

      {agent.filesModified && agent.filesModified.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border/30 flex flex-wrap gap-1">
          {agent.filesModified.slice(0, 6).map((f, i) => (
            <span
              key={i}
              className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground font-mono truncate max-w-full"
            >
              {f.split(/[/\\]/).pop()}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function DelegationsPanel({ onClose }: DelegationsPanelProps) {
  // 实时子代理：由 subagent.* 事件写入 store（agent-flow-panel.onEvent）
  const subAgents = useHelixStore(s => s.subAgents)
  const runningCount = subAgents.filter(a => a.status === 'running').length

  const [delegations, setDelegations] = useState<Delegation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selectedLog, setSelectedLog] = useState<{ path: string; name: string } | null>(null)
  const [logContent, setLogContent] = useState<string>('')
  const [logLoading, setLogLoading] = useState(false)

  const loadDelegations = useCallback(async (silent = false) => {
    if (!isElectron()) {
      setLoading(false)
      return
    }
    if (!silent) {
      setLoading(true)
    }
    setError(null)
    try {
      const api = (window as any).electron as any
      const res = await api?.delegations?.list?.()
      if (res?.ok) {
        setDelegations(res.delegations || [])
      } else if (!silent) {
        setError(res?.error || '加载失败')
      }
    } catch (e) {
      if (!silent) setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDelegations()
    // 静默轮询：委托运行完成后磁盘 live 日志随之出现，无需手动点刷新
    const timer = setInterval(() => loadDelegations(true), 10000)
    return () => clearInterval(timer)
  }, [loadDelegations])

  const loadLog = useCallback(async (path: string, name: string) => {
    setSelectedLog({ path, name })
    setLogLoading(true)
    setLogContent('')
    try {
      const api = (window as any).electron as any
      const res = await api?.delegations?.readLog?.(path, 200)
      if (res?.ok) {
        setLogContent(res.content || '')
      } else {
        setLogContent(res?.error || '读取失败')
      }
    } catch (e) {
      setLogContent(String(e))
    } finally {
      setLogLoading(false)
    }
  }, [])

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  if (!isElectron()) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-[length:var(--helix-transcript-size)]">
        子 agent 面板仅在桌面版可用
      </div>
    )
  }

  const showLive = subAgents.length > 0

  return (
    <div className="flex flex-col h-full w-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-primary" />
          <h2 className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">子 Agent</h2>
          {runningCount > 0 && (
            <span className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
              {runningCount} 运行中
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => loadDelegations()}
            className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
            data-tip="刷新"
          >
            <RefreshCw className="size-3.5" />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3 space-y-4">
        {/* 实时区：本次会话正在运行 / 刚完成的子任务 */}
        {showLive && (
          <section>
            <div className="flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/70 mb-1.5">
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              实时
            </div>
            <div className="space-y-2">
              {subAgents.map((agent) => (
                <LiveSubAgentCard key={agent.id} agent={agent} />
              ))}
            </div>
          </section>
        )}

        {/* 历史区：磁盘 live 日志（delegate_task 每次委托生成） */}
        <section>
          <div className="flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/70 mb-1.5">
            <Clock className="size-3 text-muted-foreground" />
            历史记录
          </div>
          {loading ? (
            <div className="flex items-center justify-center h-24">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-24 text-destructive text-[length:var(--helix-transcript-size)]">{error}</div>
          ) : delegations.length === 0 && !showLive ? (
            <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-[length:var(--helix-transcript-size)]">
              <Users className="size-8 mb-2 opacity-30" />
              <p>暂无子 agent 记录</p>
              <p className="text-[calc(var(--helix-transcript-size)*0.8571)] mt-1">使用 delegate_task 时会在这里显示</p>
            </div>
          ) : delegations.length === 0 ? (
            <div className="flex items-center justify-center h-16 text-muted-foreground text-[calc(var(--helix-transcript-size)*0.8571)]">
              暂无历史记录
            </div>
          ) : (
            <div className="space-y-1">
              {delegations.map((del) => {
                const isExpanded = expandedId === del.id
                return (
                  <div key={del.id} className="border border-border/30 rounded-lg overflow-hidden">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : del.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/30 transition-colors"
                    >
                      {isExpanded ? (
                        <ChevronDown className="size-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3.5 text-muted-foreground" />
                      )}
                      <Terminal className="size-3.5 text-primary" />
                      <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-mono text-foreground/80 truncate">
                        {del.id}
                      </span>
                      <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground ml-auto">
                        {(del.tasks || []).length} 个任务
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-border/30 bg-muted/20">
                        {(del.tasks || []).map((task) => (
                          <button
                            key={task.name}
                            onClick={() => loadLog(task.path, task.name)}
                            className={cn(
                              'w-full flex flex-col gap-0.5 px-4 py-2 hover:bg-accent/30 transition-colors text-left',
                              selectedLog?.path === task.path && 'bg-accent/20'
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <FileText className="size-3 text-muted-foreground shrink-0" />
                              <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-mono text-foreground/70">
                                {task.name}
                              </span>
                              {task.status && task.status !== 'running' && (
                                <span
                                  className={cn(
                                    'text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded shrink-0',
                                    task.status === 'failed' || task.status === 'error'
                                      ? 'bg-destructive/10 text-destructive'
                                      : task.status === 'interrupted' || task.status === 'cancelled'
                                        ? 'bg-muted text-muted-foreground'
                                        : 'bg-emerald-500/10 text-emerald-600'
                                  )}
                                >
                                  {task.status}
                                </span>
                              )}
                              <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground ml-auto shrink-0">
                                {formatSize(task.size)}
                              </span>
                              <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground shrink-0">
                                {timeAgo(task.modified)}
                              </span>
                            </div>
                            {task.goal && (
                              <div className="text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/60 line-clamp-2 pl-5">
                                {task.goal}
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      {/* Log viewer */}
      {selectedLog && (
        <div className="border-t border-border/50">
          <div className="flex items-center justify-between px-3 py-2 bg-muted/30">
            <div className="flex items-center gap-2">
              <Terminal className="size-3.5 text-primary" />
              <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-mono text-foreground/70">
                {selectedLog.name}
              </span>
            </div>
            <button
              onClick={() => setSelectedLog(null)}
              className="p-1 text-foreground/40 hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
          <div className="h-48 overflow-auto p-3 bg-background/50">
            {logLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="size-4 animate-spin text-primary" />
              </div>
            ) : (
              <pre className="text-[calc(var(--helix-transcript-size)*0.8571)] font-mono text-foreground/70 whitespace-pre-wrap break-all">
                {logContent || '（空）'}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
