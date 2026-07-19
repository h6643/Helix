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
 * Parse <think:ID>...</think:ID> tags from model output.
 * Returns the content outside the tags and the reasoning inside.
 */
export function extractThinkTags(text: string): { content: string; reasoning: string | null } {
  const match = text.match(/<think:([a-zA-Z0-9_-]+)>([\s\S]*?)<\/think:\1>/)
  if (match) {
    return {
      reasoning: match[2].trim(),
      content: (text.slice(0, match.index) + text.slice((match.index || 0) + match[0].length)).trimStart(),
    }
  }
  return { content: text, reasoning: null }
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

/**
 * Mid-stream Markdown safety: balance unclosed code fences so the live
 * preview stays stable until the run completes.
 */
export function safeMarkdownSource(text: string): string {
  let t = text
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
