'use client'

import React, { useState } from 'react'
import {
  AlertTriangle,
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
    case 'edit_file':
      return <FileEdit className="size-4 text-amber-400" />
    case 'run_bash':
      return <Terminal className="size-4 text-red-400" />
    default:
      return <FolderOpen className="size-4 text-muted-foreground" />
  }
}

function getToolLabel(toolName: string) {
  switch (toolName) {
    case 'write_file':
      return '写入文件'
    case 'edit_file':
      return '编辑文件'
    case 'run_bash':
      return '执行命令'
    default:
      return toolName
  }
}

function computeStats(toolName: string, params: Record<string, unknown>) {
  if (toolName === 'edit_file') {
    const oldStr = (params.old_string as string) || ''
    const newStr = (params.new_string as string) || ''
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] pb-8 bg-black/40">
      <div className="w-full max-w-md bg-card border border-border/60 rounded-2xl shadow-2xl overflow-hidden max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border/60 bg-amber-500/5 shrink-0">
          <div className="w-8 h-8 rounded-xl bg-amber-500/10 flex items-center justify-center">
            <AlertTriangle className="size-4 text-amber-500" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              操作确认
              {pendingCount > 1 && (
                <span className="text-[10px] font-normal text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded flex items-center gap-1">
                  <Layers className="size-3" />
                  待审批操作: {pendingCount}
                </span>
              )}
            </h3>
            <p className="text-[11px] text-muted-foreground">Agent 请求执行以下操作</p>
          </div>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <div className="flex items-center gap-2 px-3 py-2 bg-card/50 shadow-sm rounded-lg">
            {getToolIcon(request.toolName)}
            <span className="text-xs font-medium text-foreground">
              {getToolLabel(request.toolName)}
            </span>
          </div>

          {/* Change stats */}
          {'added' in stats && (
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="text-emerald-500">+{stats.added} 行</span>
              <span className="text-red-500">-{stats.removed} 行</span>
              <span>共 {stats.total} 行</span>
            </div>
          )}
          {'total' in stats && !('added' in stats) && (
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span>共 {stats.total} 行</span>
            </div>
          )}

          {/* Parameters */}
          <div className="space-y-2">
            {request.toolName === 'write_file' && (
              <>
                <div>
                  <span className="text-[10px] text-muted-foreground/60 uppercase">文件路径</span>
                  <p className="text-xs text-foreground font-mono mt-0.5">{request.params.path as string}</p>
                </div>
                <div>
                  <span className="text-[10px] text-muted-foreground/60 uppercase">内容预览</span>
                  <pre className="text-[11px] text-foreground/80 bg-muted/30 border border-border/30 rounded p-2 mt-0.5 max-h-32 overflow-auto font-mono">
                    {(request.params.content as string)?.slice(0, 500) || '(empty)'}
                    {(request.params.content as string)?.length > 500 && '\n... (truncated)'}
                  </pre>
                </div>
              </>
            )}
            {request.toolName === 'edit_file' && (
              <>
                <div>
                  <span className="text-[10px] text-muted-foreground/60 uppercase">文件路径</span>
                  <p className="text-xs text-foreground font-mono mt-0.5">{request.params.path as string}</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-[10px] text-red-400/60 uppercase">查找</span>
                    <pre className="text-[10px] text-red-400 bg-red-400/5 rounded p-1.5 mt-0.5 font-mono overflow-auto max-h-20">
                      {request.params.old_string as string}
                    </pre>
                  </div>
                  <div>
                    <span className="text-[10px] text-red-400/60 uppercase">查找</span>
                    <pre className="text-[10px] text-red-400 bg-red-500/5 border border-red-500/10 rounded p-1.5 mt-0.5 font-mono overflow-auto max-h-20">
                      {request.params.old_string as string}
                    </pre>
                  </div>
                  <div>
                    <span className="text-[10px] text-emerald-400/60 uppercase">替换为</span>
                    <pre className="text-[10px] text-emerald-400 bg-emerald-500/5 border border-emerald-500/10 rounded p-1.5 mt-0.5 font-mono overflow-auto max-h-20">
                      {request.params.new_string as string}
                    </pre>
                  </div>
                </div>
              </>
            )}
            {request.toolName === 'run_bash' && (
              <div>
                <span className="text-[10px] text-muted-foreground/60 uppercase">命令</span>
                <pre className="text-xs text-foreground bg-muted/30 border border-border/30 rounded p-2 mt-0.5 font-mono">
                  {request.params.command as string}
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border/60 bg-muted/10 shrink-0">
          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={cacheDecision}
              onChange={(e) => setCacheDecision(e.target.checked)}
              className="size-3 accent-primary"
            />
            不再询问此操作
          </label>
          <div className="flex items-center gap-2">
            {pendingCount > 1 && onApproveAll && (
              <Button
                variant="outline"
                size="sm"
                onClick={onApproveAll}
                className="gap-1.5"
              >
                <Layers className="size-3.5" />
                一键批准全部 ({pendingCount})
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
