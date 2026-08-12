'use client'

import { AlertTriangle, Loader2 } from 'lucide-react'
import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import type { ApprovalLevel } from '@/hermes-ui/api-client'

export interface ApprovalRequest {
  id: string
  sessionId?: string
  toolName: string
  params: Record<string, unknown>
  command?: string
  allowPermanent?: boolean
  timestamp: number
}

function getApprovalTitle(toolName: string): string {
  switch (toolName) {
    case 'terminal':
    case 'run_bash':
    case 'execute_code':
      return '检测到工作空间外部文件修改'
    default:
      return '需要你的批准'
  }
}

interface ApprovalBarProps {
  request: ApprovalRequest
  onApprove: (level: ApprovalLevel) => void
}

/**
 * Inline approval card (light, non-blocking) — anchored to the bottom-center of
 * the panel via the parent <ApprovalDialog> absolute wrapper, so it is always
 * visible regardless of how long the message list is. No modal overlay, so the
 * user can still switch conversations while it is open.
 * Keyboard: ⌘/Ctrl+Enter = allow · Esc = deny · ↑/↓ = move selection · Enter = confirm.
 */
function ApprovalBar({ request, onApprove }: ApprovalBarProps) {
  const [submitting, setSubmitting] = useState<ApprovalLevel | null>(null)
  const [selected, setSelected] = useState<ApprovalLevel>('once')
  const command =
    request.command ||
    (typeof request.params.command === 'string' ? request.params.command : '')

  const handleApprove = useCallback(
    (level: ApprovalLevel) => {
      setSubmitting(level)
      onApprove(level)
    },
    [onApprove],
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        handleApprove('once')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        handleApprove('deny')
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((s) => (s === 'deny' ? 'session' : s === 'session' ? 'once' : 'once'))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((s) => (s === 'once' ? 'session' : s === 'session' ? 'deny' : 'deny'))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        handleApprove(selected)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleApprove, selected])

  const options: { key: string; level: ApprovalLevel; label: string }[] = [
    { key: '1', level: 'once', label: '允许' },
    { key: '2', level: 'session', label: '本次会话内始终允许该类命令' },
    { key: '3', level: 'deny', label: '拒绝' },
  ]

  return (
    <div className="w-full max-w-[700px] mx-auto bg-popover text-foreground border border-border rounded-2xl shadow-2xl p-6">
      <div className="flex items-start justify-between gap-3 mb-4">
        <h3 className="text-lg font-semibold leading-snug">
          {getApprovalTitle(request.toolName)}
        </h3>
        <span className="shrink-0 mt-0.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/25">
          等待确认
        </span>
      </div>
      {command && (
        <pre className="bg-muted rounded-xl p-4 text-[14px] text-foreground/80 font-mono whitespace-pre-wrap break-all mb-5 max-h-40 overflow-auto">
          {command}
        </pre>
      )}
      <div className="flex flex-col gap-3">
        {options.map((o) => {
          const isSel = selected === o.level
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => handleApprove(o.level)}
              onMouseEnter={() => setSelected(o.level)}
              disabled={submitting !== null}
              className={
                'flex items-center gap-3.5 px-4 py-3.5 rounded-xl border text-left transition-colors disabled:opacity-60 ' +
                (isSel
                  ? 'border-ring bg-accent ring-1 ring-ring'
                  : 'border-transparent hover:bg-accent/60')
              }
            >
              <span
                className={
                  'w-8 h-8 rounded-full flex items-center justify-center text-[14px] font-semibold shrink-0 ' +
                  (isSel ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')
                }
              >
                {o.key}
              </span>
              <span className="text-[15px]">{o.label}</span>
            </button>
          )
        })}
      </div>
      <div className="text-[12px] text-muted-foreground/60 text-center mt-5">
        内容由 AI 生成，请核实重要信息 · ↑↓ 选择 · ⌘/Ctrl+Enter 允许 · Esc 拒绝
      </div>
    </div>
  )
}

