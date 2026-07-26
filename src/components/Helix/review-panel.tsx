'use client'

import React, { useState } from 'react'
import { X, GitPullRequest, Play, AlertCircle, CheckCircle2 } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'

// Dedicated Review panel. Triggers `/review` (handled by the agent) and streams
// the result into the main conversation. This panel is the launcher + guidance;
// review output appears in the chat transcript.
export function ReviewPanel({ onClose }: { onClose: () => void }) {
  const injectAndSend = useHelixStore((s) => s.injectAndSend)
  const isAgentRunning = useHelixStore((s) => s.isAgentRunning)
  const [target, setTarget] = useState('')

  const start = () => {
    const cmd = target.trim() ? `/review ${target.trim()}` : '/review'
    injectAndSend(cmd)
  }

  return (
    <div className="fixed inset-0 z-[9998] flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-sm h-full bg-card border-l border-border/60 shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <GitPullRequest className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">代码审查</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent/60">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <p className="text-xs text-muted-foreground/80 leading-relaxed">
            让 Agent 对当前未提交的改动运行代码审查，识别潜在 bug、安全问题与改进点。审查结果会输出到主对话。
          </p>
          <label className="block">
            <span className="text-xs text-muted-foreground">审查目标（可选）</span>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="例如 src/components 或 commit abc123"
              className="mt-1 w-full px-3 py-1.5 text-sm rounded-lg bg-muted/50 border border-border/50 outline-none focus:border-primary/50"
            />
          </label>
          <button
            onClick={start}
            disabled={isAgentRunning}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          >
            <Play className="size-4" /> {isAgentRunning ? '审查进行中…' : '开始审查'}
          </button>

          <div className="space-y-2 pt-2">
            <div className="flex items-start gap-2 text-xs text-muted-foreground/80">
              <CheckCircle2 className="size-3.5 mt-0.5 text-emerald-400 shrink-0" />
              <span>检查明显的逻辑错误与边界条件</span>
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground/80">
              <AlertCircle className="size-3.5 mt-0.5 text-amber-400 shrink-0" />
              <span>标注安全与性能风险</span>
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground/80">
              <CheckCircle2 className="size-3.5 mt-0.5 text-emerald-400 shrink-0" />
              <span>给出可执行的修改建议</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
