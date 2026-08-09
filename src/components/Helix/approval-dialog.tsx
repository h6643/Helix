'use client'

import { AlertTriangle, Loader2, Play } from 'lucide-react'
import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import type { ApprovalLevel } from '@/hermes-ui/api-client'

export interface ApprovalRequest {
  id: string
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
 * Inline approval card (light, non-blocking) — rendered at the bottom of the
 * panel where the chat input normally sits. No modal overlay, so the user can
 * still switch conversations while it is open.
 * Keyboard: ⌘/Ctrl+Enter = allow, Escape = deny.
 */
function ApprovalBar({ request, onApprove }: ApprovalBarProps) {
  const [submitting, setSubmitting] = useState<ApprovalLevel | null>(null)
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
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleApprove])

  const options: { key: string; level: ApprovalLevel; label: string }[] = [
    { key: '1', level: 'once', label: '允许' },
    { key: '2', level: 'session', label: '本次会话内始终允许该类命令' },
    { key: '3', level: 'deny', label: '拒绝' },
  ]

  return (
    <div className="w-full max-w-[460px] mx-auto bg-popover text-foreground border border-border rounded-2xl shadow-2xl p-5">
      <h3 className="text-[15px] font-semibold leading-snug mb-3">
        {getApprovalTitle(request.toolName)}
      </h3>
      {command && (
        <pre className="bg-muted rounded-xl p-3 text-[12px] text-foreground/80 font-mono whitespace-pre-wrap break-all mb-4 max-h-32 overflow-auto">
          {command}
        </pre>
      )}
      <div className="flex flex-col gap-2">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => handleApprove(o.level)}
            disabled={submitting !== null}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-transparent hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors text-left disabled:opacity-60"
          >
            <span className="w-6 h-6 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-[12px] font-semibold shrink-0">
              {o.key}
            </span>
            <span className="text-[13.5px]">{o.label}</span>
          </button>
        ))}
      </div>
      <div className="text-[11px] text-muted-foreground/60 text-center mt-4">
        内容由 AI 生成，请核实重要信息
      </div>
    </div>
  )
}

// Keep the old dialog for backwards compatibility — now renders the inline ApprovalBar
// without a full-screen modal (non-blocking, can switch conversations while open).
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
    <div className="flex justify-center px-5 pb-4">
      <ApprovalBar request={request} onApprove={handleApprove} />
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

  const submit = useCallback(
    (answer: string) => {
      const a = answer.trim()
      if (!a || submitting) return
      setSubmitting(true)
      onRespond(request.id, a)
    },
    [request.id, onRespond, submitting],
  )

  // Enter 提交自由输入
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(freeText)
    }
  }

  return (
    <div className="absolute bottom-36 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-2 w-[min(32rem,92vw)]">
      <div className="flex flex-col gap-2.5 px-3.5 py-3 rounded-xl bg-popover border border-border/60 text-xs shadow-2xl">
        {/* 问题 */}
        <div className="flex items-start gap-2">
          <AlertTriangle className="size-3.5 text-sky-500 mt-0.5 shrink-0" />
          <span className="text-foreground/90 whitespace-pre-wrap break-words leading-relaxed">
            {request.question || '模型需要你的选择'}
          </span>
        </div>
        {/* 选项按钮 */}
        {request.choices && request.choices.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {request.choices.map((c) => (
              <Button
                key={c}
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => submit(c)}
                className="h-6 px-2.5 text-[11px] border-border/60 hover:bg-accent/60"
              >
                {submitting ? <Loader2 className="size-3 animate-spin" /> : null}
                {c}
              </Button>
            ))}
          </div>
        )}
        {/* 自由输入 */}
        <div className="flex items-center gap-1.5">
          <input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={submitting}
            placeholder={request.choices?.length ? '或输入其他回答…' : '输入回答…'}
            className="flex-1 h-7 px-2 rounded-md bg-background/60 border border-border/50 text-[12px] text-foreground outline-none focus:border-sky-500/50 disabled:opacity-50"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={submitting || !freeText.trim()}
            onClick={() => submit(freeText)}
            className="h-7 px-2.5 text-[11px] gap-1"
          >
            {submitting ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
            回复
          </Button>
        </div>
      </div>
    </div>
  )
}
