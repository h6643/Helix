'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Search,
  Plus,
  Clock,
  Play,
  Pause,
  Trash2,
  RefreshCw,
  MoreHorizontal,
  Circle,
  X,
} from 'lucide-react'
import { useHelixStore, type ScheduledTask } from '@/stores/helix-store'
import { useHermesStore } from '@/stores/hermes-store'
import { parseChineseSchedule } from '@/lib/schedule-utils'
import { ScrollArea } from '@/components/ui/scroll-area'

interface ScheduledTasksPanelProps {
  onClose: () => void
}

function cn(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(' ')
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

type ParsedSchedule = {
  kind: 'cron' | 'once'
  expr?: string
  runAt?: number
  nextRun: number | null
  error?: string
}

function parseSchedule(text: string): ParsedSchedule {
  const lower = text.toLowerCase().trim()
  const now = Date.now()

  const inMinMatch = lower.match(/in\s+(\d+)\s*min(?:ute)?s?/)
  if (inMinMatch) {
    const t = now + parseInt(inMinMatch[1]) * 60000
    return { kind: 'once', runAt: t, nextRun: t }
  }

  const dayMatch = lower.match(/every\s+day\s+at\s+(\d{1,2}):(\d{2})/)
  if (dayMatch) {
    const h = parseInt(dayMatch[1])
    const m = parseInt(dayMatch[2])
    const target = new Date()
    target.setHours(h, m, 0, 0)
    if (target.getTime() <= now) target.setDate(target.getDate() + 1)
    return { kind: 'cron', expr: `0 ${h} * * *`, nextRun: target.getTime() }
  }

  const hourMatch = lower.match(/every\s+(\d+)\s*hour(?:s)?/)
  if (hourMatch) {
    const n = parseInt(hourMatch[1])
    const t = now + n * 3600000
    return { kind: 'cron', expr: `0 */${n} * * *`, nextRun: t }
  }

  const minMatch = lower.match(/every\s+(\d+)\s*min(?:ute)?s?/)
  if (minMatch) {
    const n = parseInt(minMatch[1])
    const t = now + n * 60000
    return { kind: 'cron', expr: `*/${n} * * * *`, nextRun: t }
  }

  if (lower.includes('every hour')) return { kind: 'cron', expr: '0 * * * *', nextRun: now + 3600000 }
  if (lower.includes('every day')) return { kind: 'cron', expr: '0 0 * * *', nextRun: now + 86400000 }
  if (lower.includes('every week')) {
    const t = now + 604800000
    return { kind: 'cron', expr: '0 0 * * 0', nextRun: t }
  }

  const t = now + 86400000
  if (/[一-鿿]/.test(text)) {
    const cn = parseChineseSchedule(text)
    return { kind: 'once', runAt: cn, nextRun: cn }
  }
  return { kind: 'once', runAt: t, nextRun: t, error: '未识别的时间格式，默认每天执行' }
}

function AddTaskForm({
  onCancel,
  onAdd,
}: {
  onCancel: () => void
  onAdd: (label: string, prompt: string, schedule: string) => void
}) {
  const [label, setLabel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [schedule, setSchedule] = useState('')
  const canSubmit = label.trim() && prompt.trim() && schedule.trim()

  return (
    <div className="p-4 rounded-xl border border-primary/30 bg-primary/[0.03] space-y-3">
      <div className="flex items-center gap-2">
        <Circle className="size-4 text-foreground/30" />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="flex-1 min-w-0 bg-transparent text-sm font-medium text-foreground placeholder:text-muted-foreground focus:outline-none"
          placeholder="任务名称"
          autoFocus
        />
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        className="w-full px-2 py-1.5 bg-muted/50 border border-border/50 rounded-lg text-xs font-mono min-h-[70px] focus:outline-none focus:ring-2 focus:ring-primary/20"
        placeholder="输入要 agent 执行的 prompt..."
      />
      <input
        value={schedule}
        onChange={(e) => setSchedule(e.target.value)}
        className="w-full px-2 py-1.5 bg-muted/50 border border-border/50 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/20"
        placeholder="e.g. every day at 9:00, every 30 minutes, in 5 minutes"
      />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-lg transition-colors">取消</button>
        <button
          onClick={() => canSubmit && onAdd(label.trim(), prompt.trim(), schedule.trim())}
          disabled={!canSubmit}
          className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg disabled:opacity-50 transition-colors"
        >
          创建
        </button>
      </div>
    </div>
  )
}

function EditTaskForm({
  task,
  onSave,
  onCancel,
}: {
  task: ScheduledTask
  onSave: (updates: Partial<ScheduledTask>) => void
  onCancel: () => void
}) {
  const [editLabel, setEditLabel] = useState(task.label)
  const [editPrompt, setEditPrompt] = useState(task.prompt)
  const [editSchedule, setEditSchedule] = useState(task.scheduleText)

  const handleSave = () => {
    if (!editLabel.trim() || !editPrompt.trim() || !editSchedule.trim()) return
    const parsed = parseSchedule(editSchedule)
    onSave({
      label: editLabel.trim(),
      prompt: editPrompt.trim(),
      scheduleText: editSchedule.trim(),
      nextRunAt: parsed.nextRun,
    })
    onCancel()
  }

  return (
    <div className="p-4 rounded-xl border border-primary/30 bg-primary/[0.03] space-y-3">
      <div className="flex items-center gap-2">
        <Circle className="size-4 text-foreground/30" />
        <input
          value={editLabel}
          onChange={(e) => setEditLabel(e.target.value)}
          className="flex-1 min-w-0 bg-transparent text-sm font-medium text-foreground placeholder:text-muted-foreground focus:outline-none"
          placeholder="任务名称"
        />
      </div>
      <textarea
        value={editPrompt}
        onChange={(e) => setEditPrompt(e.target.value)}
        className="w-full px-2 py-1.5 bg-muted/50 border border-border/50 rounded-lg text-xs font-mono min-h-[70px] focus:outline-none focus:ring-2 focus:ring-primary/20"
        placeholder="prompt 内容"
      />
      <input
        value={editSchedule}
        onChange={(e) => setEditSchedule(e.target.value)}
        className="w-full px-2 py-1.5 bg-muted/50 border border-border/50 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/20"
        placeholder="e.g. every day at 9:00, every 30 minutes"
      />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-lg transition-colors">取消</button>
        <button onClick={handleSave} className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg transition-colors">保存</button>
      </div>
    </div>
  )
}

function TaskItem({
  task,
  selectedWorkDir,
  onToggle,
  onDelete,
  onUpdate,
  onRunNow,
  isSelected,
  onToggleSelect,
}: {
  task: ScheduledTask
  selectedWorkDir: string | null
  onToggle: () => void
  onDelete: () => void
  onUpdate: (updates: Partial<ScheduledTask>) => void
  onRunNow: () => void
  isSelected?: boolean
  onToggleSelect?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const workDirName = useMemo(
    () => selectedWorkDir ? (selectedWorkDir.split(/[\/\\]/).pop() || selectedWorkDir) : '',
    [selectedWorkDir]
  )

  if (editing) {
    return (
      <EditTaskForm
        task={task}
        onSave={onUpdate}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <div className={`group flex items-start gap-3 p-4 rounded-xl border transition-colors ${isSelected ? 'border-primary/50 bg-primary/5' : 'border-border/30 bg-card/40 hover:bg-card/70'}`}>
      {onToggleSelect && (
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          className="mt-1 shrink-0 size-3.5 rounded border-border/60 text-primary focus:ring-primary/20 cursor-pointer"
        />
      )}
      <button
        onClick={onToggle}
        className={cn(
          'mt-0.5 shrink-0 transition-colors',
          task.enabled ? 'text-emerald-500 hover:text-emerald-600' : 'text-foreground/30 hover:text-foreground/60'
        )}
        title={task.enabled ? '暂停' : '启用'}
      >
        <Circle className={cn('size-4', task.enabled && 'fill-current')} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground/90">{task.label}</span>
          <span className="text-xs text-muted-foreground">
            {workDirName ? `心跳 • ${workDirName}` : task.scheduleText}
          </span>
        </div>
        <p className="text-xs text-muted-foreground/70 mt-0.5 line-clamp-2">{task.prompt}</p>
        <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground/60">
          <span className="flex items-center gap-1">
            <Clock className="size-3" />
            {task.scheduleText}
          </span>
          <span>下次: {formatTime(task.nextRunAt)}</span>
          {task.lastRunAt && <span>上次: {formatTime(task.lastRunAt)}</span>}
          <span className={task.enabled ? 'text-emerald-500/80' : 'text-muted-foreground/50'}>
            {task.enabled ? '运行中' : '已暂停'}
          </span>
        </div>
      </div>
      <div className="relative shrink-0">
        <button
          onClick={() => setMenuOpen(v => !v)}
          className="p-1.5 text-muted-foreground/60 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
        >
          <MoreHorizontal className="size-4" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-0" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-full mt-1 w-36 bg-card border border-border/60 rounded-lg shadow-lg py-1 z-10">
              <button
                onClick={() => { setMenuOpen(false); onRunNow() }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-accent/60"
              >
                <RefreshCw className="size-3.5" />
                立即执行
              </button>
              <button
                onClick={() => { setMenuOpen(false); setEditing(true) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-accent/60"
              >
                <RefreshCw className="size-3.5" />
                编辑
              </button>
              <button
                onClick={() => { setMenuOpen(false); onDelete() }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 hover:bg-accent/60"
              >
                <Trash2 className="size-3.5" />
                删除
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const TEMPLATE_SUGGESTIONS = [
  { label: '每日代码总结', prompt: '总结一下今天的代码改动和项目进展', schedule: 'every day at 18:00' },
  { label: '定时提醒', prompt: '提醒我开始专注工作', schedule: 'every day at 9:00' },
  { label: '健康检查', prompt: '检查项目是否有异常、错误日志或未提交改动', schedule: 'every hour' },
]

export function ScheduledTasksPanel({ onClose }: ScheduledTasksPanelProps) {
  const {
    scheduledTasks,
    addScheduledTask,
    updateScheduledTask,
    removeScheduledTask,
    toggleScheduledTask,
    showToast,
    selectedWorkDir,
  } = useHelixStore()
  const [activeTab, setActiveTab] = useState<'tasks' | 'templates'>('tasks')
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isAdding, setIsAdding] = useState(false)

  // Pull scheduled tasks from Hermes backend on mount
  useEffect(() => {
    const load = async () => {
      try {
        const electron = (window as any).electron
        if (!electron?.scheduledTasks?.list) return
        const res = await electron.scheduledTasks.list()
        if (!res.ok || !Array.isArray(res.tasks)) return
        const backendTasks = res.tasks as ScheduledTask[]
        useHelixStore.setState((state) => {
          const existingIds = new Set(state.scheduledTasks.map(t => t.id))
          const merged = [...state.scheduledTasks]
          for (const task of backendTasks) {
            if (!existingIds.has(task.id)) {
              merged.push(task)
            } else {
              const idx = merged.findIndex(t => t.id === task.id)
              if (idx >= 0) merged[idx] = { ...merged[idx], ...task }
            }
          }
          return { scheduledTasks: merged }
        })
      } catch (e) {
        console.error('Failed to load backend scheduled tasks:', e)
      }
    }
    load()
  }, [])

  const handleAdd = useCallback(async (label: string, prompt: string, schedule: string) => {
    const parsed = parseSchedule(schedule)
    const cronExpression = parsed.kind === 'cron' ? parsed.expr : undefined
    const nextRunAt = parsed.kind === 'once' ? parsed.runAt : undefined
    let backendId: string | undefined
    let backendNextRun: number | null = parsed.nextRun
    try {
      const electron = (window as any).electron
      if (electron?.scheduledTasks?.create) {
        const res = await electron.scheduledTasks.create({
          name: label,
          prompt,
          scheduleText: schedule,
          cronExpression,
          nextRunAt,
        })
        if (res.ok && res.id) {
          backendId = res.id
          if (res.nextRunAt) backendNextRun = res.nextRunAt
        }
      }
    } catch (e) {
      console.error('Failed to create backend scheduled task:', e)
    }
    addScheduledTask({
      id: backendId,
      label,
      prompt,
      scheduleText: schedule,
      cronExpression,
      enabled: true,
      lastRunAt: null,
      nextRunAt: backendNextRun,
    })
    if (parsed.error) showToast({ type: 'warning', title: parsed.error })
    setIsAdding(false)
  }, [addScheduledTask, showToast])

  const handleRunNow = useCallback(async (task: ScheduledTask) => {
    try {
      const { addChatMessage, updateScheduledTask, showToast } = useHelixStore.getState()
      const { hermesSessionId } = useHermesStore.getState()
      addChatMessage({ role: 'system', content: `[定时任务] ${task.label}: ${task.prompt}` })
      if (hermesSessionId) {
        try {
          await window.electron.hermes.send('session/prompt', {
            session_id: hermesSessionId,
            prompt: [{ type: 'text', text: task.prompt }],
          })
        } catch (e) {
          console.error('[ScheduledTask] Failed to dispatch to Hermes:', e)
        }
      }
      updateScheduledTask(task.id, { lastRunAt: Date.now() })
      const parsed = parseSchedule(task.scheduleText)
      if (parsed.nextRun) updateScheduledTask(task.id, { nextRunAt: parsed.nextRun })
      showToast({ type: 'info', title: `定时任务 "${task.label}" 已触发` })
    } catch (e) {
      console.error('Failed to run scheduled task:', e)
    }
  }, [])

  // Sync toggle/delete to Hermes backend
  const handleToggle = useCallback(async (task: ScheduledTask) => {
    toggleScheduledTask(task.id)
    try {
      const electron = (window as any).electron
      if (electron?.scheduledTasks?.update) {
        await electron.scheduledTasks.update({ id: task.id, enabled: !task.enabled })
      }
    } catch (e) {
      console.error('Failed to sync toggle to backend:', e)
    }
  }, [toggleScheduledTask])

  const handleDelete = useCallback(async (task: ScheduledTask) => {
    removeScheduledTask(task.id)
    try {
      const electron = (window as any).electron
      if (electron?.scheduledTasks?.remove) {
        await electron.scheduledTasks.remove({ id: task.id })
      }
    } catch (e) {
      console.error('Failed to sync delete to backend:', e)
    }
  }, [removeScheduledTask])

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleDeleteSelected = useCallback(async () => {
    const electron = (window as any).electron
    for (const id of selectedIds) {
      removeScheduledTask(id)
      try {
        if (electron?.scheduledTasks?.remove) {
          await electron.scheduledTasks.remove({ id })
        }
      } catch (e) {
        console.error('Failed to sync delete to backend:', e)
      }
    }
    setSelectedIds(new Set())
  }, [selectedIds, removeScheduledTask])

  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return scheduledTasks
    return scheduledTasks.filter(t =>
      t.label.toLowerCase().includes(q) ||
      t.prompt.toLowerCase().includes(q) ||
      t.scheduleText.toLowerCase().includes(q)
    )
  }, [scheduledTasks, search])

  const enabledCount = useMemo(() => scheduledTasks.filter(t => t.enabled).length, [scheduledTasks])

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === filteredTasks.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredTasks.map(t => t.id)))
    }
  }, [selectedIds.size, filteredTasks, filteredTasks.length])

  const applyTemplate = (tpl: typeof TEMPLATE_SUGGESTIONS[0]) => {
    handleAdd(tpl.label, tpl.prompt, tpl.schedule)
    setActiveTab('tasks')
  }

  return (
    <div className="h-full w-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 shrink-0">
        <div className="flex items-center gap-1 bg-muted/60 rounded-full p-1">
          <button
            onClick={() => setActiveTab('tasks')}
            className={cn(
              'px-3.5 py-1 text-xs font-medium rounded-full transition-colors',
              activeTab === 'tasks' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            任务
          </button>
          <button
            onClick={() => setActiveTab('templates')}
            className={cn(
              'px-3.5 py-1 text-xs font-medium rounded-full transition-colors',
              activeTab === 'templates' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            模板
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => { setActiveTab('tasks'); setIsAdding(true) }}
            className="p-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
            title="添加"
          >
            <Plus className="size-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
            title="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="max-w-3xl mx-auto px-6 pt-2 pb-8">
          {activeTab === 'tasks' ? (
            <>
              {/* Search */}
              <div className="relative mb-6">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索计划任务"
                  className="w-full h-10 pl-10 pr-4 rounded-full border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all"
                />
              </div>

              {/* Current section */}
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <h2 className="text-sm font-semibold text-foreground">当前</h2>
                    {filteredTasks.length > 0 && (
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedIds.size === filteredTasks.length && filteredTasks.length > 0}
                          onChange={handleSelectAll}
                          className="size-3.5 rounded border-border/60 text-primary focus:ring-primary/20"
                        />
                        全选
                      </label>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedIds.size > 0 && (
                      <button
                        onClick={handleDeleteSelected}
                        className="flex items-center gap-1 text-xs text-red-500 hover:text-red-600 transition-colors"
                      >
                        <Trash2 className="size-3" />
                        删除 ({selectedIds.size})
                      </button>
                    )}
                    <span className="text-xs text-muted-foreground">{enabledCount} 运行中</span>
                  </div>
                </div>

                <div className="space-y-2">
                  {filteredTasks.length === 0 && !isAdding ? (
                    <div className="text-center py-14">
                      <Clock className="size-10 text-muted-foreground/20 mx-auto mb-3" />
                      <p className="text-sm text-muted-foreground">暂无定时任务</p>
                      <p className="text-xs text-muted-foreground/60 mt-1">添加定时任务，agent 将按时自动执行</p>
                    </div>
                  ) : (
                    <>
                      {filteredTasks.map(task => (
                        <TaskItem
                          key={task.id}
                          task={task}
                          selectedWorkDir={selectedWorkDir}
                          onToggle={() => handleToggle(task)}
                          onDelete={() => handleDelete(task)}
                          onUpdate={(updates) => updateScheduledTask(task.id, updates)}
                          onRunNow={() => handleRunNow(task)}
                          isSelected={selectedIds.has(task.id)}
                          onToggleSelect={() => handleToggleSelect(task.id)}
                        />
                      ))}
                      {isAdding && (
                        <AddTaskForm
                          onCancel={() => setIsAdding(false)}
                          onAdd={handleAdd}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div>
              <h2 className="text-sm font-semibold text-foreground mb-4">模板</h2>
              <div className="space-y-2">
                {TEMPLATE_SUGGESTIONS.map((tpl) => (
                  <button
                    key={tpl.label}
                    onClick={() => applyTemplate(tpl)}
                    className="w-full text-left p-4 rounded-xl border border-border/30 bg-card/40 hover:bg-card/70 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-foreground/90">{tpl.label}</span>
                      <Plus className="size-3.5 text-muted-foreground" />
                    </div>
                    <p className="text-xs text-muted-foreground/70 mt-1">{tpl.prompt}</p>
                    <p className="text-[10px] text-muted-foreground/50 mt-2">{tpl.schedule}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
