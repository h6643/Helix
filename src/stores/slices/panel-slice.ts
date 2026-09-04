/**
 * Panel visibility toggles slice — all panel open/close state.
 * Zero business-logic cross-references; purely UI state.
 */
import type { StateCreator } from 'zustand'
import type { AvailableCommand, HermesTodo } from '../helix-types'

type NavEntry =
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
  showCustomizePanel: boolean
  showWorktreePanel: boolean
  showPluginManager: boolean
  availableCommands: AvailableCommand[]
  /**
   * Hermes's in-session todo list, captured from `session/update` events that
   * carry a todo/plan payload. Empty by default so the header button stays
   * hidden until the backend actually streams a list.
   */
  hermesTodos: HermesTodo[]
  /** 按会话缓存的 todo 列表（仅内存，不持久化）：切会话时按 currentSessionId
   *  恢复对应清单，避免 A 会话的任务清单串到 B 会话。 */
  hermesTodosBySession: Record<string, HermesTodo[]>
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
  toggleCustomizePanel: () => void
  toggleWorktreePanel: () => void
  togglePluginManager: () => void
  setAvailableCommands: (cmds: AvailableCommand[]) => void
  /** Replace the Hermes todo list (called whenever a fresh todo payload arrives).
   *  sessionId 标识该清单归属的 UI 会话：写入按会话缓存，且仅当它就是当前
   *  查看的会话时才更新展示列表（并行 run 不互相覆盖）。 */
  setHermesTodos: (todos: HermesTodo[], sessionId?: string) => void
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
  showCustomizePanel: false,
  showWorktreePanel: false,
  showPluginManager: false,
  availableCommands: [],
  hermesTodos: [],
  hermesTodosBySession: {},

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

  toggleCustomizePanel: () => set((s) => ({ showCustomizePanel: !s.showCustomizePanel })),
  toggleWorktreePanel: () => set((s) => ({ showWorktreePanel: !s.showWorktreePanel })),
  togglePluginManager: () => set((s) => ({ showPluginManager: !s.showPluginManager })),
  setAvailableCommands: (cmds) => set({ availableCommands: cmds }),
  setHermesTodos: (todos, sessionId) => set((s) => {
    const bySession = sessionId
      ? { ...s.hermesTodosBySession, [sessionId]: todos }
      : s.hermesTodosBySession
    const cur = (s as unknown as { currentSessionId: string | null }).currentSessionId
    const isVisible = sessionId === undefined || sessionId === cur
    return {
      hermesTodosBySession: bySession,
      ...(isVisible ? { hermesTodos: todos } : {}),
    }
  }),
  clearHermesTodos: () => set({ hermesTodos: [] }),
})
