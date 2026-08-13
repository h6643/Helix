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
  // 自动归档旧任务：定时扫描最近打开过的工作区，将已完成、无未读、未置顶且
  // 超过保留时长的看板任务自动归档。保留时长为 0 表示关闭自动归档。
  autoArchiveOldTasks: boolean
  archiveRetentionHours: number
  // 增强 Find 和 Grep：新建会话（或应用重启后恢复的会话）使用 ripgrep 增强的
  // 文件/内容搜索。当前会话保持创建时的设置；Windows 的 Find 保持不变。
  enhancedFindGrep: boolean
  // 集成终端 Shell（仅新会话生效）：Windows 下 Bash 工具用此 shell。
  // 'auto' = 自动优先 Git Bash，找不到回退 cmd.exe；'cmd' = 始终用 cmd.exe。
  terminalShell: 'auto' | 'cmd'
  // Agent presets (custom system prompts)
  agentPresets: Record<string, { name: string; systemPrompt: string }>
  activePreset: string | null

  setAgentMaxIterations: (n: number) => void
  setAutoCompactContext: (v: boolean) => void
  setAutoSaveSession: (v: boolean) => void
  setReasoningEffort: (v: ReasoningEffortLevel) => void
  setPersonality: (v: string) => void
  setFastMode: (v: boolean) => void
  setAutoArchiveOldTasks: (v: boolean) => void
  setArchiveRetentionHours: (n: number) => void
  setEnhancedFindGrep: (v: boolean) => void
  setTerminalShell: (v: 'auto' | 'cmd') => void
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
  autoArchiveOldTasks: false,
  archiveRetentionHours: 168, // 默认 7 天
  enhancedFindGrep: false,
  terminalShell: 'auto', // 自动：优先 Git Bash，找不到回退 cmd.exe
  // Agent presets defaults
  agentPresets: {},
  activePreset: null,

  setAgentMaxIterations: (n) => set({ agentMaxIterations: n }),
  setAutoCompactContext: (v) => set({ autoCompactContext: v }),
  setAutoSaveSession: (v) => set({ autoSaveSession: v }),
  setReasoningEffort: (v) => set({ reasoningEffort: v }),
  setPersonality: (v) => set({ personality: v }),
  setFastMode: (v) => set({ fastMode: v }),
  setAutoArchiveOldTasks: (v) => set({ autoArchiveOldTasks: v }),
  setArchiveRetentionHours: (n) => set({ archiveRetentionHours: n }),
  setEnhancedFindGrep: (v) => set({ enhancedFindGrep: v }),
  setTerminalShell: (v) => set({ terminalShell: v }),
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
