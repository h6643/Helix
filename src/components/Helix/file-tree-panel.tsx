'use client'

import {
  File,
  FileText,
  Folder,
  FolderOpen,
  ChevronRight,
  RefreshCw,
  Loader2,
  GitBranch,
} from 'lucide-react'
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { isElectron, electronGit, electronFS } from '@/lib/electron-bridge'
import { useHelixStore } from '@/stores/helix-store'

interface FileTreeItem {
  name: string
  path: string
  isDirectory: boolean
  children?: FileTreeItem[]
  expanded?: boolean
}

interface FileTreePanelProps {
  /** Called after a file's content has been loaded into the editor store, so
   *  the parent can surface the code page (the pages model, not rightSidebarTab,
   *  drives which view is visible). */
  onOpenFile?: () => void
}

// Pastel folder tints for the warm cream workspace, matching the
// colorful sidebar in the reference screenshot.
const FOLDER_COLORS = [
  'oklch(0.72 0.14 25)',
  'oklch(0.74 0.16 55)',
  'oklch(0.80 0.14 95)',
  'oklch(0.76 0.13 125)',
  'oklch(0.74 0.13 155)',
  'oklch(0.74 0.12 185)',
  'oklch(0.74 0.13 245)',
  'oklch(0.74 0.14 300)',
  'oklch(0.76 0.14 340)',
]

function folderColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return FOLDER_COLORS[hash % FOLDER_COLORS.length]
}

function parsePorcelainV2(output: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of output.split('\n')) {
    if (!line || line.startsWith('#')) continue
    // Rename/copy:  2 XY ... <X?> <score?> path
    if (line.startsWith('2 ')) {
      const parts = line.split(/\s+/)
      const path = parts[parts.length - 1]
      let st = ''
      if (parts[1] && parts[1].length >= 2) {
        const idx = parts[1].indexOf('.')
        if (idx <= 0) st = parts[1][0]
        else st = parts[1].slice(0, idx)
      }
      map.set(path, st || 'R')
      continue
    }
    // Unmerged:      u XY ...
    if (line.startsWith('u ')) {
      const parts = line.split(/\s+/)
      const path = parts[parts.length - 1]
      map.set(path, 'U')
      continue
    }
    // Regular:       1 XY ...
    if (line.startsWith('1 ')) {
      const parts = line.split(/\s+/)
      const path = parts[parts.length - 1]
      if (!parts[1]) continue
      const staged = parts[1][0]
      const unstaged = parts[1][1]
      let label = ''
      if (staged !== '.') label += staged
      if (unstaged !== '.') label += unstaged
      map.set(path, label || 'M')
      continue
    }
    // Untracked:     ? path
    if (line.startsWith('? ')) {
      const path = line.slice(2).trim()
      if (path) map.set(path, '?')
      continue
    }
    // Ignored:       ! path
    if (line.startsWith('! ')) {
      const path = line.slice(2).trim()
      if (path) map.set(path, '!')
      continue
    }
  }
  return map
}

const STATUS_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  M: { label: 'M', color: 'text-amber-400', bg: 'bg-amber-400/10' },
  A: { label: 'A', color: 'text-emerald-400', bg: 'bg-emerald-400/10' },
  D: { label: 'D', color: 'text-red-400', bg: 'bg-red-400/10' },
  '?': { label: '?', color: 'text-blue-400', bg: 'bg-blue-400/10' },
  R: { label: 'R', color: 'text-purple-400', bg: 'bg-purple-400/10' },
  C: { label: 'C', color: 'text-purple-400', bg: 'bg-purple-400/10' },
  U: { label: 'U', color: 'text-orange-400', bg: 'bg-orange-400/10' },
  '!': { label: '!', color: 'text-muted-foreground/30', bg: 'bg-muted-foreground/5' },
}

function getStatusStyle(code: string) {
  if (code === '?') return STATUS_STYLES['?']
  if (code.startsWith('M') || code.endsWith('M')) return STATUS_STYLES.M
  if (code.startsWith('A') || code.endsWith('A')) return STATUS_STYLES.A
  if (code.startsWith('D') || code.endsWith('D')) return STATUS_STYLES.D
  if (code.startsWith('R') || code.endsWith('R')) return STATUS_STYLES.R
  if (code.startsWith('C') || code.endsWith('C')) return STATUS_STYLES.C
  if (code.startsWith('U') || code.endsWith('U')) return STATUS_STYLES.U
  if (code === '!') return STATUS_STYLES['!']
  return null
}

