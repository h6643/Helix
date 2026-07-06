'use client'

import React, { useCallback, useEffect } from 'react'
import { useHelixStore } from '@/stores/helix-store'

// Parse key string like "Ctrl+Shift+X" into a normalized format
function parseKeyString(keys: string[]): { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; key: string } {
  let ctrl = false, shift = false, alt = false, meta = false, key = ''
  for (const k of keys) {
    const lower = k.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') ctrl = true
    else if (lower === 'shift') shift = true
    else if (lower === 'alt') alt = true
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') meta = true
    else key = k.length === 1 ? k.toLowerCase() : k
  }
  return { ctrl, shift, alt, meta, key }
}

function matchShortcut(e: KeyboardEvent, shortcutKeys: string[]): boolean {
  const parsed = parseKeyString(shortcutKeys)
  const isMod = e.ctrlKey || e.metaKey

  // Check modifier keys
  if (parsed.ctrl !== isMod) return false
  if (parsed.shift !== e.shiftKey) return false
  if (parsed.alt !== e.altKey) return false

  // Check main key
  if (!parsed.key) return false
  const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key
  return eventKey === parsed.key.toLowerCase()
}

// Action handlers map
function createActionHandler(state: ReturnType<typeof useHelixStore.getState>) {
  return {
    // Panel toggles
    'toggle-command-palette': () => state.toggleCommandPalette(),
    'toggle-session-manager': () => state.toggleSessionManager(),
    'toggle-skill-panel': () => state.toggleSkillPanel(),
    'toggle-scheduled-tasks-panel': () => state.toggleScheduledTasksPanel(),
    'toggle-terminal': () => state.toggleTerminal(),
    'toggle-settings': () => state.toggleSettings(),

    // Chat
    'new-chat': () => state.clearChat(),
    'archive-chat': () => {}, // TODO: implement archive
    'rename-chat': () => {}, // TODO: implement rename
    'search-chats': () => {}, // TODO: implement search
    'next-chat': () => {}, // TODO: implement
    'prev-chat': () => {}, // TODO: implement

    // Tabs
    'close-tab': () => { if (state.activeTabId) state.closeTab(state.activeTabId) },
    'next-tab': () => {
      const tabs = state.openTabs
      if (tabs.length > 1) {
        const idx = tabs.findIndex(t => t.id === state.activeTabId)
        state.setActiveTab(tabs[(idx + 1) % tabs.length].id)
      }
    },
    'prev-tab': () => {
      const tabs = state.openTabs
      if (tabs.length > 1) {
        const idx = tabs.findIndex(t => t.id === state.activeTabId)
        state.setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length].id)
      }
    },
    'chat-1': () => { if (state.openTabs[0]) state.setActiveTab(state.openTabs[0].id) },
    'chat-2': () => { if (state.openTabs[1]) state.setActiveTab(state.openTabs[1].id) },
    'chat-3': () => { if (state.openTabs[2]) state.setActiveTab(state.openTabs[2].id) },
    'chat-4': () => { if (state.openTabs[3]) state.setActiveTab(state.openTabs[3].id) },
    'chat-5': () => { if (state.openTabs[4]) state.setActiveTab(state.openTabs[4].id) },
    'chat-6': () => { if (state.openTabs[5]) state.setActiveTab(state.openTabs[5].id) },
    'chat-7': () => { if (state.openTabs[6]) state.setActiveTab(state.openTabs[6].id) },
    'chat-8': () => { if (state.openTabs[7]) state.setActiveTab(state.openTabs[7].id) },
    'chat-9': () => { if (state.openTabs[8]) state.setActiveTab(state.openTabs[8].id) },

    // File operations
    'copy-path': () => {
      const tab = state.openTabs.find(t => t.id === state.activeTabId)
      if (tab) {
        const path = state.getFilePath(tab.fileId)
        navigator.clipboard.writeText(path)
      }
    },
    'copy-workdir': () => {
      navigator.clipboard.writeText(state.selectedWorkDir || '')
    },
    'copy-session-id': () => {
      navigator.clipboard.writeText(state.currentSessionId || '')
    },

    // Model picker
    'model-picker': () => state.toggleCommandPalette(),

    // Toggle panels
    'toggle-file-tree': () => {}, // TODO: implement

    // No-op for actions not yet implemented
    'default': () => {},
  }
}

