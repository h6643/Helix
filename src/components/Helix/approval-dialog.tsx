'use client'

import React from 'react'
import {
  AlertTriangle,
  FileEdit,
  Terminal,
  FolderOpen,
  Check,
  X,
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

interface ApprovalDialogProps {
  request: ApprovalRequest
  onApprove: (id: string) => void
  onReject: (id: string) => void
}

export function ApprovalDialog({ request, onApprove, onReject }: ApprovalDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-yellow-500/5">
          <div className="w-8 h-8 rounded-xl bg-yellow-500/10 flex items-center justify-center">
            <AlertTriangle className="size-4 text-yellow-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">操作确认</h3>
            <p className="text-[11px] text-muted-foreground">Agent 请求执行以下操作</p>
          </div>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 rounded-lg">
            {getToolIcon(request.toolName)}
            <span className="text-xs font-medium text-foreground">
              {getToolLabel(request.toolName)}
            </span>
          </div>

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
                  <pre className="text-[11px] text-foreground/80 bg-muted/50 rounded p-2 mt-0.5 max-h-32 overflow-auto font-mono">
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
                    <span className="text-[10px] text-green-400/60 uppercase">替换为</span>
                    <pre className="text-[10px] text-green-400 bg-green-400/5 rounded p-1.5 mt-0.5 font-mono overflow-auto max-h-20">
                      {request.params.new_string as string}
                    </pre>
                  </div>
                </div>
              </>
            )}
            {request.toolName === 'run_bash' && (
              <div>
                <span className="text-[10px] text-muted-foreground/60 uppercase">命令</span>
                <pre className="text-xs text-foreground bg-muted/50 rounded p-2 mt-0.5 font-mono">
                  {request.params.command as string}
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onReject(request.id)}
            className="gap-1.5"
          >
            <X className="size-3.5" />
            拒绝
          </Button>
          <Button
            size="sm"
            onClick={() => onApprove(request.id)}
            className="gap-1.5 bg-green-600 hover:bg-green-700"
          >
            <Check className="size-3.5" />
            执行
          </Button>
        </div>
      </div>
    </div>
  )
}
