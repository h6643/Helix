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
import type { StateCreator } from "zustand";

interface EditorTab {
  /** Stable id — equals the file path relative to the working directory. */
  id: string;
  /** Path relative to the working directory (what fs:read/write expect). */
  path: string;
  name: string;
  /** Editor content (live, editable). */
  content: string;
  /** Content as last loaded from / saved to disk — used to compute dirty. */
  originalContent: string;
  dirty: boolean;
}

export interface EditorRevealRequest {
  /** Tab id (= absolute file path) this request targets. */
  path: string;
  /** 1-based inclusive line range to scroll to / highlight. */
  start: number;
  end: number;
  /** 递增序号：同一个文件重复点击时对象引用才会变，消费方（effect）也才有
   *  依据做「只消费一次」判断。 */
  nonce: number;
}

export interface EditorSlice {
  editorOpen: boolean;
  editorTabs: EditorTab[];
  activeEditorTabId: string | null;
  /** Editor tab awaiting an unsaved-changes confirmation before it closes. */
  pendingCloseId: string | null;
  /** 一次性的「跳到指定行」请求（见 revealEditorRange）。 */
  editorReveal: EditorRevealRequest | null;

  openFileInEditor: (path: string, name: string, content: string) => void;
  /** Synchronously create / activate a tab carrying only the file NAME (empty
   *  content) so the right-sidebar page strip can show the name immediately,
   *  before the (async) disk read finishes. Returns true if a new empty tab was
   *  created (so the caller can close it again on a read failure). */
  ensureEditorTab: (path: string, name: string) => boolean;
  /** Fill the content of a previously-created empty (optimistic) tab. */
  fillEditorTabContent: (path: string, content: string) => void;
  closeEditorTab: (id: string) => void;
  closeAllEditorTabs: () => void;
  setActiveEditorTab: (id: string) => void;
  setPendingCloseId: (id: string | null) => void;
  /** 请求编辑器把 path 这个 tab 滚到 [start, end] 行（1-based 闭区间）并高亮。
   *  只打开文件不定位，用户还得自己找改动；「已修改」卡片点文件名走这里。 */
  revealEditorRange: (path: string, start: number, end?: number) => void;
  updateEditorTabContent: (id: string, content: string) => void;
  markEditorTabSaved: (id: string) => void;
  toggleCodeEditor: () => void;
  closeCodeEditor: () => void;
}

/**
 * 切到别的文件时丢掉上一条跳转请求：reveal 里存的是绝对路径，若不清掉，
 * 用户之后从文件树重新打开那个文件会被莫名其妙地滚到某一行。
 * 只在「目标变了」时清 —— 同一路径的重复点击要继续生效（见 nonce）。
 */
function clearStaleReveal(
  get: () => EditorSlice,
  set: (partial: Partial<EditorSlice>) => void,
  path: string,
) {
  const cur = get().editorReveal;
  if (cur && cur.path !== path) set({ editorReveal: null });
}

export const createEditorSlice: StateCreator<
  EditorSlice,
  [],
  [],
  EditorSlice
> = (set, get) => ({
  editorOpen: false,
  editorTabs: [],
  activeEditorTabId: null,
  pendingCloseId: null,
  editorReveal: null,

  openFileInEditor: (path, name, content) => {
    const existing = get().editorTabs.find((t) => t.id === path);
    if (existing) {
      set({ activeEditorTabId: path, editorOpen: true });
      clearStaleReveal(get, set, path);
      return;
    }
    const tab: EditorTab = {
      id: path,
      path,
      name,
      content,
      originalContent: content,
      dirty: false,
    };
    set((s) => ({
      editorTabs: [...s.editorTabs, tab],
      activeEditorTabId: path,
      editorOpen: true,
    }));
    clearStaleReveal(get, set, path);
  },

  ensureEditorTab: (path, name) => {
    const existing = get().editorTabs.find((t) => t.id === path);
    if (existing) {
      set({ activeEditorTabId: path, editorOpen: true });
      clearStaleReveal(get, set, path);
      return false;
    }
    const tab: EditorTab = {
      id: path,
      path,
      name,
      content: "",
      originalContent: "",
      dirty: false,
    };
    set((s) => ({
      editorTabs: [...s.editorTabs, tab],
      activeEditorTabId: path,
      editorOpen: true,
    }));
    clearStaleReveal(get, set, path);
    return true;
  },

  fillEditorTabContent: (path, content) => {
    set((s) => ({
      editorTabs: s.editorTabs.map((t) =>
        t.id === path
          ? { ...t, content, originalContent: content, dirty: false }
          : t,
      ),
    }));
  },

  closeEditorTab: (id) => {
    set((s) => {
      const idx = s.editorTabs.findIndex((t) => t.id === id);
      const tabs = s.editorTabs.filter((t) => t.id !== id);
      let active = s.activeEditorTabId;
      if (active === id) {
        if (tabs.length === 0) active = null;
        else active = tabs[Math.min(idx, tabs.length - 1)].id;
      }
      return {
        editorTabs: tabs,
        activeEditorTabId: active,
        editorOpen: tabs.length > 0 ? s.editorOpen : false,
        editorReveal: s.editorReveal?.path === id ? null : s.editorReveal,
      };
    });
  },

  closeAllEditorTabs: () =>
    set({
      editorTabs: [],
      activeEditorTabId: null,
      editorOpen: false,
      editorReveal: null,
    }),

  setActiveEditorTab: (id) => set({ activeEditorTabId: id, editorOpen: true }),

  setPendingCloseId: (id) => set({ pendingCloseId: id }),

  revealEditorRange: (path, start, end) => {
    const s = Math.max(1, Math.floor(start) || 1);
    const e = Math.max(s, Math.floor(end ?? s) || s);
    set({
      editorReveal: {
        path,
        start: s,
        end: e,
        nonce: (get().editorReveal?.nonce ?? 0) + 1,
      },
    });
  },

  updateEditorTabContent: (id, content) => {
    set((s) => ({
      editorTabs: s.editorTabs.map((t) =>
        t.id === id
          ? { ...t, content, dirty: content !== t.originalContent }
          : t,
      ),
    }));
  },

  markEditorTabSaved: (id) => {
    set((s) => ({
      editorTabs: s.editorTabs.map((t) =>
        t.id === id ? { ...t, originalContent: t.content, dirty: false } : t,
      ),
    }));
  },

  toggleCodeEditor: () => set((s) => ({ editorOpen: !s.editorOpen })),
  closeCodeEditor: () => set({ editorOpen: false }),
});
