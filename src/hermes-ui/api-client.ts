'use client'

export type ApprovalLevel = 'once' | 'session' | 'always' | 'deny'

// ── Per-model presets (Hermes Desktop style) ────────────────────────────

export interface ModelPreset {
  reasoningEffort: string
  fast: boolean
}

const MODEL_PRESETS_KEY = 'helix-model-presets'

export function loadModelPresets(): Record<string, ModelPreset> {
  try {
    const raw = localStorage.getItem(MODEL_PRESETS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveModelPreset(modelKey: string, preset: ModelPreset) {
  const presets = loadModelPresets()
  presets[modelKey] = preset
  localStorage.setItem(MODEL_PRESETS_KEY, JSON.stringify(presets))
}
