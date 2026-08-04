/**
 * Text processing utilities — extracted from agent-flow-panel.tsx.
 * Pure functions with no React dependency.
 */

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi

/**
 * Decode a base64 string into UTF-8 text (handles multi-byte characters).
 */
export function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * Parse ALL <think:ID>...</think:ID> tags from model output.
 * Returns the content outside the tags and concatenated reasoning.
 */
export function extractThinkTags(text: string): { content: string; reasoning: string | null } {
  const parts: string[] = []
  let remaining = text
  let hasMatch = false
  const re = /<think:([a-zA-Z0-9_-]+)>([\s\S]*?)<\/think:\1>/
  let match: RegExpMatchArray | null
  while ((match = remaining.match(re)) !== null) {
    hasMatch = true
    parts.push(match[2].trim())
    remaining = (remaining.slice(0, match.index) + remaining.slice((match.index || 0) + match[0].length)).trimStart()
  }
  if (!hasMatch) return { content: text, reasoning: null }
  return { content: remaining, reasoning: parts.join('\n\n') || null }
}

/**
 * Normalize ACP content to plain text.
 * Handles string, array, object, and null/undefined inputs.
 */
export function normalizeAcpContent(content: unknown): string {
  let text = ''
  if (typeof content === 'string') text = content
  else if (content === null || content === undefined) text = ''
  else if (Array.isArray(content)) text = content.map((block: any) => normalizeAcpContent(block)).join('')
  else if (typeof content === 'object') {
    const obj = content as any
    if (typeof obj.text === 'string') text = obj.text
    else if (typeof obj.content === 'string') text = obj.content
    else text = JSON.stringify(obj)
  } else text = String(content)

  // Strip <system-reminder> tags only — do NOT trim, because Hermes streams
  // messages as word/token chunks and any trim() here would eat the leading
  // space of each chunk and glue words together ("I'llhelpyouexplore").
  return text.replace(SYSTEM_REMINDER_RE, '')
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}\u{200D}]/gu

/**
 * Strip emoji from model output (plain text, no emoji).
 */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI_RE, '')
}

// Models often wrap URLs in emphasis markers and glue CJK punctuation to the
// end (e.g. `**https://www.baidu.com**。`). remark-gfm's autolink then greedily
// swallows the trailing `**`/`。` into the URL, leaving the leading `**` to
// render literally. Rewrite those into proper links:
//   `**https://www.baidu.com**。` -> `**[https://www.baidu.com](https://www.baidu.com)**。`
const MODEL_URL_EMPHASIS_RE =
  /(\*\*|__|\*|_)(https?:\/\/[^\s<，。！？；：、]*?)(\*\*|__|\*|_)([，。！？；：、]?)/g

/**
 * Normalize model-emitted "URL wrapped in markdown emphasis" patterns so the
 * URL renders as a clean link instead of leaking `**` and punctuation.
 */
function normalizeModelLinks(text: string): string {
  return text.replace(MODEL_URL_EMPHASIS_RE, '$1[$2]($2)$3$4')
}

/**
 * CommonMark ATX headings REQUIRE a space (or end-of-line) after the `#` marks.
 * Models — especially with CJK right after the hashes — often emit `##完成证据`
 * / `###标题` with NO space, which strict markdown (react-markdown/remark)
 * renders as literal text instead of a heading. Insert the missing space:
 * `##完成证据` -> `## 完成证据`. Lines that already have a space are untouched.
 *
 * Only apply to SHORT lines (≤80 chars after correction); a "# " in front of a
 * long paragraph is almost certainly accidental model behavior, and making it a
 * real heading produces jarring oversized text.
 */
function normalizeHeadings(text: string): string {
  return text.replace(/^(#{1,6})([^\s#])/gm, (match, hashes, rest) => {
    if (match.length <= 80) return hashes + ' ' + rest
    return match // line too long — don't promote it to a heading
  })
}

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/

function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|') && (t.match(/\|/g) || []).length >= 3
}

function isSeparatorRow(line: string): boolean {
  const t = line.trim()
  if (!t.startsWith('|') || !t.endsWith('|')) return false
  const cells = t.slice(1, -1).split('|')
  // GFM allows 1+ dashes per cell (with optional `:` alignment); accept that so
  // a model's `| - | - |` separator is recognized instead of treated as a data
  // row (which would make normalizeMarkdownTables inject a second separator).
  return cells.length >= 2 && cells.every(c => /^:?-+:?$/.test(c.trim()))
}

function rowCols(line: string): number {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const parts = t.split('|').map(p => p.trim()).filter(Boolean)
  return Math.max(2, parts.length)
}

function buildTableSeparator(cols: number): string {
  return `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`
}

