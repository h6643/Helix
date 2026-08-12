'use client'

import { Globe, FolderTree, FileCode2, FileDiff, Maximize2, Minimize2, Plus, X, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cleanUrl } from '@/lib/url-utils'
import { useHelixStore } from '@/stores/helix-store'
import { CodeEditorPanel } from './code-editor-panel'
import { DiffSidebarPanel } from './diff-sidebar-panel'
import { FileTreePanel } from './file-tree-panel'
import { BrowserView, summarizeUrl } from './preview-rail'

type PageKind = 'browser' | 'directory' | 'code' | 'diff'
interface PanelPage {
  id: string
  kind: PageKind
  url: string
}

let pageSeq = 0
const newPageId = () => `pg-${++pageSeq}`

// Resizable file-tree column in the fullscreen split view.
const TREE_COL_MIN = 220
const TREE_COL_MAX = 560
const TREE_COL_DEFAULT = 300
const TREE_STORAGE_KEY = 'helix:split-tree-width'

function loadTreeWidth(): number {
  if (typeof localStorage === 'undefined') return TREE_COL_DEFAULT
  try {
    const v = localStorage.getItem(TREE_STORAGE_KEY)
    if (v) {
      const n = parseInt(v, 10)
      if (n >= TREE_COL_MIN && n <= TREE_COL_MAX) return n
    }
  } catch {}
  return TREE_COL_DEFAULT
}

function saveTreeWidth(w: number) {
  try { localStorage.setItem(TREE_STORAGE_KEY, String(w)) } catch {}
}

/**
 * Right-hand sidebar as a tabbed workspace. Every "page" is one of:
 *  - browser  → a single BrowserView (one URL)
 *  - directory → the file tree
 *  - code      → the shared code editor (opened from the file tree)
 * All pages render the same inline tab bar in the header and can be added /
 * switched / closed independently (the "+" menu creates a new page).
 */
