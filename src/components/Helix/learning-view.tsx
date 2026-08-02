'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { electronFS, electronShell } from '@/lib/electron-bridge'
import { SectionHeading } from './settings-ui'

interface MemNode {
  name: string
  path: string
  isDir: boolean
}

// Read-only view of Hermes learning / memory. The gateway's `/api/learning`
// REST endpoint isn't exposed over Helix's stdio gateway, so we read the local
// memory store directly via the fs bridge (read-only).
//
// NOTE: the memory dir is fetched from the MAIN process via electronFS.memoryDir()
// — never derived from process.env.LOCALAPPDATA in the renderer. In a Next.js
// client bundle `process.env.LOCALAPPDATA` is undefined at runtime, which used
// to produce a bogus "/hermes/memory" path rejected by the fs sandbox.
export function LearningView({ onClose }: { onClose?: () => void }) {
  const [nodes, setNodes] = useState<MemNode[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [active, setActive] = useState<{ name: string; path: string; text: string } | null>(null)
  const [revealErr, setRevealErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    setActive(null)
    try {
      const MEMORY_DIR = await electronFS.memoryDir()
      if (!MEMORY_DIR) throw new Error('无法获取 Hermes 记忆目录（非 Electron 环境？）')
      const list = await electronFS.readDir(MEMORY_DIR)
      setNodes(
        (list as { name: string; isDirectory: boolean }[])
          // Skip editor/process lockfiles and dotfiles — they are not memory
          // content (e.g. MEMORY.md.lock is Hermes's concurrent-write lock).
          .filter((n) => !n.name.startsWith('.') && !n.name.endsWith('.lock'))
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
      setActive({ name: n.name, path: n.path, text: typeof text === 'string' ? text : String(text) })
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-xl space-y-1">
      <div className="flex items-center justify-between">
        <SectionHeading>Memory</SectionHeading>
        <button onClick={load} className="px-1.5 py-1 rounded-lg text-xs text-muted-foreground hover:bg-accent/60" title="刷新">
          刷新
        </button>
      </div>
      {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground/60 mt-6">
            读取中…
          </div>
        ) : err ? (
          <p className="text-xs text-red-400 mt-6">{err}</p>
        ) : active ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <button onClick={() => setActive(null)} className="text-[11px] text-muted-foreground hover:text-foreground">
                ← 返回列表
              </button>
                <button
                  onClick={async () => {
                    setRevealErr(null)
                    try {
                      const res = await electronShell.showItemInFolder(active.path) as unknown as { ok?: boolean; error?: string } | undefined
                      if (res && res.ok === false) {
                        setRevealErr(`无法打开：${res.error || '未知错误'}（多半是主进程未彻底重启）`)
                      }
                    } catch (e: any) {
                      setRevealErr(String(e?.message || e))
                    }
                  }}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  title="在资源管理器中打开文件位置"
                >
                  打开位置
                </button>
            </div>
            {revealErr && <p className="text-[10px] text-red-400 mb-1">{revealErr}</p>}
            <h3 className="text-sm font-medium mb-1">{active.name}</h3>
            <pre className="text-sm whitespace-pre-wrap break-all max-h-[60vh] overflow-auto bg-muted/40 rounded-lg p-2">
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
                <span className="text-xs truncate">{n.name}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  )
}
