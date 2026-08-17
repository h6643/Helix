'use client'

import { useCallback, useEffect, useState } from 'react'
import { FolderTree, Loader2, Folder, RefreshCw, X } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { hermesApi } from '@/lib/electron-bridge'

interface ProjectLane {
  id: string
  label: string
  path: string
  kind: string
  session_ids?: string[]
}

interface ProjectsPayload {
  projects: ProjectLane[]
  active_id?: string | null
  scoped_session_ids?: string[]
}

/** 项目发现面板：projects.tree 列出后端扫描到的项目 / 仓库，可刷新或激活。 */
export function ProjectsPanel({ onClose }: { onClose: () => void }) {
  const [payload, setPayload] = useState<ProjectsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await hermesApi()!.send('projects.tree', { preview_limit: 3 }) as any
      setPayload({
        projects: Array.isArray(r?.projects) ? r.projects : [],
        active_id: r?.active_id ?? null,
        scoped_session_ids: Array.isArray(r?.scoped_session_ids) ? r.scoped_session_ids : [],
      })
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const setActive = useCallback(async (id: string | null) => {
    try {
      const r = await hermesApi()!.send('projects.set_active', id ? { id } : {}) as any
      setPayload(prev => prev ? { ...prev, active_id: r?.active_id ?? null } : prev)
      useHelixStore.getState().showToast({ type: 'success', title: id ? '已设为当前项目' : '已清除当前项目' })
    } catch (e) {
      useHelixStore.getState().showToast({ type: 'error', title: '操作失败', description: String(e) })
    }
  }, [])

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card border border-border/60 rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <FolderTree className="size-4 text-emerald-400" />
            <h2 className="text-[length:var(--helix-transcript-size)] font-semibold">项目发现</h2>
            <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-full">
              {payload?.projects.length ?? 0} 个项目
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={load}
              className="p-1.5 rounded-lg text-foreground/50 hover:text-foreground hover:bg-accent/60 transition-colors"
              data-tip="重新扫描"
            >
              <RefreshCw className="size-3.5" />
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
          ) : !payload || payload.projects.length === 0 ? (
            <div className="px-5 py-12 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
              后端未扫描到项目。可尝试用「重新扫描」触发一次磁盘扫描。
            </div>
          ) : (
            payload.projects.map((p) => {
              const isActive = payload.active_id === p.id
              return (
                <div
                  key={p.id}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border border-border/40 ${isActive ? 'bg-primary/5 border-primary/20' : ''}`}
                >
                  <div className="w-8 h-8 rounded-xl bg-emerald-500/10 flex items-center justify-center shrink-0">
                    <Folder className="size-4 text-emerald-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium truncate">{p.label}</p>
                      {isActive && (
                        <span className="text-[calc(var(--helix-transcript-size)*0.6429)] text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded-full shrink-0">当前</span>
                      )}
                    </div>
                    <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground font-mono truncate mt-0.5">{p.path}</p>
                    {p.session_ids && p.session_ids.length > 0 && (
                      <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60 mt-0.5">
                        {p.session_ids.length} 个关联会话
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => setActive(isActive ? null : p.id)}
                    className="px-3 py-1.5 rounded-lg border border-border/50 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/70 hover:bg-accent/50 transition-colors shrink-0"
                  >
                    {isActive ? '清除' : '设为当前'}
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