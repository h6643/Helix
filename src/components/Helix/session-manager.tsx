'use client'

import {
  FolderOpen,
  Trash2,
  Download,
  DownloadCloud,
  Upload,
  X,
  Bot,
  Loader2,
  Search,
  AlertTriangle,
} from 'lucide-react'
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { timeAgo } from '@/lib/format'
import { persistence, type PersistedSession } from '@/lib/persist'
import { useHelixStore } from '@/stores/helix-store'
import { useHermesStore } from '@/stores/hermes-store'

export function SessionManager({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<PersistedSession[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<PersistedSession | null>(null)
  const [exportMenuSession, setExportMenuSession] = useState<PersistedSession | null>(null)
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

  const handleExportSession = async (session: PersistedSession, format: 'json' | 'markdown' = 'json') => {
    try {
      let data: string
      let ext: string
      let mime: string
      if (format === 'markdown') {
        data = await persistence.exportSessionAsMarkdown(session)
        ext = 'md'
        mime = 'text/markdown'
      } else {
        data = await persistence.exportSessionAsJson(session)
        ext = 'json'
        mime = 'application/json'
      }
      const blob = new Blob([data], { type: mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `helix-session-${session.label || session.id}.${ext}`
      a.click()
      URL.revokeObjectURL(url)
      useHelixStore.getState().showToast({ type: 'success', title: '导出成功' })
    } catch (e) {
      console.error('Export failed:', e)
      useHelixStore.getState().showToast({ type: 'error', title: '导出失败' })
    }
  }

  const handleExportAll = async () => {
    try {
      const data = JSON.stringify(sessions, null, 2)
      const blob = new Blob([data], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `helix-sessions-all-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      useHelixStore.getState().showToast({ type: 'success', title: `已导出 ${sessions.length} 个会话` })
    } catch (e) {
      console.error('Export all failed:', e)
      useHelixStore.getState().showToast({ type: 'error', title: '批量导出失败' })
    }
  }

  const handleImportSession = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    let imported = 0
    let failed = 0
    for (const file of Array.from(files)) {
      try {
        const text = await file.text()
        if (file.name.endsWith('.md') || file.name.endsWith('.markdown')) {
          const session = await persistence.importSessionFromMarkdown(text)
          if (session) { imported++ } else { failed++ }
        } else {
          // JSON: 支持单会话包裹格式、裸单会话，以及「导出全部」裸数组 / {sessions:[...]}
          const data = JSON.parse(text)
          const arr = Array.isArray(data)
            ? data
            : data && Array.isArray((data as any).sessions) ? (data as any).sessions : null
          if (arr && arr.length > 0) {
            for (const item of arr) {
              const wrapped = typeof item === 'string'
                ? item
                : JSON.stringify({ type: 'helix-session', session: item })
              const s = await persistence.importSessionFromJson(wrapped)
              if (s) { imported++ } else { failed++ }
            }
          } else {
            const jsonStr = data.type === 'helix-session' ? text : JSON.stringify(data)
            const session = await persistence.importSessionFromJson(jsonStr)
            if (session) { imported++ } else { failed++ }
          }
        }
      } catch {
        failed++
      }
    }
    await loadSessions()
    // 通知左侧边栏（sidebar）刷新：sidebar 监听 sessionSaveVersion，import 走 persist 直接写库、不经过 store action，需手动 bump
    useHelixStore.setState((st) => ({ sessionSaveVersion: (st.sessionSaveVersion || 0) + 1 }))
    if (files.length === 1) {
      useHelixStore.getState().showToast({
        type: imported > 0 ? 'success' : 'error',
        title: imported > 0 ? '会话已导入' : '导入失败',
      })
    } else {
      useHelixStore.getState().showToast({
        type: imported > 0 ? 'success' : 'error',
        title: `导入完成：${imported} 成功，${failed} 失败`,
      })
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
      // 丢弃 draft-partial 占位（同 sidebar/navigateSession）：并发下切换/打开
      // 会话不中断后台 run，占位消息不应展示（会与最终提交的完整回复重复）。
      const seen = new Set<string>()
      const msgs = fresh.chatMessages
        .filter(msg => {
          if (seen.has(msg.id)) return false
          seen.add(msg.id)
          if (typeof msg.id === 'string' && msg.id.startsWith('draft-partial-')) return false
          return true
        })
        .map(msg => ({
        id: msg.id,
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
        images: msg.images,
        timestamp: msg.timestamp,
        reasoning: msg.reasoning,
        steps: msg.steps,
        blocks: msg.blocks,
      }))
      useHelixStore.setState({
        chatMessages: msgs,
        activeSessionWorkDir: fresh.workDir ?? null,
      })
      // selectedWorkDir 同步到对话所属项目，让 Git 分支选择器等 UI 跟随对话。
      if (fresh.workDir) {
        useHelixStore.getState().setSelectedWorkDir(fresh.workDir)
      }
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
            {sessions.length > 0 && (
              <button
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/50 text-xs font-medium text-foreground/70 hover:bg-accent/50 cursor-pointer transition-colors h-7"
                onClick={handleExportAll}
              >
                <DownloadCloud className="size-3" />
                全部导出
              </button>
            )}
            <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/50 text-xs font-medium text-foreground/70 hover:bg-accent/50 cursor-pointer transition-colors h-7">
              <Upload className="size-3" />
              导入
              <input type="file" accept=".json,.md,.markdown" multiple className="hidden" onChange={handleImportSession} />
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
                    onClick={(e) => { e.stopPropagation(); setExportMenuSession(exportMenuSession?.id === session.id ? null : session) }}
                    data-tip="导出"
                  >
                    <Download className="size-3 text-muted-foreground" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(session) }}
                    data-tip="删除"
                  >
                    <Trash2 className="size-3 text-destructive/60" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Export format popover */}
      {exportMenuSession && (
        <div className="fixed inset-0 z-[10000]" onClick={() => setExportMenuSession(null)}>
          <div className="absolute bg-card border border-border/80 rounded-xl shadow-xl py-1 w-36"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-foreground/80 hover:bg-accent/60 transition-colors"
              onClick={() => { handleExportSession(exportMenuSession, 'json'); setExportMenuSession(null) }}
            >
              <Download className="size-3.5" />
              导出为 JSON
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-foreground/80 hover:bg-accent/60 transition-colors"
              onClick={() => { handleExportSession(exportMenuSession, 'markdown'); setExportMenuSession(null) }}
            >
              <Download className="size-3.5" />
              导出为 Markdown
            </button>
          </div>
        </div>
      )}

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
