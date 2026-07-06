'use client'

import React, { useState, useEffect, useCallback } from 'react'
import {
  X,
  Plus,
  Trash2,
  Clock,
  Play,
  Pause,
  Timer,
  RefreshCw,
} from 'lucide-react'
import { useHelixStore, type ScheduledTask } from '@/stores/helix-store'
import { ScrollArea } from '@/components/ui/scroll-area'

interface ScheduledTasksPanelProps {
  onClose: () => void
}

function formatTime(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = new Date()
  const diff = d.getTime() - now.getTime()
  if (diff < 0) return '已过期'
  if (diff < 60000) return '即将执行'
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟后`
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时后`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function parseSchedule(text: string): { nextRun: number | null; error?: string } {
  const lower = text.toLowerCase().trim()

  // "every X minutes"
  const minMatch = lower.match(/every\s+(\d+)\s*min(?:ute)?s?/)
  if (minMatch) {
    const interval = parseInt(minMatch[1]) * 60000
    return { nextRun: Date.now() + interval }
  }

  // "every X hours"
  const hourMatch = lower.match(/every\s+(\d+)\s*hour(?:s)?/)
  if (hourMatch) {
    const interval = parseInt(hourMatch[1]) * 3600000
    return { nextRun: Date.now() + interval }
  }

  // "every day at HH:MM"
  const dayMatch = lower.match(/every\s+day\s+at\s+(\d{1,2}):(\d{2})/)
  if (dayMatch) {
    const now = new Date()
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(dayMatch[1]), parseInt(dayMatch[2]))
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
    return { nextRun: target.getTime() }
  }

  // "every hour"
  if (lower.includes('every hour')) {
    return { nextRun: Date.now() + 3600000 }
  }

  // "every day"
  if (lower.includes('every day')) {
    return { nextRun: Date.now() + 86400000 }
  }

  // "every week"
  if (lower.includes('every week')) {
    return { nextRun: Date.now() + 604800000 }
  }

  // "in X minutes" — one-off
  const inMinMatch = lower.match(/in\s+(\d+)\s*min(?:ute)?s?/)
  if (inMinMatch) {
    return { nextRun: Date.now() + parseInt(inMinMatch[1]) * 60000 }
  }

  return { nextRun: Date.now() + 86400000, error: '未识别的时间格式，默认每天执行' }
}