/**
 * GFM tables REQUIRE a header separator row (`| --- | --- |`); models often
 * emit bare pipe rows (header + data) without it, so remark-gfm renders them
 * as plain paragraph lines instead of a table. Detect consecutive pipe rows
 * that lack a separator and inject one (matching the first row's column count).
 */
export function normalizeMarkdownTables(text: string): string {
  if (!text) return text
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (isTableRow(lines[i])) {
      let j = i
      while (j < lines.length && isTableRow(lines[j])) j++
      const run = lines.slice(i, j)
      out.push(run[0])
      if (run.length >= 2 && !isSeparatorRow(run[1])) {
        out.push(buildTableSeparator(rowCols(run[0])))
        out.push(...run.slice(1))
      } else {
        out.push(...run.slice(1))
      }
      i = j
    } else {
      out.push(lines[i])
      i++
    }
  }
  return out.join('\n')
}

// A "loose separator": a line made only of dashes and whitespace (NO pipes)
// with ≥2 runs of dashes — the reliable signal of a model's half-pipe table.
// (A single dash run is an <hr>, not a table separator, so require ≥2.)
// Models emit this when they pipe only the header and use a dash ruler + tab
//-separated data for the rest:
//   完成证据| 检查项 | 状态 |     ← header (label glued on, or proper pipes)
//   --------   ------             ← loose separator (no pipes)
//   输出文件   输出\xxx.docx（…）  ← tab-separated data (no pipes)
function isLooseSeparator(line: string): boolean {
  const t = line.trim()
  if (!t || t.includes('|')) return false
  if (!/^[-\s]+$/.test(t)) return false
  return (t.match(/-{2,}/g) || []).length >= 2
}
function looseSepCols(line: string): number {
  return (line.trim().match(/-{2,}/g) || []).length
}

function splitLooseDataRow(line: string): string[] {
  // Prefer tab separation (the common case); fall back to 2+ spaces. Drop empty
  // edge cells so a trailing tab doesn't invent a phantom column.
  let parts = line.includes('\t') ? line.split('\t') : line.split(/\s{2,}/)
  parts = parts.map(s => s.trim())
  while (parts.length && parts[0] === '') parts.shift()
  while (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}

// Extract `cols` header cells from the line ABOVE a loose separator. Handles:
//  - a proper pipe header `| a | b |`
//  - a pipe header with a glued leading label `完成证据| a | b |`
//    (the label becomes `leading`, emitted as preceding text)
//  - a tab/space-delimited header `a\tb`
function extractHeaderCells(line: string, cols: number): { leading: string; cells: string[] } | null {
  if (!line || !line.trim()) return null
  if (line.includes('|')) {
    let leading = ''
    let s = line.trim()
    if (!s.startsWith('|')) {
      const idx = s.indexOf('|')
      leading = s.slice(0, idx).trim()
      s = s.slice(idx) // now starts with '|'
    }
    const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    while (cells.length < cols) cells.push('')
    return { leading, cells: cells.slice(0, cols) }
  }
  const cells = splitLooseDataRow(line)
  if (cells.length < cols) return null
  return { leading: '', cells: cells.slice(0, cols) }
}

/**
 * Rewrite the model's "half-pipe" tables into proper GFM. SEPARATOR-driven:
 * the dash ruler (no pipes) is the trigger, because models pipe only the
 * header and leave the separator + data un-piped. The separator's dash-run
 * count is the column authority; the line above is the header (a glued leading
 * label is split off as preceding text); subsequent lines that split into that
 * many cells are data rows. Requires ≥1 data row so a lone ruler (<hr>) or a
 * ruler under non-table text isn't mis-converted.
 */
function normalizeLooseTables(text: string): string {
  if (!text) return text
  const lines = text.split('\n')
  const out: string[] = []
  const esc = (c: string) => c.replace(/\|/g, '\\|')
  let i = 0
  while (i < lines.length) {
    if (isLooseSeparator(lines[i])) {
      const cols = looseSepCols(lines[i])
      const headerLine = i > 0 ? lines[i - 1] : ''
      const header = extractHeaderCells(headerLine, cols)
      const dataRows: string[][] = []
      let j = i + 1
      while (j < lines.length && lines[j].trim() && splitLooseDataRow(lines[j]).length === cols) {
        dataRows.push(splitLooseDataRow(lines[j]))
        j++
      }
      if (header && dataRows.length >= 1) {
        // The header line was already pushed to `out` — drop it so we can
        // replace header + separator + data with one GFM table.
        if (out.length > 0 && out[out.length - 1] === headerLine) out.pop()
        if (header.leading) out.push(header.leading)
        out.push('| ' + header.cells.map(esc).join(' | ') + ' |')
        out.push('| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |')
        for (const row of dataRows) out.push('| ' + row.map(esc).join(' | ') + ' |')
        i = j
        continue
      }
    }
    out.push(lines[i])
    i++
  }
  return out.join('\n')
}

/**
 * Escape backslashes (`\`) to `\\` outside of fenced code blocks and inline
 * code spans, so Windows file paths like `D:\Project\data` render correctly
 * in CommonMark markdown (where `\` is an escape character and remarkBreaks
 * treats trailing `\` as a hard line break).
 */
function escapeBackslashOutsideCode(text: string): string {
  // Split by fenced code blocks (```...```) — leave those untouched
  return text.split(/(```[\s\S]*?```)/g).map(fencePart => {
    if (fencePart.startsWith('```') && fencePart.endsWith('```')) return fencePart
    // Within non-fence text, split by inline code spans (`...`) — also untouched
    return fencePart.split(/(`[^`\n]+`)/g).map(seg => {
      if (seg.startsWith('`') && seg.endsWith('`')) return seg
      // Everything else: double backslashes so the markdown parser treats them as literal
      return seg.replace(/\\/g, '\\\\')
    }).join('')
  }).join('')
}

/**
 * Mid-stream Markdown safety: normalize model markdown quirks (headings
 * missing a space, half-pipe tables, bare pipe tables, URL emphasis), then
 * balance unclosed code fences so the live preview stays stable until the
 * run completes.
 */
export function safeMarkdownSource(text: string): string {
  let t = escapeBackslashOutsideCode(text)
  t = normalizeMarkdownTables(normalizeModelLinks(normalizeLooseTables(normalizeHeadings(t))))
  const fences = (t.match(/```/g) || []).length
  if (fences % 2 === 1) t += String.fromCharCode(10) + '```'
  return t
}

/**
 * Strip <system-reminder> tags from output text.
 */
export function stripSystemReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, '')
}

