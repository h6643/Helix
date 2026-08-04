'use client'

import { FileCode, ChevronRight } from 'lucide-react'
import React, { useMemo, useState } from 'react'
import type { PendingChange } from '@/stores/helix-types'
import { computeDiff, countDiffLines } from './diff-preview'

function DiffBody({ change }: { change: PendingChange }) {
  const fallbackDiff = useMemo(
    () => computeDiff(change.oldContent || '', change.newContent || ''),
    [change.oldContent, change.newContent]
  )
  if (change.unifiedDiff) {
    return (
      <div className="font-mono text-[11px] leading-relaxed rounded-md overflow-hidden">
        {change.unifiedDiff.split('\n').map((line, i) => {
          if (line.startsWith('+++') || line.startsWith('---')) {
            return (
              <div key={i} className="bg-purple-500/10 px-2 py-px text-purple-300/80 whitespace-pre-wrap">{line}</div>
            )
          }
          if (line.startsWith('@@')) {
            return (
              <div key={i} className="bg-sky-500/10 px-2 py-px text-sky-300/80 whitespace-pre-wrap">{line}</div>
            )
          }
          if (line.startsWith('+')) {
            return (
              <div key={i} className="bg-emerald-500/10 border-l-2 border-emerald-500 px-2 py-px text-emerald-300/90 whitespace-pre-wrap">{line}</div>
            )
          }
          if (line.startsWith('-')) {
            return (
              <div key={i} className="bg-red-500/10 border-l-2 border-red-500 px-2 py-px text-red-300/90 whitespace-pre-wrap">{line}</div>
            )
          }
          return (
            <div key={i} className="px-2 py-px text-muted-foreground/70 whitespace-pre-wrap">{line}</div>
          )
        })}
      </div>
    )
  }
  return (
    <div className="font-mono text-[11px] leading-relaxed rounded-md overflow-hidden">
      {fallbackDiff.map((line, i) => {
        if (line.type === 'equal') {
          return (
            <div key={i} className="px-2 py-px text-muted-foreground/70 whitespace-pre-wrap">{line.content}</div>
          )
        }
        if (line.type === 'add') {
          return (
            <div key={i} className="bg-emerald-500/10 border-l-2 border-emerald-500 px-2 py-px text-emerald-300/90 whitespace-pre-wrap">+ {line.content}</div>
          )
        }
        return (
          <div key={i} className="bg-red-500/10 border-l-2 border-red-500 px-2 py-px text-red-300/90 whitespace-pre-wrap">- {line.content}</div>
        )
      })}
    </div>
  )
}

/**
 * Inline per-file change stats shown directly in the conversation transcript.
 * Each file gets a green `+N` (additions) and red `-N` (deletions/modifications)
 * count; clicking a row expands the full unified diff. Replaces the auto-popping
 * DiffPreview confirmation modal for in-conversation review.
 */
export function FileChangeSummary({ changes, hideHeader = false }: { changes: PendingChange[]; hideHeader?: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const stats = useMemo(() => changes.map(countDiffLines), [changes])

  if (changes.length === 0) return null

  const toggle = (fileId: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }

  const totalAdded = stats.reduce((sum, s) => sum + s.added, 0)
  const totalRemoved = stats.reduce((sum, s) => sum + s.removed, 0)

  return (
    <div className="overflow-hidden rounded-lg border border-border/40 bg-card/40">
      {!hideHeader && (
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/30 text-[12px] text-foreground/70">
        <span className="font-medium">变更</span>
        <span className="text-[10px] text-muted-foreground">{changes.length} 个文件</span>
        <span className="ml-auto flex items-center gap-2 text-[10px] tabular-nums">
          {totalAdded > 0 && <span className="text-emerald-500">+{totalAdded}</span>}
          {totalRemoved > 0 && <span className="text-red-500">-{totalRemoved}</span>}
        </span>
      </div>
      )}
      {changes.map((change, idx) => {
        const s = stats[idx]
        const isExpanded = expanded.has(change.fileId)
        return (
          <div key={change.fileId} className="border-b border-border/20 last:border-b-0">
            <button
              type="button"
              onClick={() => toggle(change.fileId)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-muted/40 transition-colors"
            >
              <ChevronRight className={`size-3 shrink-0 text-foreground/30 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
              <FileCode className="size-3.5 shrink-0 text-sky-500/80" />
              <span className="flex-1 truncate font-mono text-[11px] text-foreground/70">{change.fileName}</span>
              <span className="shrink-0 tabular-nums text-[11px]">
                {s.added > 0 && <span className="text-emerald-500 mr-1.5">+{s.added}</span>}
                {s.removed > 0 && <span className="text-red-500">-{s.removed}</span>}
              </span>
            </button>
            {isExpanded && (
              <div className="px-3 pb-2">
                <DiffBody change={change} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
