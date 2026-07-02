'use client'

import React from 'react'
import { ChevronRight } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'

export function Breadcrumb() {
  const { activeTabId, openTabs, getFilePath } = useHelixStore()
  const activeTab = openTabs.find((t) => t.id === activeTabId)

  if (!activeTab) return null

  const filePath = getFilePath(activeTab.fileId)
  if (!filePath) return null

  const segments = filePath.split('/')

  return (
    <div className="flex items-center h-7 px-3 bg-card border-b border-border text-xs text-muted-foreground shrink-0">
      {segments.map((segment, idx) => (
        <React.Fragment key={idx}>
          {idx > 0 && <ChevronRight className="size-3 mx-0.5 opacity-50" />}
          <span className={idx === segments.length - 1 ? 'text-foreground font-medium' : ''}>
            {segment}
          </span>
        </React.Fragment>
      ))}
    </div>
  )
}