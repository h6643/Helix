/**
 * Panel visibility toggles slice — all panel open/close state.
 * Zero business-logic cross-references; purely UI state.
 */
import type { StateCreator } from 'zustand'
import type { AvailableCommand, HermesTodo } from '../helix-types'

export type NavEntry =
  | { type: 'chat'; sessionId: string }
  | { type: 'settings'; page: string }

export interface PanelSlice {
  showCommandPalette: boolean
  showTaskPanel: boolean
  showSubAgentPanel: boolean
  showSessionManager: boolean
  showSettings: boolean
  settingsPage: string | null
  /** Unified navigation history — tracks both chat sessions and settings pages */
  navigationHistory: NavEntry[]
  navigationIndex: number
  showDiffPreview: boolean
  showCustomizePanel: boolean
  showWorktreePanel: boolean
  availableCommands: AvailableCommand[]
  /**
   * Hermes's in-session todo list, captured from `session/update` events that
   * carry a todo/plan payload. Empty by default so the header button stays
   * hidden until the backend actually streams a list.
   */
  hermesTodos: HermesTodo[]
  toggleCommandPalette: () => void
  setCommandPaletteOpen: (open: boolean) => void
  toggleTaskPanel: () => void
  toggleSubAgentPanel: () => void
  toggleSessionManager: () => void
  toggleSettings: (page?: string) => void
  setSettingsPage: (page: string | null) => void
  pushNavigation: (entry: NavEntry) => void
  navigateBack: () => NavEntry | null
  navigateForward: () => NavEntry | null
  canGoBack: () => boolean
  canGoForward: () => boolean
  setShowDiffPreview: (show: boolean) => void
  toggleCustomizePanel: () => void
  toggleWorktreePanel: () => void
  setAvailableCommands: (cmds: AvailableCommand[]) => void
  /** Replace the Hermes todo list (called whenever a fresh todo payload arrives). */
  setHermesTodos: (todos: HermesTodo[]) => void
  /** Clear the todo list (e.g. when a run completes or the session is reset). */
  clearHermesTodos: () => void
}

export const createPanelSlice: StateCreator<PanelSlice, [], [], PanelSlice> = (set, get) => ({
  showCommandPalette: false,
  showTaskPanel: false,
  showSubAgentPanel: false,
  showSessionManager: false,
  showSettings: false,
  settingsPage: null,
  navigationHistory: [],
  navigationIndex: -1,
  showDiffPreview: false,
  showCustomizePanel: false,
  showWorktreePanel: false,
  availableCommands: [],
  hermesTodos: [],

  toggleCommandPalette: () =>
    set((state) => ({ showCommandPalette: !state.showCommandPalette })),
  setCommandPaletteOpen: (open) => set({ showCommandPalette: open }),
  toggleTaskPanel: () => set((s) => ({ showTaskPanel: !s.showTaskPanel })),
  toggleSubAgentPanel: () => set((s) => ({ showSubAgentPanel: !s.showSubAgentPanel })),
  toggleSessionManager: () => set((s) => ({ showSessionManager: !s.showSessionManager })),
  toggleSettings: (page?) => set((s) => ({
    showSettings: page ? true : !s.showSettings,
    settingsPage: page ?? s.settingsPage,
  })),
  setSettingsPage: (page) => set({ settingsPage: page }),

  pushNavigation: (entry) => set((s) => {
    const history = [...s.navigationHistory]
    const idx = s.navigationIndex
    // Remove forward history and push new entry
    const newHistory = [...history.slice(0, idx + 1), entry]
    return {
      navigationHistory: newHistory,
      navigationIndex: newHistory.length - 1,
    }
  }),

  navigateBack: () => {
    const { navigationHistory, navigationIndex } = get()
    if (navigationIndex <= 0) return null
    const newIndex = navigationIndex - 1
    const entry = navigationHistory[newIndex]
    set({ navigationIndex: newIndex })
    return entry
  },

  navigateForward: () => {
    const { navigationHistory, navigationIndex } = get()
    if (navigationIndex >= navigationHistory.length - 1) return null
    const newIndex = navigationIndex + 1
    const entry = navigationHistory[newIndex]
    set({ navigationIndex: newIndex })
    return entry
  },

  canGoBack: () => get().navigationIndex > 0,
  canGoForward: () => {
    const { navigationHistory, navigationIndex } = get()
    return navigationIndex < navigationHistory.length - 1
  },

  setShowDiffPreview: (show) => set({ showDiffPreview: show }),
  toggleCustomizePanel: () => set((s) => ({ showCustomizePanel: !s.showCustomizePanel })),
  toggleWorktreePanel: () => set((s) => ({ showWorktreePanel: !s.showWorktreePanel })),
  setAvailableCommands: (cmds) => set({ availableCommands: cmds }),
  setHermesTodos: (todos) => set({ hermesTodos: todos }),
  clearHermesTodos: () => set({ hermesTodos: [] }),
})
