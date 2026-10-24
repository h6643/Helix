"use client";

import { useCallback, useEffect } from "react";
import { isRemoteWorkDir } from "@/lib/remote-projects";
import { useHelixStore } from "@/stores/helix-store";

// Parse key string like "Ctrl+Shift+X" into a normalized format
function parseKeyString(keys: string[]): {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
} {
  let ctrl = false,
    shift = false,
    alt = false,
    meta = false,
    key = "";
  for (const k of keys) {
    const lower = k.toLowerCase();
    if (lower === "ctrl" || lower === "control") ctrl = true;
    else if (lower === "shift") shift = true;
    else if (lower === "alt") alt = true;
    else if (lower === "meta" || lower === "cmd" || lower === "command")
      meta = true;
    else key = k.length === 1 ? k.toLowerCase() : k;
  }
  return { ctrl, shift, alt, meta, key };
}

function matchShortcut(e: KeyboardEvent, shortcutKeys: string[]): boolean {
  const parsed = parseKeyString(shortcutKeys);
  const isMod = e.ctrlKey || e.metaKey;

  // Check modifier keys
  if (parsed.ctrl !== isMod) return false;
  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.alt !== e.altKey) return false;

  // Check main key
  if (!parsed.key) return false;
  const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return eventKey === parsed.key.toLowerCase();
}

// Action handlers map
function createActionHandler(state: ReturnType<typeof useHelixStore.getState>) {
  return {
    // Panel toggles
    "toggle-command-palette": () => state.toggleCommandPalette(),

    "toggle-scheduled-tasks-panel": () => state.toggleScheduledTasksPanel(),
    "toggle-terminal": () => {
      // 云端对话没有本机终端可开（与标题栏/文件树/命令面板同一判定），快捷键
      // 对它不生效，而不是去翻转一个不会显示的面板。
      if (isRemoteWorkDir(state.activeSessionWorkDir)) return;
      state.toggleTerminal();
    },
    "toggle-settings": () => state.toggleSettings(),
    "toggle-file-tree": () => {
      if (state.selectedWorkDir)
        state.toggleDirectoryProject(state.selectedWorkDir);
    },
    settings: () => state.toggleSettings(),
    "show-shortcuts": () => {},
    "command-palette": () => state.toggleCommandPalette(),

    // Chat
    "new-chat": () => state.clearChat(),
    "archive-chat": () => state.clearChat(),
    "rename-chat": () => {
      const sessionId = state.currentSessionId;
      if (sessionId)
        window.dispatchEvent(
          new CustomEvent("helix:rename-session", { detail: { sessionId } }),
        );
    },
    "search-chats": () => state.toggleSessionManager(),
    "prev-chat": () => state.toggleSessionManager(),
    "go-back": () => state.navigateHistory("back"),
    "go-forward": () => state.navigateHistory("forward"),

    // Tabs
    "prev-tab": () => {
      const tabs = state.openTabs;
      if (tabs.length > 1) {
        const idx = tabs.findIndex((t) => t.id === state.activeTabId);
        state.setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
      }
    },

    // Approve/decline
    "approve-request": () => {
      window.dispatchEvent(
        new CustomEvent("helix:approve-request", {
          detail: { approved: true },
        }),
      );
    },
    "decline-request": () => {
      window.dispatchEvent(
        new CustomEvent("helix:approve-request", {
          detail: { approved: false },
        }),
      );
    },

    // Navigation & misc
    "quick-chat": () => state.clearChat(),
    "search-chat": () =>
      window.dispatchEvent(new CustomEvent("helix:conversation-search")),
    "next-recent-chat": () => state.toggleSessionManager(),
    "prev-recent-chat": () => state.toggleSessionManager(),
    // 「右侧边栏」页（MoreActionsPage）那几张卡的快捷键版本：动作与卡片点击
    // 完全同一套（卡片上的 kbd 读的也正是这几个 id），改键两边一起变。
    "open-review": () => state.setRightSidebarTab("diff"),
    "open-terminal": () => state.setRightSidebarTab("terminal"),
    "open-browser": () => state.requestAddBrowserPage(),
    "force-reload": () => window.location.reload(),
    "new-window": () => window.open(window.location.href, "_blank"),
    "model-picker": () => state.toggleSettings("api"),

    // No-op for actions not yet implemented
    default: () => {},
  };
}

