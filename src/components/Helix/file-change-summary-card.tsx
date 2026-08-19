'use client'

import { ChevronRight, FileCode, Undo2 } from 'lucide-react'
import React, { useMemo, useState } from 'react'
import { electronFS } from '@/lib/electron-bridge'
import { useHelixStore } from '@/stores/helix-store'
import type { PendingChange } from '@/stores/helix-types'
import { computeDiff, countDiffLines } from './diff-preview'

function DiffBody({ change }: { change: PendingChange }) {
  const fallbackDiff = useMemo(
    () => computeDiff(change.oldContent || '', change.newContent || ''),
    [change.oldContent, change.newContent],
  )
  const diffLines = change.unifiedDiff
    ? change.unifiedDiff.split('\n').map(line => ({ line }))
    : fallbackDiff

  return (
    <div className="font-mono text-[length:var(--helix-transcript-size)] leading-relaxed rounded-md overflow-hidden">
      {diffLines.map((entry, i) => {
        const line = 'line' in entry ? entry.line : ('content' in entry ? entry.content : '')
        const isHeader = line.startsWith('+++') || line.startsWith('---')
        const isHunk = line.startsWith('@@')
        const isAdd = !isHeader && !isHunk && line.startsWith('+')
        const isRemove = !isHeader && !isHunk && line.startsWith('-')
        return (
          <div
            key={i}
            className={`px-2 py-px whitespace-pre-wrap border-l-2 ${
              isHeader
                ? 'bg-purple-500/10 border-transparent text-purple-300/80'
                : isHunk
                  ? 'bg-sky-500/10 border-transparent text-sky-300/80'
                  : isAdd
                    ? 'bg-emerald-500/10 border-emerald-500 text-emerald-300/90'
                    : isRemove
                      ? 'bg-red-500/10 border-red-500 text-red-300/90'
                      : 'border-transparent text-muted-foreground/70'
            }`}
          >
            {line}
          </div>
        )
      })}
    </div>
  )
}

function reverseUnifiedDiff(diff: string, currentContent: string): string | null {
  const hunks: Array<{ newStart: number; newCount: number; body: string[] }> = []
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('@@ ')) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
      if (!m) return null
      hunks.push({ newStart: Number(m[1]), newCount: m[2] ? Number(m[2]) : 1, body: [] })
    } else if (hunks.length > 0 && !line.startsWith('---') && !line.startsWith('+++')) {
      if (line.startsWith('\\')) continue
      hunks[hunks.length - 1].body.push(line)
    }
  }

  const result = currentContent.split('\n')
  for (let i = hunks.length - 1; i >= 0; i--) {
    const hunk = hunks[i]
    const start = hunk.newStart - 1
    const end = start + hunk.newCount
    if (start < 0 || end > result.length) return null
    const oldSegment: string[] = []
    for (const bodyLine of hunk.body) {
      if (bodyLine.startsWith('+')) continue
      if (bodyLine.startsWith('-')) oldSegment.push(bodyLine.slice(1))
      else if (bodyLine.startsWith(' ')) oldSegment.push(bodyLine.slice(1))
      else oldSegment.push(bodyLine)
    }
    result.splice(start, hunk.newCount, ...oldSegment)
  }
  return result.join('\n')
}

/**
 * 单条回复末尾的修改汇总卡片：外层卡片 + 每个文件一行，点击行展开该文件的 diff。
 */