export function KeyboardShortcuts() {
  const storeState = useHelixStore()
  const { toggleCommandPalette, activeTabId, closeTab, openTabs, setActiveTab, markTabSaved, showToast, setCommandPaletteOpen, customShortcuts, toggleSessionManager, toggleSkillPanel, toggleScheduledTasksPanel } =
    storeState

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey
      const target = e.target as HTMLElement
      const isInputFocused = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      // Check custom shortcuts first (always active)
      for (const [id, shortcut] of Object.entries(customShortcuts)) {
        if (matchShortcut(e, shortcut.keys)) {
          e.preventDefault()
          // Dispatch action
          const action = shortcut.action
          const handlerMap = createActionHandler(useHelixStore.getState())
          const handler = handlerMap[action as keyof ReturnType<typeof createActionHandler>] || handlerMap['default']
          handler()
          return
        }
      }

      // Ctrl+K: Command Palette (always)
      if (isMod && e.key === 'k') {
        e.preventDefault()
        toggleCommandPalette()
        return
      }

      // Ctrl+P: Quick file open (always)
      if (isMod && e.key === 'p' && !e.shiftKey) {
        e.preventDefault()
        setCommandPaletteOpen(true)
        return
      }

      // Ctrl+Shift+M: Toggle session manager
      if (isMod && e.shiftKey && e.key === 'M') {
        e.preventDefault()
        toggleSessionManager()
        return
      }

      // Ctrl+Shift+P: Toggle skill panel
      if (isMod && e.shiftKey && e.key === 'P') {
        e.preventDefault()
        toggleSkillPanel()
        return
      }

      // Ctrl+Shift+T: Toggle scheduled tasks panel
      if (isMod && e.shiftKey && e.key === 'T') {
        e.preventDefault()
        toggleScheduledTasksPanel()
        return
      }

      // Ctrl+L: Focus chat input
      if (isMod && !e.shiftKey && e.key === 'l') {
        e.preventDefault()
        const chatInput = document.querySelector<HTMLTextAreaElement>('[data-chat-input]')
        if (chatInput) {
          chatInput.focus()
        }
        return
      }

      // Skip remaining shortcuts if input is focused
      if (isInputFocused) return

      // Ctrl+S: Save
      if (isMod && e.key === 's') {
        e.preventDefault()
        if (activeTabId) {
          markTabSaved(activeTabId)
          const state = useHelixStore.getState()
          const tab = state.openTabs.find(t => t.id === activeTabId)
          if (tab) {
            state.addTerminalOutput(`\x1b[32m[保存] ${tab.name} 已保存\x1b[0m`)
            showToast({ type: 'success', title: '已保存', description: tab.name })
          }
        }
        return
      }

      // Ctrl+W: Close active tab
      if (isMod && e.key === 'w') {
        e.preventDefault()
        if (activeTabId) closeTab(activeTabId)
        return
      }

      // Ctrl+Shift+N: New file
      if (isMod && e.shiftKey && e.key === 'N') {
        e.preventDefault()
        const name = prompt('输入文件名：')
        if (name?.trim()) {
          useHelixStore.getState().createFile(null, name.trim(), 'file')
        }
        return
      }

      // Ctrl+Tab: Next tab
      if (isMod && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        const state = useHelixStore.getState()
        const tabs = state.openTabs
        if (tabs.length > 1) {
          const idx = tabs.findIndex(t => t.id === state.activeTabId)
          const next = tabs[(idx + 1) % tabs.length]
          setActiveTab(next.id)
        }
        return
      }

      // Ctrl+Shift+Tab: Previous tab
      if (isMod && e.shiftKey && e.key === 'Tab') {
        e.preventDefault()
        const state = useHelixStore.getState()
        const tabs = state.openTabs
        if (tabs.length > 1) {
          const idx = tabs.findIndex(t => t.id === state.activeTabId)
          const prev = tabs[(idx - 1 + tabs.length) % tabs.length]
          setActiveTab(prev.id)
        }
        return
      }

      // Ctrl+`: Toggle terminal
      if (isMod && e.key === '`') {
        e.preventDefault()
        useHelixStore.getState().toggleTerminal()
        return
      }

      // Ctrl+Shift+C: Copy file path
      if (isMod && e.shiftKey && e.key === 'C') {
        e.preventDefault()
        const state = useHelixStore.getState()
        const tab = state.openTabs.find(t => t.id === state.activeTabId)
        if (tab) {
          const path = state.getFilePath(tab.fileId)
          navigator.clipboard.writeText(path)
          showToast({ type: 'success', title: '路径已复制', description: path })
        }
        return
      }

      // Ctrl+1 to Ctrl+9: Switch to tab N
      if (isMod && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const num = parseInt(e.key)
        const state = useHelixStore.getState()
        if (num <= state.openTabs.length) {
          setActiveTab(state.openTabs[num - 1].id)
        }
        return
      }

      // F2: Rename active file
      if (e.key === 'F2') {
        e.preventDefault()
        const state = useHelixStore.getState()
        const tab = state.openTabs.find(t => t.id === state.activeTabId)
        if (tab) {
          const newName = prompt('重命名文件：', tab.name)
          if (newName?.trim() && newName.trim() !== tab.name) {
            state.renameFile(tab.fileId, newName.trim())
            showToast({ type: 'info', title: '文件已重命名', description: `${tab.name} → ${newName.trim()}` })
          }
        }
        return
      }

      // F12: Toggle DevTools
      if (e.key === 'F12') {
        e.preventDefault()
        ;(window as any).electron?.window?.toggleDevTools()
        return
      }

      // Delete: Delete selected file
      if (e.key === 'Delete') {
        const state = useHelixStore.getState()
        if (state.selectedFileId) {
          const file = state.getFileById(state.selectedFileId)
          if (file && confirm(`确定要删除 ${file.name} 吗？`)) {
            state.deleteFile(state.selectedFileId)
            showToast({ type: 'info', title: '已删除', description: file.name })
          }
        }
        return
      }
    },
    [toggleCommandPalette, activeTabId, closeTab, openTabs, setActiveTab, markTabSaved, showToast, setCommandPaletteOpen, customShortcuts, toggleSessionManager, toggleSkillPanel, toggleScheduledTasksPanel]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return null
}
