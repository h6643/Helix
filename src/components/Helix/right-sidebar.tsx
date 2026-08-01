'use client'

import { Globe, FileCode2, X } from 'lucide-react'
import React from 'react'
import { useHelixStore } from '@/stores/helix-store'
import { CodeEditorPanel } from './code-editor-panel'
import { PreviewRailContent } from './preview-rail'

/**
 * Single right-hand sidebar that hosts both the in-app browser and the code
 * editor. A tab strip at the top switches between them; the X button closes
 * the panel. Re-open via the toolbar 代码/浏览器 buttons or the window menu.
 */
export function RightSidebar() {
  const tab = useHelixStore(s => s.rightSidebarTab)
  const setTab = useHelixStore(s => s.setRightSidebarTab)

  if (!tab) return null

  const tabBtn = (
    id: 'browser' | 'code',
    icon: React.ReactNode,
    label: string,
  ) => (
    <button
      onClick={() => setTab(id)}
      className={`flex items-center gap-1 px-3 py-1.5 text-[12px] rounded-md transition-colors ${
        tab === id ? 'bg-primary/10 text-primary' : 'text-foreground/60 hover:bg-accent/50 hover:text-foreground'
      }`}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <div className="h-full w-full bg-background border-l border-border/30 flex flex-col overflow-hidden">
      <div className="flex items-center gap-1 px-2 h-10 shrink-0 border-b border-border/20 bg-sidebar">
        {tabBtn('browser', <Globe className="size-3.5" />, '浏览器')}
        {tabBtn('code', <FileCode2 className="size-3.5" />, '代码')}
        <div className="flex-1" />
        <button
          onClick={() => setTab(null)}
          className="p-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-accent/60 transition-colors"
          title="关闭侧边栏"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        {tab === 'browser' ? (
          <PreviewRailContent />
        ) : (
          <CodeEditorPanel onClose={() => setTab(null)} />
        )}
      </div>
    </div>
  )
}