// Keep the old dialog for backwards compatibility — now renders the inline ApprovalBar
// as a bottom-anchored, non-blocking card (can switch conversations while open).
interface LegacyProps {
  request: ApprovalRequest
  pendingCount?: number
  onApprove: (id: string, cache?: boolean) => void
  onReject: (id: string, cache?: boolean) => void
  onApproveAll?: () => void
}
export function ApprovalDialog(props: LegacyProps) {
  const { request, onApprove, onReject } = props
  const handleApprove = useCallback(
    (level: ApprovalLevel) => {
      if (!request) return
      if (level === 'deny') {
        onReject(request.id, false)
      } else {
        onApprove(request.id, level === 'always')
      }
    },
    [request, onApprove, onReject],
  )
  if (!request) return null
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 w-full px-5 pointer-events-none">
      <div className="pointer-events-auto mx-auto max-w-[700px]">
        <ApprovalBar request={request} onApprove={handleApprove} />
      </div>
    </div>
  )
}

// ── Clarify 反问浮条 ─────────────────────────────────────────────────────
// 模型调用 clarify 工具反问你（给几个选项让你挑，或自由输入）。样式/位置与
// ApprovalDialog 的底部浮条一致。点选项或提交输入后 onRespond(requestId, answer)。

export interface ClarifyRequest {
  id: string
  question: string
  choices: string[] | null
}

interface ClarifyBarProps {
  request: ClarifyRequest
  onRespond: (requestId: string, answer: string) => void
}

export function ClarifyBar({ request, onRespond }: ClarifyBarProps) {
  const [freeText, setFreeText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const choices = request.choices || []
  const [selectedIdx, setSelectedIdx] = useState<number | null>(choices.length > 0 ? 0 : null)

  const submit = useCallback(
    (answer: string) => {
      const a = answer.trim()
      if (!a || submitting) return
      setSubmitting(true)
      onRespond(request.id, a)
    },
    [request.id, onRespond, submitting],
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx((i) => {
          if (choices.length === 0) return null
          if (i === null) return 0
          return i > 0 ? i - 1 : 0
        })
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx((i) => {
          if (choices.length === 0) return null
          if (i === null) return choices.length - 1
          return i < choices.length - 1 ? i + 1 : choices.length - 1
        })
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        if (freeText.trim()) {
          submit(freeText)
        } else if (selectedIdx !== null && choices[selectedIdx]) {
          submit(choices[selectedIdx])
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [choices, freeText, selectedIdx, submit])

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 w-full px-5 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-[700px] mx-auto bg-popover text-foreground border border-border rounded-2xl shadow-2xl p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <h3 className="text-lg font-semibold leading-snug">需要你的确认</h3>
          <span className="shrink-0 mt-0.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/25">
            等待确认
          </span>
        </div>

        <div className="bg-muted rounded-xl p-4 text-[14px] text-foreground/80 leading-relaxed whitespace-pre-wrap break-words mb-5 max-h-40 overflow-auto">
          {request.question || '模型需要你的选择'}
        </div>

        {choices.length > 0 && (
          <div className="flex flex-col gap-3 mb-5">
            {choices.map((c, idx) => {
              const isSel = selectedIdx === idx
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => submit(c)}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  disabled={submitting}
                  className={
                    'flex items-center gap-3.5 px-4 py-3.5 rounded-xl border text-left transition-colors disabled:opacity-60 ' +
                    (isSel
                      ? 'border-ring bg-accent ring-1 ring-ring'
                      : 'border-transparent hover:bg-accent/60')
                  }
                >
                  <span
                    className={
                      'w-8 h-8 rounded-full flex items-center justify-center text-[14px] font-semibold shrink-0 ' +
                      (isSel ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')
                    }
                  >
                    {idx + 1}
                  </span>
                  <span className="text-[15px]">{c}</span>
                </button>
              )
            })}
          </div>
        )}

        <div className="flex items-center gap-2.5">
          <input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            disabled={submitting}
            placeholder={choices.length ? '或输入其他回答…' : '输入回答…'}
            className="flex-1 h-11 px-4 rounded-xl bg-background/60 border border-border/50 text-[15px] text-foreground outline-none focus:border-ring disabled:opacity-50"
          />
          <Button
            size="sm"
            disabled={submitting || !freeText.trim()}
            onClick={() => submit(freeText)}
            className="h-11 px-5 text-[15px]"
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : '回复'}
          </Button>
        </div>

        <div className="text-[12px] text-muted-foreground/60 text-center mt-5">
          内容由 AI 生成，请核实重要信息 · ↑↓ 选择 · Enter 确认 · 也可自由输入
        </div>
      </div>
    </div>
  )
}
