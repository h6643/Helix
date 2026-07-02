'use client'

import React, { useState } from 'react'
import {
  CheckCircle2,
  Circle,
  Clock,
  AlertTriangle,
  Plus,
  Trash2,
  ChevronRight,
  ChevronDown,
  Target,
  X,
} from 'lucide-react'
import { useHelixStore, type TaskNode } from '@/stores/helix-store'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

const STATUS_CONFIG = {
  pending: { icon: Circle, color: 'text-gray-400', label: '待办' },
  in_progress: { icon: Clock, color: 'text-blue-400', label: '进行中' },
  done: { icon: CheckCircle2, color: 'text-emerald-400', label: '已完成' },
  blocked: { icon: AlertTriangle, color: 'text-amber-400', label: '阻塞' },
}

function TaskItem({ task, depth = 0 }: { task: TaskNode; depth?: number }) {
  const { updateTask, removeTask, addTask, tasks } = useHelixStore()
  const [expanded, setExpanded] = useState(true)
  const [isAdding, setIsAdding] = useState(false)
  const [newSubTask, setNewSubTask] = useState('')
  const cfg = STATUS_CONFIG[task.status]
  const StatusIcon = cfg.icon

  const nextStatus: Record<TaskNode['status'], TaskNode['status']> = {
    pending: 'in_progress',
    in_progress: 'done',
    done: 'pending',
    blocked: 'pending',
  }

  const handleAddSubtask = () => {
    if (newSubTask.trim()) {
      addTask(newSubTask.trim(), task.id)
      setNewSubTask('')
      setIsAdding(false)
    }
  }

  return (
    <div>
      <div
        className="group flex items-center gap-1.5 px-2 py-1 hover:bg-accent/30 rounded text-xs cursor-pointer transition-colors"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {task.children && task.children.length > 0 && (
          <button onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }} className="shrink-0">
            {expanded ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
          </button>
        )}
        {!task.children?.length && <span className="w-3 shrink-0" />}

        <button
          onClick={() => updateTask(task.id, { status: nextStatus[task.status] })}
          className="shrink-0 hover:scale-110 transition-transform"
          title={`标记为 ${STATUS_CONFIG[nextStatus[task.status]].label}`}
        >
          <StatusIcon className={`size-3.5 ${cfg.color}`} />
        </button>

        <span className={`flex-1 truncate ${task.status === 'done' ? 'line-through text-muted-foreground' : ''}`}>
          {task.label}
        </span>

        <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); setIsAdding(true) }}
            className="p-0.5 hover:bg-accent rounded"
            title="添加子任务"
          >
            <Plus className="size-3" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); removeTask(task.id) }}
            className="p-0.5 hover:bg-destructive/20 rounded"
            title="删除"
          >
            <Trash2 className="size-3 text-destructive/60" />
          </button>
        </span>
      </div>

      {isAdding && (
        <div className="flex items-center gap-1.5 px-2 py-1" style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
          <input
            value={newSubTask}
            onChange={(e) => setNewSubTask(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddSubtask(); if (e.key === 'Escape') setIsAdding(false) }}
            placeholder="子任务名称..."
            className="flex-1 bg-background border border-input rounded px-2 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
            autoFocus
          />
          <button onClick={handleAddSubtask}><CheckCircle2 className="size-3 text-emerald-400" /></button>
          <button onClick={() => setIsAdding(false)}><X className="size-3 text-muted-foreground" /></button>
        </div>
      )}

      {expanded && task.children && task.children.length > 0 && (
        <div>
          {task.children.map(child => (
            <TaskItem key={child.id} task={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export function TaskPanel() {
  const { tasks, addTask, clearCompletedTasks, goal, setGoal, saveCheckpoint, showToast } = useHelixStore()
  const [isAdding, setIsAdding] = useState(false)
  const [newTask, setNewTask] = useState('')
  const [showGoalInput, setShowGoalInput] = useState(false)
  const [goalInput, setGoalInput] = useState('')

  const doneCount = tasks.filter(t => t.status === 'done').length
  const totalCount = tasks.length
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0

  const handleAddTask = () => {
    if (newTask.trim()) {
      addTask(newTask.trim())
      setNewTask('')
      setIsAdding(false)
    }
  }

  const handleSetGoal = () => {
    if (goalInput.trim()) {
      setGoal(goalInput.trim())
      setShowGoalInput(false)
      setGoalInput('')
      showToast({ type: 'info', title: '目标已设置', description: goalInput.trim() })
    }
  }

  return (
    <div className="h-full flex flex-col bg-card">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Target className="size-3.5 text-amber-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            任务追踪
          </span>
          {totalCount > 0 && (
            <span className="text-[10px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-full">
              {doneCount}/{totalCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="size-6" onClick={() => saveCheckpoint()} title="保存检查点">
            <ChevronDown className="size-3" />
          </Button>
          {doneCount > 0 && (
            <Button variant="ghost" size="icon" className="size-6" onClick={clearCompletedTasks} title="清除已完成">
              <Trash2 className="size-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {totalCount > 0 && (
        <div className="px-3 py-2 border-b border-border/50">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-muted-foreground">进度</span>
            <span className="text-[10px] font-medium text-emerald-400">{progress}%</span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Goal */}
      <div className="px-3 py-2 border-b border-border/50">
        {goal ? (
          <div className="flex items-start gap-2">
            <Target className="size-3.5 text-amber-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-muted-foreground mb-0.5">目标</p>
              <p className="text-xs text-amber-300">{goal}</p>
            </div>
            <button onClick={() => setGoal(null)} className="p-0.5 hover:bg-accent rounded shrink-0">
              <X className="size-3 text-muted-foreground" />
            </button>
          </div>
        ) : showGoalInput ? (
          <div className="flex items-center gap-1.5">
            <Target className="size-3 text-amber-400 shrink-0" />
            <input
              value={goalInput}
              onChange={(e) => setGoalInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSetGoal(); if (e.key === 'Escape') setShowGoalInput(false) }}
              placeholder="输入目标条件..."
              className="flex-1 bg-background border border-input rounded px-2 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
              autoFocus
            />
            <button onClick={handleSetGoal}><CheckCircle2 className="size-3 text-emerald-400" /></button>
          </div>
        ) : (
          <button
            onClick={() => setShowGoalInput(true)}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-amber-400 transition-colors"
          >
            <Target className="size-3" />
            设置目标条件...
          </button>
        )}
      </div>

      {/* Task list */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {tasks.map(task => (
            <TaskItem key={task.id} task={task} />
          ))}

          {isAdding ? (
            <div className="flex items-center gap-1.5 px-3 py-1">
              <input
                value={newTask}
                onChange={(e) => setNewTask(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddTask(); if (e.key === 'Escape') setIsAdding(false) }}
                placeholder="任务名称..."
                className="flex-1 bg-background border border-input rounded px-2 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                autoFocus
              />
              <button onClick={handleAddTask}><CheckCircle2 className="size-3 text-emerald-400" /></button>
              <button onClick={() => setIsAdding(false)}><X className="size-3 text-muted-foreground" /></button>
            </div>
          ) : (
            <button
              onClick={() => setIsAdding(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="size-3" />
              添加任务
            </button>
          )}

          {tasks.length === 0 && !isAdding && (
            <div className="px-4 py-6 text-center">
              <Target className="size-6 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">暂无任务</p>
              <p className="text-[10px] text-muted-foreground/60 mt-1">点击上方添加任务，或使用 /task 命令</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}