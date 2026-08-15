'use client'

/**
 * Syntax-highlighted code body — ported from the official hermes-agent
 * shiki-highlighter.tsx. Renders a fence's code through shiki's `codeToHtml`
 * with the official dual theme (`github-light-default` / `github-dark-dimmed`,
 * `defaultColor="light-dark()"` so the app's `.light`/`.dark` color-scheme
 * drives the palette). Falls back to plain preformatted text until the shiki
 * chunk loads, and skips highlighting entirely past the budget guard.
 *
 * shiki (grammars + themes) is the heaviest dependency in the renderer, so it
 * is dynamic-imported here on first highlighted block — never in the entry
 * chunk. The highlight HTML is built off-thread in the effect and injected
 * through `dangerouslySetInnerHTML`; no per-token React elements are needed.
 */

import { memo, useEffect, useState } from 'react'

// GitHub's lower-contrast dark palette — the vivid `github-dark-default`
// tokens read harsh at small code size. Shared by the diff renderer. The
// light-mode comment remap bumps `#6e7781` (borderline unreadable for shell
// comments) to GitHub's darker muted gray `#57606a`. Keyed per theme so the
// bump only applies in light.
const SHIKI_THEMES = { dark: 'github-dark-dimmed', light: 'github-light-default' } as const
const SHIKI_COLOR_REPLACEMENTS: Record<string, Record<string, string>> = {
  'github-light-default': { '#6e7781': '#57606a' }
}

const MAX_HIGHLIGHT_CHARS = 150_000
const MAX_HIGHLIGHT_LINES = 3_000

export function exceedsHighlightBudget(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) {
    return true
  }

  let lines = 1
  let index = code.indexOf('\n')

  while (index !== -1) {
    if ((lines += 1) > MAX_HIGHLIGHT_LINES) {
      return true
    }

    index = code.indexOf('\n', index + 1)
  }

  return false
}

type ShikiModule = typeof import('shiki')

let shikiPromise: Promise<ShikiModule> | null = null

function loadShiki(): Promise<ShikiModule> {
  if (!shikiPromise) {
    shikiPromise = import('shiki')
  }

  return shikiPromise
}

// ── Highlight cache ─────────────────────────────────────────────────────────
// Switching conversations remounts every message (new chatMessages objects
// defeat React.memo), which used to re-run shiki's codeToHtml for EVERY code
// block in the target conversation — the "切换对话卡顿" bottleneck. Cache the
// highlight result per (language, code) so a re-mount just reads the finished
// promise instead of re-highlighting. Values are promises so concurrent mounts
// of the same block share one highlight; bounded LRU-style so long sessions
// can't grow it without limit.
const HIGHLIGHT_CACHE_MAX = 200
const highlightCache = new Map<string, Promise<string>>()

function cacheHighlight(key: string, p: Promise<string>): Promise<string> {
  highlightCache.delete(key) // refresh insertion order (LRU)
  highlightCache.set(key, p)
  if (highlightCache.size > HIGHLIGHT_CACHE_MAX) {
    const oldest = highlightCache.keys().next().value
    if (oldest !== undefined && oldest !== key) highlightCache.delete(oldest)
  }
  return p
}

/** Pull just the `<code>…</code>` token markup out of shiki's full `<pre>` output. */
function codeInnerHtml(html: string): string {
  const codeOpen = html.indexOf('<code')
  const codeStart = html.indexOf('>', codeOpen) + 1
  const codeEnd = html.lastIndexOf('</code>')

  if (codeOpen === -1 || codeStart === -1 || codeEnd === -1 || codeEnd < codeStart) {
    return html
  }

  return html.slice(codeStart, codeEnd)
}

interface HighlightedCodeProps {
  code: string
  language: string
}

export const HighlightedCode = memo(function HighlightedCode({ code, language }: HighlightedCodeProps) {
  const [html, setHtml] = useState<string | null>(null)

  const trimmed = code.replace(/^\n+/, '').trimEnd()

  useEffect(() => {
    if (!trimmed || !language || language === 'text' || exceedsHighlightBudget(trimmed)) {
      setHtml(null)

      return
    }

    let cancelled = false
    const key = `${language}\u0000${trimmed}`
    const apply = (rendered: string) => {
      if (!cancelled) setHtml(codeInnerHtml(rendered))
    }
    const fail = () => {
      if (!cancelled) setHtml(null)
    }

    let highlight: Promise<string> | undefined = highlightCache.get(key)
    if (!highlight) {
      // Miss → run codeToHtml once, share the promise with any concurrent
      // mount of the same block, and drop the entry on failure so a later
      // mount can retry instead of pinning a dead promise.
      highlight = cacheHighlight(
        key,
        loadShiki()
          .then(shiki => shiki.codeToHtml(trimmed, {
            lang: language,
            themes: SHIKI_THEMES,
            defaultColor: 'light-dark()',
            colorReplacements: SHIKI_COLOR_REPLACEMENTS,
          })),
      )
      highlight.catch(() => { highlightCache.delete(key) })
    }
    highlight.then(apply).catch(fail)

    return () => {
      cancelled = true
    }
  }, [language, trimmed])

  if (html) {
    return <code dir="ltr" className="block whitespace-pre-wrap break-words" dangerouslySetInnerHTML={{ __html: html }} />
  }

  return <code dir="ltr" className="block whitespace-pre-wrap break-words">{trimmed}</code>
})
