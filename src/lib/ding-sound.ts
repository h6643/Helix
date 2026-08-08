// Synthesized "ding" notification sound via Web Audio API.
// Used to confirm wake-word detection before the voice turn begins.

let _ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  try {
    if (!_ctx || _ctx.state === 'closed') {
      _ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    }
    return _ctx
  } catch {
    return null
  }
}

/**
 * Play a short two-tone chime: A₅ (880 Hz) → C♯₆ (1100 Hz).
 * Quick decay envelope (~400 ms). Fire-and-forget — never throws.
 */
export function playDingSound(): void {
  const ctx = getCtx()
  if (!ctx) return

  try {
    // Resume if suspended (browser autoplay policy).
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }

    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.type = 'sine'
    const now = ctx.currentTime

    // Two-tone chime: 880 Hz → 1100 Hz after 100 ms.
    osc.frequency.setValueAtTime(880, now)
    osc.frequency.setValueAtTime(1100, now + 0.1)

    // Quick attack, fast decay.
    gain.gain.setValueAtTime(0.01, now)
    gain.gain.linearRampToValueAtTime(0.25, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4)

    osc.start(now)
    osc.stop(now + 0.45)
  } catch {
    // Web Audio not available — silent fallback is fine.
  }
}
