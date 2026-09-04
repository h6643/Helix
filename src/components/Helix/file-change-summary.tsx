'use client'

import { ChevronRight, FilePen } from 'lucide-react'
import React, { useMemo, useState } from 'react'
import type { PendingChange } from '@/stores/helix-types'
import { computeDiff, countDiffLines } from './diff-preview'

function DiffBody({ change }: { change: PendingChange }) {
  const fallbackDiff = useMemo(
    () => computeDiff(change.oldContent || '', change.newContent || ''),
    [change.oldContent, change.newContent]
  )
  if (change.unifiedDiff) {
    // Normalize CRLF to LF for consistent line splitting across platforms
    const normalizedDiff = change.unifiedDiff.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    return (
      <div className="font-mono text-[calc(var(--helix-transcript-size)*0.7857)] leading-relaxed rounded-md overflow-hidden">
        {normalizedDiff.split('\n').map((line, i) => {
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
    <div className="font-mono text-[calc(var(--helix-transcript-size)*0.7857)] leading-relaxed rounded-md overflow-hidden">
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
 * Inline one-line change summary shown in the conversation transcript:
 * `已编辑 a.py、b.ts +N -N`. Plain text line — no card wrapper. Clicking the
 * line expands the per-file colored diffs below it.
 */
export function FileChangeSummary({ changes }: { changes: PendingChange[]; hideHeader?: boolean }) {
  const [expanded, setExpanded] = useState(false)

  const stats = useMemo(() => changes.map(countDiffLines), [changes])

  if (changes.length === 0) return null

  const totalAdded = stats.reduce((sum, s) => sum + s.added, 0)
  const totalRemoved = stats.reduce((sum, s) => sum + s.removed, 0)

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-1.5 px-1 py-1 text-left text-[length:var(--helix-transcript-size)] text-foreground/70 hover:bg-muted/30 rounded transition-colors"
      >
        <FilePen className="size-3.5 shrink-0 text-foreground/40" />
        <span className="font-medium shrink-0">已编辑</span>
        <span className="flex-1 break-all font-mono text-[length:var(--helix-transcript-size)] text-muted-foreground">{changes.map(c => c.fileName).join('、')}</span>
        <span className="shrink-0 flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.7143)] tabular-nums">
          <span className="text-emerald-500">+{totalAdded}</span>
          <span className="text-red-500">-{totalRemoved}</span>
        </span>
        <ChevronRight className={`size-3 shrink-0 text-foreground/30 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>
      {expanded && (
        <div className="pl-5 pr-1 pb-1 flex flex-col gap-2">
          {changes.map(change => (
            <DiffBody key={change.fileId} change={change} />
          ))}
        </div>
      )}
    </div>
  )
}
