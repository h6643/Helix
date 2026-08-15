'use client'

import { CheckCircle2, FileDiff, Globe } from 'lucide-react'

interface MoreActionsMenuProps {
  rightSidebarTab: string | null
  onToggleTab: (kind: 'browser' | 'diff') => void
  /** 点「浏览器」时总是新开一个浏览器页（多开）。缺省时退化为 onToggleTab（切换）。 */
  onAddBrowser?: () => void
}

/**
 * The conversation header's "更多操作" dropdown (浏览器 / 变更), extracted
 * so the right sidebar's "＋" can reuse the exact same actions.
 */
export function MoreActionsMenu({ rightSidebarTab, onToggleTab, onAddBrowser }: MoreActionsMenuProps) {
  return (
    <div className="w-52 bg-card border border-border/80 rounded-lg shadow-xl py-1">
      <button
        data-tip="浏览器"
        onClick={() => (onAddBrowser ? onAddBrowser() : onToggleTab('browser'))}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] hover:bg-accent/60 transition-colors ${rightSidebarTab === 'browser' ? 'text-primary' : 'text-foreground/80'}`}
      >
        <Globe className="size-3.5" />
        <span className="flex-1 text-left">浏览器</span>
        {rightSidebarTab === 'browser' && <CheckCircle2 className="size-3.5" />}
      </button>
      <button
        data-tip="变更"
        onClick={() => onToggleTab('diff')}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] hover:bg-accent/60 transition-colors ${rightSidebarTab === 'diff' ? 'text-primary' : 'text-foreground/80'}`}
      >
        <FileDiff className="size-3.5" />
        <span className="flex-1 text-left">变更</span>
        {rightSidebarTab === 'diff' && <CheckCircle2 className="size-3.5" />}
      </button>
    </div>
  )
}