'use client'

import React from 'react'
import { useHelixStore } from '@/stores/helix-store'

/**
 * Inner content of the browser panel. The outer container + tab strip live in
 * the unified RightSidebar, so this only renders the URL bar and the iframe.
 */
export function PreviewRailContent() {
  const previewRailUrl = useHelixStore(s => s.previewRailUrl)
  const setPreviewRailUrl = useHelixStore(s => s.setPreviewRailUrl)

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-white">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/20 shrink-0 bg-background">
        <input
          value={previewRailUrl ?? ''}
          onChange={e => setPreviewRailUrl(e.target.value)}
          placeholder="https://…"
          className="flex-1 px-2 py-1 text-[11px] bg-muted/30 border border-border/20 rounded text-foreground/70 outline-none focus:border-primary/40"
        />
      </div>
      <div className="flex-1 min-h-0 bg-white">
        {previewRailUrl ? (
          <iframe
            src={previewRailUrl}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            title="Preview"
          />
        ) : (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground/40">
            点击消息中的链接或文件以预览
          </div>
        )}
      </div>
    </div>
  )
}
