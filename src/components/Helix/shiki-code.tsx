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

    void loadShiki()
      .then(shiki => shiki.codeToHtml(trimmed, {
        lang: language,
        themes: SHIKI_THEMES,
        defaultColor: 'light-dark()',
        colorReplacements: SHIKI_COLOR_REPLACEMENTS
      }))
      .then(rendered => {
        if (!cancelled) {
          setHtml(codeInnerHtml(rendered))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHtml(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [language, trimmed])

  if (html) {
    return <code dir="ltr" className="block whitespace-pre-wrap break-words" dangerouslySetInnerHTML={{ __html: html }} />
  }

  return <code dir="ltr" className="block whitespace-pre-wrap break-words">{trimmed}</code>
})
