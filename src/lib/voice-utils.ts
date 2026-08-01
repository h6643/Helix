// Browser-native speech helpers (Web Speech API). Renderer-only — no gateway
// needed. Shared by the message "朗读" button and the always-on auto-speak
// effect in helix-layout, so the logic lives in one place.

export function stripAcp(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('')
  return content?.text || ''
}

export function speak(text: string) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text.slice(0, 4000))
  u.lang = 'zh-CN'
  u.rate = 1.05
  window.speechSynthesis.speak(u)
}

export function stopSpeaking() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  window.speechSynthesis.cancel()
}