function ExtensionIcon({ name, className }: { name: string; className?: string }) {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : ''
  const colorMap: Record<string, string> = {
    ts: 'text-blue-400',
    tsx: 'text-blue-400',
    js: 'text-yellow-400',
    jsx: 'text-yellow-400',
    json: 'text-orange-400',
    md: 'text-sky-400',
    css: 'text-pink-400',
    scss: 'text-pink-400',
    html: 'text-orange-400',
    py: 'text-blue-300',
    go: 'text-cyan-400',
    rs: 'text-orange-500',
    yaml: 'text-cyan-400',
    yml: 'text-cyan-400',
    toml: 'text-green-400',
    vue: 'text-emerald-400',
    svelte: 'text-orange-400',
    java: 'text-red-400',
    cpp: 'text-pink-300',
    c: 'text-blue-400',
    h: 'text-purple-400',
  }
  return <FileText className={`size-4 shrink-0 ${ext && colorMap[ext] ? colorMap[ext] : 'text-muted-foreground/60'} ${className || ''}`} />
}

export function FileTreePanel({ onOpenFile }: FileTreePanelProps) {
  const selectedWorkDir = useHelixStore(s => s.selectedWorkDir)
  const showToast = useHelixStore(s => s.showToast)
  const openFileInEditor = useHelixStore(s => s.openFileInEditor)
  const [items, setItems] = useState<FileTreeItem[]>([])
  const [gitStatus, setGitStatus] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [branchName, setBranchName] = useState('')
  const showHidden = false

  const loadTree = useCallback(async () => {
    if (!isElectron() || !selectedWorkDir) {
      setLoading(false)
      setError(!selectedWorkDir ? 'No directory selected' : 'File tree is only available in desktop mode')
      return
    }
    setLoading(true)
    setError(null)
    // Load git status
    try {
      const gitResult = await electronGit.status()
      if (gitResult.ok && gitResult.output) {
        const lines = gitResult.output.split('\n')
        for (const line of lines) {
          const m = line.match(/^# branch\.head (.+)$/)
          if (m) { setBranchName(m[1]); break }
        }
        setGitStatus(parsePorcelainV2(gitResult.output))
      }
    } catch {}
    // Load directory listing — recursive via scanTree
    try {
      const api = (window as any).electron
      let tree: FileTreeItem[] = []
      if (api?.fs?.scanTree) {
        const raw = (await api.fs.scanTree()) as Array<{ id: string; name: string; type: 'file' | 'folder'; children?: any[] }>
        function convert(rawList: Array<{ name: string; type: string; children?: any[] }>, prefix: string): FileTreeItem[] {
          const result: FileTreeItem[] = []
          for (const item of rawList) {
            if (item.name.startsWith('.') && !showHidden) continue
            const path = prefix ? `${prefix}/${item.name}` : item.name
            if (item.type === 'folder' && item.children) {
              const children = convert(item.children, path)
              result.push({ name: item.name, path, isDirectory: true, children, expanded: false })
            } else {
              result.push({ name: item.name, path, isDirectory: false })
            }
          }
          result.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
            return a.name.localeCompare(b.name)
          })
          return result
        }
        tree = convert(raw, '')
      } else {
        // Fallback: load only root
        const entries = await api.fs.readdir() as Array<{ name: string; isDirectory: boolean }>
        for (const e of entries) {
          if (e.name.startsWith('.') && !showHidden) continue
          tree.push({ name: e.name, path: e.name, isDirectory: e.isDirectory })
        }
        tree.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      }
      setItems(tree)
    } catch (e: any) {
      setError(e.message || 'Failed to load file tree')
    }
    setLoading(false)
  }, [selectedWorkDir, showHidden])

  useEffect(() => { loadTree() }, [loadTree])

  const toggleExpand = async (item: FileTreeItem) => {
    if (!item.isDirectory) return
    if (item.expanded) {
      item.expanded = false
      setItems([...items])
      return
    }
    item.expanded = true
    // If children not loaded (fallback path), load them
    if (!item.children || item.children.length === 0) {
      try {
        const api = (window as any).electron
        const entries = await api.fs.readdir(item.path) as Array<{ name: string; isDirectory: boolean }>
        const children: FileTreeItem[] = []
        for (const e of entries) {
          if (e.name.startsWith('.') && !showHidden) continue
          children.push({ name: e.name, path: `${item.path}/${e.name}`, isDirectory: e.isDirectory })
        }
        children.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        item.children = children
      } catch {}
    }
    setItems([...items])
  }

  const handleFileClick = (item: FileTreeItem) => {
    if (item.isDirectory) {
      toggleExpand(item)
    } else {
      openFileInEditorAction(item)
    }
  }

  // Known non-text (binary) extensions — opened in the editor would be garbage.
  const BINARY_EXT = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'pdf', 'zip',
    'tar', 'gz', 'tgz', 'rar', '7z', 'exe', 'dll', 'so', 'dylib', 'bin',
    'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp3', 'mp4', 'mov', 'avi', 'mkv',
    'webm', 'wav', 'flac', 'class', 'pyc', 'o', 'obj', 'a', 'lib', 'db',
  ])

  const openFileInEditorAction = async (item: FileTreeItem) => {
    const ext = item.name.includes('.') ? item.name.split('.').pop()!.toLowerCase() : ''
    if (BINARY_EXT.has(ext)) {
      showToast({ type: 'error', title: '无法编辑', description: `${item.name} 是二进制文件` })
      return
    }
    try {
      const content = await electronFS.readFile(item.path)
      if (content == null) throw new Error('读取为空')
      if (content.length > 1_000_000) {
        showToast({ type: 'error', title: '文件过大', description: `${item.name} 超过 1MB，暂不支持在编辑器打开` })
        return
      }
      // Reject files that look binary (null bytes in the first 4KB).
      if (/[\u0000-\u0008]/.test(content.slice(0, 4096))) {
        showToast({ type: 'error', title: '无法编辑', description: `${item.name} 不是文本文件` })
        return
      }
      openFileInEditor(item.path, item.name, content)
      onOpenFile?.()
    } catch (e: any) {
      showToast({ type: 'error', title: '打开失败', description: e?.message || '读取文件出错' })
    }
  }

  const handleOpenInFolder = (item: FileTreeItem) => {
    const api = (window as any).electron
    if (api?.shell?.showItemInFolder) {
      api.shell.showItemInFolder(`${selectedWorkDir}/${item.path}`)
    }
  }

  function renderTree(items: FileTreeItem[], depth: number = 0): React.ReactNode {
    return items.map((item) => {
      const status = gitStatus.get(item.path)
      const style = status ? getStatusStyle(status) : null
      const isTopFolder = item.isDirectory && depth === 0
      const bg = isTopFolder ? folderColor(item.name) : undefined
      return (
        <div key={item.path}>
          <div
            className={`flex items-center gap-1 px-2 py-0.5 cursor-pointer rounded-md group text-[13px] transition-colors ${
              item.isDirectory ? 'hover:brightness-95' : 'hover:bg-accent/40'
            }`}
            style={{
              paddingLeft: `${depth * 16 + 8}px`,
              ...(bg ? { backgroundColor: bg } : {}),
            }}
            onClick={() => handleFileClick(item)}
            onContextMenu={(e) => {
              e.preventDefault()
              handleOpenInFolder(item)
            }}
          >
            {item.isDirectory ? (
              <ChevronRight
                className={`size-3.5 shrink-0 transition-transform duration-150 ${
                  bg ? 'text-white/80' : 'text-muted-foreground/40'
                } ${item.expanded ? 'rotate-90' : ''}`}
              />
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            {item.isDirectory ? (
              item.expanded ? (
                <FolderOpen className={`size-4 shrink-0 ${bg ? 'text-white/90' : 'text-amber-400/70'}`} />
              ) : (
                <Folder className={`size-4 shrink-0 ${bg ? 'text-white/80' : 'text-amber-400/60'}`} />
              )
            ) : (
              <ExtensionIcon name={item.name} />
            )}
            <span className={`truncate flex-1 ${bg ? 'text-white' : 'text-foreground/80'}`}>{item.name}</span>
            {style && (
              <span
                className={`shrink-0 text-[10px] font-bold w-4 h-4 flex items-center justify-center rounded ${style.color} ${style.bg}`}
                title={status || ''}
              >
                {style.label}
              </span>
            )}
          </div>
          {item.isDirectory && item.expanded && item.children && (
            renderTree(item.children, depth + 1)
          )}
        </div>
      )
    })
  }

  return (
    <div className="h-full w-full bg-sidebar flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-sidebar-border/60">
        <div className="flex items-center gap-1.5 min-w-0">
          {branchName && (
            <>
              <GitBranch className="size-3 text-muted-foreground/50 shrink-0" />
              <span className="text-[11px] text-muted-foreground/60 truncate font-mono">{branchName}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => loadTree()}
            className="p-1 rounded text-muted-foreground/30 hover:text-foreground/60 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1 text-sm">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground/40">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-xs">Loading...</span>
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-xs text-muted-foreground/50">{error}</div>
        ) : items.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground/30">Empty directory</div>
        ) : (
          renderTree(items)
        )}
      </div>
    </div>
  )
}
