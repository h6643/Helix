'use client'

import React, { useState } from 'react'
import { Clock, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DetectedTask } from '@/lib/schedule-utils'

interface Props {
  tasks: DetectedTask[]
  onConfirm: (tasks: DetectedTask[]) => void
  onDismiss: () => void
}

/**
 * Modal shown when the AI's reply contains scheduled-task declarations. We do NOT
 * auto-create them — the user must confirm (and can uncheck individual tasks).
 * Mirrors the approval-dialog style (fixed overlay + centered card).
 */
export function ScheduledTaskConfirm({ tasks, onConfirm, onDismiss }: Props) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(tasks.map((_, i) => i)))

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const chosen = tasks.filter((_, i) => selected.has(i))
  const allSelected = chosen.length === tasks.length

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px] animate-in fade-in"
      onClick={onDismiss}
    >
      <div
        className="w-[440px] max-w-[92vw] max-h-[80vh] overflow-hidden rounded-2xl border border-border/50 bg-popover shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40">
          <Clock className="size-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">
            AI 想要创建 {tasks.length} 个定时任务
          </span>
          <button
            onClick={onDismiss}
            className="ml-auto p-1 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="忽略"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
          {tasks.map((t, i) => (
            <button
              key={i}
              onClick={() => toggle(i)}
              className={`flex items-start gap-2.5 text-left w-full rounded-lg border px-3 py-2.5 transition-colors ${
                selected.has(i)
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border/40 bg-muted/20 opacity-60'
              }`}
            >
              <span
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
                  selected.has(i) ? 'bg-primary border-primary text-primary-foreground' : 'border-border'
                }`}
              >
                {selected.has(i) && <Check className="size-3" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground truncate">{t.label}</span>
                <span className="block text-xs text-muted-foreground truncate">{t.scheduleText}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border/40">
          <span className="text-xs text-muted-foreground">
            已选 {chosen.length} / {tasks.length}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              忽略
            </Button>
            <Button size="sm" disabled={chosen.length === 0} onClick={() => onConfirm(chosen)}>
              {allSelected ? `创建 ${chosen.length} 个` : `创建选中 (${chosen.length})`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
