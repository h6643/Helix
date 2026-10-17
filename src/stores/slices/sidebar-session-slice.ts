/**
 * Per-session right-sidebar state.
 *
 * Every conversation gets its own independent right-sidebar workspace:
 *   · the list of open pages (browser / diff / agent / byline / terminal)
 *   · which page is active
 *   · which sub-agent is being viewed
 *
 * The flat fields (`rightSidebarPages`, `activePageId`, `activeAgentView`)
 * are the *current-session view* — always the data for `currentSessionId`.
 * They are swapped in and out of the per-session records (`…BySession`) on
 * session change, so existing code that reads `s.editorTabs` or calls
 * `s.openFileInEditor()` keeps working unchanged.
 *
 * Editor tabs (`editorTabs`, `activeEditorTabId`) are handled separately in
 * `editor-slice.ts`; this slice only covers the right-sidebar page model and
 * the agent view.
 */
import type { StateCreator } from "zustand";

/**
 * One entry in the right-sidebar pages array.
 * Mirrors the local `PanelPage` type that used to live in right-sidebar.tsx.
 */
export interface SidebarPage {
  id: string;
  kind:
    | "browser"
    | "code"
    | "diff"
    | "agent"
    | "byline"
    | "terminal"
    | "more";
  url: string;
}

export interface AgentView {
  id: string;
  name: string;
}

export interface SidebarSessionSlice {
  // ── Per-session backing stores ──────────────────────────────────────────
  rightSidebarPagesBySession: Record<string, SidebarPage[]>;
  activePageIdBySession: Record<string, string | null>;
  activeAgentViewBySession: Record<string, AgentView | null>;

  // ── Current-session view (synced by swapSidebarSession) ────────────────
  rightSidebarPages: SidebarPage[];
  activePageId: string | null;

  // ── Mutators (write to current session + backing store) ────────────────
  setRightSidebarPages: (pages: SidebarPage[]) => void;
  setActivePageId: (id: string | null) => void;
}

export const createSidebarSessionSlice: StateCreator<
  SidebarSessionSlice,
  [],
  [],
  SidebarSessionSlice
> = (set) => ({
  rightSidebarPagesBySession: {},
  activePageIdBySession: {},
  activeAgentViewBySession: {},

  rightSidebarPages: [],
  activePageId: null,

  setRightSidebarPages: (pages) =>
    set((s) => {
      const cid = (s as unknown as { currentSessionId: string | null }).currentSessionId ?? "__draft__";
      return {
        rightSidebarPages: pages,
        rightSidebarPagesBySession: {
          ...s.rightSidebarPagesBySession,
          [cid]: pages,
        },
      };
    }),

  setActivePageId: (id) =>
    set((s) => {
      const cid = (s as unknown as { currentSessionId: string | null }).currentSessionId ?? "__draft__";
      return {
        activePageId: id,
        activePageIdBySession: {
          ...s.activePageIdBySession,
          [cid]: id,
        },
      };
    }),
});

/**
 * Pure swap function: save the current session's sidebar state and restore the
 * target session's. Called from `setCurrentSessionId` alongside
 * `swapRightSidebarTab`.  `nextId === null` (new-conversation draft) only
 * saves; it does not restore (there is no target yet).
 */
export function swapSidebarSession(
  state: SidebarSessionSlice & {
    currentSessionId: string | null;
    activeAgentView: AgentView | null;
  },
  nextId: string | null,
): Partial<SidebarSessionSlice & { activeAgentView: AgentView | null }> {
  const cid = state.currentSessionId ?? "__draft__";

  // Save current session's state
  const pagesBySession = {
    ...state.rightSidebarPagesBySession,
    [cid]: state.rightSidebarPages,
  };
  const pageIdBySession = {
    ...state.activePageIdBySession,
    [cid]: state.activePageId,
  };
  const agentViewBySession = {
    ...state.activeAgentViewBySession,
    [cid]: state.activeAgentView,
  };

  if (!nextId) {
    return {
      rightSidebarPagesBySession: pagesBySession,
      activePageIdBySession: pageIdBySession,
      activeAgentViewBySession: agentViewBySession,
    };
  }

  // Restore target session's state
  return {
    rightSidebarPagesBySession: pagesBySession,
    activePageIdBySession: pageIdBySession,
    activeAgentViewBySession: agentViewBySession,
    rightSidebarPages: pagesBySession[nextId] ?? [],
    activePageId: pageIdBySession[nextId] ?? null,
    activeAgentView: agentViewBySession[nextId] ?? null,
  };
}
