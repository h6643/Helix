'use client'

import { Globe, FolderTree, FileCode2, Mail, Maximize2, Minimize2, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useHelixStore } from '@/stores/helix-store'
import { cleanUrl } from '@/lib/url-utils'
import { CodeEditorPanel } from './code-editor-panel'
import { FileTreePanel } from './file-tree-panel'
import { BrowserView, summarizeUrl } from './preview-rail'
import { EmailPanel } from './email-panel'

type PageKind = 'browser' | 'directory' | 'code' | 'email'
interface PanelPage {
  id: string
  kind: PageKind
  url: string
}

let pageSeq = 0
const newPageId = () => `pg-${++pageSeq}`

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
  useEffect(() => {
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

  // VS Code–style split layout: when the sidebar is in fullscreen overlay mode
  // AND the active page is the directory, the whole overlay becomes a left/right
  // split — the left column shows the file tree, the right column shows the code
  // editor (exactly like VS Code's explorer + editor panes). Browser / code
  // pages keep the plain full-screen overlay behavior.
  const activePage = pages.find(p => p.id === activePageId)
  const expandedSplit = isExpanded && activePage?.kind === 'directory'

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
    k === 'browser' ? <Globe className="size-3" /> : k === 'directory' ? <FolderTree className="size-3" /> : k === 'code' ? <FileCode2 className="size-3" /> : <Mail className="size-3" />
  const pageTitle = (p: PanelPage) =>
    p.kind === 'directory' ? '目录' : p.kind === 'code' ? '代码' : p.kind === 'email' ? '邮箱' : summarizeUrl(p.url)

  return (
    <div
      ref={sidebarRef}
      className={`h-full w-full bg-background flex flex-col overflow-hidden ${
        isExpanded
          ? (expandedSplit
              ? 'fixed left-0 right-0 top-0 bottom-0 z-40'
              : 'fixed inset-x-0 bottom-0 z-40')
          : 'border-l border-border/30'
      }`}
      style={
        isExpanded
          ? (expandedSplit ? { top: 40 } : { top: 40 })
          : undefined
      }
    >
      <div className="flex items-center gap-2 px-2 h-10 shrink-0 border-b border-border/20 bg-sidebar">
        {/* Inline tab bar — every page (browser / directory / code) lives here. */}
        <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto scrollbar-hide">
          {(isExpanded && hasDirectory ? pages.filter(p => p.kind !== 'code') : pages).map(p => (
            <span
              key={p.id}
              onClick={() => setActivePageId(p.id)}
              className={`flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded cursor-pointer whitespace-nowrap transition-colors ${p.id === activePageId ? 'bg-accent text-foreground' : 'text-foreground/60 hover:bg-accent/50'}`}
              title={pageTitle(p)}
            >
              {pageIcon(p.kind)}
              <span className="max-w-[100px] truncate text-[11px]">{pageTitle(p)}</span>
              <button
                onClick={e => { e.stopPropagation(); closePage(p.id) }}
                className="p-0.5 rounded text-muted-foreground/40 hover:text-foreground hover:bg-accent/80 transition-colors"
                title="关闭标签页"
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
          title="新建页面"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          onClick={() => setIsExpanded(v => !v)}
          className={`p-1 rounded transition-colors ${isExpanded ? 'text-primary bg-primary/10' : 'text-muted-foreground/40 hover:text-foreground hover:bg-accent/60'}`}
          title={isExpanded ? '退出全屏' : '切换全屏'}
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
            <div className="w-[300px] shrink-0 h-full border-r border-border/30 flex flex-col min-h-0">
              <FileTreePanel onOpenFile={openCodePage} />
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
                <FileTreePanel onOpenFile={openCodePage} />
              )}
            {p.kind === 'code' && (
              <CodeEditorPanel onClose={() => closePage(p.id)} />
            )}
            {p.kind === 'email' && (
              <EmailPanel onClose={() => closePage(p.id)} />
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
              onClick={() => addPage('email')}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-accent/60 transition-colors"
            >
              <Mail className="size-3.5" />
              <span className="flex-1 text-left">邮箱</span>
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