function ScheduledTaskItem({
  task,
  onToggle,
  onDelete,
  onUpdate,
}: {
  task: ScheduledTask
  onToggle: () => void
  onDelete: () => void
  onUpdate: (updates: Partial<ScheduledTask>) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editLabel, setEditLabel] = useState(task.label)
  const [editPrompt, setEditPrompt] = useState(task.prompt)
  const [editSchedule, setEditSchedule] = useState(task.scheduleText)

  const handleSave = () => {
    if (!editLabel.trim() || !editPrompt.trim() || !editSchedule.trim()) return
    const parsed = parseSchedule(editSchedule)
    onUpdate({
      label: editLabel.trim(),
      prompt: editPrompt.trim(),
      scheduleText: editSchedule.trim(),
      nextRunAt: parsed.nextRun,
    })
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="p-3 rounded-lg border border-primary/50 bg-primary/5 space-y-2">
        <input
          value={editLabel}
          onChange={(e) => setEditLabel(e.target.value)}
          className="w-full px-2 py-1 bg-muted border border-border/50 rounded text-sm"
          placeholder="任务名称"
        />
        <textarea
          value={editPrompt}
          onChange={(e) => setEditPrompt(e.target.value)}
                  className="w-full px-2 py-1 bg-muted border border-border/50 rounded text-xs font-mono min-h-[60px]"
          placeholder="prompt 内容"
        />
        <input
          value={editSchedule}
          onChange={(e) => setEditSchedule(e.target.value)}
                className="w-full px-2 py-1 bg-muted border border-border/50 rounded text-xs font-mono"
          placeholder="e.g. every day at 9:00, every 30 minutes, in 5 minutes"
        />
        <div className="flex justify-end gap-2">
          <button onClick={() => setEditing(false)} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground">取消</button>
          <button onClick={handleSave} className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded">保存</button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-3 rounded-lg border border-border/30 bg-card/50 shadow-sm hover:bg-card/80 transition-colors group">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <Timer className="size-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{task.label}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${task.enabled ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground'}`}>
                {task.enabled ? '运行中' : '已暂停'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{task.prompt}</p>
            <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground/60">
              <span className="flex items-center gap-1">
                <Clock className="size-3" />
                {task.scheduleText}
              </span>
              <span>下次: {formatTime(task.nextRunAt)}</span>
              {task.lastRunAt && <span>上次: {formatTime(task.lastRunAt)}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onToggle}
            className="p-1 text-muted-foreground/60 hover:text-foreground rounded transition-colors"
            title={task.enabled ? '暂停' : '启用'}
          >
            {task.enabled ? <Pause className="size-3" /> : <Play className="size-3" />}
          </button>
          <button
            onClick={() => { setEditing(true); setEditLabel(task.label); setEditPrompt(task.prompt); setEditSchedule(task.scheduleText) }}
            className="p-1 text-muted-foreground/60 hover:text-foreground rounded transition-colors"
            title="编辑"
          >
            <RefreshCw className="size-3" />
          </button>
          <button
            onClick={onDelete}
            className="p-1 text-muted-foreground/60 hover:text-red-500 rounded transition-colors"
            title="删除"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      </div>
    </div>
  )
}

export function ScheduledTasksPanel({ onClose }: ScheduledTasksPanelProps) {
  const { scheduledTasks, addScheduledTask, updateScheduledTask, removeScheduledTask, toggleScheduledTask, showToast } = useHelixStore()
  const [isAdding, setIsAdding] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newPrompt, setNewPrompt] = useState('')
  const [newSchedule, setNewSchedule] = useState('')

  const handleAdd = () => {
    if (!newLabel.trim() || !newPrompt.trim() || !newSchedule.trim()) return
    const parsed = parseSchedule(newSchedule)
    addScheduledTask({
      label: newLabel.trim(),
      prompt: newPrompt.trim(),
      scheduleText: newSchedule.trim(),
      cronExpression: undefined,
      enabled: true,
      lastRunAt: null,
      nextRunAt: parsed.nextRun,
    })
    if (parsed.error) {
      showToast({ type: 'warning', title: parsed.error })
    }
    setNewLabel(''); setNewPrompt(''); setNewSchedule('')
    setIsAdding(false)
  }

  const handleRunNow = useCallback(async (task: ScheduledTask) => {
    try {
      const { addChatMessage, setChatLoading } = useHelixStore.getState()
      addChatMessage({ role: 'system', content: `[定时任务] ${task.label}: ${task.prompt}` })
      updateScheduledTask(task.id, { lastRunAt: Date.now() })
      const parsed = parseSchedule(task.scheduleText)
      updateScheduledTask(task.id, { nextRunAt: parsed.nextRun })
      showToast({ type: 'info', title: `定时任务 "${task.label}" 已触发` })
    } catch (e) {
      console.error('Failed to run scheduled task:', e)
    }
  }, [updateScheduledTask, showToast])

  // Auto-trigger checker
  useEffect(() => {
    const interval = setInterval(() => {
      const state = useHelixStore.getState()
      const now = Date.now()
      for (const task of state.scheduledTasks) {
        if (task.enabled && task.nextRunAt && task.nextRunAt <= now) {
          handleRunNow(task)
        }
      }
    }, 30000)
    return () => clearInterval(interval)
  }, [handleRunNow])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-card border border-border/60 rounded-2xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60 shrink-0">
          <div className="flex items-center gap-2">
            <Clock className="size-4 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">定时任务</h2>
            {scheduledTasks.filter(t => t.enabled).length > 0 && (
              <span className="text-[10px] bg-emerald-500/10 text-emerald-500 px-1.5 py-0.5 rounded-full">
                {scheduledTasks.filter(t => t.enabled).length} 运行中
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors">
            <X className="size-4" />
          </button>
        </div>

        <ScrollArea className="flex-1">
          <div className="px-5 py-4 space-y-3">
            {scheduledTasks.length === 0 && !isAdding && (
              <div className="text-center py-8">
                <Clock className="size-8 text-muted-foreground/20 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">暂无定时任务</p>
                <p className="text-xs text-muted-foreground/60 mt-1">添加定时任务，agent 将按时自动执行</p>
              </div>
            )}
            {scheduledTasks.map(task => (
              <ScheduledTaskItem
                key={task.id}
                task={task}
                onToggle={() => toggleScheduledTask(task.id)}
                onDelete={() => removeScheduledTask(task.id)}
                onUpdate={(updates) => updateScheduledTask(task.id, updates)}
              />
            ))}

            {isAdding ? (
              <div className="p-3 rounded-lg border border-primary/50 bg-primary/5 space-y-2">
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  className="w-full px-2 py-1 bg-muted border border-border/50 rounded text-sm"
                  placeholder="任务名称"
                />
                <textarea
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  className="w-full px-2 py-1 bg-muted border border-border/50 rounded text-xs font-mono min-h-[80px]"
                  placeholder="输入要 agent 执行的 prompt..."
                  autoFocus
                />
                <input
                  value={newSchedule}
                  onChange={(e) => setNewSchedule(e.target.value)}
                  className="w-full px-2 py-1 bg-muted border border-border/50 rounded text-xs font-mono"
                  placeholder="e.g. every day at 9:00, every 30 minutes, in 5 minutes, every hour"
                />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setIsAdding(false)} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground">取消</button>
                  <button
                    onClick={handleAdd}
                    disabled={!newLabel.trim() || !newPrompt.trim() || !newSchedule.trim()}
                    className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded disabled:opacity-50"
                  >
                    创建
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setIsAdding(true)}
                className="w-full p-3 rounded-lg border border-dashed border-border/50 hover:border-primary/50 hover:bg-accent/30 transition-colors flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              >
                <Plus className="size-4" />
                添加定时任务
              </button>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
