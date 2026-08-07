import { Check, Copy, Download, Globe, ExternalLink } from 'lucide-react'
import React, { useState, useRef, useEffect, useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import type { PluggableList } from 'unified'
import { useHelixStore } from '@/stores/helix-store'
import { cleanUrl } from '@/lib/url-utils'

export const markdownPlugins: { remarkPlugins: PluggableList; rehypePlugins: PluggableList } = {
  remarkPlugins: [remarkGfm, remarkBreaks],
  rehypePlugins: [[rehypeHighlight, { detect: true }]],
}

// Click-to-zoom image for assistant messages (multimodal output)
const LightboxImage = ({ src, alt }: { src?: string; alt?: string }) => {
  const [open, setOpen] = useState(false)
  if (!src) return null
  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
        className="rounded-lg max-w-full h-auto my-2 cursor-zoom-in hover:opacity-90 transition-opacity"
      />
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 cursor-zoom-out"
          onClick={() => setOpen(false)}
        >
          <img src={src} alt={alt} className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </>
  )
}

// ── Mermaid (loaded lazily from CDN; no build dependency) ──────────────────
let _mermaidPromise: Promise<any> | null = null
const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs'
function getMermaid() {
  if (!_mermaidPromise) {
    _mermaidPromise = import(/* @vite-ignore */ MERMAID_URL)
      .then((m) => {
        m.default.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' })
        return m.default
      })
      .catch(() => null)
  }
  return _mermaidPromise
}

const MermaidBlock = ({ code }: { code: string }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getMermaid().then(async (m) => {
      if (!m || cancelled) return
      try {
        const { svg } = await m.render('m' + Math.random().toString(36).slice(2), code)
        if (!cancelled && ref.current) ref.current.innerHTML = svg
      } catch (e) {
        if (!cancelled) setErr(String(e))
      }
    })
    return () => {
      cancelled = true
    }
  }, [code])
  if (err) {
    return (
      <pre className="text-xs text-red-400 whitespace-pre-wrap my-2 p-2 bg-red-950/30 rounded-lg overflow-auto">
        {code}
      </pre>
    )
  }
  return <div ref={ref} className="my-3 flex justify-center" />
}

// ── Rich link embeds (YouTube / Spotify / X-Twitter) ──────────────────────
function embedFor(href: string): { kind: 'youtube' | 'spotify' | 'twitter'; src: string } | null {
  try {
    const u = new URL(href)
    const h = u.hostname.replace(/^www\./, '')
    if (h === 'youtu.be' || h === 'youtube.com' || h === 'm.youtube.com') {
      const id = h === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v')
      if (id) return { kind: 'youtube', src: `https://www.youtube.com/embed/${id}` }
    }
    if (h === 'spotify.com' || h === 'open.spotify.com') {
      const path = u.pathname
      if (path.length > 1) return { kind: 'spotify', src: `https://open.spotify.com/embed${path}` }
    }
    if (h === 'twitter.com' || h === 'x.com') {
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts.length >= 2 && parts[1] === 'status')
        return { kind: 'twitter', src: `https://platform.twitter.com/embed/Tweet.html?url=${encodeURIComponent(href)}` }
    }
  } catch {
    /* not a URL */
  }
  return null
}

// Strip Markdown emphasis markers and CJK/western punctuation that the model
// often glues to the end of URLs (e.g. `**https://www.baidu.com**。`).
// Without this, the browser opens `https://www.baidu.com%E3%80%82`.
const EmbedCard = ({ href: rawHref, children }: { href: string; children?: React.ReactNode }) => {
  const href = useMemo(() => cleanUrl(rawHref), [rawHref])
  const e = useMemo(() => embedFor(href), [href])
  const isHttp = /^https?:\/\//i.test(href)
  const openInSidebar = () => useHelixStore.getState().setPreviewRailUrl(href)
  if (!e) {
    if (isHttp) {
      return (
        <span className="group/link relative inline-flex items-center align-baseline">
          <a
            href={href}
            onClick={(ev) => { ev.preventDefault(); openInSidebar() }}
            className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-primary"
          >
            {children}
            <span
              role="button"
              tabIndex={0}
              onClick={(ev) => { ev.stopPropagation(); window.open(href, '_blank', 'noopener,noreferrer') }}
              onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.stopPropagation(); window.open(href, '_blank', 'noopener,noreferrer') } }}
              className="inline-flex opacity-0 group-hover/link:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-primary"
              title="在外部浏览器打开"
              aria-label="在外部浏览器打开"
            >
              <ExternalLink className="size-3.5" />
            </span>
          </a>
        </span>
      )
    }
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  }
  return (
    <div className="my-3 rounded-xl overflow-hidden border border-border/40 bg-card/40">
      {e.kind === 'twitter' ? (
        <iframe src={e.src} className="w-full h-80 border-0" title="Tweet" />
      ) : (
        <iframe
          src={e.src}
          className="w-full border-0"
          style={{ height: e.kind === 'spotify' ? 152 : 240 }}
          title={e.kind}
          allow="encrypted-media; clipboard-write"
        />
      )}
      <div className="flex justify-end px-2 py-1 border-t border-border/20">
        <button
          type="button"
          onClick={openInSidebar}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
          title="在右侧边栏打开"
        >
          <Globe className="size-3" /> 在右侧边栏打开
        </button>
      </div>
    </div>
  )
}

// Code block wrapper with a copy button (syntax highlighting added via rehype plugin upstream).
// Uppercase name so React Hooks rules apply (react-markdown maps the `pre` tag to it).
function Pre({ children }: { children?: React.ReactNode }) {
  // Detect a mermaid block rendered by our `code` override.
  const child = Array.isArray(children) ? children[0] : children
  const isMermaid = React.isValidElement(child) && (child.props as any)?.['data-mermaid']
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const [singleLine, setSingleLine] = useState(false)
  useEffect(() => {
    const text = ref.current?.textContent || ''
    setSingleLine(text.trim().split('\n').length === 1)
  }, [children])
  if (isMermaid) return <>{children}</>
  const onCopy = () => {
    const text = ref.current?.textContent || ''
    if (navigator.clipboard) navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className={`relative group my-1.5 rounded-lg overflow-hidden bg-muted/20 border border-border/50 ${singleLine ? 'w-fit max-w-full pl-10 pr-14 py-1' : 'px-6 py-1.5'}`}>
      <button
        type="button"
        onClick={onCopy}
        className="absolute right-3 top-3 z-10 px-1.5 py-1 rounded bg-muted/80 text-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
      <pre
        ref={ref}
        className={`text-[13px] leading-7 ${singleLine ? 'flex justify-center overflow-hidden whitespace-nowrap' : 'text-left whitespace-pre-wrap break-words'}`}
      >
        {children}
      </pre>
    </div>
  )
}

export const markdownComponents: Components = {
  a: ({ href, children, ...props }) =>
    href ? <EmbedCard href={href}>{children}</EmbedCard> : <a {...props}>{children}</a>,
  img: ({ src, alt }) => <LightboxImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
  // Code block wrapper with a copy button (syntax highlighting added via rehype plugin upstream)
  pre: Pre,
  code: ({ className, children, ...props }) => {
    const text = String(children ?? '')
    const isMermaid = /language-mermaid/.test(className || '')
    const isInline = !className && text.indexOf('\n') === -1
    if (isMermaid) {
      return (
        <code data-mermaid style={{ display: 'block' }}>
          <MermaidBlock code={text.replace(/\n$/, '')} />
        </code>
      )
    }
    if (isInline) {
      return (
        <code {...props}>
          {children}
        </code>
      )
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
}
