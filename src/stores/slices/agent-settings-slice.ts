/**
 * Agent behaviour settings slice — model parameters and Hermes feature flags.
 * All setters are trivial; no cross-state reads/writes.
 */
import type { StateCreator } from 'zustand'

export type Language = 'zh' | 'en'

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
