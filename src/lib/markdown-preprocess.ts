/**
 * Markdown preprocessor — ported from the official hermes-agent desktop
 * renderer (lib/markdown-preprocess.ts). LLMs emit noisy markdown: stray
 * fences, prose wrapped in fenced code blocks, unmarked bare URLs, bracketed
 * citation markers like `[1,2]`, and bare `---` divider lines that CommonMark
 * reads as setext heading underlines. This scrubs those before react-markdown
 * parses, so the result matches the official desktop rendering.
 *
 * Math/session-ref/preview-target transforms the official pipeline also runs
 * are partially omitted here — session-ref/preview-target directives have no
 * Helix equivalent, but the KaTeX-relevant display-math + currency-dollar
 * normalization is kept so `\[ ... \]` display math and `$5 and $10` prices
 * render correctly through remark-math / rehype-katex.
 */

import { isLikelyProseFence, sanitizeLanguageTag } from '@/lib/markdown-code'

const REASONING_BLOCK_RE = /<(think|thinking|reasoning|scratchpad|analysis)>[\s\S]*?<\/\1>\s*/gi

const FENCE_LINE_RE = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/
const EMPTY_FENCE_BLOCK_RE = /(^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*\n[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\n|$)/g
const CODE_FENCE_SPLIT_RE = /((?:```|~~~)[\s\S]*?(?:```|~~~))/g
const INLINE_CODE_SPLIT_RE = /(`[^`\n]+`)/g
const LATEX_DISPLAY_OPEN_LINE_RE = /^([ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?[ \t]*)\\{1,2}\[[ \t]*\r?$/
const LATEX_DISPLAY_CLOSE_LINE_RE = /^([ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?[ \t]*)\\{1,2}\][ \t]*\r?$/
const CUSTOM_DISPLAY_MATH_LINE_RE = /^([ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?[ \t]*)\[\/math\][ \t]*\r?$/
// Bare-URL autolink matcher. The character classes EXCLUDE `*` (so a URL that
// abuts markdown emphasis like `**label: https://x**` doesn't swallow the
// trailing `**`) AND exclude every non-ASCII code point (`\u0080-\uFFFF`, which
// also covers CJK and astral emoji via their surrogate halves). Without the
// latter, a bare URL glued directly to CJK text — e.g.
// `https://github.com/x参考这个代码` — is greedily extended across the Chinese
// run, turning the whole sentence into one link. Real URLs are pure ASCII
// (non-ASCII must be percent-encoded), so stopping at the first non-ASCII char
// is safe. Other trailing ASCII punctuation is still peeled off by the final
// `[^\s<>"'`*.,;:!?\u0080-\uFFFF]` class.
const RAW_URL_RE = /https?:\/\/[^\s<>"'`*\u0080-\uFFFF]+[^\s<>"'`*.,;:!?\u0080-\uFFFF]/g
const CITATION_MARKER_RE = /(?<=[\p{L}\p{N})\].,!?:;"'”’])\[(?:\d+(?:\s*,\s*\d+)*)\](?!\()/gu

/**
 * Returns true when `body` contains a line that's exactly `marker` (modulo
 * leading/trailing horizontal whitespace) — i.e. an unambiguous close fence
 * for an opening fence with the same marker.
 */
function hasCloseFenceLine(body: string, marker: string): boolean {
  const lines = body.split('\n')

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    let lo = 0
    let hi = line.length

    while (lo < hi && (line[lo] === ' ' || line[lo] === '\t')) {
      lo += 1
    }

    while (hi > lo && (line[hi - 1] === ' ' || line[hi - 1] === '\t')) {
      hi -= 1
    }

    if (line.slice(lo, hi) === marker) {
      return true
    }
  }

  return false
}

function scrubBacktickNoise(text: string): string {
  const balancedFenceRe = /(^|\n)([ \t]*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g
  const protectedRanges: { end: number; start: number }[] = []
  let match: RegExpExecArray | null

  while ((match = balancedFenceRe.exec(text)) !== null) {
    const start = match.index + match[1].length

    protectedRanges.push({ end: balancedFenceRe.lastIndex, start })
  }

  const danglingCodeFenceRe = /(^|\n)[ \t]*(`{3,}|~{3,})([a-z0-9][a-z0-9+#-]{0,15})[ \t]*\n([\s\S]*)$/gi

  while ((match = danglingCodeFenceRe.exec(text)) !== null) {
    const start = match.index + match[1].length
    const marker = match[2] || '```'
    const info = match[3] || ''
    const body = match[4] || ''

    if (!hasCloseFenceLine(body, marker) && sanitizeLanguageTag(info) && !isLikelyProseFence(info, body)) {
      protectedRanges.push({ end: text.length, start })

      break
    }
  }

  protectedRanges.sort((a, b) => a.start - b.start)

  const fenceNoiseRe = /`{3,}/g
  let out = ''
  let cursor = 0

  for (const range of protectedRanges) {
    out += text.slice(cursor, range.start).replace(fenceNoiseRe, '')
    out += text.slice(range.start, range.end)
    cursor = range.end
  }

  out += text.slice(cursor).replace(fenceNoiseRe, '')

  for (let pass = 0; pass < 2; pass += 1) {
    // Match EXACTLY 2 backticks (not part of a longer run) on each side.
    // Without the lookbehind/lookahead, two adjacent triple-backtick
    // fences with only whitespace between them get spliced together —
    // e.g. ```bash\n...\n```\n\n```latex matches the regex's
    // last-2-of-bash-close + \n\n + first-2-of-latex-open and the
    // surrounding fence markers collapse into a single longer block,
    // which the markdown parser then treats as ONE giant code block.
    out = out.replace(/(?<!`)``(?!`)\s*(?<!`)``(?!`)/g, '')
    out = out.replace(/(^|[^`])``(?=\s|[.,;:!?)\]'"\u2014\u2013-]|$)/g, '$1')
  }

  return out
}

function stripEmptyFenceBlocks(text: string): string {
  return text.replace(EMPTY_FENCE_BLOCK_RE, '$1')
}

function autoLinkRawUrls(text: string): string {
  return text.replace(RAW_URL_RE, (url: string, index: number) => {
    const previous = text[index - 1] || ''
    const beforePrevious = text[index - 2] || ''

    if (previous === '<' || (beforePrevious === ']' && previous === '(')) {
      return url
    }

    return `<${url}>`
  })
}

function normalizeVisibleProse(text: string): string {
  return text
    .split(INLINE_CODE_SPLIT_RE)
    .map(part => (part.startsWith('`') ? part : autoLinkRawUrls(part.replace(CITATION_MARKER_RE, ''))))
    .join('')
}

function isEscapedAt(text: string, index: number): boolean {
  let slashCount = 0

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    slashCount += 1
  }

  return slashCount % 2 === 1
}

function findClosingSingleDollar(text: string, openingIndex: number): number {
  for (let cursor = openingIndex + 1; cursor < text.length && text[cursor] !== '\n'; cursor += 1) {
    if (text[cursor] !== '$' || isEscapedAt(text, cursor)) {
      continue
    }

    // A `$$` run belongs to display math, not to this inline candidate.
    if (text[cursor - 1] === '$' || text[cursor + 1] === '$') {
      continue
    }

    return cursor
  }

  return -1
}

function isLikelyNumericInlineMath(body: string, followingCharacter: string): boolean {
  const value = body.trim()

  if (!/^\d/u.test(value)) {
    return false
  }

  // Currency ranges and prose fragments can sit between two price openers,
  // e.g. `$5-$10` or `$5, then $10`. They are not balanced math spans.
  if (/[+\-*/=<>^_,;:(]$/u.test(value)) {
    return false
  }

  if (/https?:\/\//iu.test(value)) {
    return false
  }

  // A dollar immediately followed by a letter/number is more likely the next
  // opener in prose such as `$5 and $10` or `$5 and $x$`. Preserve it only
  // when the candidate body itself carries an unambiguous math signal.
  if (/^\p{N}/u.test(followingCharacter)) {
    return false
  }

  if (/^[\p{L}\\]/u.test(followingCharacter)) {
    return /\\[A-Za-z]+|[+*/=<>^_{}]/u.test(value)
  }

  return true
}

function opensCompleteInlineMath(text: string, openingIndex: number): boolean {
  const closingIndex = findClosingSingleDollar(text, openingIndex)

  if (closingIndex === -1) {
    return false
  }

  const body = text.slice(openingIndex + 1, closingIndex)

  return /^[\p{L}\p{N}\\{([|+\-=_^]/u.test(body)
}

/**
 * Escape price openers without corrupting balanced numeric inline math.
 * LLMs write things like `$5 and $10`. Without the escape, remark-math sees
 * `$5` as an inline-math opener and pairs it with a later stray dollar,
 * rendering prose as math. The escape keeps `$5` literal.
 */
function escapeCurrencyDollarsPreservingMath(text: string): string {
  let out = ''
  let copiedThrough = 0

  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (
      text[cursor] !== '$' ||
      !/\d/u.test(text[cursor + 1] || '') ||
      text[cursor - 1] === '$' ||
      isEscapedAt(text, cursor)
    ) {
      continue
    }

    const closingIndex = findClosingSingleDollar(text, cursor)

    if (
      closingIndex !== -1 &&
      !opensCompleteInlineMath(text, closingIndex) &&
      isLikelyNumericInlineMath(text.slice(cursor + 1, closingIndex), text[closingIndex + 1] || '')
    ) {
      cursor = closingIndex

      continue
    }

    out += `${text.slice(copiedThrough, cursor)}\\$`
    copiedThrough = cursor + 1
  }

  return out + text.slice(copiedThrough)
}

function normalizeDisplayMathForMarkdown(text: string): string {
  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const latexMatch = lines[index].match(LATEX_DISPLAY_OPEN_LINE_RE)
    const customMatch = lines[index].match(CUSTOM_DISPLAY_MATH_LINE_RE)
    const openingMatch = latexMatch || customMatch

    if (!openingMatch) {
      continue
    }

    const prefix = openingMatch[1] || ''
    const closingPattern = latexMatch ? LATEX_DISPLAY_CLOSE_LINE_RE : CUSTOM_DISPLAY_MATH_LINE_RE

    for (let closingIndex = index + 1; closingIndex < lines.length; closingIndex += 1) {
      const closingMatch = lines[closingIndex].match(closingPattern)

      if (!closingMatch) {
        continue
      }

      const openingCarriageReturn = lines[index].endsWith('\r') ? '\r' : ''
      const closingCarriageReturn = lines[closingIndex].endsWith('\r') ? '\r' : ''
      const closingPrefix = closingMatch[1] || ''

      lines[index] = `${prefix}$$${openingCarriageReturn}`
      lines[closingIndex] = `${closingPrefix}$$${closingCarriageReturn}`
      index = closingIndex

      break
    }
  }

  return lines.join('\n')
}

function normalizeProseMath(text: string): string {
  return escapeCurrencyDollarsPreservingMath(normalizeDisplayMathForMarkdown(text))
}

function extend(out: string[], lines: string[]) {
  for (const line of lines) {
    out.push(line)
  }
}

function pushProseFence(out: string[], indent: string, info: string, lines: string[]) {
  if (info) {
    out.push(`${indent}${info}`.trimEnd())
  }

  extend(out, lines)
}

function findClosingFence(lines: string[], start: number, marker: string): number {
  for (let cursor = start + 1; cursor < lines.length; cursor += 1) {
    const closeMatch = (lines[cursor] || '').match(FENCE_LINE_RE)

    if (!closeMatch) {
      continue
    }

    const closeMarker = closeMatch[2] || ''
    const closeInfo = (closeMatch[3] || '').trim()

    if (!closeInfo && closeMarker[0] === marker[0] && closeMarker.length >= marker.length) {
      return cursor
    }
  }

  return -1
}

function normalizeFenceBlocks(text: string): string {
  const sourceLines = text.split('\n')
  const out: string[] = []
  let index = 0

  while (index < sourceLines.length) {
    const line = sourceLines[index] || ''
    const match = line.match(FENCE_LINE_RE)

    if (!match) {
      out.push(line)
      index += 1

      continue
    }

    const indent = match[1] || ''
    const marker = match[2] || '```'
    const infoRaw = (match[3] || '').trim()
    const languageToken = infoRaw.split(/\s+/, 1)[0] || ''
    const language = sanitizeLanguageTag(languageToken)
    const openerValid = !infoRaw || Boolean(language)

    if (!openerValid) {
      out.push(`${indent}${infoRaw}`.trimEnd())
      index += 1

      continue
    }

    const closeIndex = findClosingFence(sourceLines, index, marker)
    const bodyLines = sourceLines.slice(index + 1, closeIndex === -1 ? sourceLines.length : closeIndex)
    const body = bodyLines.join('\n')

    if (closeIndex === -1) {
      if (!body.trim()) {
        index += 1

        continue
      }

      if (isLikelyProseFence(infoRaw, body)) {
        pushProseFence(out, indent, infoRaw, bodyLines)
      } else {
        out.push(`${indent}${marker}${language}`)
        extend(out, bodyLines)
      }

      break
    }

    if (isLikelyProseFence(infoRaw, body)) {
      pushProseFence(out, indent, infoRaw, bodyLines)
      index = closeIndex + 1

      continue
    }

    out.push(`${indent}${marker}${language}`)
    extend(out, bodyLines)
    out.push(`${indent}${marker}`)
    index = closeIndex + 1
  }

  return out.join('\n')
}

// A full line of `-` or `=` immediately after a content line. Without a blank
// line between them, CommonMark reads this as a setext heading underline and
// promotes the previous line to an <h2> (`---`) or <h1> (`===`). LLMs end
// answers with bare `---` dividers all the time, so plain prose suddenly
// renders as a heading.
const SETEXT_UNDERLINE_LINE_RE = /(?<=[^\n])\n(?!\n)([ \t]*(?:>[ \t]*)*)(-+|=+)[ \t]*(?=\n|$)/g

/**
 * Neutralize accidental setext heading underlines. Escaping the first marker
 * character (`---` → `\---`) keeps the line as literal text — exactly what the
 * model meant — instead of a heading. Blank-line-separated `---` (a legitimate
 * thematic break) is untouched, as is `- - -`/`___`/`***` (hr-only, never a
 * setext underline).
 */
function neutralizeSetextUnderlines(text: string): string {
  return text.replace(
    SETEXT_UNDERLINE_LINE_RE,
    (_match, prefix: string, markers: string) => `\n${prefix}\\${markers}`
  )
}

// LLMs often write ATX headings with a full-width space after the marker:
// `##　标题`. CommonMark only accepts `#` followed by an ASCII space/tab, so
// those lines would render as literal text. Only a full-width space is
// repaired — a space-like separator is unambiguous heading intent. Lines
// where the marker is glued DIRECTLY to the content (`##标题`, `##"引用"`)
// are deliberately left as literal text: the marker there is usually
// decoration, and repair would promote plain prose to a heading out of
// nowhere. A lone `#` is always left alone (ambiguous with hashtags like
// `#话题`). Fenced code is excluded upstream, so only prose lines are
// touched.
const ATX_HEADING_BROKEN_RE = /^( {0,3})((?:>[ \t]*)*)(#{2,6})(\u3000)([^\n]*)$/gm

// LLMs sometimes glue a table header straight onto an ATX heading with no
// newline: `##　做了什么|步骤 |结果 |`. The plain broken-heading fix above
// would turn the WHOLE line into a heading, swallowing the table header —
// the `|---|---|` separator then has no header row to pair with, so the GFM
// table collapses into a plain paragraph. Detect a heading (full-width-space
// form) whose remainder contains a `|...|...` table-header shape (≥2 pipes)
// and split it into heading + table row instead. A single pipe
// (`##　标题|a`) is left alone — could be a legit pipe inside heading text.
const ATX_HEADING_GLUED_TABLE_RE = /^( {0,3})((?:>[ \t]*)*)(#{2,6})(\u3000)([^|\n]*)(\|[^|\n]*\|[^\n]*)$/gm

/**
 * Replace a full-width space after a `##`+ heading marker with an ASCII
 * space, so `##　标题` parses as an `<h2>` instead of showing literal
 * `##　标题` text. Glued markers (`##标题`) are NOT repaired — CommonMark
 * already renders them as literal text, keeping plain prose from spuriously
 * turning into a heading. The line's leading indent is deliberately not
 * re-emitted — the pipeline preserves it separately via the `leading` slice,
 * so keeping it here would double it (2 spaces → 4 spaces = indented code
 * block).
 */
function normalizeAtxHeadings(text: string): string {
  const unglued = text.replace(
    ATX_HEADING_GLUED_TABLE_RE,
    (_match, _indent: string, prefix: string, hashes: string, _fwSpace: string, rest: string, tablePart: string) =>
      `${prefix}${hashes} ${rest}\n${tablePart}`
  )

  return unglued.replace(
    ATX_HEADING_BROKEN_RE,
    (_match, _indent: string, prefix: string, hashes: string, _fwSpace: string, rest: string) =>
      `${prefix}${hashes} ${rest}`
  )
}

// LLMs pad emphasis with spaces/full-width spaces around the `**` markers —
// `** 有。第一版填的就。这里的 **` — and CommonMark's strong rule is the
// OPPOSITE of ATX headings: the opener must NOT be followed by whitespace and
// the closer must NOT be preceded by it. Spaced `**` pairs render as literal
// asterisks, exactly the "bold doesn't render" complaint. Strip the padding to
// recover the emphasis. Three passes (double-sided, opener-side, closer-side)
// so single-sided padding is covered too.
//
// Safety: content excludes `*` so a closer of one pair can't be re-read as an
// opener of another (`**a** **b**` stays untouched), and the closing `**` must
// be followed by end-of-line/punctuation/whitespace — or, when followed by
// text (legal after a strong closer), no other `**` may remain on the line —
// so `**加粗** 之后 ** 再来 **` fixes the broken pair without letting the
// first pair's closer get captured as an opener.
const STRONG_PADDED_DOUBLE_RE = /\*\*[ \t\u3000]+([^\n*][^*\n]*?)[ \t\u3000]+\*\*(?=[\s。，、；：！？）》」』….!?;:)\]}]|$|(?=[^\s])(?![^\n]*\*\*))/g
const STRONG_PADDED_OPEN_RE = /\*\*[ \t\u3000]+([^\n*][^*\n]*?[^\s*])\*\*(?=[\s。，、；：！？）》」』….!?;:)\]}]|$|(?=[^\s])(?![^\n]*\*\*))/g
const STRONG_PADDED_CLOSE_RE = /\*\*([^\n*][^*\n]*?[^\s*])[ \t\u3000]+\*\*(?=[\s。，、；：！？）》」』….!?;:)\]}]|$|(?=[^\s])(?![^\n]*\*\*))/g

