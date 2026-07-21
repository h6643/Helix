/**
 * Hermes Store — connection + session state for the Hermes backend.
 *
 * This store keeps only what the Hermes integration layer needs:
 * gateway connection status, current Hermes session id, and a monotonic
 * gatewayEpoch used to detect restarts mid-flight. All UI/feature state
 * lives in helix-store.
 *
 * `McpServerConfig` is still exported from here for historical import paths
 * (helix-store re-exports it).
 */

import { create } from 'zustand'

// ── Types ───────────────────────────────────────────────────────────────────

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
  gatewayEpoch: number
  setHermesConnected: (connected: boolean) => void
  setHermesSessionId: (id: string | null) => void
  setHermesError: (error: string | null) => void
  bumpGatewayEpoch: () => void
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
}))
