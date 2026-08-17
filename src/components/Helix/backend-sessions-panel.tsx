'use client'

import { useCallback, useEffect, useState } from 'react'
import { FolderKanban, Loader2, Play, Trash2, Eye, EyeOff, X } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { hermesApi } from '@/lib/electron-bridge'
import { timeAgo } from '@/lib/format'
import { resolveBackendSid } from '@/lib/session-map'

interface LiveSession {
  current: boolean
  id: string
  last_active: number
  message_count: number
  model: string
  preview: string
  session_key: string
  started_at: number
  status: string
  title: string
}

interface BackendSessionsPanelProps {
  sessionId: string
  onClose: () => void
}

// 后端 last_active/started_at 是 epoch 秒（float），timeAgo 需要毫秒。
function epochToMs(sec: number): number {
  return sec > 1e12 ? sec : sec * 1000
}

/** 后端会话管理面板：session.active_list 列出现有会话，支持激活 / 删除 / 隐藏。 */
export function BackendSessionsPanel({ sessionId, onClose }: BackendSessionsPanelProps) {
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Record<string, boolean>>({})

  const currentSid = useCallback(async () => resolveBackendSid(sessionId), [sessionId])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await hermesApi()!.send('session.active_list', { current_session_id: (await currentSid()) || '' }) as any
      setSessions(Array.isArray(r?.sessions) ? r.sessions : [])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [currentSid])

  useEffect(() => { load() }, [load])

  const activate = useCallback(async (sid: string) => {
    setBusy(sid)
    try {
      await hermesApi()!.send('session.activate', { session_id: sid, omit_messages: true })
      useHelixStore.getState().showToast({ type: 'success', title: '已激活会话' })
    } catch (e) {
      useHelixStore.getState().showToast({ type: 'error', title: '激活失败', description: String(e) })
    } finally {
      setBusy(null)
    }
  }, [])

  const toggleHidden = useCallback(async (sid: string, cur: boolean) => {
    setBusy(sid)
    try {
      const r = await hermesApi()!.send('session.set_hidden', { session_id: sid, hidden: !cur }) as any
      setHidden(h => ({ ...h, [sid]: r?.hidden ?? !cur }))
      useHelixStore.getState().showToast({ type: 'success', title: r?.hidden ? '已隐藏' : '已取消隐藏' })
    } catch (e) {
      useHelixStore.getState().showToast({ type: 'error', title: '操作失败', description: String(e) })
    } finally {
      setBusy(null)
    }
  }, [])

  const del = useCallback(async (sid: string) => {
    setBusy(sid)
    try {
      const r = await hermesApi()!.send('session.delete', { session_id: sid }) as any
      if (r?.deleted) {
        setSessions(prev => prev.filter(s => s.id !== sid))
        useHelixStore.getState().showToast({ type: 'success', title: '会话已删除' })
      } else {
        useHelixStore.getState().showToast({ type: 'error', title: '删除失败', description: '会话仍处于活动状态' })
      }
    } catch (e) {
      useHelixStore.getState().showToast({ type: 'error', title: '删除失败', description: String(e) })
    } finally {
      setBusy(null)
    }
  }, [])

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card border border-border/60 rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <FolderKanban className="size-4 text-blue-400" />
            <h2 className="text-[length:var(--helix-transcript-size)] font-semibold">后端会话</h2>
            <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-full">
              {sessions.length} 个活动会话
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={load}
              className="px-3 py-1.5 rounded-lg border border-border/50 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/70 hover:bg-accent/50 transition-colors"
            >
              刷新
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-foreground/50 hover:text-foreground hover:bg-accent/60 transition-colors"
              data-tip="关闭"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-1.5">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="px-5 py-12 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-red-400">{error}</div>
          ) : sessions.length === 0 ? (
            <div className="px-5 py-12 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
              后端没有活动会话。
            </div>
          ) : (
            sessions.map((s) => {
              const isHidden = hidden[s.id] ?? false
              return (
                <div
                  key={s.id}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border border-border/40 ${s.current ? 'bg-primary/5 border-primary/20' : ''}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium truncate">
                        {s.title || '(无标题)'}
                      </p>
                      {s.current && (
                        <span className="text-[calc(var(--helix-transcript-size)*0.6429)] text-primary bg-primary/10 px-1.5 py-0.5 rounded-full shrink-0">当前</span>
                      )}
                      {isHidden && (
                        <span className="text-[calc(var(--helix-transcript-size)*0.6429)] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-full shrink-0">已隐藏</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
                      <span className="font-mono">{s.id}</span>
                      <span>{s.message_count} 条</span>
                      <span>{s.status}</span>
                      {s.last_active > 0 && <span>{timeAgo(epochToMs(s.last_active))}</span>}
                    </div>
                    {s.preview && (
                      <p className="mt-0.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/70 truncate">{s.preview}</p>
                    )}
                  </div>
                  <button
                    onClick={() => activate(s.id)}
                    disabled={busy === s.id}
                    className="p-1.5 rounded-lg text-foreground/50 hover:text-foreground hover:bg-accent/60 transition-colors shrink-0 disabled:opacity-40"
                    data-tip="激活"
                  >
                    <Play className="size-3.5" />
                  </button>
                  <button
                    onClick={() => toggleHidden(s.id, isHidden)}
                    disabled={busy === s.id}
                    className="p-1.5 rounded-lg text-foreground/50 hover:text-foreground hover:bg-accent/60 transition-colors shrink-0 disabled:opacity-40"
                    data-tip={isHidden ? '取消隐藏' : '隐藏'}
                  >
                    {isHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                  </button>
                  <button
                    onClick={() => del(s.id)}
                    disabled={busy === s.id || s.current}
                    className="p-1.5 rounded-lg text-destructive/60 hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0 disabled:opacity-40"
                    data-tip={s.current ? '当前会话不能删除' : '删除'}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}