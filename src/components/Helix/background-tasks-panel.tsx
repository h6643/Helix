'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, X, XCircle, CheckCircle2, Trash2, Terminal } from 'lucide-react'
import { useBackgroundTasksStore } from '@/stores/background-tasks-store'

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r > 0 ? `${m} 分 ${r} 秒` : `${m} 分`
}

/** 后台任务面板：顶栏「后台任务」按钮的弹出卡片。只显示当前会话的任务，
 *  每项 = 命令名 + 状态 + 执行时间（不做流式输出）。 */
export function BackgroundTasksPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const tasks = useBackgroundTasksStore(s => s.tasks)
  const clearFinished = useBackgroundTasksStore(s => s.clearFinished)
  const removeTask = useBackgroundTasksStore(s => s.removeTask)
  const ref = useRef<HTMLDivElement>(null)

  // 每秒 tick 刷新运行中任务的耗时显示
  const [, setNow] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // 点击外部关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const myTasks = useMemo(() => tasks.filter(t => t.sessionId === sessionId), [tasks, sessionId])
  const running = myTasks.filter(t => t.status === 'running')
  const done = myTasks.filter(t => t.status !== 'running')

  return (
    <div
      ref={ref}
      className="absolute right-0 top-[calc(100%+6px)] z-50 w-[26rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover text-popover-foreground shadow-xl flex flex-col max-h-[50vh]"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-semibold">
          后台任务
          {running.length > 0 && (
            <span className="ml-1.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-primary font-normal">
              {running.length} 运行中
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          {done.length > 0 && (
            <button
              onClick={clearFinished}
              className="px-1.5 py-0.5 rounded text-[calc(var(--helix-transcript-size)*0.7143)] text-foreground/50 hover:text-foreground hover:bg-muted/40 transition-colors"
              data-tip="清除已完成"
            >
              清除完成
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded text-foreground/50 hover:text-foreground hover:bg-muted/40 transition-colors"
            data-tip="关闭"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {myTasks.length === 0 && (
          <div className="px-3 py-6 text-center text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/40">
            当前对话没有后台任务。
          </div>
        )}
        {myTasks.map((task) => {
          const runningTask = task.status === 'running'
          const durationMs = (task.finishedAt ?? Date.now()) - task.startedAt
          return (
            <div
              key={task.id}
              className="flex items-center gap-2 px-3 py-2 border-b border-border/30 last:border-b-0"
            >
              {runningTask ? (
                <Loader2 className="size-3.5 text-primary shrink-0 animate-spin" />
              ) : task.status === 'failed' ? (
                <XCircle className="size-3.5 text-red-500 shrink-0" />
              ) : (
                <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
              )}
              <Terminal className="size-3.5 text-foreground/30 shrink-0" />
              <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.7857)] font-mono text-foreground/80">
                {task.command}
              </span>
              <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground shrink-0">
                {runningTask ? `运行中 ${formatDuration(durationMs)}` : `耗时 ${formatDuration(durationMs)}`}
              </span>
              {!runningTask && (
                <button
                  onClick={() => removeTask(task.id)}
                  className="p-0.5 rounded text-foreground/30 hover:text-foreground hover:bg-muted/40 transition-colors shrink-0"
                  data-tip="移除"
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
