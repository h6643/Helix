'use client'

import React, { useCallback, useEffect } from 'react'
import { useHelixStore } from '@/stores/helix-store'

export function KeyboardShortcuts() {
  const { toggleCommandPalette, activeTabId, closeTab, openTabs, setActiveTab, markTabSaved, showToast, setCommandPaletteOpen, setChatLoading } =
    useHelixStore()

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey
      const target = e.target as HTMLElement
      const isInputFocused = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

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
    [toggleCommandPalette, activeTabId, closeTab, openTabs, setActiveTab, markTabSaved, showToast, setCommandPaletteOpen, setChatLoading]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return null
}