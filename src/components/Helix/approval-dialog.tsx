'use client'

import React, { useState } from 'react'
import {
  ShieldCheck,
  FileEdit,
  Terminal,
  FolderOpen,
  Check,
  X,
  Layers,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface ApprovalRequest {
  id: string
  toolName: string
  params: Record<string, unknown>
  timestamp: number
}

function getToolIcon(toolName: string) {
  switch (toolName) {
    case 'write_file':
    case 'patch':
      return <FileEdit className="size-3.5 text-sky-500" />
    case 'run_bash':
      return <Terminal className="size-3.5 text-rose-500" />
    default:
      return <FolderOpen className="size-3.5 text-muted-foreground" />
  }
}

function getToolLabel(toolName: string) {
  switch (toolName) {
    case 'write_file':
      return '写入文件'
    case 'patch':
      return '编辑文件'
    case 'run_bash':
      return '执行命令'
    default:
      return toolName
  }
}

function computeStats(toolName: string, params: Record<string, unknown>) {
  if (toolName === 'patch') {
    const oldStr = String(params.old_string ?? params.old_text ?? '')
    const newStr = String(params.new_string ?? params.new_text ?? '')
    const oldLines = oldStr.split('\n').length
    const newLines = newStr.split('\n').length
    const added = Math.max(0, newLines - oldLines)
    const removed = Math.max(0, oldLines - newLines)
    return { added, removed, total: newLines }
  }
  if (toolName === 'write_file') {
    const content = (params.content as string) || ''
    return { total: content.split('\n').length }
  }
  return {}
}

interface ApprovalDialogProps {
  request: ApprovalRequest
  pendingCount?: number
  onApprove: (id: string, cacheDecision?: boolean) => void
  onReject: (id: string, cacheDecision?: boolean) => void
  onApproveAll?: () => void
}

export function ApprovalDialog({ request, pendingCount = 1, onApprove, onReject, onApproveAll }: ApprovalDialogProps) {
  const [cacheDecision, setCacheDecision] = useState(false)
  const stats = computeStats(request.toolName, request.params)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border/60 bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-start gap-2.5 px-5 pt-4">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-foreground">操作确认</h3>
              {pendingCount > 1 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  <Layers className="size-3" />
                  待审批 {pendingCount}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="px-5 py-4">
          {/* Tool chip + change stats */}
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-0.5 text-xs font-medium text-foreground">
              {getToolIcon(request.toolName)}
              {getToolLabel(request.toolName)}
            </div>
            {'added' in stats && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="text-emerald-500">+{stats.added}</span>
                <span className="text-red-500">-{stats.removed}</span>
                <span>共 {stats.total} 行</span>
              </div>
            )}
            {'total' in stats && !('added' in stats) && (
              <span className="text-[11px] text-muted-foreground">共 {stats.total} 行</span>
            )}
          </div>

          {/* Parameters */}
          <div className="space-y-3">
            {request.toolName === 'write_file' && (
              <>
                <div>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">文件路径</span>
                  <p className="mt-0.5 break-all font-mono text-xs text-foreground">{request.params.path as string}</p>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">内容预览</span>
                  <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-muted/30 p-2.5 font-mono text-[11px] text-foreground/80">
                    {(request.params.content as string)?.slice(0, 500) || '(empty)'}
                    {(request.params.content as string)?.length > 500 && '\n... (truncated)'}
                  </pre>
                </div>
              </>
            )}
            {request.toolName === 'patch' && (
              <>
                <div>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">文件路径</span>
                  <p className="mt-0.5 break-all font-mono text-xs text-foreground">{request.params.path as string}</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-[10px] uppercase tracking-wide text-red-400/80">查找</span>
                    <pre className="mt-1 max-h-24 overflow-auto rounded-lg bg-red-500/5 p-2 font-mono text-[10px] text-red-500/90">
                      {request.params.old_string as string}
                    </pre>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase tracking-wide text-emerald-400/80">替换为</span>
                    <pre className="mt-1 max-h-24 overflow-auto rounded-lg bg-emerald-500/5 p-2 font-mono text-[10px] text-emerald-500/90">
                      {request.params.new_string as string}
                    </pre>
                  </div>
                </div>
              </>
            )}
            {request.toolName === 'run_bash' && (
              <div>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">命令</span>
                <pre className="mt-1 max-h-32 overflow-auto rounded-lg border-l-2 border-rose-500/60 bg-muted/40 p-2.5 font-mono text-[11px] text-foreground/90">
                  {request.params.command as string}
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 pb-5 pt-1">
          <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={cacheDecision}
              onChange={(e) => setCacheDecision(e.target.checked)}
              className="size-3 accent-primary"
            />
            不再询问此操作
          </label>
          <div className="flex items-center gap-1">
            {pendingCount > 1 && onApproveAll && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onApproveAll}
                className="gap-1.5"
              >
                <Layers className="size-3.5" />
                批准全部 ({pendingCount})
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReject(request.id, cacheDecision)}
              className="gap-1.5"
            >
              <X className="size-3.5" />
              拒绝
            </Button>
            <Button
              size="sm"
              onClick={() => onApprove(request.id, cacheDecision)}
              className="gap-1.5"
            >
              <Check className="size-3.5" />
              执行
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
