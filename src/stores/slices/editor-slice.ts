/**
 * Embedded code-editor slice. Isolated domain: holds open file tabs for the
 * in-app code editor (opened from the file tree), plus the panel toggle.
 *
 * NOTE: this slice deliberately does NOT import electron-bridge / electronFS.
 * The actual disk read/write lives in the UI layer (file-tree-panel /
 * code-editor-panel) to avoid a circular import
 * (helix-store → editor-slice → electron-bridge → helix-store). The slice only
 * manages in-memory tab state; the component performs the IO and then calls
 * markEditorTabSaved() once the write succeeds.
 */
import type { StateCreator } from 'zustand'

interface EditorTab {
  /** Stable id — equals the file path relative to the working directory. */
  id: string
  /** Path relative to the working directory (what fs:read/write expect). */
  path: string
  name: string
  /** Editor content (live, editable). */
  content: string
  /** Content as last loaded from / saved to disk — used to compute dirty. */
  originalContent: string
  dirty: boolean
}

export interface EditorSlice {
  editorOpen: boolean
  editorTabs: EditorTab[]
  activeEditorTabId: string | null

  openFileInEditor: (path: string, name: string, content: string) => void
  closeEditorTab: (id: string) => void
  closeAllEditorTabs: () => void
  setActiveEditorTab: (id: string) => void
  updateEditorTabContent: (id: string, content: string) => void
  markEditorTabSaved: (id: string) => void
  toggleCodeEditor: () => void
  closeCodeEditor: () => void
}

export const createEditorSlice: StateCreator<EditorSlice, [], [], EditorSlice> = (set, get) => ({
  editorOpen: false,
  editorTabs: [],
  activeEditorTabId: null,

  openFileInEditor: (path, name, content) => {
    const existing = get().editorTabs.find((t) => t.id === path)
    if (existing) {
      set({ activeEditorTabId: path, editorOpen: true })
      return
    }
    const tab: EditorTab = {
      id: path,
      path,
      name,
      content,
      originalContent: content,
      dirty: false,
    }
    set((s) => ({
      editorTabs: [...s.editorTabs, tab],
      activeEditorTabId: path,
      editorOpen: true,
    }))
  },

  closeEditorTab: (id) => {
    set((s) => {
      const idx = s.editorTabs.findIndex((t) => t.id === id)
      const tabs = s.editorTabs.filter((t) => t.id !== id)
      let active = s.activeEditorTabId
      if (active === id) {
        if (tabs.length === 0) active = null
        else active = tabs[Math.min(idx, tabs.length - 1)].id
      }
      return { editorTabs: tabs, activeEditorTabId: active, editorOpen: tabs.length > 0 ? s.editorOpen : false }
    })
  },

  closeAllEditorTabs: () => set({ editorTabs: [], activeEditorTabId: null, editorOpen: false }),

  setActiveEditorTab: (id) => set({ activeEditorTabId: id, editorOpen: true }),

  updateEditorTabContent: (id, content) => {
    set((s) => ({
      editorTabs: s.editorTabs.map((t) =>
        t.id === id ? { ...t, content, dirty: content !== t.originalContent } : t,
      ),
    }))
  },

  markEditorTabSaved: (id) => {
    set((s) => ({
      editorTabs: s.editorTabs.map((t) =>
        t.id === id ? { ...t, originalContent: t.content, dirty: false } : t,
      ),
    }))
  },

  toggleCodeEditor: () => set((s) => ({ editorOpen: !s.editorOpen })),
  closeCodeEditor: () => set({ editorOpen: false }),
})
