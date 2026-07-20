import React from 'react'
import { useHelixStore } from '@/stores/helix-store'
import { X, Plus } from 'lucide-react'

interface TabBarProps {
  onNewTab: () => void
  onCloseTab: (sessionId: string) => void
  onSwitchTab: (sessionId: string) => void
}

export function TabBar({ onNewTab, onCloseTab, onSwitchTab }: TabBarProps) {
  const currentSessionId = useHelixStore(s => s.currentSessionId)
  const sessionHistory = useHelixStore(s => s.sessionHistory)
  const streamingDrafts = useHelixStore(s => s.streamingDrafts)
  const chatMessages = useHelixStore(s => s.chatMessages)

  const allSessions = React.useMemo(() => {
    const set = new Set<string>(sessionHistory)
    if (currentSessionId) set.add(currentSessionId)
    const sessions = Array.from(set).filter(Boolean)
    sessions.sort((a, b) => {
      if (a === currentSessionId) return -1
      if (b === currentSessionId) return 1
      return 0
    })
    return sessions
  }, [sessionHistory, currentSessionId])

  const hasSessions = allSessions.length > 0
  if (!hasSessions) return null

  return (
    <div className="flex items-center gap-0.5 px-2 pt-1.5 pb-0 overflow-x-auto scrollbar-none border-b border-border/10">
      {allSessions.map(sid => {
        const draft = streamingDrafts[sid]
        const isRunning = draft?.isAgentRunning
        const isActive = sid === currentSessionId
        const firstMsg = chatMessages.find(m => m.sessionId === sid && m.role === 'user')
        const title = firstMsg?.content?.slice(0, 20) || sid.slice(-8)

        return (
          <button
            key={sid}
            onClick={() => onSwitchTab(sid)}
            className={`group relative flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-t-lg transition-colors shrink-0 ${
              isActive
                ? 'bg-background text-foreground border border-border/20 border-b-background z-10'
                : 'text-muted-foreground/60 hover:text-foreground hover:bg-muted/20 border border-transparent'
            }`}
          >
            {isRunning && (
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            )}
            <span className="max-w-[100px] truncate">{title}</span>
            <span
              onClick={(e) => { e.stopPropagation(); onCloseTab(sid) }}
              className="size-3.5 flex items-center justify-center rounded opacity-0 group-hover:opacity-60 hover:opacity-100 hover:bg-muted/40 transition-opacity"
            >
              <X className="size-2.5" />
            </span>
          </button>
        )
      })}
      <button
        onClick={onNewTab}
        className="flex items-center justify-center size-5 rounded hover:bg-muted/20 text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
        title="新建标签页"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}
