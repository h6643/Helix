'use client'

import React, { useState, useCallback, useEffect } from 'react'
import {
  Plus,
  ChevronDown,
  Sparkles,
  Box,
  Clock,
  Palette,
  MessageSquare,
  Loader2,
  Trash2,
} from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { persistence, type PersistedSession } from '@/lib/persist'
import { timeAgo } from '@/lib/format'

interface SidebarProps {
  onNewTask?: () => void
}

export function Sidebar({ onNewTask }: SidebarProps) {
  const {
    clearChat,
    toggleSettings,
    showToast,
  } = useHelixStore()

  const [activeSection, setActiveSection] = useState<'new' | 'artifacts' | 'scheduled' | 'customize'>('new')
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<PersistedSession[]>([])
  const [loading, setLoading] = useState(true)

  const loadSessions = useCallback(async () => {
    try {
      const list = await persistence.loadSessions()
      setSessions(list.sort((a, b) => b.savedAt - a.savedAt))
    } catch (e) {
      console.error('Failed to load sessions:', e)
    }
  }, [])

  useEffect(() => {
    loadSessions().finally(() => setLoading(false))
  }, [loadSessions])

  // Refresh session list when auto-saved
  const sessionSaveVersion = useHelixStore(s => s.sessionSaveVersion)
  useEffect(() => {
    if (sessionSaveVersion > 0) loadSessions()
  }, [sessionSaveVersion, loadSessions])

  const handleNewTask = useCallback(() => {
    clearChat()
    useHelixStore.getState().clearExecutionFlow()
    setActiveSessionId(null)
    showToast({ type: 'info', title: '新对话已创建' })
    onNewTask?.()
  }, [clearChat, showToast, onNewTask])

  const handleLoadSession = useCallback(async (session: PersistedSession) => {
    try {
      useHelixStore.getState().clearExecutionFlow()
      const msgs = session.chatMessages.map(msg => ({
        id: msg.id,
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
        timestamp: msg.timestamp,
      }))
      useHelixStore.setState({ chatMessages: msgs })
      setActiveSection('new')
      setActiveSessionId(session.id)
      showToast({ type: 'success', title: '对话已加载', description: session.label })
    } catch (e) {
      console.error('Failed to load session:', e)
      showToast({ type: 'error', title: '加载失败' })
    }
  }, [showToast])

  const handleDeleteSession = useCallback(async (id: string) => {
    if (!confirm('确定要删除这个对话吗？')) return
    try {
      await persistence.deleteSession(id)
      await loadSessions()
      showToast({ type: 'info', title: '对话已删除' })
    } catch (e) {
      console.error('Failed to delete session:', e)
    }
  }, [loadSessions, showToast])

  const menuItems = [
    { id: 'new' as const, label: '新任务', icon: Plus, action: handleNewTask },
    { id: 'artifacts' as const, label: '制品', icon: Box },
    { id: 'scheduled' as const, label: '定时任务', icon: Clock },
    { id: 'customize' as const, label: '自定义', icon: Palette },
  ]

  return (
    <div className="h-full flex flex-col bg-[#FAF8F5] text-[#2D2A24]">
      {/* Menu Items */}
      <div className="px-2 py-2 space-y-0.5 shrink-0">
        {menuItems.map(item => (
          <button
            key={item.id}
            onClick={() => {
              setActiveSection(item.id)
              if (item.action) item.action()
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-xl transition-colors ${
              activeSection === item.id
                ? 'bg-[#EDE8E0] font-medium'
                : 'hover:bg-[#EDE8E0]/50'
            }`}
          >
            <item.icon className="size-4" />
            {item.label}
          </button>
        ))}
      </div>

      {/* 最近对话 */}
      <div className="flex-1 overflow-hidden">
        <div className="px-4 pt-3 pb-1">
          <span className="text-xs font-medium text-[#2D2A24]/50 uppercase tracking-wider">最近对话</span>
        </div>
        <div className="px-2 overflow-y-auto max-h-full">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-4 animate-spin text-[#2D2A24]/40" />
            </div>
          ) : sessions.length > 0 ? (
            <div className="space-y-0.5">
              {sessions.map(session => (
                <div
                  key={session.id}
                  onClick={() => handleLoadSession(session)}
                  className={`group flex items-center gap-2 px-3 py-2 rounded-xl transition-colors cursor-pointer ${
                    activeSessionId === session.id
                      ? 'bg-[#EDE8E0] font-medium'
                      : 'hover:bg-[#EDE8E0]/50'
                  }`}
                >
                  <MessageSquare className={`size-4 shrink-0 ${activeSessionId === session.id ? 'text-[#2D2A24]' : 'text-[#2D2A24]/40'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{session.label}</p>
                    <p className="text-[10px] text-[#2D2A24]/40 mt-0.5">{timeAgo(session.savedAt)}</p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteSession(session.id)
                    }}
                    className="p-1 rounded text-[#2D2A24]/30 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-6 text-center text-sm text-[#2D2A24]/40">
              暂无对话记录
            </div>
          )}
        </div>
      </div>

      {/* 设置 - 置底 */}
      <div className="px-3 py-3 border-t border-[#EDE8E0] shrink-0">
        <button
          onClick={toggleSettings}
          className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-[#EDE8E0] rounded-xl transition-colors"
        >
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-orange-500" />
            <span className="font-medium">Helix</span>
          </div>
          <ChevronDown className="size-4 text-[#2D2A24]/40" />
        </button>
      </div>
    </div>
  )
}
