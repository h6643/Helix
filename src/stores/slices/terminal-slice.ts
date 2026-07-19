/**
 * Terminal output / history slice. Isolated domain: no cross-references with
 * other store state beyond being displayed in TerminalPanel.
 */
import type { StateCreator } from 'zustand'

export interface TerminalSlice {
  terminalOutput: string[]
  terminalRawBuffer: string
  isTerminalOpen: boolean
  terminalHistory: string[]
  terminalHistoryIndex: number
  addTerminalOutput: (output: string) => void
  clearTerminal: () => void
  setTerminalRawBuffer: (buffer: string) => void
  toggleTerminal: () => void
  pushTerminalHistory: (cmd: string) => void
  navigateTerminalHistory: (direction: 'up' | 'down') => string
}

export const createTerminalSlice: StateCreator<TerminalSlice, [], [], TerminalSlice> = (set, get) => ({
  terminalOutput: [
    'Helix v1.0.0 ready — type help for commands',
    '',
  ],
  terminalRawBuffer: '',
  isTerminalOpen: false,
  terminalHistory: [],
  terminalHistoryIndex: 0,

  addTerminalOutput: (output) =>
    set((state) => {
      const filtered = output.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim()
      if (!filtered) return state
      const lines = filtered.split('\n')
      return { terminalOutput: [...state.terminalOutput, ...lines] }
    }),
  clearTerminal: () => set({ terminalOutput: [], terminalRawBuffer: '' }),
  setTerminalRawBuffer: (buffer) => set({ terminalRawBuffer: buffer }),
  toggleTerminal: () => set((state) => ({ isTerminalOpen: !state.isTerminalOpen })),
  pushTerminalHistory: (cmd) =>
    set((state) => ({
      terminalHistory: [...state.terminalHistory, cmd],
      terminalHistoryIndex: state.terminalHistory.length + 1,
    })),
  navigateTerminalHistory: (direction) => {
    const state = get()
    const history = state.terminalHistory
    let idx = state.terminalHistoryIndex
    if (direction === 'up' && idx > 0) idx--
    else if (direction === 'down' && idx < history.length) idx++
    set({ terminalHistoryIndex: idx })
    return history[idx] || ''
  },
})
