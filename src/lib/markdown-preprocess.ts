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

  // 围栏语言后同行直接跟正文（模型常把第一行拼到 ```lang 上，如 ```tsxul: (...) => ...）。
  // 平衡围栏与「语言+换行」悬空围栏都覆盖不到这里 → 之前 ``` 会被剥成纯文本。
  // 这里保留围栏标记（到文本末尾），交给 normalizeFenceBlocks 拆分语言与正文。
  // 语言以拉丁/数字开头才保护——中文式的散文围栏（```总结要点）不在此列。
  // 正文允许含反引号（JSX 模板串），所以匹配到行尾任意字符。
  const mergedFenceRe = /(^|\n)[ \t]*(`{3,}|~{3,})[A-Za-z0-9][^\n]*(?=\n|$)/g

  while ((match = mergedFenceRe.exec(text)) !== null) {
    const start = match.index + match[1].length

    protectedRanges.push({ end: text.length, start })

    break
  }

  protectedRanges.sort((a, b) => a.start - b.start)

  const fenceNoiseRe = /`{3,}/g
  let out = ''
  let cursor = 0

  for (const range of protectedRanges) {
    // 区间可能重叠（merged 保护到末尾、会包住更早的平衡围栏区间）：跳过已被
    // 覆盖的部分，避免重复切片导致围栏内容被复制两份。
    const sliceStart = Math.max(cursor, range.start)

    if (sliceStart >= range.end) continue
    out += text.slice(cursor, sliceStart).replace(fenceNoiseRe, '')
    out += text.slice(sliceStart, range.end)
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
    // 模型常把正文第一行拼到围栏语言后面（```tsxul: (...) => ...）。语言 token
    // 之后的剩余内容拆出来当正文首行，别让它在 info 串里丢失。
    const infoTail = infoRaw.slice(languageToken.length).trim()
    // 语言不在严格白名单（如 tsx.js、拼了正文的 tsxul:...）不等于散文——只要语言
    // token 以拉丁/数字开头就当代码围栏，由 isLikelyProseFence 判断正文是代码还是
    // 散文；中文式 info（```总结要点）仍按散文拆开，保持原行为。
    const openerValid = !infoRaw || Boolean(language) || Boolean(infoTail) || /^[A-Za-z0-9]/.test(languageToken)

    if (!openerValid) {
      out.push(`${indent}${infoRaw}`.trimEnd())
      index += 1

      continue
    }

    const closeIndex = findClosingFence(sourceLines, index, marker)
    const rawBodyLines = sourceLines.slice(index + 1, closeIndex === -1 ? sourceLines.length : closeIndex)
    const bodyLines = infoTail ? [infoTail, ...rawBodyLines] : rawBodyLines
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
// repaired — a space-like separator is unambiguous heading intent. A lone `#`
// is always left alone (ambiguous with hashtags like `#话题`). Fenced code is
// excluded upstream, so only prose lines are touched.
const ATX_HEADING_BROKEN_RE = /^( {0,3})((?:>[ \t]*)*)(#{2,6})(\u3000)([^\n]*)$/gm

// LLMs also glue the heading text straight onto the marker with no space at
// all: `##自包含工具卡`, `##页面结构单页`, `##查询配置（：…）`. CommonMark
// requires an ASCII space/tab after the `#` run, so these lines render as
// plain paragraphs instead of headings. A line that starts with `#{2,6}`
// directly followed by visible content is unambiguous heading intent, so
// repair it (`##标题` → `## 标题`). Single `#` stays untouched (hashtags),
// and markers already followed by whitespace are skipped by the `[^\s#]`
// guard. A `- ##xxx` list item is not matched (leading `- ` breaks the
// `^ {0,3}` prefix).
const ATX_HEADING_GLUED_RE = /^( {0,3})((?:>[ \t]*)*)(#{2,6})([^\s#][^\n]*)$/gm

// LLMs sometimes flatten the whole newline away, leaving the heading glued
// MID-LINE: `…归因分解##数据智能细节-打开页面自动查询`. ATX markers are only
// read at line start, so insert a line break before the mid-line `##` and a
// space after it. Lookbehind = any non-newline/non-space/non-`#` char (CJK
// text, punctuation, digits); lookahead = a letter (heading text). Mid-line
// `##` before a letter is essentially never legit prose — `C## ` (C#) has a
// space/EOL after, and `###` runs fail the `\p{L}` lookahead.
const ATX_HEADING_MIDLINE_RE = /(?<=[^\n\s#])##(?=\p{L})/gu

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
 * Repair ATX headings: replace a full-width space after a `##`+ marker with
 * an ASCII space (`##　标题` → `## 标题`), and insert a space where the text
 * is glued straight onto the marker (`##标题` → `## 标题`) so both parse as
 * real headings instead of literal text. Glued-table rows (`##　做了什么|步骤|结果`)
 * are split into heading + table header first. The line's leading indent is
 * deliberately not re-emitted — the pipeline preserves it separately via the
 * `leading` slice, so keeping it here would double it (2 spaces → 4 spaces =
 * indented code block).
 */
function normalizeAtxHeadings(text: string): string {
  const unglued = text.replace(
    ATX_HEADING_GLUED_TABLE_RE,
    (_match, _indent: string, prefix: string, hashes: string, _fwSpace: string, rest: string, tablePart: string) =>
      `${prefix}${hashes} ${rest}\n${tablePart}`
  )

  const fixedBroken = unglued.replace(
    ATX_HEADING_BROKEN_RE,
    (_match, _indent: string, prefix: string, hashes: string, _fwSpace: string, rest: string) =>
      `${prefix}${hashes} ${rest}`
  )

  return fixedBroken
    .replace(
      ATX_HEADING_GLUED_RE,
      (_match, _indent: string, prefix: string, hashes: string, rest: string) =>
        `${prefix}${hashes} ${rest}`
    )
    .replace(ATX_HEADING_MIDLINE_RE, '\n## ')
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

// LLMs sometimes drop the closing `**`: `**不能。这台是 VMware NAT模式虚拟机`
// renders as a literal `**` because the strong pair never closes. A line that
// STARTS with `**` (≤3 spaces indent) and contains no other `**` on the line
// is unambiguous dangling-strong intent — close it at the end of the line.
// `***` (em-strong mix) is excluded via `(?!\*)`, and already-closed pairs
// (`**a** …`) contain a second `**` so they're untouched.
const DANGLING_STRONG_RE = /^( {0,3})\*\*(?!\*)([^\n]*)$/gm

function closeDanglingStrongEmphasis(text: string): string {
  return text.replace(DANGLING_STRONG_RE, (whole, indent: string, rest: string) => {
    if (!rest.includes('**') && rest.trim()) {
      return `${indent}**${rest}**`
    }
    return whole
  })
}

// LLMs emit GFM tables whose header row has MORE columns than the separator
// row: `证据|检查项 |结果 |含义 |` over `|---|---|---|` renders nothing — GFM
// needs the separator to have exactly as many cells as the header. When the
// header has more cells than the dash row, rebuild the dash row with the
// header's cell count. Cell count = non-empty `|`-delimited segments (so both
// `| a | b |` and `a|b` count 2).
//
// Models also sometimes put a BLANK LINE between the header and the dash row
// — GFM requires them adjacent, so the blank line is removed too.
const TABLE_DASH_LINE_RE = /^\s*\|?[\t ]*:?-+:?[\t ]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?\s*$/

function cellCount(line: string): number {
  return line
    .trim()
    .split('|')
    .filter((segment) => segment.trim().length > 0).length
}

function padTableDelimiterRows(text: string): string {
  const lines = text.split('\n')

  for (let index = 0; index + 1 < lines.length; index += 1) {
    const headerCells = cellCount(lines[index])
    if (headerCells < 2) continue

    // The dash row may sit 1 line below (normal) or 2 lines below with a blank
    // line in between — GFM needs the header immediately followed by it.
    let delimIndex = index + 1
    if (delimIndex < lines.length && !lines[delimIndex].trim()) {
      delimIndex += 1
    }
    if (delimIndex >= lines.length || !TABLE_DASH_LINE_RE.test(lines[delimIndex])) {
      continue
    }

    const dashCells = cellCount(lines[delimIndex])
    if (dashCells > 0 && dashCells < headerCells) {
      lines[delimIndex] = `|${'---|'.repeat(headerCells)}`
    }

    if (delimIndex === index + 2) {
      // Remove the blank line so the header + dash row form one table block.
      lines.splice(index + 1, 1)
      delimIndex -= 1
    }

    index = delimIndex
  }

  return lines.join('\n')
}

// LLMs glue consecutive ordered-list items onto one line — item 4's `4. `
// runs straight into item 3's text: `…显示返回行数 +耗时4. 时间从产品成立`.
// CommonMark only treats `4. ` as a list marker at line start, so the glued
// item renders as part of the paragraph instead of a numbered entry. Insert
// a line break before an inline `N. `/`N、` marker that sits right after
// visible text. Guards:
//   - `(?<=[^\n\s，。、；：！？）】》])` — must follow text (not a line start,
//     whitespace, or a Chinese sentence terminator that would suggest the
//     number is plain prose like `用时4. 5秒`)。
//   - `(?=[ \t\u3000]+\S)` — must be followed by a space + content.
//   - `(?![ \t\u3000]*\d)` — not a version/decimal like `2. 0` / `3. 5元`.
//   - `\d{1,2}` — ordered-list numbers are 1–2 digits; 3-digit runs (years,
//     IDs) are left alone.
const GLUED_LIST_ITEM_RE = /(?<=[^\n\s，。、；：！？）】》])(\d{1,2}[.、])(?=[ \t\u3000]+\S)(?![ \t\u3000]*\d)/g

// Same gluing bug for bullet lists: `- **月收益率明细表**：- **动态回撤图**`
// — the second `- ` runs straight into the first item's text after the `：`.
// Insert a line break before an inline `- ` that follows visible text.
// Guards:
//   - `(?<=[^\n\s-])` — must follow text/space-like-terminator, NOT a line
//     start, whitespace, or another `-` (`- - ` chains are left alone).
//   - `(?=[^\s-])` — the `- ` must be followed by non-space, non-`-` content.
//   - `(?<![A-Za-z0-9] - [A-Za-z0-9])` — not an English dash or minus like
//     `A - B` / `5 - 3` (letter/digit on both sides with surrounding spaces).
const GLUED_BULLET_ITEM_RE = /(?<=[^\n\s-])(- )(?=[^\s-])(?<![A-Za-z0-9] - [A-Za-z0-9])/g

// `-` glued directly to the item text with NO space: `-打开页面自动查询`,
// and mid-line `…细节-打开…` after the model flattened the newline.
// CommonMark needs `- ` (marker + space) at line start, so insert the missing
// space (line start) or a line break + space (mid-line).
//
// Line-start guard: `-` must be followed by a letter / `*` / `_` (a bullet
// marker, not a negative number like `-1` and not a bare `---` divider —
// the next char would be `-`). Line-start `-foo` / `-打开` is unambiguous
// bullet intent; hyphenated words never START with `-`.
//
// Mid-line guard: both sides must be Han (`节-打开`), and the following Han
// run must be ≥4 chars — a full list item (`打开页面自动查询`), NOT a short
// hyphenated pair like `中-美`, `港-澳`, `人-机交互` (following side is
// 1–3 chars). English hyphens (`foo-bar`) and `T-恤` are excluded by the Han
// lookbehind; `5-3` by the letter lookahead.
const GLUED_BULLET_NOSPACE_LINE_START_RE = /^( {0,3})-(?=[*_\p{L}])/gmu
const GLUED_BULLET_NOSPACE_MIDLINE_RE = /(?<=\p{Script=Han})-(?=\p{Script=Han}{4})/gu

// Glued-list repair must NOT touch inline code spans: `` `- hermes-cli` `` —
// `- ` inside backticks is a literal dash, not a bullet. Without the
// INLINE_CODE_SPLIT_RE guard, GLUED_BULLET_ITEM_RE inserts a `\n` into the
// code span, splitting the backtick pair so CommonMark renders the backticks
// literally and the code text as a list item (user-visible: `` ` `` 换行
// `` hermes-cli` `` 而非行内代码)。Same protection pattern as
// normalizeVisibleProse — only prose segments get the list repair.
function normalizeGluedListItems(text: string): string {
  return text
    .split(INLINE_CODE_SPLIT_RE)
    .map(part => {
      if (part.startsWith('`')) return part
      const numbered = part.replace(GLUED_LIST_ITEM_RE, '\n$1')
      const withSpacedBullets = numbered.replace(GLUED_BULLET_ITEM_RE, '\n$1')
      const withNospaceLineStart = withSpacedBullets.replace(GLUED_BULLET_NOSPACE_LINE_START_RE, '$1- ')
      return withNospaceLineStart.replace(GLUED_BULLET_NOSPACE_MIDLINE_RE, '\n- ')
    })
    .join('')
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

      const transformed = normalizeGluedListItems(
        normalizeSpacedEmphasis(
          closeDanglingStrongEmphasis(
            padTableDelimiterRows(
              normalizeAtxHeadings(normalizeVisibleProse(normalizeProseMath(neutralizeSetextUnderlines(part))))
            )
          )
        )
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