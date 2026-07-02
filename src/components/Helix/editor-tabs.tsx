'use client'

import React, { useCallback, useRef, useState } from 'react'
import { X, Circle } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'

function getTabIcon(language: string): string {
  const map: Record<string, string> = {
    typescript: 'TS',
    javascript: 'JS',
    python: 'PY',
    html: 'HTML',
    css: 'CSS',
    json: '{}',
    markdown: 'MD',
    shell: 'SH',
    plaintext: 'TXT',
    go: 'GO',
    rust: 'RS',
    java: 'JV',
  }
  return map[language] || 'F'
}

export function EditorTabs() {
  const { openTabs, activeTabId, setActiveTab, closeTab } = useHelixStore()
  const [draggedTab, setDraggedTab] = useState<string | null>(null)
  const [dragOverTab, setDragOverTab] = useState<string | null>(null)
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation()
      closeTab(tabId)
    },
    [closeTab]
  )

  const handleMiddleClick = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      if (e.button === 1) {
        e.preventDefault()
        closeTab(tabId)
      }
    },
    [closeTab]
  )

  const handleDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    setDraggedTab(tabId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', tabId)
    setTimeout(() => {
      const el = tabRefs.current[tabId]
      if (el) el.style.opacity = '0.5'
    }, 0)
  }, [])

  const handleDragEnd = useCallback((tabId: string) => {
    setDraggedTab(null)
    setDragOverTab(null)
    const el = tabRefs.current[tabId]
    if (el) el.style.opacity = '1'
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, tabId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverTab(tabId)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverTab(null)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent, targetTabId: string) => {
      e.preventDefault()
      const sourceTabId = e.dataTransfer.getData('text/plain')
      if (sourceTabId && sourceTabId !== targetTabId) {
        const state = useHelixStore.getState()
        const tabs = [...state.openTabs]
        const sourceIdx = tabs.findIndex(t => t.id === sourceTabId)
        const targetIdx = tabs.findIndex(t => t.id === targetTabId)
        if (sourceIdx >= 0 && targetIdx >= 0) {
          const [moved] = tabs.splice(sourceIdx, 1)
          tabs.splice(targetIdx, 0, moved)
          useHelixStore.setState({ openTabs: tabs })
        }
      }
      setDraggedTab(null)
      setDragOverTab(null)
    },
    []
  )

  if (openTabs.length === 0) {
    return (
      <div className="flex items-center h-8 border-b border-border bg-card px-4 font-mono">
        <span className="text-[11px] text-muted-foreground">没有打开的文件</span>
      </div>
    )
  }

  return (
    <div className="flex items-center border-b border-border bg-card overflow-hidden">
      <ScrollArea className="flex-1 h-8" type="scroll">
        <div className="flex items-center h-full min-w-max">
          {openTabs.map((tab) => {
            const isActive = tab.id === activeTabId
            const isDragOver = dragOverTab === tab.id
            return (
              <div
                key={tab.id}
                ref={(el) => { tabRefs.current[tab.id] = el }}
                draggable
                onDragStart={(e) => handleDragStart(e, tab.id)}
                onDragEnd={() => handleDragEnd(tab.id)}
                onDragOver={(e) => handleDragOver(e, tab.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, tab.id)}
                className={`group flex items-center gap-1.5 h-full px-3 text-[11px] cursor-pointer border-r border-border/50 transition-all duration-150 shrink-0 select-none font-mono ${
                  isActive
                    ? 'bg-background text-foreground border-b-2 border-b-primary'
                    : 'text-muted-foreground hover:bg-accent/50'
                } ${isDragOver && !isActive ? 'border-l-2 border-l-primary' : ''} ${
                  draggedTab === tab.id ? 'opacity-50' : ''
                }`}
                onClick={() => setActiveTab(tab.id)}
                onMouseDown={(e) => handleMiddleClick(e, tab.id)}
              >
                {tab.isDirty && (
                  <Circle className="size-1.5 fill-current text-yellow-400 shrink-0" />
                )}
                <span className="text-muted-foreground/60 text-[10px]">
                  {getTabIcon(tab.language)}
                </span>
                <span className="whitespace-nowrap">{tab.name}</span>
                <button
                  onClick={(e) => handleClose(e, tab.id)}
                  className="ml-1 p-0.5 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  )
}
