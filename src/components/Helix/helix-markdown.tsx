'use client'

/**
 * HelixMarkdown — markdown renderer for assistant messages.
 *
 * Renders react-markdown + remark-gfm through the official hermes-agent
 * preprocess pipeline (lib/markdown-preprocess.ts), then applies the official
 * desktop renderer's component overrides (markdown-text.tsx): heading sizes,
 * quiet `---` spacing, GFM alert blockquotes, styled tables, code cards, and
 * inline-code direction. Renders into the existing `.helix-md` stylesheet;
 * code fences emit `<pre><div>` so `.helix-md pre > div` paints the code card.
 */

import { cloneElement, isValidElement, memo, useMemo, type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, Info, type LucideIcon, Zap } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

import { sanitizeLanguageTag } from '@/lib/markdown-code'
import { preprocessMarkdown } from '@/lib/markdown-preprocess'
import { HighlightedCode } from '@/components/Helix/shiki-code'

interface HelixMarkdownProps {
  text: string
  className?: string
}

// ── GFM alerts (`> [!NOTE]` blockquotes) — ported from embeds/alert.tsx ──

type AlertType = 'caution' | 'important' | 'note' | 'tip' | 'warning'

interface AlertStyle {
  accent: string
  icon: LucideIcon
  label: string
}

// GitHub's five alert kinds, mapped to our icon set + a tinted accent.
const ALERT_STYLES: Record<AlertType, AlertStyle> = {
  caution: { accent: 'text-rose-500', icon: AlertTriangle, label: 'Caution' },
  important: { accent: 'text-violet-500', icon: AlertCircle, label: 'Important' },
  note: { accent: 'text-blue-500', icon: Info, label: 'Note' },
  tip: { accent: 'text-emerald-500', icon: Zap, label: 'Tip' },
  warning: { accent: 'text-amber-500', icon: AlertTriangle, label: 'Warning' }
}

const MARKER_RE = /^\s*\[!(note|tip|important|warning|caution)\]\s*\n?/i

function firstText(node: ReactNode): string {
  if (typeof node === 'string') {
    return node
  }

  if (typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      const text = firstText(child)

      if (text.trim()) {
        return text
      }
    }

    return ''
  }

  if (isValidElement(node)) {
    return firstText((node.props as { children?: ReactNode }).children)
  }

  return ''
}

// Remove the leading `[!TYPE]` token from the first text node that carries it,
// leaving the rest of the blockquote body intact. One-shot via the `state` flag.
function stripMarker(node: ReactNode, state: { done: boolean }): ReactNode {
  if (state.done) {
    return node
  }

  if (typeof node === 'string') {
    const replaced = node.replace(MARKER_RE, '')

    if (replaced !== node) {
      state.done = true

      return replaced
    }

    return node
  }

  if (Array.isArray(node)) {
    return node.map((child, index) => <Fragmentless key={index} node={stripMarker(child, state)} />)
  }

  if (isValidElement(node)) {
    const children = (node.props as { children?: ReactNode }).children

    if (children == null) {
      return node
    }

    return cloneElement(node, undefined, stripMarker(children, state))
  }

  return node
}

function Fragmentless({ node }: { node: ReactNode }) {
  return <>{node}</>
}

function extractAlert(children: ReactNode): { body: ReactNode; type: AlertType } | null {
  const match = firstText(children).match(MARKER_RE)

  if (!match) {
    return null
  }

  return { body: stripMarker(children, { done: false }), type: match[1].toLowerCase() as AlertType }
}

function MarkdownAlert({ children, type }: { children: ReactNode; type: AlertType }) {
  const style = ALERT_STYLES[type]
  const Icon = style.icon

  return (
    <div className="my-2 rounded-lg border border-border/50 bg-muted/25 px-3 py-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <div className={`mb-1 flex items-center gap-1.5 text-[0.8125rem] font-semibold ${style.accent}`}>
        <Icon className="size-4 shrink-0" />
        {style.label}
      </div>
      {children}
    </div>
  )
}

// ── Code cards ───────────────────────────────────────────────────────────

function CodeCard({ language, code }: { language: string; code: string }) {
  const trimmed = code.replace(/^\n+/, '').trimEnd()

  return (
    <pre>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] uppercase tracking-wider text-foreground/40 select-none font-medium">
            {language || 'code'}
          </span>
          <button
            type="button"
            aria-label="复制代码"
            onClick={() => {
              try {
                void navigator.clipboard?.writeText(trimmed)
              } catch {
                /* clipboard unavailable */
              }
            }}
            className="text-[10px] text-foreground/40 hover:text-foreground/70 transition-colors cursor-pointer"
          >
            复制
          </button>
        </div>
        <HighlightedCode code={trimmed} language={language} />
      </div>
    </pre>
  )
}

