'use client'

import { X, Folder, ChevronLeft, ChevronRight, RotateCw, ExternalLink } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { isRealElectron } from '@/lib/electron-bridge'
import { useHelixStore, type BrowserBookmark } from '@/stores/helix-store'
import { createPortal } from 'react-dom'
import { cleanUrl } from '@/lib/url-utils'

// ---------------------------------------------------------------------------
// Suppress benign <webview> navigation-abort noise.
//
// When the Electron <webview> guest redirects, or a newer navigation supersedes
// an in-flight load, Chromium aborts the previous loadURL with ERR_ABORTED
// (-3). Electron surfaces this as a rejected `GUEST_VIEW_MANAGER_CALL` IPC which
// Next.js's dev overlay prints to the console as an "Unexpected error while
// loading URL" unhandled rejection. The page always finishes loading, so this
// is purely cosmetic — we swallow it globally here (registered once per module
// load, guarded so HMR re-imports don't stack listeners).
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined' && !(window as any).__helixWebviewErrSuppressed) {
  ;(window as any).__helixWebviewErrSuppressed = true
  const isBenignNavError = (e: any): boolean => {
    const msg = e?.reason?.message || e?.message || String(e?.reason ?? e ?? '')
    return (
      msg.includes('GUEST_VIEW_MANAGER_CALL') ||
      msg.includes('ERR_ABORTED') ||
      msg.includes('(-3)')
    )
  }
  window.addEventListener('unhandledrejection', (e: any) => {
    if (isBenignNavError(e)) {
      e.preventDefault()
      e.stopImmediatePropagation?.()
    }
  })
  window.addEventListener('error', (e: any) => {
    if (isBenignNavError(e)) {
      e.preventDefault()
      e.stopImmediatePropagation?.()
    }
  })
}

/**
 * A single browser page rendered by RightSidebar. It shows one <webview>/<iframe>
 * for the given `url`, a navigation toolbar (back / forward / refresh), an
 * inline-editable address, and the imported bookmark bar.
 *
 * In Electron we use a real <webview> so sites that forbid iframing
 * (X-Frame-Options / CSP frame-ancestors) still render. Outside Electron we
 * fall back to a plain <iframe>.
 */

function cleanInput(raw: string): string {
  let t = raw.trim()
  const linkMatch = t.match(/^\[[^\]]*\]\(([^)]+)\)$/)
  if (linkMatch) t = linkMatch[1].trim()
  t = t.replace(/^<([^>]+)>$/, '$1')
  t = t.replace(/[*_`]/g, '')
  t = t.replace(/[.,;:!?。，；！？)…'"\]}»>]+$/, '')
  return t.trim()
}

function normalizeUrl(raw: string): string {
  const t = cleanInput(raw)
  if (!t) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return t
  if (t.startsWith('localhost') || /^\d{1,3}(\.\d{1,3}){3}/.test(t) || t.startsWith('[')) return `http://${t}`
  return `https://${t}`
}

export function summarizeUrl(url: string): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') {
      const name = decodeURIComponent(u.pathname).split('/').pop()
      return name || url
    }
    return u.hostname || url
  } catch { return url }
}

/**
 * A single bookmark entry. URL entries open in the active tab; folder entries
 * pop a fixed-position portal menu (so it is never clipped by an overflowing
 * bookmark bar) that recurses for nested folders.
 */
