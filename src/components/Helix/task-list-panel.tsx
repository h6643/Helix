'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { X, Save, ListTodo, Loader2 } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { isElectron, electronHermes } from '@/lib/electron-bridge'

// ── Types ────────────────────────────────────────────────────────────────
/** A task item returned by the Hermes backend. */
export interface HermesTask {
  id: string
  name: string
  prompt: string
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

interface TaskListPanelProps {
  onClose: () => void
}

// ── Component ────────────────────────────────────────────────────────────
export function TaskListPanel({ onClose }: TaskListPanelProps) {
  const [tasks, setTasks] = useState<HermesTask[]>([])
  const [editedPrompts, setEditedPrompts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const storeActions = useHelixStore(s => s)

  // ── Fetch tasks on mount ──
  const fetchTasks = useCallback(async () => {
    if (!isElectron()) {
      setLoading(false)
      return
    }
    try {
      const result = await electronHermes.send('hermes:getTasks')
      const list: HermesTask[] = Array.isArray(result)
        ? result
        : result?.tasks ?? result?.items ?? []
      setTasks(list)
      // Initialize edited prompts
      const prompts: Record<string, string> = {}
      for (const t of list) {
        prompts[t.id] = t.prompt
      }
      setEditedPrompts(prompts)
    } catch (err) {
      console.error('[TaskListPanel] Failed to fetch tasks:', err)
      storeActions.showToast({ type: 'error', title: '获取任务清单失败', description: err instanceof Error ? err.message : '未知错误' })
    } finally {
      setLoading(false)
    }
  }, [storeActions])

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  // ── ESC to close ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // ── Save a single task's prompt ──
  const handleSave = useCallback(async (taskId: string) => {
    const prompt = editedPrompts[taskId]
    if (prompt === undefined) return
    setSavingId(taskId)
    try {
      await electronHermes.send('hermes:updateTaskPrompt', { taskId, prompt })
      // Update local state
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, prompt } : t))
    } catch (err) {
      console.error('[TaskListPanel] Failed to save task prompt:', err)
      storeActions.showToast({ type: 'error', title: '保存失败', description: err instanceof Error ? err.message : '未知错误' })
    } finally {
      setSavingId(null)
    }
  }, [editedPrompts, storeActions])

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-[560px] max-w-[92vw] max-h-[82vh] flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <ListTodo className="size-4 text-primary" />
            <span className="text-base font-semibold text-foreground">任务清单</span>
            {tasks.length > 0 && (
              <span className="text-[13px] text-foreground/40">({tasks.length})</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-foreground/50 hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-foreground/50">
              <Loader2 className="size-4 animate-spin mr-2" />
              <span className="text-base">加载中...</span>
            </div>
          ) : tasks.length === 0 ? (
            <div className="text-center py-12 text-base text-foreground/40">
              暂无任务
            </div>
          ) : (
            tasks.map(task => (
              <div key={task.id} className="rounded-xl border border-border/60 overflow-hidden">
                {/* Task name header */}
                <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 border-b border-border/40">
                  <span className="text-[15px] font-medium text-foreground flex-1 truncate">{task.name}</span>
                  {task.status && (
                    <span className={`text-[12px] px-1.5 py-0.5 rounded-full ${
                      task.status === 'completed' ? 'bg-green-500/15 text-green-600' :
                      task.status === 'in_progress' ? 'bg-blue-500/15 text-blue-600' :
                      task.status === 'cancelled' ? 'bg-muted text-foreground/40' :
                      'bg-amber-500/15 text-amber-600'
                    }`}>
                      {task.status === 'completed' ? '已完成' :
                       task.status === 'in_progress' ? '进行中' :
                       task.status === 'cancelled' ? '已取消' : '待处理'}
                    </span>
                  )}
                </div>
                {/* Editable prompt */}
                <div className="p-2.5">
                  <textarea
                    value={editedPrompts[task.id] ?? task.prompt}
                    onChange={e => setEditedPrompts(prev => ({ ...prev, [task.id]: e.target.value }))}
                    className="w-full min-h-[60px] px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y leading-relaxed"
                    placeholder="输入提示词..."
                  />
                  <div className="flex justify-end mt-1.5">
                    <button
                      onClick={() => handleSave(task.id)}
                      disabled={savingId === task.id || editedPrompts[task.id] === task.prompt}
                      className="flex items-center gap-1.5 px-3 py-1 text-[13px] font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {savingId === task.id ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Save className="size-3" />
                      )}
                      <span>保存</span>
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
