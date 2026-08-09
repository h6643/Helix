// TTS (Text-to-Speech) utilities for voice conversation mode.
// Calls the Rust backend (`hermes_tts_speak_stream` / `hermes_tts_stop`) which
// delegates to the Hermes Python TTS pipeline (edge_tts by default).
// Streaming mode: audio chunks are played as they arrive for lower latency.

/**
 * Synthesize and play text as speech via the Hermes TTS backend.
 * Uses streaming mode for lower latency — audio starts playing before
 * the full synthesis is complete.
 */
export async function speakText(text: string): Promise<void> {
  const t = text.trim()
  if (!t) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    // Try streaming first; fall back to legacy if command not available.
    try {
      await invoke('hermes_tts_speak_stream', { text: t })
    } catch (e: any) {
      if (e?.message?.includes('command not found') || e?.includes?.('command not found')) {
        await invoke('hermes_tts_speak', { text: t })
      } else {
        throw e
      }
    }
  } catch (err: any) {
    console.error('[tts] speakText 失败:', err.message || err)
  }
}

/**
 * Stop any in-progress TTS playback. Safe to call when nothing is playing.
 */
export async function stopSpeaking(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('hermes_tts_stop')
  } catch (err: any) {
    console.error('[tts] stopSpeaking 失败:', err.message || err)
  }
}

/**
 * Split a text buffer at sentence boundaries (., !, ?, 。, ！, ？, newlines).
 *
 * Each split point separates a "complete" sentence AND the delimiter from the
 * remaining text. Incomplete trailing text (no terminator, or shorter than
 * ``minChars``) stays in the remainder for the next call.
 *
 * Returns completed sentences and the remainder that has not yet been flushed.
 */
export interface SentenceSplit {
  complete: string[]
  remainder: string
}

export function splitSentences(
  buffer: string,
  minChars = 20,
): SentenceSplit {
  const complete: string[] = []
  let remaining = buffer

  // Match any sentence terminator: Chinese 。！？ or Western .!? or newline.
  // We match the terminator AND any following whitespace so each flush point
  // includes the punctuation that ends the sentence.
  const re = /[。！？.!?]\s*/g

  let lastSplit = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(remaining)) !== null) {
    const end = match.index + match[0].length
    const candidate = remaining.slice(0, end).trim()
    if (candidate.length >= minChars) {
      complete.push(candidate)
      lastSplit = end
    }
  }

  const remainder = remaining.slice(lastSplit)

  // If the remainder contains no terminators at all, keep it for later.
  // If it has terminators but the candidate was too short, it stays too.
  return { complete, remainder }
}
