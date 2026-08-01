/**
 * Hermes Store — connection + session state for the Hermes backend.
 *
 * State machine for gateway connection: idle → connecting → open → closed/error → connecting (retry).
 * Includes CWD tracking, interruption state, and auto-compaction flag.
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

export type GatewayState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

interface HermesState {
  // ── Gateway connection state machine ─────────────────────────────────────
  gatewayState: GatewayState
  hermesConnected: boolean // derived: gatewayState === 'open'
  hermesSessionId: string | null
  hermesError: string | null
  gatewayEpoch: number

  // ── Session tracking ─────────────────────────────────────────────────────
  currentCwd: string | null
  currentBranch: string | null
  interrupted: boolean
  autoCompacting: boolean

  // ── Actions ──────────────────────────────────────────────────────────────
  setGatewayState: (state: GatewayState) => void
  setHermesConnected: (connected: boolean) => void
  setHermesSessionId: (id: string | null) => void
  setHermesError: (error: string | null) => void
  bumpGatewayEpoch: () => void
  setCurrentCwd: (cwd: string | null) => void
  setCurrentBranch: (branch: string | null) => void
  setInterrupted: (v: boolean) => void
  setAutoCompacting: (v: boolean) => void
}

// ── Store ───────────────────────────────────────────────────────────────────

export const useHermesStore = create<HermesState>((set) => ({
  gatewayState: 'idle',
  hermesConnected: false,
  hermesSessionId: null,
  hermesError: null,
  gatewayEpoch: 0,
  currentCwd: null,
  currentBranch: null,
  interrupted: false,
  autoCompacting: false,

  setGatewayState: (state) => set({
    gatewayState: state,
    hermesConnected: state === 'open',
    hermesError: state === 'error' ? 'Gateway error' : state === 'closed' ? 'Gateway disconnected' : null,
  }),
  setHermesConnected: (connected) => set({ hermesConnected: connected }),
  setHermesSessionId: (id) => set({ hermesSessionId: id }),
  setHermesError: (error) => set({ hermesError: error }),
  bumpGatewayEpoch: () => set((s) => ({ gatewayEpoch: s.gatewayEpoch + 1 })),
  setCurrentCwd: (cwd) => set({ currentCwd: cwd }),
  setCurrentBranch: (branch) => set({ currentBranch: branch }),
  setInterrupted: (v) => set({ interrupted: v }),
  setAutoCompacting: (v) => set({ autoCompacting: v }),
}))
