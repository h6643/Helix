'use client'

import { X, Check, RotateCcw, FileCode, Split, Rows3, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import React, { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

export interface DiffChange {
  fileId: string
  fileName: string
  filePath: string
  oldContent: string
  newContent: string
  language: string
  /** Backend-rendered unified diff (Helix inline_diff). When present the
   *  viewers render these lines directly instead of recomputing from
   *  old/new content. */
  unifiedDiff?: string
}

interface DiffLine {
  type: 'add' | 'remove' | 'equal'
  content: string
  oldLineNum?: number
  newLineNum?: number
}

// Optimized diff algorithm using patience diff approach
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const result: DiffLine[] = []

  // Simple line-by-line diff using LCS
  const m = oldLines.length
  const n = newLines.length

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
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
  const stack: DiffLine[] = []
  let i = m, j = n
  let oldLineNum = m
  let newLineNum = n

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({
        type: 'equal',
        content: oldLines[i - 1],
        oldLineNum: i,
        newLineNum: j,
      })
      i--; j--; oldLineNum--; newLineNum--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({
        type: 'add',
        content: newLines[j - 1],
        newLineNum: j,
      })
      j--; newLineNum--
    } else {
      stack.push({
        type: 'remove',
        content: oldLines[i - 1],
        oldLineNum: i,
      })
      i--; oldLineNum--
    }
  }

  while (stack.length > 0) {
    result.push(stack.pop()!)
  }

  return result
}

// Find word-level changes within a line
function findWordDiff(oldLine: string, newLine: string): { old: string; new: string }[] {
  const oldWords = oldLine.split(/(\s+)/)
  const newWords = newLine.split(/(\s+)/)
  const result: { old: string; new: string }[] = []

  // Simple word diff - mark changed words
  const maxLen = Math.max(oldWords.length, newWords.length)
  for (let i = 0; i < maxLen; i++) {
    const oldWord = i < oldWords.length ? oldWords[i] : ''
    const newWord = i < newWords.length ? newWords[i] : ''
    if (oldWord !== newWord) {
      result.push({ old: oldWord, new: newWord })
    }
  }

  return result
}

