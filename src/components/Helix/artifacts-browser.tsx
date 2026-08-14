'use client'

import { X, FolderOpen, FileText, ArrowUp, Loader2, ExternalLink, Folder } from 'lucide-react'
import React, { useState, useEffect, useCallback } from 'react'
import { electronFS, electronDialog, electronShell } from '@/lib/electron-bridge'

interface TreeNode {
  id: string
  name: string
  type: string
  children?: TreeNode[]
}

// Browse artifact / generated files via the existing fs bridge. Default roots
// to the project workdir; supports navigating into folders.
export function ArtifactsBrowser({ onClose }: { onClose: () => void }) {
  const [root, setRoot] = useState<string>('')
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [content, setContent] = useState<{ name: string; text: string } | null>(null)

  const load = useCallback(async (dir: string) => {
    setLoading(true)
    setErr(null)
    setContent(null)
    try {
      const nodes = await electronFS.scanTree(dir || undefined)
      setTree(Array.isArray(nodes) ? (nodes as TreeNode[]) : [])
      setRoot(dir)
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load('')
  }, [load])

  const openDir = async () => {
    const dir = await electronDialog.openDirectory()
    if (dir) load(dir)
  }

  const readFile = async (path: string, name: string) => {
    setLoading(true)
    try {
      const text = await electronFS.readFile(path)
      setContent({ name, text: typeof text === 'string' ? text : String(text) })
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  const renderNodes = (nodes: TreeNode[], depth = 0) =>
    nodes.map((n) => (
      <div key={n.id}>
        <div
          className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent/30 cursor-pointer"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (n.type === 'directory' ? load(n.id) : readFile(n.id, n.name))}
        >
          {n.type === 'directory' ? (
            <Folder className="size-3.5 text-amber-400/80 shrink-0" />
          ) : (
            <FileText className="size-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="text-[calc(var(--helix-transcript-size)*0.8571)] truncate flex-1">{n.name}</span>
          {n.type !== 'directory' && (
            <button
              className="opacity-0 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                electronShell.open(n.id)
              }}
            >
              <ExternalLink className="size-3 text-muted-foreground" />
            </button>
          )}
        </div>
        {n.children && renderNodes(n.children, depth + 1)}
      </div>
    ))

  return (
    <div className="fixed inset-0 z-[9998] flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-sm h-full bg-card border-l border-border/60 shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-4 text-primary" />
            <h2 className="text-[var(--helix-transcript-size)] font-semibold">产物浏览器</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent/60">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/70">
          <button onClick={openDir} className="flex items-center gap-1 hover:text-foreground">
            <FolderOpen className="size-3" /> 选择目录
          </button>
          <span className="truncate flex-1">{root || '（项目工作目录）'}</span>
          {root && (
            <button onClick={() => load('')} className="hover:text-foreground">
              <ArrowUp className="size-3" />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60 mt-6">
              <Loader2 className="size-3.5 animate-spin" /> 加载中…
            </div>
          ) : err ? (
            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-red-400 mt-6">{err}</p>
          ) : content ? (
            <div>
              <div className="flex items-center justify-between px-1 py-1">
                <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium truncate">{content.name}</span>
                <button onClick={() => setContent(null)} className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground hover:text-foreground">
                  返回
                </button>
              </div>
              <pre className="text-[calc(var(--helix-transcript-size)*0.7857)] whitespace-pre-wrap break-all max-h-[60vh] overflow-auto bg-muted/40 rounded-lg p-2">
                {content.text.slice(0, 20000)}
              </pre>
            </div>
          ) : tree.length === 0 ? (
            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60 text-center mt-8">空目录</p>
          ) : (
            <div className="group">{renderNodes(tree)}</div>
          )}
        </div>
      </div>
    </div>
  )
}