export function KeyboardShortcuts() {
  const storeState = useHelixStore();
  const {
    activeTabId,
    closeTab,
    setActiveTab,
    markTabSaved,
    customShortcuts,
    toggleScheduledTasksPanel,
  } = storeState;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // Check custom shortcuts first (always active)
      for (const [, shortcut] of Object.entries(customShortcuts)) {
        if (matchShortcut(e, shortcut.keys)) {
          e.preventDefault();
          // Dispatch action
          const action = shortcut.action;
          const handlerMap = createActionHandler(useHelixStore.getState());
          const handler =
            handlerMap[
              action as keyof ReturnType<typeof createActionHandler>
            ] || handlerMap["default"];
          handler();
          return;
        }
      }

      // Ctrl+Shift+T: Toggle scheduled tasks panel
      if (isMod && e.shiftKey && e.key === "T") {
        e.preventDefault();
        toggleScheduledTasksPanel();
        return;
      }

      // Skip remaining shortcuts if input is focused
      if (isInputFocused) return;

      // Ctrl+S: Save
      if (isMod && e.key === "s") {
        e.preventDefault();
        if (activeTabId) {
          markTabSaved(activeTabId);
          const state = useHelixStore.getState();
          const tab = state.openTabs.find((t) => t.id === activeTabId);
          if (tab) {
            state.addTerminalOutput(`\x1b[32m[保存] ${tab.name} 已保存\x1b[0m`);
          }
        }
        return;
      }

      // Ctrl+W: Close active tab
      if (isMod && e.key === "w") {
        e.preventDefault();
        if (activeTabId) closeTab(activeTabId);
        return;
      }

      // Ctrl+Shift+C: Copy file path
      if (isMod && e.shiftKey && e.key === "C") {
        e.preventDefault();
        const state = useHelixStore.getState();
        const tab = state.openTabs.find((t) => t.id === state.activeTabId);
        if (tab) {
          const path = state.getFilePath(tab.fileId);
          navigator.clipboard.writeText(path);
        }
        return;
      }

      // Ctrl+1 to Ctrl+9: Switch to tab N
      if (isMod && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const num = parseInt(e.key);
        const state = useHelixStore.getState();
        if (num <= state.openTabs.length) {
          setActiveTab(state.openTabs[num - 1].id);
        }
        return;
      }

      // F2: Rename active file
      if (e.key === "F2") {
        e.preventDefault();
        const state = useHelixStore.getState();
        const tab = state.openTabs.find((t) => t.id === state.activeTabId);
        if (tab) {
          const newName = prompt("重命名文件：", tab.name);
          if (newName?.trim() && newName.trim() !== tab.name) {
            state.renameFile(tab.fileId, newName.trim());
          }
        }
        return;
      }

      // F12: Toggle DevTools
      if (e.key === "F12") {
        e.preventDefault();
        window.electron?.window?.toggleDevTools();
        return;
      }

      // Delete: Delete selected file
      if (e.key === "Delete") {
        const state = useHelixStore.getState();
        if (state.selectedFileId) {
          const file = state.getFileById(state.selectedFileId);
          if (file && confirm(`确定要删除 ${file.name} 吗？`)) {
            state.deleteFile(state.selectedFileId);
          }
        }
        return;
      }
    },
    [
      activeTabId,
      closeTab,
      setActiveTab,
      markTabSaved,
      customShortcuts,
      toggleScheduledTasksPanel,
    ],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return null;
}