/** Extract a `<code>` block's child text nodes into a plain string. */
function codeText(children: unknown): string {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(codeText).join('')
  return ''
}

const HelixMarkdown = memo(function HelixMarkdown({ text, className }: HelixMarkdownProps) {
  const processed = useMemo(() => (text ? preprocessMarkdown(text) : ''), [text])

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[[remarkMath, { singleDollarTextMath: true }], remarkGfm]}
        rehypePlugins={[rehypeKatex]}
      components={{
        // Headings shrink to chat scale (official HEADING_SIZES table).
        h1: (props) => <h1 className="my-1 font-semibold text-[1rem] tracking-tight" {...props} />,
        h2: (props) => <h2 className="my-1 font-semibold text-[0.9375rem] tracking-tight" {...props} />,
        h3: (props) => <h3 className="my-1 font-semibold text-[0.875rem]" {...props} />,
        h4: (props) => <h4 className="my-1 font-semibold text-[0.8125rem]" {...props} />,
        p: (props) => <p {...props} />,
        a: ({ children, href, ...props }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
            {children}
          </a>
        ),
        // Inline code must not vote when an ancestor resolves `dir="auto"`
        // (mirrors the official `inlineCode` override). Fenced code goes
        // through the `pre` override below, never here.
        code: ({ className, ...props }) => <code className={className} dir="ltr" {...props} />,
        // `---` as quiet spacing, not a heavy full-width rule.
        hr: () => <div aria-hidden className="my-3" />,
        // `> [!NOTE]`-style blockquotes render as a GFM alert callout;
        // everything else stays a plain quote.
        blockquote: ({ children, className, ...props }) => {
          const alert = extractAlert(children)

          if (alert) {
            return <MarkdownAlert type={alert.type}>{alert.body}</MarkdownAlert>
          }

          return (
            <blockquote
              className={`border-s-2 border-border/50 ps-3 text-muted-foreground italic ${className || ''}`}
              dir="auto"
              {...props}
            >
              {children}
            </blockquote>
          )
        },
        ul: ({ className, ...props }) => <ul className={`my-1 gap-0 ${className || ''}`} dir="auto" {...props} />,
        ol: ({ className, ...props }) => <ol className={`my-1 gap-0 ${className || ''}`} dir="auto" {...props} />,
        li: ({ className, ...props }) => <li className={className} {...props} />,
        // Tables — official: rounded card wrapper + header bg + nowrap th +
        // row separators (last row un-bordered).
        table: ({ className, ...props }) => (
          <div className="aui-md-table my-2 max-w-full overflow-x-auto rounded-[0.375rem] border border-border/50">
            <table
              className={`m-0 w-full min-w-[18rem] border-collapse text-[0.8125rem] [&_tr]:border-b [&_tr]:border-border/50 last:[&_tr]:border-0 ${className || ''}`}
              {...props}
            />
          </div>
        ),
        thead: ({ className, ...props }) => (
          <thead className={`m-0 bg-muted/35 text-muted-foreground ${className || ''}`} {...props} />
        ),
        th: ({ className, ...props }) => (
          <th
            className={`whitespace-nowrap px-2.5 py-1.5 text-left align-middle text-[0.75rem] font-medium text-muted-foreground ${className || ''}`}
            {...props}
          />
        ),
        td: ({ className, ...props }) => (
          <td className={`px-2.5 py-1.5 align-top text-[0.8125rem] leading-snug ${className || ''}`} {...props} />
        ),
        img: ({ alt, src, ...props }) => (
          <img alt={alt || ''} src={src} className="my-2 block h-auto max-w-full rounded-lg object-contain" {...props} />
        ),
        // Fenced code → the `.helix-md pre > div` code card.
        pre: ({ children }) => {
          const child = Array.isArray(children) ? children[0] : children
          const codeEl = (child as React.ReactElement | null) || null
          const classNameRaw =
            codeEl && typeof codeEl === 'object' && 'props' in codeEl
              ? String((codeEl.props as { className?: string } | undefined)?.className ?? '')
              : ''
          const match = /language-([\w+#-]+)/.exec(classNameRaw)
          const language = match ? sanitizeLanguageTag(match[1]) : ''
          const code = codeText((codeEl?.props as { children?: unknown } | undefined)?.children)
          return <CodeCard language={language} code={code} />
        },
      }}
    >
      {processed}
    </ReactMarkdown>
    </div>
  )
})

export { HelixMarkdown }