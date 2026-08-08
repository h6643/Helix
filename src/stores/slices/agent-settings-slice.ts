/**
 * Agent behaviour settings slice — Hermes Desktop style.
 *
 * Changes from original:
 * - Removed temperature, maxOutputTokens (backend-managed)
 * - Removed customInstructions (backend-managed via SOUL.md)
 * - Removed smartTruncation, compressionEnabled, toolGuardrailsEnabled (backend-managed)
 * - Removed streamingEnabled (always on)
 * - Changed reasoningEffort to Hermes native scale: none/minimal/low/medium/high/xhigh/max/ultra
 * - Added perModelPresets (reasoning + fast per provider::model key)
 * - Added fastMode (service tier)
 * - Personality is now named preset (not free text)
 */
import type { StateCreator } from 'zustand'
import { loadModelPresets, saveModelPreset } from '@/hermes-ui/api-client'
import type { ReasoningEffortLevel } from '@/hermes-ui/types'

export interface AgentSettingsSlice {
  agentMaxIterations: number
  autoCompactContext: boolean
  autoSaveSession: boolean
  reasoningEffort: ReasoningEffortLevel
  personality: string
  fastMode: boolean
  // Notification settings
  desktopNotifications: boolean
  // Agent presets (custom system prompts)
  agentPresets: Record<string, { name: string; systemPrompt: string }>
  activePreset: string | null

  setAgentMaxIterations: (n: number) => void
  setAutoCompactContext: (v: boolean) => void
  setAutoSaveSession: (v: boolean) => void
  setReasoningEffort: (v: ReasoningEffortLevel) => void
  setPersonality: (v: string) => void
  setFastMode: (v: boolean) => void
  setDesktopNotifications: (v: boolean) => void
  setAgentPresets: (presets: Record<string, { name: string; systemPrompt: string }>) => void
  setActivePreset: (preset: string | null) => void

  // Per-model presets (Hermes Desktop style)
  applyModelPreset: (providerModelKey: string) => void
  saveCurrentAsModelPreset: (providerModelKey: string) => void
}

export const createAgentSettingsSlice: StateCreator<AgentSettingsSlice, [], [], AgentSettingsSlice> = (set, get) => ({
  agentMaxIterations: 90,
  autoCompactContext: true,
  autoSaveSession: false,
  reasoningEffort: 'medium',
  personality: 'helpful',
  fastMode: false,
  // Notification defaults
  desktopNotifications: true,
  // Agent presets defaults
  agentPresets: {},
  activePreset: null,

  setAgentMaxIterations: (n) => set({ agentMaxIterations: n }),
  setAutoCompactContext: (v) => set({ autoCompactContext: v }),
  setAutoSaveSession: (v) => set({ autoSaveSession: v }),
  setReasoningEffort: (v) => set({ reasoningEffort: v }),
  setPersonality: (v) => set({ personality: v }),
  setFastMode: (v) => set({ fastMode: v }),
  setDesktopNotifications: (v) => set({ desktopNotifications: v }),
  setAgentPresets: (presets) => set({ agentPresets: presets }),
  setActivePreset: (preset) => set({ activePreset: preset }),

  applyModelPreset: (providerModelKey: string) => {
    const preset = loadModelPresets()[providerModelKey]
    if (!preset) return
    set({
      reasoningEffort: (preset.reasoningEffort as ReasoningEffortLevel) || 'medium',
      fastMode: preset.fast ?? false,
    })
  },

  saveCurrentAsModelPreset: (providerModelKey: string) => {
    const state = get()
    saveModelPreset(providerModelKey, {
      reasoningEffort: state.reasoningEffort,
      fast: state.fastMode,
    })
  },
})
