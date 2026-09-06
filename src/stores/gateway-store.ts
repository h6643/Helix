/**
 * Gateway Store — connection + session state for the backend gateway.
 *
 * State machine for gateway connection: idle → connecting → open → closed/error → connecting (retry).
 * Includes CWD tracking, interruption state, and auto-compaction flag.
 */

import { create } from 'zustand'

// ── Types ───────────────────────────────────────────────────────────────────

export type GatewayState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

interface GatewayStateStore {
  // ── Gateway connection state machine ─────────────────────────────────────
  gatewayState: GatewayState
  helixConnected: boolean // derived: gatewayState === 'open'
  helixSessionId: string | null
  helixError: string | null
  gatewayEpoch: number

  // ── Session tracking ─────────────────────────────────────────────────────
  currentCwd: string | null
  currentBranch: string | null
  interrupted: boolean
  autoCompacting: boolean

  // ── Actions ──────────────────────────────────────────────────────────────
  setGatewayState: (state: GatewayState) => void
  setHelixConnected: (connected: boolean) => void
  setHelixSessionId: (id: string | null) => void
  setHelixError: (error: string | null) => void
  bumpGatewayEpoch: () => void
  setCurrentCwd: (cwd: string | null) => void
  setCurrentBranch: (branch: string | null) => void
  setInterrupted: (v: boolean) => void
  setAutoCompacting: (v: boolean) => void
}

// ── Store ───────────────────────────────────────────────────────────────────

export const useGatewayStore = create<GatewayStateStore>((set) => ({
  gatewayState: 'idle',
  helixConnected: false,
  helixSessionId: null,
  helixError: null,
  gatewayEpoch: 0,
  currentCwd: null,
  currentBranch: null,
  interrupted: false,
  autoCompacting: false,

  setGatewayState: (state) => set({
    gatewayState: state,
    helixConnected: state === 'open',
    helixError: state === 'error' ? 'Gateway error' : state === 'closed' ? 'Gateway disconnected' : null,
  }),
  setHelixConnected: (connected) => set({ helixConnected: connected }),
  setHelixSessionId: (id) => set({ helixSessionId: id }),
  setHelixError: (error) => set({ helixError: error }),
  bumpGatewayEpoch: () => set((s) => ({ gatewayEpoch: s.gatewayEpoch + 1 })),
  setCurrentCwd: (cwd) => set({ currentCwd: cwd }),
  setCurrentBranch: (branch) => set({ currentBranch: branch }),
  setInterrupted: (v) => set({ interrupted: v }),
  setAutoCompacting: (v) => set({ autoCompacting: v }),
}))
