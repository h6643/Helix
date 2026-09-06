/**
 * Agent model presets — persistence layer for per-model settings.
 */

const STORAGE_KEY = 'helix:model-presets'

export interface ModelPreset {
  reasoningEffort?: string
  fast?: boolean
}

export function loadModelPresets(): Record<string, ModelPreset> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveModelPreset(key: string, preset: ModelPreset): void {
  const presets = loadModelPresets()
  presets[key] = preset
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets))
}