export function FileChangeSummaryCard({ changes }: { changes: PendingChange[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [undone, setUndone] = useState<Set<string>>(new Set())
  const [undoing, setUndoing] = useState(false)
  const visibleChanges = useMemo(() => changes.filter(c => !undone.has(c.fileId)), [changes, undone])
  const stats = useMemo(() => visibleChanges.map(countDiffLines), [visibleChanges])

  if (visibleChanges.length === 0) return null

  const totalAdded = stats.reduce((sum, s) => sum + s.added, 0)
  const totalRemoved = stats.reduce((sum, s) => sum + s.removed, 0)

  const toggle = (fileId: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }

  const undoChange = async (change: PendingChange) => {
    if (!change.filePath) throw new Error('缺少文件路径')
    const st = useHelixStore.getState()
    const workDir = st.selectedWorkDir ?? st.activeSessionWorkDir ?? ''
    const absolutePath = /^[A-Za-z]:[\\/]/.test(change.filePath) || change.filePath.startsWith('/')
      ? change.filePath
      : workDir
        ? `${workDir.replace(/[\\/]+$/, '')}/${change.filePath}`
        : change.filePath

    const isNewFile = change.unifiedDiff?.includes('--- /dev/null') === true
    let restored: string | null | undefined = change.oldContent

    if (isNewFile) {
      await electronFS.deleteFile(absolutePath)
    } else if (restored) {
      await electronFS.writeFile(absolutePath, restored)
    } else if (change.unifiedDiff) {
      const current = await electronFS.readFile(absolutePath)
      restored = reverseUnifiedDiff(change.unifiedDiff, current)
      if (restored == null) throw new Error('无法解析 diff，无法撤销')
      await electronFS.writeFile(absolutePath, restored)
    } else {
      throw new Error('缺少可撤销的变更内容')
    }

    useHelixStore.setState(s => ({
      pendingChanges: s.pendingChanges.filter(c => c.fileId !== change.fileId || (c.workDir ?? '') !== workDir),
    }))

    const existing = useHelixStore.getState().findFileByPath(absolutePath)
    if (existing) {
      if (restored != null) useHelixStore.getState().applyFileChange(existing.id, restored)
      else useHelixStore.getState().deleteFile(existing.id)
    }
  }

  const handleUndoAll = async () => {
    if (undoing || visibleChanges.length === 0) return
    setUndoing(true)
    const failed: string[] = []
    const restoredIds: string[] = []
    for (const change of visibleChanges) {
      try {
        await undoChange(change)
        restoredIds.push(change.fileId)
      } catch (e) {
        failed.push(`${change.fileName}（${String(e)}）`)
      }
    }
    setUndone(prev => new Set([...prev, ...restoredIds]))
    setUndoing(false)

    const st = useHelixStore.getState()
    if (failed.length === 0) {
      st.showToast({
        type: 'success',
        title: '已撤销',
        description: `已恢复本次回复修改的 ${restoredIds.length} 个文件`,
      })
    } else {
      st.showToast({
        type: 'error',
        title: '部分撤销失败',
        description: failed.join('；'),
      })
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border/40 bg-card/40">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/30 text-[length:var(--helix-transcript-size)] text-foreground/70">
        <span className="font-medium">已修改</span>
        <span className="text-[length:var(--helix-transcript-size)] text-muted-foreground">{visibleChanges.length} 个文件</span>
        <span className="ml-auto flex items-center gap-2 text-[length:var(--helix-transcript-size)] tabular-nums">
          {totalAdded > 0 && <span className="text-emerald-500">+{totalAdded}</span>}
          {totalRemoved > 0 && <span className="text-red-500">-{totalRemoved}</span>}
        </span>
        <button
          type="button"
          onClick={handleUndoAll}
          disabled={undoing}
          className="ml-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded text-[length:var(--helix-transcript-size)] text-foreground/50 hover:text-foreground hover:bg-red-500/10 disabled:opacity-50 transition-colors"
          data-tip={undoing ? '撤销中' : '撤销本次回复的全部修改'}
        >
          <Undo2 className={`size-3.5 ${undoing ? 'animate-pulse' : ''}`} />
          {undoing ? '撤销中' : '撤销'}
        </button>
      </div>
      {visibleChanges.map((change, idx) => {
        const s = stats[idx]
        const isExpanded = expanded.has(change.fileId)
        return (
          <div key={change.fileId} className="border-b border-border/20 last:border-b-0">
            <div className="flex items-center hover:bg-muted/40 transition-colors">
              <button
                type="button"
                onClick={() => toggle(change.fileId)}
                className="flex flex-1 min-w-0 items-center gap-1.5 px-3 py-1.5 text-left"
              >
                <FileCode className="size-3.5 shrink-0 text-sky-500/80" />
                <span className="truncate font-mono text-[length:var(--helix-transcript-size)] text-foreground/70">{change.fileName}</span>
                <span className="shrink-0 tabular-nums text-[length:var(--helix-transcript-size)]">
                  {s.added > 0 && <span className="text-emerald-500 mr-1.5">+{s.added}</span>}
                  {s.removed > 0 && <span className="text-red-500">-{s.removed}</span>}
                </span>
                <ChevronRight className={`size-3 shrink-0 text-foreground/30 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
              </button>
            </div>
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