// Matches kaomoji status lines like "(¬_¬) reasoning..." / "_( ˘˘) computing..." etc.
// These are single-line status indicators emitted by some models inside thinking content.
const KAOMOJI_STATUS_RE = /^\s*[_\(]?\s*[¬˘•○⊙＞≦´・_~xX ]{2,}[\s\S]{0,10}[\)_]?\s+\S.+\.{2,}\s*$/m

// Matches inline kaomoji status markers such as:
//   "( •_•)> reflecting...The user is saying..."
//   "(°ロ°) contemplating...The project directory..."
// It captures the kaomoji prefix + status word + ellipsis only.
const KAOMOJI_INLINE_STATUS_RE = /(\((?=[^)]*[^\w\s])[^)]{1,40}\)[^\s\w]*)\s+([a-zA-Z]{3,})\.{2,}/g

/**
 * Extract the last kaomoji status line from thinking content.
 * Returns { status, body } where `status` is the kaomoji line (or null)
 * and `body` is the remaining thinking text with the status line removed.
 *
 * Also detects inline status markers (e.g. model emits them mid-paragraph).
 * For inline markers the body is left unchanged and only the latest marker
 * is surfaced as the status.
 */
export function extractKaomojiStatus(thinking: string): { status: string | null; body: string } {
  if (!thinking) return { status: null, body: '' }

  // 1) Stand-alone status line at the end of a line.
  const lines = thinking.split('\n')
  let statusLine: string | null = null
  let statusIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (KAOMOJI_STATUS_RE.test(lines[i]) || KAOMOJI_STATUS_RE.test(trimmed)) {
      statusLine = trimmed
      statusIdx = i
      break
    }
  }
  if (statusLine !== null) {
    const bodyLines = lines.slice(0, statusIdx).concat(lines.slice(statusIdx + 1))
    return { status: statusLine, body: bodyLines.join('\n').trim() }
  }

  // 2) Inline markers (no newline separation); return the latest one and keep the body intact.
  let inlineMatch: RegExpMatchArray | null = null
  let m: RegExpMatchArray | null
  while ((m = KAOMOJI_INLINE_STATUS_RE.exec(thinking)) !== null) {
    inlineMatch = m
  }
  if (inlineMatch) {
    return { status: inlineMatch[0].trim(), body: thinking }
  }

  return { status: null, body: thinking }
}

/**
 * First non-empty line of `text`, trimmed and capped at `maxLen`.
 * Used for the one-line preview shown inside a collapsed <details> summary.
 */
export function firstLinePreview(text: string, maxLen = 42): string {
  if (!text) return ''
  for (const raw of text.split('\n')) {
    const t = raw.trim()
    if (t.length === 0) continue
    // Skip residual kaomoji status lines so the preview isn't just emoji noise.
    if (KAOMOJI_STATUS_RE.test(t)) continue
    return t.length > maxLen ? t.slice(0, maxLen) + '…' : t
  }
  return ''
}
