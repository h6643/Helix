'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Save,
  FolderOpen,
  Trash2,
  Download,
  Upload,
  X,
  Bot,
  Loader2,
  Search,
  AlertTriangle,
} from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { useHermesStore } from '@/stores/hermes-store'
import { persistence, type PersistedSession } from '@/lib/persist'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { timeAgo } from '@/lib/format'

export function SessionManager({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<PersistedSession[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<PersistedSession | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

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
        workDir: state.selectedWorkDir,
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
        openTabs: state.openTabs.map(tab => ({
          id: tab.id,
          fileId: tab.fileId,
          name: tab.name,
          language: tab.language,
          isDirty: tab.isDirty,
        })),
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

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    try {
      await persistence.deleteSession(deleteTarget.id)
      setDeleteTarget(null)
      await loadSessions()
    } catch (e) {
      console.error('Failed to delete session:', e)
    }
  }

  const handleExportSession = (session: PersistedSession) => {
    const data = JSON.stringify(session, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `helix-session-${session.label || session.id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportSession = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const session = JSON.parse(text) as PersistedSession
      if (!session.id || !session.chatMessages) {
        useHelixStore.getState().showToast({ type: 'error', title: '无效的会话文件' })
        return
      }
      await persistence.saveSession({
        id: session.id,
        label: session.label || `导入 ${new Date().toLocaleString('zh-CN')}`,
        workDir: session.workDir,
        goal: session.goal,
        memories: session.memories || [],
        tasks: session.tasks || [],
        notes: session.notes || '',
        checkpoints: session.checkpoints || [],
        chatMessages: session.chatMessages || [],
        files: session.files || [],
        openTabs: session.openTabs || [],
      })
      await loadSessions()
      useHelixStore.getState().showToast({ type: 'success', title: '会话已导入' })
    } catch {
      useHelixStore.getState().showToast({ type: 'error', title: '导入失败' })
    }
    e.target.value = ''
  }

  const handleOpenSession = useCallback(async (session: PersistedSession) => {
    try {
      const state = useHelixStore.getState()
      await state.flushSessionPersist()
      state.clearExecutionFlow()
      useHermesStore.getState().setHermesSessionId(null)
      const all = await persistence.loadSessions()
      const fresh = all.find(s => s.id === session.id) || session
      const msgs = fresh.chatMessages.map(msg => ({
        id: msg.id,
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
        images: msg.images,
        timestamp: msg.timestamp,
        reasoning: msg.reasoning,
        steps: msg.steps,
      }))
      useHelixStore.setState({
        chatMessages: msgs,
        selectedWorkDir: fresh.workDir || null,
        activeSessionWorkDir: fresh.workDir ?? null,
      })
      useHelixStore.getState().setCurrentSessionId(session.id)
      useHelixStore.getState().pushNavigation({ type: 'chat', sessionId: session.id })
      await useHelixStore.getState().persistToStorage()
      onClose()
    } catch (e) {
      console.error('Failed to open session:', e)
      useHelixStore.getState().showToast({ type: 'error', title: '加载失败' })
    }
  }, [onClose])

  useEffect(() => {
    if (sessions.length > 0) {
      const t = setTimeout(() => searchInputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [sessions.length])

  const filteredSessions = sessions.filter(s => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    if (s.label?.toLowerCase().includes(q)) return true
    const allText = s.chatMessages.map(m => m.content).join(' ').toLowerCase()
    return allText.includes(q)
  })

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card border border-border/60 rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60">
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
            <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/50 text-xs font-medium text-foreground/70 hover:bg-accent/50 cursor-pointer transition-colors h-7">
              <Upload className="size-3" />
              导入
              <input type="file" accept=".json" className="hidden" onChange={handleImportSession} />
            </label>
            <Button variant="ghost" size="icon" className="size-7" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Search */}
        {sessions.length > 0 && (
          <div className="px-5 py-2 border-b border-border/50">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索会话（按名称或内容）..."
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted/50 border border-border/50 rounded-lg focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
        )}

        {/* Session list */}
        <ScrollArea className="flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <FolderOpen className="size-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                {searchQuery ? '没有匹配的会话' : '暂无保存的会话'}
              </p>
              {!searchQuery && (
                <p className="text-xs text-muted-foreground/60 mt-1">
                  点击「保存当前会话」创建你的第一个快照
                </p>
              )}
            </div>
          ) : (
            <div className="p-2">
              {filteredSessions.map(session => (
                <div
                  key={session.id}
                  onClick={() => handleOpenSession(session)}
                  className="group flex items-center gap-3 px-3 py-2.5 hover:bg-accent/30 rounded-xl transition-colors cursor-pointer"
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
                    onClick={(e) => { e.stopPropagation(); handleExportSession(session) }}
                    title="导出"
                  >
                    <Download className="size-3 text-muted-foreground" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(session) }}
                    title="删除"
                  >
                    <Trash2 className="size-3 text-destructive/60" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDeleteTarget(null)} />
          <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-80 mx-4 p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-50 dark:bg-red-950/50 flex items-center justify-center shrink-0">
                <AlertTriangle className="size-5 text-red-500" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">删除会话</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  确定要删除「{deleteTarget.label}」吗？此操作不可撤销。
                </p>
              </div>
            </div>
            <div className="flex justify-between gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleConfirmDelete}
                className="gap-1.5"
              >
                <Trash2 className="size-3" />
                删除
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
