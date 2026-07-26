import React, { useState, useRef, useEffect, useMemo } from 'react'
import { Check, Copy, Download } from 'lucide-react'
import 'highlight.js/styles/github-dark.css'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

export const markdownPlugins = {
  remarkPlugins: [remarkGfm, remarkBreaks],
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
    _mermaidPromise = import(/* webpackIgnore: true */ MERMAID_URL)
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

const EmbedCard = ({ href, children }: { href: string; children?: React.ReactNode }) => {
  const e = useMemo(() => embedFor(href), [href])
  if (!e) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
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
    </div>
  )
}

export const markdownComponents: Components = {
  a: ({ href, children, ...props }) =>
    href ? <EmbedCard href={href}>{children}</EmbedCard> : <a {...props}>{children}</a>,
  img: ({ src, alt }) => <LightboxImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
  // Code block wrapper with a copy button (syntax highlighting added via rehype plugin upstream)
  pre: ({ children }) => {
    // Detect a mermaid block rendered by our `code` override.
    const child = Array.isArray(children) ? children[0] : children
    const isMermaid = React.isValidElement(child) && (child.props as any)?.['data-mermaid']
    if (isMermaid) return <>{children}</>
    const ref = useRef<HTMLPreElement>(null)
    const [copied, setCopied] = useState(false)
    const onCopy = () => {
      const text = ref.current?.textContent || ''
      if (navigator.clipboard) navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
    return (
      <div className="relative group my-3 rounded-xl overflow-hidden border border-border/40">
        <button
          type="button"
          onClick={onCopy}
          className="absolute right-2 top-2 z-10 px-1.5 py-1 rounded bg-muted/80 text-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
        <pre ref={ref}>{children}</pre>
      </div>
    )
  },
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
        <code className="px-1.5 py-0.5 rounded bg-muted text-[0.85em] font-mono" {...props}>
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
