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
export function normalizeAcpContent(content: unknown, opts?: { stripSystemReminder?: boolean }): string {
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

  // Strip <system-reminder> tags only when requested — do NOT trim, because
  // Helix streams messages as word/token chunks and any trim() here would eat
  // the leading space of each chunk and glue words together ("I'llhelpyouexplore").
  const stripSystemReminder = opts?.stripSystemReminder ?? true
  const cleaned = stripSystemReminder ? text.replace(SYSTEM_REMINDER_RE, '') : text
  // Strip invisible transport control chars that overlap lines in WebKitGTK's
  // pre-wrap (lone CR = progress-bar carriage-return; ANSI CSI sequences).
  // Visible text, emoji and <system-reminder> are preserved.
  return sanitizeControlChars(cleaned)
}

/**
 * Flatten ACP content to a string WITHOUT any content modification:
 * does NOT strip <system-reminder> tags and does NOT strip emoji.
 * Use for verbatim ("raw") model output display.
 */
export function normalizeAcpContentRaw(content: unknown): string {
  return normalizeAcpContent(content, { stripSystemReminder: false })
}

// Remove control characters that cause line overlap in WebKitGTK (Tauri on Linux):
//  - CR not followed by LF -> LF (prevents "carriage return to line start" overlap)
//  - ANSI CSI escape sequences (\x1b[...m / cursor moves) -> removed (rendered as garbage)
export function sanitizeControlChars(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}\u{200D}]/gu

/**
 * Strip emoji from model output (plain text, no emoji).
 */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI_RE, '')
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
// 常见英文状态词 → 中文（用于去掉 kaomoji 后统一显示）
const STATUS_ZH: Record<string, string> = {
  reasoning: '推理中', thinking: '思考中', computing: '计算中', reflecting: '反思中',
  contemplating: '沉思中', analyzing: '分析中', searching: '搜索中', planning: '规划中',
  loading: '加载中', processing: '处理中', reading: '读取中', writing: '写入中',
  executing: '执行中', generating: '生成中', summarizing: '总结中',
}

// 去掉 kaomoji 前缀，并将英文状态词映射为中文
function normalizeKaomojiStatus(raw: string): string {
  if (!raw) return raw
  const wordMatch = raw.match(/([a-zA-Z]{3,})/)
  if (wordMatch) {
    const word = wordMatch[1].toLowerCase()
    const zh = STATUS_ZH[word]
    if (zh) return zh + '...'
  }
  const ascii = raw.replace(/[^\x00-\x7F]/g, '').trim()
  const cleaned = ascii.replace(/^\s*[^A-Za-z0-9\s]+/, '').trim()
  return cleaned || raw
}
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
    return { status: normalizeKaomojiStatus(statusLine), body: bodyLines.join('\n').trim() }
  }

  // 2) Inline markers (no newline separation); return the latest one and keep the body intact.
  let inlineMatch: RegExpMatchArray | null = null
  let m: RegExpMatchArray | null
  while ((m = KAOMOJI_INLINE_STATUS_RE.exec(thinking)) !== null) {
    inlineMatch = m
  }
  if (inlineMatch) {
    return { status: normalizeKaomojiStatus(inlineMatch[0].trim()), body: thinking }
  }

  return { status: null, body: thinking }
}
