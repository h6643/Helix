/**
 * Agent behaviour settings slice — model parameters and Hermes feature flags.
 * All setters are trivial; no cross-state reads/writes.
 */
import type { StateCreator } from 'zustand'

export type Language = 'zh' | 'en'

/** Hermes backend's `parse_reasoning_effort` only accepts
 *  none/minimal/low/medium/high/xhigh/max/ultra. Our UI scale
 *  (ultra_low … max) uses two names it doesn't recognise (ultra_low,
 *  ultra_high), which `parse_reasoning_effort` silently drops → the user's
 *  pick falls back to the default (medium), defeating fast/slow control.
 *  Translate at the IPC boundary so every UI level actually reaches the model. */
export function toBackendReasoningEffort(
  v: 'ultra_low' | 'low' | 'medium' | 'high' | 'ultra_high' | 'max',
): string {
  switch (v) {
    case 'ultra_low': return 'minimal'
    case 'low': return 'low'
    case 'medium': return 'medium'
    case 'high': return 'high'
    case 'ultra_high': return 'xhigh'
    case 'max': return 'max'
  }
}

export interface AgentSettingsSlice {
  agentMaxIterations: number
  autoCompactContext: boolean
  smartTruncation: boolean
  autoSaveSession: boolean
  temperature: number
  reasoningEffort: 'ultra_low' | 'low' | 'medium' | 'high' | 'ultra_high' | 'max'
  maxOutputTokens: number
  customInstructions: string
  streamingEnabled: boolean
  compressionEnabled: boolean
  toolGuardrailsEnabled: boolean
  personality: string
  outputStyle: 'default' | 'concise' | 'detailed' | 'technical'
  // Notification settings
  desktopNotifications: boolean
  soundEnabled: boolean
  // Startup behavior
  restoreLastSession: boolean
  defaultWorkDir: string
  // Language
  language: Language
  // Security
  confirmDangerousActions: boolean
  autoApproveRead: boolean
  setAgentMaxIterations: (n: number) => void
  setAutoCompactContext: (v: boolean) => void
  setSmartTruncation: (v: boolean) => void
  setAutoSaveSession: (v: boolean) => void
  setTemperature: (n: number) => void
  setReasoningEffort: (v: 'ultra_low' | 'low' | 'medium' | 'high' | 'ultra_high' | 'max') => void
  setMaxOutputTokens: (n: number) => void
  setCustomInstructions: (v: string) => void
  setStreamingEnabled: (v: boolean) => void
  setCompressionEnabled: (v: boolean) => void
  setToolGuardrailsEnabled: (v: boolean) => void
  setPersonality: (v: string) => void
  setOutputStyle: (v: 'default' | 'concise' | 'detailed' | 'technical') => void
  setDesktopNotifications: (v: boolean) => void
  setSoundEnabled: (v: boolean) => void
  setRestoreLastSession: (v: boolean) => void
  setDefaultWorkDir: (v: string) => void
  setLanguage: (v: Language) => void
  setConfirmDangerousActions: (v: boolean) => void
  setAutoApproveRead: (v: boolean) => void
}

export const createAgentSettingsSlice: StateCreator<AgentSettingsSlice, [], [], AgentSettingsSlice> = (set) => ({
  agentMaxIterations: 50,
  autoCompactContext: true,
  smartTruncation: true,
  autoSaveSession: false,
  temperature: 0.7,
  reasoningEffort: 'medium',
  maxOutputTokens: 4096,
  customInstructions: '',
  streamingEnabled: true,
  compressionEnabled: true,
  toolGuardrailsEnabled: true,
  personality: '',
  outputStyle: 'default',
  // Notification defaults
  desktopNotifications: true,
  soundEnabled: false,
  // Startup defaults
  restoreLastSession: true,
  defaultWorkDir: '',
  // Language
  language: 'zh',
  // Security
  confirmDangerousActions: true,
  autoApproveRead: false,

  setAgentMaxIterations: (n) => set({ agentMaxIterations: n }),
  setAutoCompactContext: (v) => set({ autoCompactContext: v }),
  setSmartTruncation: (v) => set({ smartTruncation: v }),
  setAutoSaveSession: (v) => set({ autoSaveSession: v }),
  setTemperature: (v) => set({ temperature: v }),
  setReasoningEffort: (v) => set({ reasoningEffort: v }),
  setMaxOutputTokens: (v) => set({ maxOutputTokens: v }),
  setCustomInstructions: (v) => set({ customInstructions: v }),
  setStreamingEnabled: (v) => set({ streamingEnabled: v }),
  setCompressionEnabled: (v) => set({ compressionEnabled: v }),
  setToolGuardrailsEnabled: (v) => set({ toolGuardrailsEnabled: v }),
  setPersonality: (v) => set({ personality: v }),
  setOutputStyle: (v) => set({ outputStyle: v }),
  setDesktopNotifications: (v) => set({ desktopNotifications: v }),
  setSoundEnabled: (v) => set({ soundEnabled: v }),
  setRestoreLastSession: (v) => set({ restoreLastSession: v }),
  setDefaultWorkDir: (v) => set({ defaultWorkDir: v }),
  setLanguage: (v) => set({ language: v }),
  setConfirmDangerousActions: (v) => set({ confirmDangerousActions: v }),
  setAutoApproveRead: (v) => set({ autoApproveRead: v }),
})