export function RightSidebar() {
  const tab = useHelixStore(s => s.rightSidebarTab)
  const setTab = useHelixStore(s => s.setRightSidebarTab)
  const previewRailUrl = useHelixStore(s => s.previewRailUrl)
  const browserBookmarks = useHelixStore(s => s.browserBookmarks)

  const [pages, setPages] = useState<PanelPage[]>(() => {
    const start = cleanUrl(previewRailUrl ?? '') || ''
    if (tab === 'files') return [{ id: newPageId(), kind: 'directory', url: '' }]
    if (tab === 'code') return [{ id: newPageId(), kind: 'code', url: '' }]
        if (tab === 'diff') return [{ id: newPageId(), kind: 'diff', url: '' }]
    return [{ id: newPageId(), kind: 'browser', url: start }]
  })
  const [activePageId, setActivePageId] = useState<string>(() => pages[0]?.id ?? '')

  // Ref to the whole sidebar so the fullscreen button only expands the panel,
  // not the entire conversation UI.
  const sidebarRef = useRef<HTMLDivElement>(null)

  // "Fullscreen" here is a CSS overlay (NOT the OS Fullscreen API): the panel
  // covers the whole main area below the app's top title bar. Using the native
  // requestFullscreen() would hide BOTH the app title bar AND the Windows
  // taskbar, which the user wants to keep visible.
  const [isExpanded, setIsExpanded] = useState(false)
  useEffect(() => {
    if (!isExpanded) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsExpanded(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isExpanded])

  // "+" panel-switcher dropdown.
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const plusBtnRef = useRef<HTMLButtonElement>(null)
  const plusMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!plusMenuOpen) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (plusBtnRef.current?.contains(target) || plusMenuRef.current?.contains(target)) return
      setPlusMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [plusMenuOpen])

  const activePageIdRef = useRef(activePageId)
  activePageIdRef.current = activePageId

  // External link (e.g. a message link click) → open / navigate a browser page.
  // Only reacts to changes AFTER mount: the initial `pages` state already seeds
  // a browser page from previewRailUrl, so a stale URL (e.g. from a previous
  // browser session) must not hijack other tabs like the diff panel into
  // showing a browser page on mount.
  const prevRailUrlRef = useRef(previewRailUrl)
  useEffect(() => {
    if (prevRailUrlRef.current === previewRailUrl) return
    prevRailUrlRef.current = previewRailUrl
    const url = cleanUrl(previewRailUrl ?? '')
    if (!url) return
    let addedId: string | null = null
    setPages(prev => {
      const active = prev.find(p => p.id === activePageIdRef.current)
      if (active?.kind === 'browser') {
        return prev.map(p => p.id === active.id ? { ...p, url } : p)
      }
      const np = { id: newPageId(), kind: 'browser' as const, url }
      addedId = np.id
      return [...prev, np]
    })
    if (addedId) setActivePageId(addedId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRailUrl])

  if (!tab) return null

  const updatePageUrl = (id: string, url: string) =>
    setPages(prev => prev.map(p => p.id === id ? { ...p, url } : p))

  const addPage = (kind: PageKind) => {
    const np = { id: newPageId(), kind, url: '' }
    setPages(prev => [...prev, np])
    setActivePageId(np.id)
    setPlusMenuOpen(false)
  }

  const closePage = (id: string) => {
    const idx = pages.findIndex(p => p.id === id)
    if (idx === -1) return
    const next = pages.filter(p => p.id !== id)
    if (next.length === 0) {
      setPages([])
      setTab(null)
      return
    }
    setPages(next)
    if (id === activePageId) {
      const neighbor = next[Math.min(idx, next.length - 1)]
      setActivePageId(neighbor.id)
    }
  }

  // Only one directory page is allowed at a time — disable the "目录" entry
  // while one already exists; it re-enables once that page is closed.
  const hasDirectory = pages.some(p => p.kind === 'directory')
  const hasCode = pages.some(p => p.kind === 'code')
  const hasDiff = pages.some(p => p.kind === 'diff')

  // VS Code–style split layout: when the sidebar is in fullscreen overlay mode
  // AND the active page is the directory, the whole overlay becomes a left/right
  // split — the left column shows the file tree, the right column shows the code
  // editor (exactly like VS Code's explorer + editor panes). Browser / code
  // pages keep the plain full-screen overlay behavior.
  // Split into file-tree + code editor whenever BOTH a directory page and a
  // code page exist, so entering fullscreen from a code tab still defaults the
  // left sidebar to the directory (VS Code–style) instead of a bare editor.
  const expandedSplit = isExpanded && hasDirectory && hasCode

  // Resizable file-tree column in the fullscreen split view.
  const [treeWidth, setTreeWidth] = useState(loadTreeWidth)
  // Bumped by the refresh button next to the 目录 tab; the file tree reloads.
  const [treeReloadKey, setTreeReloadKey] = useState(0)
  const treeDrag = useRef<{ startX: number; startW: number } | null>(null)
  const [treeDragging, setTreeDragging] = useState(false)
  const onTreeDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    treeDrag.current = { startX: e.clientX, startW: treeWidth }
    setTreeDragging(true)
  }, [treeWidth])
  useEffect(() => {
    if (!treeDragging) return
    document.body.style.userSelect = 'none'
    const onMove = (e: MouseEvent) => {
      const d = treeDrag.current
      if (!d) return
      const next = Math.max(TREE_COL_MIN, Math.min(TREE_COL_MAX, d.startW + (e.clientX - d.startX)))
      setTreeWidth(next)
    }
    const onUp = () => {
      treeDrag.current = null
      document.body.style.userSelect = ''
      setTreeDragging(false)
      setTreeWidth(w => { saveTreeWidth(w); return w })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [treeDragging])

  // A file was opened from the directory page. The store already loaded its
  // content via openFileInEditor(); here we make sure a code page exists and
  // is active (the page model replaced the old rightSidebarTab switching).
  const openCodePage = useCallback(() => {
    // In VS Code–style split mode (fullscreen + directory active) the code
    // editor already lives in the right column, so opening a file from the
    // tree just needs to add it to the store's editor tabs — no page switch.
    if (expandedSplit) return
    const existing = pages.find(p => p.kind === 'code')
    if (existing) {
      setActivePageId(existing.id)
      return
    }
    const np = { id: newPageId(), kind: 'code' as const, url: '' }
    setPages(prev => [...prev, np])
    setActivePageId(np.id)
  }, [pages, expandedSplit])

  const pageIcon = (k: PageKind) =>
    k === 'browser' ? <Globe className="size-3" /> : k === 'directory' ? <FolderTree className="size-3" /> : k === 'code' ? <FileCode2 className="size-3" /> : k === 'diff' ? <FileDiff className="size-3" /> : <Globe className="size-3" />
  const pageTitle = (p: PanelPage) =>
    p.kind === 'directory' ? '目录' : p.kind === 'code' ? '代码': p.kind === 'diff' ? '变更' : summarizeUrl(p.url)

  return (
    <div
      ref={sidebarRef}
      className={`h-full w-full bg-card flex flex-col overflow-hidden ${
        isExpanded
          ? (expandedSplit
              ? 'fixed left-0 right-0 top-0 bottom-0 z-40'
              : 'fixed inset-x-0 bottom-0 z-40')
          : ''
      }`}
      style={
        isExpanded
          ? (expandedSplit ? { top: 40 } : { top: 40 })
          : undefined
      }
    >
      <div className="flex items-center gap-2 px-2 h-10 shrink-0 bg-card">
        {/* Inline tab bar — every page (browser / directory / code) lives here. */}
        <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto scrollbar-hide">
          {(isExpanded && hasDirectory ? pages.filter(p => p.kind !== 'code') : pages).map(p => (
            <span
              key={p.id}
              onClick={() => setActivePageId(p.id)}
              className={`flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded cursor-pointer whitespace-nowrap transition-colors ${p.id === activePageId ? 'bg-accent text-foreground' : 'text-foreground/60 hover:bg-accent/50'}`}
              data-tip={pageTitle(p)}
            >
              {pageIcon(p.kind)}
              <span className="max-w-[100px] truncate text-[11px]">{pageTitle(p)}</span>
              {p.kind === 'directory' && (
                <button
                  onClick={e => { e.stopPropagation(); setTreeReloadKey(k => k + 1) }}
                  className="p-0.5 rounded text-muted-foreground/40 hover:text-foreground hover:bg-accent/80 transition-colors"
                  data-tip="刷新目录"
                >
                  <RefreshCw className="size-2.5" />
                </button>
              )}
              <button
                onClick={e => { e.stopPropagation(); closePage(p.id) }}
                className="p-0.5 rounded text-muted-foreground/40 hover:text-foreground hover:bg-accent/80 transition-colors"
                data-tip="关闭标签页"
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
        <button
          ref={plusBtnRef}
          onClick={() => setPlusMenuOpen(v => !v)}
          className={`p-1 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/60 transition-colors ${plusMenuOpen ? 'bg-accent/60 text-foreground' : ''}`}
          data-tip="新建页面"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          onClick={() => setIsExpanded(v => !v)}
          className={`p-1 rounded transition-colors ${isExpanded ? 'text-primary bg-primary/10' : 'text-muted-foreground/40 hover:text-foreground hover:bg-accent/60'}`}
          data-tip={isExpanded ? '退出全屏' : '切换全屏'}
        >
          {isExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
      </div>

      {/* Content: keep every page mounted (hidden if inactive) so switching tabs
          preserves each page's state — same as the old multi-tab browser. */}
      <div className="flex-1 min-h-0 flex flex-col">
        {expandedSplit ? (
          // VS Code–style split: file tree on the left, code editor on the right.
          <div className="flex-1 min-h-0 flex flex-row">
            <div className="relative shrink-0 h-full flex flex-col min-h-0" style={{ width: treeWidth }}>
              <FileTreePanel onOpenFile={openCodePage} reloadKey={treeReloadKey} />
              {/* Resize handle overlays the tree's right edge so it adds no
                  visual gap between the tree and the editor. */}
              <div
                onMouseDown={onTreeDragStart}
                className={`absolute top-0 right-0 w-1.5 h-full cursor-col-resize z-10 transition-colors ${treeDragging ? 'bg-primary/30' : 'hover:bg-primary/30'}`}
                data-tip="拖动调整目录宽度"
              />
            </div>
            <div className="flex-1 min-w-0 h-full flex flex-col min-h-0">
              <CodeEditorPanel onClose={() => setIsExpanded(false)} />
            </div>
          </div>
        ) : (
          pages.map(p => (
            <div key={p.id} className={p.id === activePageId ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
              {p.kind === 'browser' && (
                <BrowserView
                  url={p.url}
                  onUrlChange={(u) => updatePageUrl(p.id, u)}
                  browserBookmarks={browserBookmarks}
                />
              )}
              {p.kind === 'directory' && (
                <FileTreePanel onOpenFile={openCodePage} reloadKey={treeReloadKey} />
              )}
            {p.kind === 'code' && (
              <CodeEditorPanel onClose={() => closePage(p.id)} />
            )}
            {p.kind === 'diff' && (
              <DiffSidebarPanel />
            )}
            </div>
          ))
        )}
      </div>

      {plusMenuOpen && typeof window !== 'undefined' && createPortal(
        <div
          className="fixed z-[200]"
          style={{
            top: (plusBtnRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
            left: plusBtnRef.current?.getBoundingClientRect().right ? plusBtnRef.current!.getBoundingClientRect().right - 160 : 0,
          }}
        >
          <div ref={plusMenuRef} className="w-40 bg-card border border-border/80 rounded-lg shadow-xl py-1">
            <button
              onClick={() => addPage('browser')}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-accent/60 transition-colors"
            >
              <Globe className="size-3.5" />
              <span className="flex-1 text-left">浏览器</span>
            </button>
            <button
              onClick={() => addPage('directory')}
              disabled={hasDirectory}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-accent/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <FolderTree className="size-3.5" />
              <span className="flex-1 text-left">目录</span>
            </button>
            
            <button
              onClick={() => addPage('diff')}
              disabled={hasDiff}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-accent/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <FileDiff className="size-3.5" />
              <span className="flex-1 text-left">变更</span>
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
