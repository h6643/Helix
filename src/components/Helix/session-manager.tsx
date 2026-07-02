'use client'

import React, { useState, useEffect, useCallback } from 'react'
import {
  Save,
  FolderOpen,
  Trash2,
  Download,
  Upload,
  Clock,
  X,
  Bot,
  Loader2,
} from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { persistence, type PersistedSession } from '@/lib/persist'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { timeAgo } from '@/lib/format'

export function SessionManager({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<PersistedSession[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      const list = await persistence.loadSessions()
      setSessions(list.sort((a, b) => b.savedAt - a.savedAt))
    } catch (e) {
      console.error('Failed to load sessions:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  const handleSave = async () => {
    setSaving(true)
    try {
      const state = useHelixStore.getState()
      const label = prompt('保存会话名称：', new Date().toLocaleString('zh-CN'))
      if (!label) { setSaving(false); return }

      const collectFiles = (nodes: typeof state.files): PersistedSession['files'] => {
        return nodes.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
          content: n.content,
          language: n.language,
          children: n.children ? collectFiles(n.children) : undefined,
        }))
      }

      await persistence.saveSession({
        label,
        goal: state.goal,
        memories: state.memories,
        tasks: state.tasks,
        notes: state.notes,
        checkpoints: state.checkpoints,
        chatMessages: state.chatMessages.map(m => ({
          id: m.id,
          sessionId: 'session-' + Date.now(),
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          isStreaming: m.isStreaming ?? false,
        })),
        files: collectFiles(state.files),
      })

      state.showToast({ type: 'success', title: '会话已保存', description: label })
      await loadSessions()
    } catch (e) {
      console.error('Failed to save session:', e)
      useHelixStore.getState().showToast({ type: 'error', title: '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除这个会话吗？')) return
    try {
      await persistence.deleteSession(id)
      await loadSessions()
    } catch (e) {
      console.error('Failed to delete session:', e)
    }
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-4 text-amber-400" />
            <h2 className="text-sm font-semibold">会话管理</h2>
            <span className="text-[10px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-full">
              {sessions.length} 个会话
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
              保存当前会话
            </Button>
            <Button variant="ghost" size="icon" className="size-7" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Session list */}
        <ScrollArea className="flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <FolderOpen className="size-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">暂无保存的会话</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                点击「保存当前会话」创建你的第一个快照
              </p>
            </div>
          ) : (
            <div className="p-2">
              {sessions.map(session => (
                <div
                  key={session.id}
                  className="group flex items-center gap-3 px-3 py-2.5 hover:bg-accent/30 rounded-xl transition-colors"
                >
                  <div className="w-8 h-8 rounded-xl bg-amber-500/10 flex items-center justify-center shrink-0">
                    <Bot className="size-4 text-amber-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{session.label}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-muted-foreground">{timeAgo(session.savedAt)}</span>
                      <span className="text-[10px] text-muted-foreground/50">
                        {session.chatMessages.length} 条消息
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleDelete(session.id)}
                  >
                    <Trash2 className="size-3 text-destructive/60" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  )
}