function SideBySideDiffViewer({ change, onNavigateToLine }: { change: DiffChange; onNavigateToLine?: (filePath: string, lineNumber: number) => void }) {
  const diff = useMemo(() => computeDiff(change.oldContent, change.newContent), [change.oldContent, change.newContent])

  // Group diff lines into pairs for side-by-side view
  const pairs: { left: DiffLine | null; right: DiffLine | null }[] = []
  let i = 0

  while (i < diff.length) {
    const line = diff[i]

    if (line.type === 'equal') {
      pairs.push({ left: line, right: line })
      i++
    } else if (line.type === 'remove') {
      // Look ahead for corresponding add
      let addLine: DiffLine | null = null
      if (i + 1 < diff.length && diff[i + 1].type === 'add') {
        addLine = diff[i + 1]
        i += 2
      } else {
        i++
      }
      pairs.push({ left: line, right: addLine })
    } else if (line.type === 'add') {
      pairs.push({ left: null, right: line })
      i++
    }
  }

  return (
    <div className="flex font-mono text-[calc(var(--helix-font-size,13px)*0.9231)]">
      {/* Left side (old) */}
      <div className="flex-1 border-r border-border">
        <div className="px-3 py-1.5 bg-red-500/10 border-b border-border text-red-400 text-[calc(var(--helix-transcript-size)*0.7143)] font-medium">
          原始版本
        </div>
        <div className="max-h-[500px] overflow-y-auto">
          {pairs.map((pair, idx) => {
            if (!pair.left) {
              return (
                <div key={idx} className="flex h-6 bg-emerald-500/5">
                  <span className="w-12 shrink-0 text-right pr-2 text-muted-foreground/30 select-none" />
                  <span className="px-2 flex-1" />
                </div>
              )
            }

            const isRemoved = pair.left.type === 'remove'
            return (
              <div
                key={idx}
                onClick={() => onNavigateToLine?.(change.filePath, pair.left!.oldLineNum || 1)}
                className={`flex h-6 cursor-pointer ${isRemoved ? 'bg-red-500/10 border-l-2 border-red-500' : 'hover:bg-accent/20'}`}
              >
                <span className={`w-12 shrink-0 text-right pr-2 select-none ${isRemoved ? 'text-red-400' : 'text-muted-foreground/40'}`}>
                  {pair.left.oldLineNum || ''}
                </span>
                <span className={`px-2 flex-1 whitespace-pre ${isRemoved ? 'text-red-300' : ''}`}>
                  {isRemoved && <span className="text-red-400 mr-1">-</span>}
                  {pair.left.content}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Right side (new) */}
      <div className="flex-1">
        <div className="px-3 py-1.5 bg-emerald-500/10 border-b border-border text-emerald-400 text-[calc(var(--helix-transcript-size)*0.7143)] font-medium">
          新版本
        </div>
        <div className="max-h-[500px] overflow-y-auto">
          {pairs.map((pair, idx) => {
            if (!pair.right) {
              return (
                <div key={idx} className="flex h-6 bg-red-500/5">
                  <span className="w-12 shrink-0 text-right pr-2 text-muted-foreground/30 select-none" />
                  <span className="px-2 flex-1" />
                </div>
              )
            }

            const isAdded = pair.right.type === 'add'
            return (
              <div
                key={idx}
                onClick={() => onNavigateToLine?.(change.filePath, pair.right!.newLineNum || 1)}
                className={`flex h-6 cursor-pointer ${isAdded ? 'bg-emerald-500/10 border-l-2 border-emerald-500' : 'hover:bg-accent/20'}`}
              >
                <span className={`w-12 shrink-0 text-right pr-2 select-none ${isAdded ? 'text-emerald-400' : 'text-muted-foreground/40'}`}>
                  {pair.right.newLineNum || ''}
                </span>
                <span className={`px-2 flex-1 whitespace-pre ${isAdded ? 'text-emerald-300' : ''}`}>
                  {isAdded && <span className="text-emerald-400 mr-1">+</span>}
                  {pair.right.content}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function UnifiedDiffViewer({ change, onNavigateToLine }: { change: DiffChange; onNavigateToLine?: (filePath: string, lineNumber: number) => void }) {
  const diff = useMemo(() => computeDiff(change.oldContent, change.newContent), [change.oldContent, change.newContent])

  return (
    <div className="font-mono text-[calc(var(--helix-font-size,13px)*0.9231)]">
      <div className="max-h-[500px] overflow-y-auto">
        {diff.map((line, idx) => {
          if (line.type === 'equal') {
            return (
              <div key={idx} onClick={() => onNavigateToLine?.(change.filePath, line.oldLineNum || 1)} className="flex hover:bg-accent/20 cursor-pointer">
                <span className="w-12 shrink-0 text-right pr-2 text-muted-foreground/40 select-none">{line.oldLineNum}</span>
                <span className="w-12 shrink-0 text-right pr-2 text-muted-foreground/40 select-none">{line.newLineNum}</span>
                <span className="px-2 flex-1 whitespace-pre">{line.content}</span>
              </div>
            )
          }

          if (line.type === 'add') {
            return (
              <div key={idx} onClick={() => onNavigateToLine?.(change.filePath, line.newLineNum || 1)} className="flex bg-emerald-500/10 border-l-2 border-emerald-500 cursor-pointer">
                <span className="w-12 shrink-0 text-right pr-2 text-muted-foreground/40 select-none" />
                <span className="w-12 shrink-0 text-right pr-2 text-emerald-400 select-none">{line.newLineNum}</span>
                <span className="px-2 flex-1 whitespace-pre text-emerald-300">+ {line.content}</span>
              </div>
            )
          }

          return (
            <div key={idx} onClick={() => onNavigateToLine?.(change.filePath, line.oldLineNum || 1)} className="flex bg-red-500/10 border-l-2 border-red-500 cursor-pointer">
              <span className="w-12 shrink-0 text-right pr-2 text-red-400 select-none">{line.oldLineNum}</span>
              <span className="w-12 shrink-0 text-right pr-2 text-muted-foreground/40 select-none" />
              <span className="px-2 flex-1 whitespace-pre text-red-300 line-through opacity-70">- {line.content}</span>
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
  onNavigateToLine?: (filePath: string, lineNumber: number) => void
  onOpenFile?: (change: DiffChange) => void
}

// Renders a backend-provided unified diff string directly (Helix inline_diff).
// Lines carry their own +/-/context markers, so we colorize them instead of
// recomputing a diff from old/new content.
function UnifiedDiffTextViewer({ diff }: { diff: string }) {
  // Normalize \r\n to \n for consistent splitting across platforms
  const normalizedDiff = useMemo(() => diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), [diff])
  const lines = useMemo(() => normalizedDiff.split('\n'), [normalizedDiff])
  return (
    <div className="font-mono text-[calc(var(--helix-font-size,13px)*0.9231)]">
      <div className="max-h-[500px] overflow-y-auto">
        {lines.map((line, idx) => {
          if (line.startsWith('+++') || line.startsWith('---')) {
            return (
              <div key={idx} className="flex bg-purple-500/10 px-2 py-0.5 text-purple-300">
                <span className="px-2 flex-1 whitespace-pre-wrap">{line}</span>
              </div>
            )
          }
          if (line.startsWith('@@')) {
            return (
              <div key={idx} className="flex bg-sky-500/10 px-2 py-0.5 text-sky-300">
                <span className="px-2 flex-1 whitespace-pre-wrap">{line}</span>
              </div>
            )
          }
          if (line.startsWith('+')) {
            return (
              <div key={idx} className="flex bg-emerald-500/10 border-l-2 border-emerald-500">
                <span className="px-2 flex-1 whitespace-pre-wrap text-emerald-300">{line}</span>
              </div>
            )
          }
          if (line.startsWith('-')) {
            return (
              <div key={idx} className="flex bg-red-500/10 border-l-2 border-red-500">
                <span className="px-2 flex-1 whitespace-pre-wrap text-red-300">{line}</span>
              </div>
            )
          }
          return (
            <div key={idx} className="flex hover:bg-accent/20">
              <span className="px-2 flex-1 whitespace-pre-wrap text-muted-foreground/80">{line}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Count +added / -removed lines from a unified diff or old/new content pair. */
export function countDiffLines(change: DiffChange): { added: number; removed: number } {
  if (change.unifiedDiff) {
    let added = 0, removed = 0
    for (const line of change.unifiedDiff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++
      else if (line.startsWith('-') && !line.startsWith('---')) removed++
    }
    return { added, removed }
  }
  const diff = computeDiff(change.oldContent, change.newContent)
  return {
    added: diff.filter(l => l.type === 'add').length,
    removed: diff.filter(l => l.type === 'remove').length,
  }
}

export function DiffPreview({ changes, onApply, onApplyAll, onReject, onRejectAll, onClose, onNavigateToLine, onOpenFile }: DiffPreviewProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [viewMode, setViewMode] = useState<'unified' | 'side-by-side'>('side-by-side')

  const activeChange = changes[activeIndex]

  // Per-file line-change counts (memoized so file list doesn't recompute on every render)
  const perFileStats = useMemo(() => changes.map(countDiffLines), [changes])

  // Active file stats (for the header badge)
  const stats = activeChange ? countDiffLines(activeChange) : { added: 0, removed: 0 }

  if (changes.length === 0 || !activeChange) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-4xl max-h-[85vh] bg-card border border-border/60 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-[length:var(--helix-transcript-size)] font-semibold">代码变更预览</span>
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              {changes.length} 个文件
            </span>
            <div className="flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.7143)]">
              <span className="text-emerald-500">+{stats.added}</span>
              <span className="text-red-500">-{stats.removed}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* View mode toggle */}
            <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
              <button
                onClick={() => setViewMode('unified')}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === 'unified' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
                data-tip="统一视图"
              >
                <Rows3 className="size-3.5" />
              </button>
              <button
                onClick={() => setViewMode('side-by-side')}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === 'side-by-side' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
                data-tip="并排视图"
              >
                <Split className="size-3.5" />
              </button>
            </div>
            <button onClick={onClose} className="p-1 hover:bg-accent rounded">
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* File tabs */}
        {changes.length > 1 && (
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border overflow-x-auto">
            <button
              onClick={() => setActiveIndex(Math.max(0, activeIndex - 1))}
              disabled={activeIndex === 0}
              className="p-1 hover:bg-accent rounded disabled:opacity-30"
            >
              <ChevronLeft className="size-3.5" />
            </button>
            {changes.map((c, idx) => {
              const isNew = c.oldContent.trim() === '' && !c.unifiedDiff
              const fs = perFileStats[idx]
              return (
                <div
                  key={c.fileId}
                  onClick={() => setActiveIndex(idx)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] rounded-md transition-colors whitespace-nowrap cursor-pointer select-none ${
                    idx === activeIndex
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50'
                  }`}
                >
                  <FileCode className="size-3 shrink-0" />
                  <span className="truncate max-w-[150px]">{c.fileName}</span>
                  <span className="shrink-0 tabular-nums ml-auto">
                    <span className="text-emerald-500">+{fs.added}</span>
                    <span className="text-red-500 ml-1">-{fs.removed}</span>
                  </span>
                </div>
              )
            })}
            <button
              onClick={() => setActiveIndex(Math.min(changes.length - 1, activeIndex + 1))}
              disabled={activeIndex === changes.length - 1}
              className="p-1 hover:bg-accent rounded disabled:opacity-30"
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        )}

        {/* Diff content */}
        <div className="flex-1 overflow-hidden">
          {activeChange.unifiedDiff ? (
            <UnifiedDiffTextViewer diff={activeChange.unifiedDiff} />
          ) : viewMode === 'side-by-side' ? (
            <SideBySideDiffViewer change={activeChange} onNavigateToLine={onNavigateToLine} />
          ) : (
            <UnifiedDiffViewer change={activeChange} onNavigateToLine={onNavigateToLine} />
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { onReject(activeChange); if (changes.length <= 1) onClose() }}
              className="text-[calc(var(--helix-transcript-size)*0.8571)]"
            >
              <X className="size-3.5 mr-1" />
              拒绝
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRejectAll}
              className="text-[calc(var(--helix-transcript-size)*0.8571)] text-destructive hover:text-destructive"
            >
              <RotateCcw className="size-3.5 mr-1" />
              全部拒绝
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={onApplyAll}
              className="text-[calc(var(--helix-transcript-size)*0.8571)]"
            >
              <Check className="size-3.5 mr-1" />
              全部应用
            </Button>
            <Button
              size="sm"
              onClick={() => { onApply(activeChange); if (changes.length <= 1) onClose() }}
              className="text-[calc(var(--helix-transcript-size)*0.8571)]"
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