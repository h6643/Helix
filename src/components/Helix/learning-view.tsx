'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { Brain, FileText, Loader2, RefreshCw } from 'lucide-react'
import { electronFS } from '@/lib/electron-bridge'

const MEMORY_DIR = `${process.env.LOCALAPPDATA || ''}/hermes/memory`.replace(/\\/g, '/')

interface MemNode {
  name: string
  path: string
  isDir: boolean
}

// Read-only view of Hermes learning / memory. The gateway's `/api/learning`
// REST endpoint isn't exposed over Helix's stdio gateway, so we read the local
// memory store directly via the fs bridge (read-only).
export function LearningView({ onClose }: { onClose?: () => void }) {
  const [nodes, setNodes] = useState<MemNode[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [active, setActive] = useState<{ name: string; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    setActive(null)
    try {
      const list = await electronFS.readDir(MEMORY_DIR)
      setNodes(
        (list as { name: string; isDirectory: boolean }[])
          .map((n) => ({ name: n.name, path: `${MEMORY_DIR}/${n.name}`.replace(/\\/g, '/'), isDir: n.isDirectory }))
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
      )
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const open = async (n: MemNode) => {
    if (n.isDir) return
    setLoading(true)
    try {
      const text = await electronFS.readFile(n.path)
      setActive({ name: n.name, text: typeof text === 'string' ? text : String(text) })
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <Brain className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">学习 / 记忆</h2>
        </div>
        <button onClick={load} className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent/60" title="刷新">
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground/60 mt-6">
            <Loader2 className="size-3.5 animate-spin" /> 读取中…
          </div>
        ) : err ? (
          <p className="text-xs text-red-400 mt-6">{err}</p>
        ) : active ? (
          <div>
            <button onClick={() => setActive(null)} className="text-[11px] text-muted-foreground hover:text-foreground mb-2">
              ← 返回列表
            </button>
            <h3 className="text-xs font-medium mb-1">{active.name}</h3>
            <pre className="text-[11px] whitespace-pre-wrap break-all max-h-[60vh] overflow-auto bg-muted/40 rounded-lg p-2">
              {active.text.slice(0, 20000)}
            </pre>
          </div>
        ) : nodes.length === 0 ? (
          <p className="text-xs text-muted-foreground/60 text-center mt-8">暂无学习记录</p>
        ) : (
          <div className="space-y-1">
            {nodes.map((n) => (
              <div
                key={n.path}
                onClick={() => open(n)}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-accent/30 ${n.isDir ? 'cursor-default' : 'cursor-pointer'}`}
              >
                <FileText className="size-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs truncate">{n.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="px-4 py-2 border-t border-border/60 text-[10px] text-muted-foreground/50">
        只读视图 · 数据来自本地 Hermes 记忆目录
      </div>
    </div>
  )
}
