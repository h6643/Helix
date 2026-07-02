'use client'

import React, { useMemo } from 'react'
import { X, Check, RotateCcw, FileCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useHelixStore, type FileNode } from '@/stores/helix-store'

export interface DiffChange {
  fileId: string
  fileName: string
  filePath: string
  oldContent: string
  newContent: string
  language: string
}

function diffLines(oldText: string, newText: string): { type: 'add' | 'remove' | 'equal'; content: string }[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const result: { type: 'add' | 'remove' | 'equal'; content: string }[] = []

  // Simple LCS-based diff
  const m = oldLines.length
  const n = newLines.length

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to get diff
  const diff: { type: 'add' | 'remove' | 'equal'; content: string }[] = []
  let i = m, j = n
  const stack: { type: 'add' | 'remove' | 'equal'; content: string }[] = []

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: 'equal', content: oldLines[i - 1] })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'add', content: newLines[j - 1] })
      j--
    } else {
      stack.push({ type: 'remove', content: oldLines[i - 1] })
      i--
    }
  }

  while (stack.length > 0) {
    diff.push(stack.pop()!)
  }

  return diff
}

function DiffViewer({ change }: { change: DiffChange }) {
  const lines = useMemo(() => diffLines(change.oldContent, change.newContent), [change.oldContent, change.newContent])

  let lineNum = 0
  return (
    <div className="font-mono text-xs leading-5 overflow-x-auto">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 border-b border-border">
        <FileCode className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">{change.filePath}</span>
        <span className="text-[10px] text-muted-foreground">
          {lines.filter(l => l.type !== 'equal').length} 处变更
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {lines.map((line, idx) => {
          if (line.type === 'equal') {
            lineNum++
            return (
              <div key={idx} className="flex hover:bg-accent/20">
                <span className="w-10 shrink-0 text-right pr-3 text-muted-foreground/40 select-none">{lineNum}</span>
                <span className="px-2 whitespace-pre">{line.content}</span>
              </div>
            )
          }
          if (line.type === 'add') {
            lineNum++
            return (
              <div key={idx} className="flex bg-emerald-500/10 border-l-2 border-emerald-500">
                <span className="w-10 shrink-0 text-right pr-3 text-emerald-400 select-none">{lineNum}</span>
                <span className="px-2 whitespace-pre text-emerald-300">+ {line.content}</span>
              </div>
            )
          }
          return (
            <div key={idx} className="flex bg-red-500/10 border-l-2 border-red-500">
              <span className="w-10 shrink-0 text-right pr-3 text-red-400 select-none">{lineNum}</span>
              <span className="px-2 whitespace-pre text-red-300 line-through opacity-70">- {line.content}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface DiffPreviewProps {
  changes: DiffChange[]
  onApply: (change: DiffChange) => void
  onApplyAll: () => void
  onReject: (change: DiffChange) => void
  onRejectAll: () => void
  onClose: () => void
}

export function DiffPreview({ changes, onApply, onApplyAll, onReject, onRejectAll, onClose }: DiffPreviewProps) {
  const [activeIndex, setActiveIndex] = useState(0)

  if (changes.length === 0) return null

  const activeChange = changes[activeIndex]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-3xl max-h-[80vh] bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-sm font-semibold">代码变更预览</span>
            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              {changes.length} 个文件
            </span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X className="size-4" />
          </button>
        </div>

        {/* File tabs */}
        {changes.length > 1 && (
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border overflow-x-auto">
            {changes.map((c, idx) => (
              <button
                key={c.fileId}
                onClick={() => setActiveIndex(idx)}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors whitespace-nowrap ${
                  idx === activeIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50'
                }`}
              >
                <FileCode className="size-3" />
                {c.fileName}
              </button>
            ))}
          </div>
        )}

        {/* Diff content */}
        <div className="flex-1 overflow-hidden">
          <DiffViewer change={activeChange} />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { onReject(activeChange); if (changes.length <= 1) onClose() }}
              className="text-xs"
            >
              <X className="size-3.5 mr-1" />
              拒绝
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRejectAll}
              className="text-xs text-destructive hover:text-destructive"
            >
              <RotateCcw className="size-3.5 mr-1" />
              全部拒绝
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={onApplyAll}
              className="text-xs"
            >
              <Check className="size-3.5 mr-1" />
              全部应用
            </Button>
            <Button
              size="sm"
              onClick={() => { onApply(activeChange); if (changes.length <= 1) onClose() }}
              className="text-xs"
              variant="outline"
            >
              <Check className="size-3.5 mr-1" />
              应用此文件
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}