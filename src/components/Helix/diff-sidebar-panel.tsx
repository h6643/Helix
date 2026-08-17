'use client'

import { FileDiff } from 'lucide-react'
import { useMemo } from 'react'
import { useHelixStore } from '@/stores/helix-store'
import { countDiffLines } from './diff-preview'
import { FileChangeSummary } from './file-change-summary'

/**
 * Right-sidebar "变更" tab: a read-only file-change comparison surfaced by the
 * toolbar diff button. Each file row shows its +added / -removed count and
 * expands to the full colored unified diff — purely for viewing, no
 * apply/reject actions (file modifications are applied by the agent itself).
 */
export function DiffSidebarPanel() {
  const pendingChanges = useHelixStore(s => s.pendingChanges)
  const currentWorkDir = useHelixStore(s => s.selectedWorkDir)

  // 只展示当前项目（工作目录）的变更，不同项目各自独立。
  const projectChanges = useMemo(
    () => pendingChanges.filter(c => (c.workDir ?? '') === (currentWorkDir ?? '')),
    [pendingChanges, currentWorkDir],
  )

  const totalStats = useMemo(
    () => projectChanges.reduce(
      (sum, c) => {
        const s = countDiffLines(c)
        return { added: sum.added + s.added, removed: sum.removed + s.removed }
      },
      { added: 0, removed: 0 },
    ),
    [projectChanges],
  )

  return (
    <div className="h-full w-full flex flex-col min-h-0 bg-card">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        {projectChanges.length > 0 && (
          <>
            <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
              {projectChanges.length} 个文件
            </span>
            <span className="ml-auto flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.7143)] tabular-nums">
              <span className="text-emerald-500">+{totalStats.added}</span>
              <span className="text-red-500">-{totalStats.removed}</span>
            </span>
          </>
        )}
      </div>

      {/* Body — read-only comparison list */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {projectChanges.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground/70">
            <FileDiff className="size-9" strokeWidth={1.5} />
            <span className="text-[length:var(--helix-transcript-size)]">暂无变更</span>
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">当前项目对话中的文件修改会自动收集到这里</span>
          </div>
        ) : (
          <FileChangeSummary changes={projectChanges} hideHeader />
        )}
      </div>
    </div>
  )
}
