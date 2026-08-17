'use client'

import { useCallback, useEffect, useState } from 'react'
import { History, Loader2, RotateCcw, FileDiff, X } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { hermesApi } from '@/lib/electron-bridge'
import { resolveBackendSid } from '@/lib/session-map'

interface Checkpoint {
  hash: string
  timestamp: string
  message: string
}

interface RollbackPanelProps {
  sessionId: string
  onClose: () => void
}

/** 回滚检查点面板：列出现有会话的检查点，可查看 diff、按检查点恢复。
 *  对应后端 rollback.list / rollback.diff / rollback.restore。 */
export function RollbackPanel({ sessionId, onClose }: RollbackPanelProps) {
  const [enabled, setEnabled] = useState(true)
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeHash, setActiveHash] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ stat: string; diff: string } | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)

  const resolveSid = useCallback(async (): Promise<string | null> => {
    return resolveBackendSid(sessionId)
  }, [sessionId])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const sid = await resolveSid()
      if (!sid) { setEnabled(false); setCheckpoints([]); setLoading(false); return }
      const r = await hermesApi()!.send('rollback.list', { session_id: sid }) as any
      setEnabled(r?.enabled !== false)
      setCheckpoints(Array.isArray(r?.checkpoints) ? r.checkpoints : [])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [resolveSid])

  useEffect(() => { load() }, [load])

  const viewDiff = useCallback(async (hash: string) => {
    setActiveHash(hash)
    setDiff(null)
    setDiffLoading(true)
    try {
      const sid = await resolveSid()
      if (!sid) return
      const r = await hermesApi()!.send('rollback.diff', { session_id: sid, hash }) as any
      setDiff({ stat: r?.stat || '', diff: r?.diff || '' })
    } catch (e) {
      setDiff({ stat: '', diff: String(e) })
    } finally {
      setDiffLoading(false)
    }
  }, [resolveSid])

  const restore = useCallback(async (hash: string) => {
    setRestoring(true)
    try {
      const sid = await resolveSid()
      if (!sid) throw new Error('无法解析后端会话')
      const r = await hermesApi()!.send('rollback.restore', { session_id: sid, hash }) as any
      if (r?.success) {
        useHelixStore.getState().showToast({
          type: 'success',
          title: '已恢复到检查点',
          description: r.restored_to || hash.slice(0, 8),
        })
      } else {
        useHelixStore.getState().showToast({ type: 'error', title: '恢复失败', description: r?.error || '未知错误' })
      }
    } catch (e) {
      useHelixStore.getState().showToast({ type: 'error', title: '恢复失败', description: String(e) })
    } finally {
      setRestoring(false)
    }
  }, [resolveSid])

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card border border-border/60 rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <History className="size-4 text-violet-400" />
            <h2 className="text-[length:var(--helix-transcript-size)] font-semibold">回滚检查点</h2>
            <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-full">
              {checkpoints.length} 个
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-foreground/50 hover:text-foreground hover:bg-accent/60 transition-colors"
            data-tip="关闭"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="px-5 py-12 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-red-400">{error}</div>
          ) : !enabled ? (
            <div className="px-5 py-12 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
              当前会话未启用检查点（需配置 checkpoints 后在新会话生效）。
            </div>
          ) : checkpoints.length === 0 ? (
            <div className="px-5 py-12 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
              暂无检查点。
            </div>
          ) : (
            checkpoints.map((cp) => (
              <div key={cp.hash} className="border border-border/40 rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 hover:bg-accent/30 cursor-pointer transition-colors"
                  onClick={() => viewDiff(cp.hash)}>
                  <span className="font-mono text-[calc(var(--helix-transcript-size)*0.7857)] text-primary/80">{cp.hash.slice(0, 8)}</span>
                  <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)]">
                    {cp.message || cp.timestamp || '检查点'}
                  </span>
                  <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground shrink-0">{cp.timestamp}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); restore(cp.hash) }}
                    disabled={restoring}
                    className="p-1.5 rounded-lg text-foreground/50 hover:text-foreground hover:bg-accent/60 transition-colors shrink-0 disabled:opacity-40"
                    data-tip="恢复到此检查点"
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                </div>
                {activeHash === cp.hash && (
                  <div className="border-t border-border/40 bg-muted/20 px-3 py-2">
                    {diffLoading ? (
                      <div className="flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" /> 加载 diff…
                      </div>
                    ) : diff ? (
                      <div>
                        {diff.stat && <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/70 mb-1 font-mono">{diff.stat}</p>}
                        <pre className="text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/80 overflow-x-auto whitespace-pre-wrap break-all max-h-64 overflow-y-auto">{diff.diff}</pre>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-border/50">
          <div className="flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60">
            <FileDiff className="size-3" />
            点击检查点查看 diff，点右侧按钮恢复
          </div>
          <button
            onClick={load}
            className="px-3 py-1.5 rounded-lg border border-border/50 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/70 hover:bg-accent/50 transition-colors"
          >
            刷新
          </button>
        </div>
      </div>
    </div>
  )
}