function BookmarkMenu({ node, onOpen, onDelete, path = [], nested }: {
  node: BrowserBookmark
  onOpen: (url: string) => void
  onDelete?: (path: number[]) => void
  path?: number[]
  nested?: boolean
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })

  useEffect(() => {
    if (!open) return
    const onDown = () => setOpen(false)
    // Defer so the toggling click doesn't immediately close the menu.
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => { window.clearTimeout(id); document.removeEventListener('mousedown', onDown) }
  }, [open])

  if (node.type === 'url') {
    return (
      <div className="group flex items-center gap-0.5 rounded text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/70 hover:bg-accent/60 whitespace-nowrap max-w-[220px]">
        <button
          onClick={() => node.url && onOpen(node.url)}
          data-tip={node.url}
          className="flex items-center gap-1 px-2 py-1 min-w-0"
        >
          <span className="truncate">{node.name || node.url}</span>
        </button>
        {onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(path) }}
            data-tip="删除书签"
            className="shrink-0 px-1 py-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground/60 hover:text-red-500 transition-opacity"
          >
            <X className="size-3" />
          </button>
        )}
      </div>
    )
  }

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos(nested ? { left: r.right + 2, top: r.top } : { left: r.left, top: r.bottom + 4 })
    setOpen(o => !o)
  }

  return (
    <>
      <button
        ref={ref}
        onClick={toggle}
        className="flex items-center gap-1 px-2 py-1 rounded text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/70 hover:bg-accent/60 whitespace-nowrap"
      >
        <Folder className="size-3 shrink-0" />
        <span className="truncate max-w-[160px]">{node.name}</span>
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 300 }}
          onMouseDown={(e) => e.stopPropagation()}
          className="min-w-[200px] max-h-[60vh] overflow-auto rounded-md border border-border/70 bg-popover p-1 shadow-xl"
        >
          {(node.children ?? []).map((c, i) => (
            <BookmarkMenu
              key={i}
              node={c}
              onOpen={(u) => { setOpen(false); onOpen(u) }}
              onDelete={onDelete}
              path={[...path, i]}
              nested
            />
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}

/** Delete a bookmark (by path) and persist the result. */
function deleteBookmarkAt(path: number[]) {
  if (path.length === 0) return
  const prev = useHelixStore.getState().browserBookmarks
  const next = [...prev]
  let cur = next
  for (let i = 0; i < path.length - 1; i++) {
    const node = cur[path[i]]
    if (!node || node.type !== 'folder' || !node.children) return
    cur = node.children
  }
  cur.splice(path[path.length - 1], 1)
  useHelixStore.getState().setBrowserBookmarks(next)
}

export function BrowserView({
  url,
  onUrlChange,
  browserBookmarks,
  onPageTitle,
}: {
  url: string
  onUrlChange: (url: string) => void
  browserBookmarks: BrowserBookmark[]
  onPageTitle?: (title: string) => void
}) {
  const [loaded, setLoaded] = useState(cleanUrl(url))
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const webviewRef = useRef<any>(null)
  const inElectron = isRealElectron()

  // Sync when the controlled `url` prop changes (external link / page switch).
  useEffect(() => {
    const u = cleanUrl(url)
    if (u !== loadedRef.current) setLoaded(u)
  }, [url])

  const goBack = () => { try { webviewRef.current?.goBack?.() } catch {} }
  const goForward = () => { try { webviewRef.current?.goForward?.() } catch {} }
  const reload = () => { try { webviewRef.current?.reload?.() } catch {} }

  const commitUrl = (raw?: string) => {
    const input = (raw ?? '').trim()
    const u = cleanUrl(normalizeUrl(input))
    if (!u) return
    setLoaded(u)
    setError('')
    onUrlChange(u)
  }

  const openBookmark = (u: string) => {
    const target = cleanUrl(normalizeUrl(u))
    if (!target) return
    setLoaded(target)
    setError('')
    onUrlChange(target)
  }

  const [editingUrl, setEditingUrl] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const startUrlEdit = () => { setUrlDraft(loaded); setEditingUrl(true) }
  const submitUrlEdit = () => { commitUrl(urlDraft); setEditingUrl(false) }
  const cancelUrlEdit = () => setEditingUrl(false)

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-card">
      {/* Navigation toolbar */}
      <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-border/20 shrink-0 bg-card">
        <button
          onClick={goBack}
          disabled={!inElectron}
          className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          data-tip="后退"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          onClick={goForward}
          disabled={!inElectron}
          className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          data-tip="前进"
        >
          <ChevronRight className="size-4" />
        </button>
        <button
          onClick={reload}
          disabled={!inElectron}
          className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          data-tip="刷新"
        >
          <RotateCw className="size-3.5" />
        </button>
        <div className="flex-1 min-w-0 text-center px-2">
          {editingUrl ? (
            <input
              autoFocus
              value={urlDraft}
              onChange={e => setUrlDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitUrlEdit()
                if (e.key === 'Escape') cancelUrlEdit()
              }}
              onBlur={submitUrlEdit}
              spellCheck={false}
              className="w-full px-2 py-0.5 text-[calc(var(--helix-transcript-size)*0.7857)] bg-muted/30 border border-border/20 rounded text-foreground/70 outline-none focus:border-primary/40 text-center"
            />
          ) : (
            <button
              onClick={startUrlEdit}
              className="text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/70 truncate hover:text-foreground hover:bg-accent/60 rounded px-2 py-0.5 transition-colors"
              data-tip={loaded}
            >
              {summarizeUrl(loaded)}
            </button>
          )}
        </div>
        <button
          onClick={() => {
            if (loaded) {
              import('@/lib/electron-bridge').then(({ electronShell }) => {
                electronShell.open(loaded)
              })
            }
          }}
          className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 transition-colors"
          data-tip="在外部浏览器中打开"
        >
          <ExternalLink className="size-3.5" />
        </button>
      </div>

      {/* Bookmark bar (imported from Chrome etc.) */}
      {browserBookmarks.length > 0 && (
        <div className="flex items-center gap-1 px-2.5 py-1 border-b border-border/20 shrink-0 bg-card overflow-x-auto scrollbar-hide">
          {browserBookmarks.map((b, i) => (
            <BookmarkMenu key={i} node={b} onOpen={openBookmark} onDelete={deleteBookmarkAt} path={[i]} />
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 bg-card relative">
        {url ? (
          <WebviewFrame
            url={url}
            active
            onLoading={setLoading}
            onError={(e) => { setError(e); setLoading(false) }}
            onNavigate={(u) => { setLoaded(u) }}
            onWebviewRef={(el) => { webviewRef.current = el }}
            onPageTitle={onPageTitle}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/40 pointer-events-none">
            点击消息中的链接以预览
          </div>
        )}
        {loading && (
          <div className="absolute top-2 right-2 z-10 px-2 py-0.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/70 bg-card/80 rounded pointer-events-none">
            加载中…
          </div>
        )}
        {error && (
          <div className="absolute inset-x-0 top-0 z-10 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] text-red-500 bg-red-50/90 border-b border-red-100">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

/** A single webview/iframe frame + its lifecycle listeners and resize sizing. */
function WebviewFrame({
  url,
  active,
  onLoading,
  onError,
  onNavigate,
  onWebviewRef,
  onPageTitle,
}: {
  url: string
  active: boolean
  onLoading: (loading: boolean) => void
  onError: (error: string) => void
  onNavigate: (url: string) => void
  onWebviewRef?: (el: any) => void
  onPageTitle?: (title: string) => void
}) {
  const webviewRef = useRef<any>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inElectron = isRealElectron()
  // Freeze the INITIAL src to `about:blank` so the <webview> guest process is
  // created exactly once. We must NOT bind `src` to the live `url` — every
  // `src` change makes Electron call loadURL internally, whose ERR_ABORTED
  // rejection is an UN-catchable console error (the GUEST_VIEW_MANAGER_CALL
  // noise). All real navigations go through our own loadURL below, which
  // swallows ERR_ABORTED ourselves.
  const initialSrcRef = useRef<string>('about:blank')
  const urlRef = useRef(url)
  urlRef.current = url
  // The last url we actually asked the guest to load. Prevents duplicate loads
  // (a duplicate loadURL is exactly what produces the benign ERR_ABORTED -3).
  const lastLoadedRef = useRef<string | null>(null)
  const [guestReady, setGuestReady] = useState(false)
  // Keep callbacks fresh without re-running the mount-once listener effect.
  const onLoadingRef = useRef(onLoading)
  const onErrorRef = useRef(onError)
  const onNavigateRef = useRef(onNavigate)
  const onPageTitleRef = useRef(onPageTitle)
  onLoadingRef.current = onLoading
  onErrorRef.current = onError
  onNavigateRef.current = onNavigate
  onPageTitleRef.current = onPageTitle
  const setWebviewRef = (el: any) => { webviewRef.current = el; onWebviewRef?.(el) }

  // Electron's <webview> doesn't reflow on container resize (known flex-parent
  // bug). Size it imperatively to the wrapper; ResizeObserver keeps it correct
  // (including when the frame becomes visible again after being hidden).
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || typeof ResizeObserver === 'undefined') return
    const apply = () => {
      const rect = wrap.getBoundingClientRect()
      const wv = webviewRef.current
      if (wv && rect.width > 0) {
        wv.style.width = `${rect.width}px`
        wv.style.height = `${rect.height}px`
      }
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // Our own loadURL wrapper — the promise is ours, so we can swallow ERR_ABORTED.
  const doLoad = (target: string) => {
    if (!target || lastLoadedRef.current === target) return
    const el = webviewRef.current
    if (!el) return
    lastLoadedRef.current = target
    onLoadingRef.current(true)
    try {
      el.loadURL(target).catch((err: any) => {
        // ERR_ABORTED (-3): a newer navigation superseded this one (the site
        // redirected, a link was clicked, or a refresh interrupted an in-flight
        // load). Benign — the page always finishes loading. The error arrives
        // serialized across the GUEST_VIEW_MANAGER_CALL IPC, so the `code`
        // property is not always preserved; match on code OR message.
        const msg = err?.message || ''
        const benign =
          err?.code === 'ERR_ABORTED' ||
          err?.errno === -3 ||
          msg.includes('ERR_ABORTED') ||
          msg.includes('(-3)')
        if (!benign) onErrorRef.current(err?.message || '页面加载失败')
        onLoadingRef.current(false)
      })
    } catch {
      onLoadingRef.current(false)
    }
  }

  // Lifecycle listeners (Electron <webview> only). Attached once on mount.
  useEffect(() => {
    if (!inElectron) return
    const el = webviewRef.current
    if (!el || typeof el.addEventListener !== 'function') return
    const onStart = () => onLoadingRef.current(true)
    const onStop = () => onLoadingRef.current(false)
    const onDomReady = () => {
      setGuestReady(true)
      doLoad(urlRef.current)
    }
    const onNav = (e: any) => { if (e?.url) onNavigateRef.current(e.url) }
    const onTitle = (e: any) => { if (e?.title) onPageTitleRef.current?.(e.title) }
    const onFail = (e: any) => {
      // ERR_ABORTED (-3) is a benign navigation supersede — never surface it.
      if (e?.errorCode && e.errorCode !== -3) {
        onErrorRef.current(e?.errorDescription || '页面加载失败')
        onLoadingRef.current(false)
      }
    }
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('dom-ready', onDomReady)
    el.addEventListener('did-navigate', onNav)
    el.addEventListener('page-title-updated', onTitle)
    el.addEventListener('did-fail-load', onFail)
    // If the guest is already live (dom-ready fired before React attached the
    // listener, e.g. after an HMR remount), load now — otherwise dom-ready will.
    try {
      if (typeof el.getWebContentsId === 'function' && el.getWebContentsId() != null) onDomReady()
    } catch { /* guest not ready yet; dom-ready will fire */ }
    return () => {
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('dom-ready', onDomReady)
      el.removeEventListener('did-navigate', onNav)
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('did-fail-load', onFail)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load whenever the controlled `url` prop changes (user input / external link).
  // Gated on guestReady so we never call loadURL before the guest exists.
  useEffect(() => {
    if (!inElectron || !guestReady) return
    const el = webviewRef.current
    if (!el || !url) return
    doLoad(url)
  }, [url, guestReady, inElectron])

  if (!url) return null

  return (
    <div ref={wrapRef} className={`absolute inset-0 ${active ? '' : 'hidden'}`}>
      {inElectron ? (
        React.createElement(
          'webview',
          {
            ref: setWebviewRef,
            src: initialSrcRef.current,
            allowpopups: 'true',
            className: 'w-full h-full border-0',
          } as any,
          null,
        )
      ) : (
        <iframe
          ref={setWebviewRef as any}
          src={url}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          data-tip="Preview"
        />
      )}
    </div>
  )
}
