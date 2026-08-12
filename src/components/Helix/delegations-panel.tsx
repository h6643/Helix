'use client'

import {
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  RefreshCw,
  Terminal,
  Users,
  X,
} from 'lucide-react'
import React, { useState, useEffect, useCallback } from 'react'
import { isElectron } from '@/lib/electron-bridge'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useHelixStore } from '@/stores/helix-store'

interface DelegationTask {
  name: string
  path: string
  size: number
  modified: number
  preview: string
}

interface Delegation {
  id: string
  path: string
  tasks: DelegationTask[]
}

interface DelegationsPanelProps {
  onClose?: () => void
}

export function DelegationsPanel({ onClose }: DelegationsPanelProps) {
  const showToast = useHelixStore(s => s.showToast)

  const [delegations, setDelegations] = useState<Delegation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selectedLog, setSelectedLog] = useState<{ path: string; name: string } | null>(null)
  const [logContent, setLogContent] = useState<string>('')
  const [logLoading, setLogLoading] = useState(false)

  const loadDelegations = useCallback(async () => {
    if (!isElectron()) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const api = (window as any).electron as any
      const res = await api?.delegations?.list?.()
      if (res?.ok) {
        setDelegations(res.delegations || [])
      } else {
        setError(res?.error || '加载失败')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDelegations()
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
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        子 agent 面板仅在桌面版可用
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full w-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">子 Agent</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={loadDelegations}
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
      <div className="flex-1 overflow-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-32 text-destructive text-sm">
            {error}
          </div>
        ) : delegations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-sm">
            <Users className="size-8 mb-2 opacity-30" />
            <p>暂无子 agent 记录</p>
            <p className="text-xs mt-1">使用 delegate_task 时会在这里显示</p>
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
                    <span className="text-xs font-mono text-foreground/80 truncate">
                      {del.id}
                    </span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {del.tasks.length} 个任务
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-border/30 bg-muted/20">
                      {del.tasks.map((task) => (
                        <button
                          key={task.name}
                          onClick={() => loadLog(task.path, task.name)}
                          className={cn(
                            'w-full flex items-center gap-2 px-4 py-2 hover:bg-accent/30 transition-colors text-left',
                            selectedLog?.path === task.path && 'bg-accent/20'
                          )}
                        >
                          <FileText className="size-3 text-muted-foreground" />
                          <span className="text-xs font-mono text-foreground/70">
                            {task.name}
                          </span>
                          <span className="text-xs text-muted-foreground ml-auto">
                            {formatSize(task.size)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {timeAgo(task.modified)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Log viewer */}
      {selectedLog && (
        <div className="border-t border-border/50">
          <div className="flex items-center justify-between px-3 py-2 bg-muted/30">
            <div className="flex items-center gap-2">
              <Terminal className="size-3.5 text-primary" />
              <span className="text-xs font-mono text-foreground/70">
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
              <pre className="text-xs font-mono text-foreground/70 whitespace-pre-wrap break-all">
                {logContent || '（空）'}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
