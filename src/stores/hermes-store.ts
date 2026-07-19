/**
 * Hermes Store — connection + chat-loading state for the Hermes backend.
 *
 * After the Helix refactor, almost all UI/feature state moved to helix-store.
 * This store now keeps only what the Hermes integration layer (use-hermes.ts)
 * actually needs: gateway connection status, the current Hermes session id,
 * and a lightweight chat buffer used while a prompt is in flight. Everything
 * else (files, editor tabs, skills, MCP, panels, settings, toasts) lives in
 * helix-store.
 *
 * `McpServerConfig` is still exported from here for historical import paths
 * (helix-store re-exports it).
 */

import { create } from 'zustand'

// ── Types ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  reasoning?: string
}

export interface McpServerConfig {
  name?: string
  type: 'local' | 'remote'
  command?: string[]
  url?: string
  environment?: Record<string, string>
  enabled?: boolean
  cwd?: string
  timeout?: number
  headers?: Record<string, string>
}

interface HermesState {
  // ── Hermes connection ──────────────────────────────────────────────────
  hermesConnected: boolean
  hermesSessionId: string | null
  hermesError: string | null
  // Monotonic counter incremented on EVERY gateway restart (gateway.ready).
  // handleRun compares the epoch at session-creation time against the live
  // epoch to detect "my session died in a restart" even when hermesConnected
  // is already true again — which is exactly the case that broke repeated
  // model switches (first switch worked, second silently failed).
  gatewayEpoch: number
  setHermesConnected: (connected: boolean) => void
  setHermesSessionId: (id: string | null) => void
  setHermesError: (error: string | null) => void
  bumpGatewayEpoch: () => void

  // ── Chat buffer (transient; the canonical transcript lives in helix-store) ─
  chatMessages: ChatMessage[]
  isChatLoading: boolean
  addChatMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => string
  setChatMessageStreaming: (messageId: string, isStreaming: boolean) => void
  clearChat: () => void
}

// ── Store ───────────────────────────────────────────────────────────────────

export const useHermesStore = create<HermesState>((set) => ({
  hermesConnected: false,
  hermesSessionId: null,
  hermesError: null,
  gatewayEpoch: 0,
  setHermesConnected: (connected) => set({ hermesConnected: connected }),
  setHermesSessionId: (id) => set({ hermesSessionId: id }),
  setHermesError: (error) => set({ hermesError: error }),
  bumpGatewayEpoch: () => set((s) => ({ gatewayEpoch: s.gatewayEpoch + 1 })),

  chatMessages: [],
  isChatLoading: false,
  addChatMessage: (message) => {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const timestamp = Date.now()
    set((state) => ({
      chatMessages: [...state.chatMessages, { ...message, id, timestamp }],
    }))
    return id
  },
  setChatMessageStreaming: (messageId, isStreaming) =>
    set((state) => ({
      chatMessages: state.chatMessages.map((m) =>
        m.id === messageId ? { ...m, isStreaming } : m,
      ),
    })),
  clearChat: () => set({ chatMessages: [] }),
}))