function normalizeSpacedEmphasis(text: string): string {
  let out = text.replace(STRONG_PADDED_DOUBLE_RE, '**$1**')
  out = out.replace(STRONG_PADDED_OPEN_RE, '**$1**')
  return out.replace(STRONG_PADDED_CLOSE_RE, '**$1**')
}

const processCache = new Map<string, string>()

/**
 * Preprocess LLM-authored markdown before react-markdown parses it.
 * Cached: streaming grows the text monotonically, and the regex pass is pure.
 */
export function preprocessMarkdown(text: string): string {
  const cached = processCache.get(text)

  if (cached !== undefined) {
    return cached
  }

  const cleaned = text.replace(REASONING_BLOCK_RE, '')
  const scrubbed = scrubBacktickNoise(cleaned)
  const normalizedFences = normalizeFenceBlocks(scrubbed)
  const strippedEmptyFences = stripEmptyFenceBlocks(normalizedFences)

  const result = strippedEmptyFences
    .split(CODE_FENCE_SPLIT_RE)
    .map(part => {
      // Fence blocks pass through untouched.
      if (/^(?:```|~~~)/.test(part)) {
        return part
      }

      // Whitespace-only segments must NOT be run through the prose transform —
      // trimming would glue surrounding fences together.
      if (!part.trim()) {
        return part
      }

      const leading = part.match(/^\s*/)?.[0] ?? ''
      const trailing = part.match(/\s*$/)?.[0] ?? ''

      const transformed = normalizeSpacedEmphasis(
        normalizeAtxHeadings(normalizeVisibleProse(normalizeProseMath(neutralizeSetextUnderlines(part))))
      )

      return leading + transformed + trailing
    })
    .join('')
    .replace(/[ \t]+\n/g, '\n')

  if (processCache.size > 600) {
    processCache.clear()
  }

  processCache.set(text, result)

  return result
}