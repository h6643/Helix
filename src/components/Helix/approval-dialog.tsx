'use client'

import {
  Terminal,
  FolderOpen,
  Play,
  Shield,
  Clock,
  Ban,
  ChevronDown,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import React, { useState, useEffect, useCallback, useRef } from 'react'
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

function getToolIcon(toolName: string) {
  switch (toolName) {
    case 'terminal':
    case 'execute_code':
    case 'run_bash':
      return <Terminal className="size-3.5 text-rose-500" />
    default:
      return <FolderOpen className="size-3.5 text-muted-foreground" />
  }
}

function getToolLabel(toolName: string) {
  switch (toolName) {
    case 'terminal':
    case 'run_bash':
      return '执行命令'
    case 'execute_code':
      return '执行代码'
    default:
      return toolName
  }
}

interface ApprovalBarProps {
  request: ApprovalRequest
  onApprove: (level: ApprovalLevel) => void
}

/**
 * Inline approval bar (Hermes Desktop style) — renders inside the tool row,
 * non-blocking. Supports keyboard shortcuts: ⌘/Ctrl+Enter = approve, Escape = deny.
 */
function ApprovalBar({ request, onApprove }: ApprovalBarProps) {
  const [submitting, setSubmitting] = useState<ApprovalLevel | null>(null)
  const [showDropdown, setShowDropdown] = useState(false)
  const [showAlwaysConfirm, setShowAlwaysConfirm] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const command = request.command || (typeof request.params.command === 'string' ? request.params.command : '')
  const allowPermanent = request.allowPermanent !== false

  const handleApprove = useCallback((level: ApprovalLevel) => {
    setSubmitting(level)
    onApprove(level)
  }, [onApprove])

  // Keyboard shortcuts — stopPropagation to prevent multi-instance conflicts
  useEffect(() => {
    if (showAlwaysConfirm || showDropdown) return
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
  }, [showAlwaysConfirm, showDropdown, handleApprove])

  // Click-outside to close dropdown
  useEffect(() => {
    if (!showDropdown) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDropdown])

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs">
      {getToolIcon(request.toolName)}
      <span className="font-medium text-foreground/80">{getToolLabel(request.toolName)}</span>
      {command && (
        <code className="text-[11px] text-foreground/60 font-mono max-h-20 overflow-y-auto whitespace-pre-wrap break-all flex-1 min-w-0">
          {command}
        </code>
      )}
      <div className="flex items-center gap-1 ml-auto">
        {/* Primary: Run button with keyboard hint */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleApprove('once')}
          disabled={submitting !== null}
          className="h-6 px-2 text-[11px] gap-1"
        >
          {submitting === 'once' ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Play className="size-3" />
          )}
          运行
          <kbd className="ml-0.5 text-[9px] text-muted-foreground font-mono">⌘⏎</kbd>
        </Button>

        {/* Dropdown for session/always */}
        <div className="relative" ref={dropdownRef}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDropdown(!showDropdown)}
            disabled={submitting !== null}
            className="h-6 px-1.5 text-[11px] gap-0.5"
          >
            <ChevronDown className="size-3" />
          </Button>
          {showDropdown && (
            <div className="absolute top-full right-0 mt-1 w-44 bg-card border border-border/60 rounded-lg shadow-lg z-50 py-1">
              <button
                onClick={() => { setShowDropdown(false); handleApprove('session') }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-foreground hover:bg-muted/60 transition-colors"
              >
                <Clock className="size-3" />
                本次会话允许
              </button>
              {allowPermanent && (
                <button
                  onClick={() => { setShowDropdown(false); setShowAlwaysConfirm(true) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-foreground hover:bg-muted/60 transition-colors"
                >
                  <Shield className="size-3" />
                  始终允许
                </button>
              )}
            </div>
          )}
        </div>

        {/* Reject button — standalone */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleApprove('deny')}
          disabled={submitting !== null}
          className="h-6 px-2 text-[11px] gap-1 text-red-500 hover:text-red-600"
        >
          {submitting === 'deny' ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Ban className="size-3" />
          )}
          拒绝
          <kbd className="ml-0.5 text-[9px] text-muted-foreground font-mono">Esc</kbd>
        </Button>
      </div>

      {/* Always-allow confirmation dialog */}
      {showAlwaysConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onClick={() => setShowAlwaysConfirm(false)}>
          <div className="bg-card border border-border/60 rounded-xl shadow-2xl p-5 w-80 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-amber-500">
              <AlertTriangle className="size-5" />
              <span className="text-sm font-semibold">确认始终允许</span>
            </div>
            <p className="text-xs text-muted-foreground">
              此操作将允许 <strong>{getToolLabel(request.toolName)}</strong> 在所有会话中自动执行，无需再次确认。
            </p>
            {command && (
              <pre className="text-[11px] text-foreground/60 bg-muted/30 rounded p-2 max-h-24 overflow-auto font-mono whitespace-pre-wrap break-all">
                {command}
              </pre>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowAlwaysConfirm(false)} className="h-7 text-[11px]">
                取消
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => { setShowAlwaysConfirm(false); handleApprove('always') }}
                className="h-7 text-[11px]"
              >
                确认始终允许
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Keep the old dialog for backwards compatibility — now renders the inline ApprovalBar
interface LegacyProps {
  request: ApprovalRequest
  pendingCount?: number
  onApprove: (id: string, cache?: boolean) => void
  onReject: (id: string, cache?: boolean) => void
  onApproveAll?: () => void
}
export function ApprovalDialog(props: LegacyProps) {
  const { request, pendingCount, onApprove, onReject, onApproveAll } = props
  const handleApprove = useCallback((level: ApprovalLevel) => {
    if (!request) return
    if (level === 'deny') {
      onReject(request.id, false)
    } else {
      onApprove(request.id, level === 'always')
    }
  }, [request, onApprove, onReject])
  if (!request) return null
  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-2">
      <div className="flex items-center gap-2">
        <ApprovalBar request={request} onApprove={handleApprove} />
        {pendingCount && pendingCount > 1 && (
          <span className="text-[10px] text-muted-foreground/50 font-mono">
            +{pendingCount - 1}
          </span>
        )}
        {onApproveAll && pendingCount && pendingCount > 1 && (
          <button
            onClick={onApproveAll}
            className="text-[11px] text-primary/70 hover:text-primary transition-colors px-2 py-1"
          >
            全部允许
          </button>
        )}
      </div>
    </div>
  )
}

