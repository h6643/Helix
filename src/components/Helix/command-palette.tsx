'use client'

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import {
  Search,
  FileCode,
  Plus,
  Terminal,
  MessageSquare,
  FolderPlus,
  Save,
  Trash2,
  Keyboard,
  Moon,
  Sun,
  Copy,
  Settings,
  Sparkles,
} from 'lucide-react'
import { useHelixStore, type FileNode } from '@/stores/helix-store'
import { DEFAULT_SHORTCUTS } from '@/stores/helix-types'

function getShortcutLabel(id: string, customShortcuts: Record<string, { keys: string[] }>): string {
  const entry = customShortcuts[id] || DEFAULT_SHORTCUTS[id]
  return entry?.keys?.join('+') || ''
}

interface CommandItem {
  id: string
  label: string
  description?: string
  icon: React.ReactNode
  action: () => void
  category: 'file' | 'action'
  shortcut?: string
  disabled?: boolean
}

export function CommandPalette() {
  const {
    showCommandPalette,
    setCommandPaletteOpen,
    openFile,
    toggleTerminal,
    clearChat,
    createFile,
    files,
    showToast,
    markTabSaved,
    activeTabId,
    openTabs,
    editorTheme,
    setEditorTheme,
    getAllFiles,
    getFilePath,
    customShortcuts,
  } = useHelixStore()

  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedIndexRef = useRef(0)

  const allFiles = useMemo(() => {
    const result: FileNode[] = []
    const collect = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.type === 'file') result.push(n)
        if (n.children) collect(n.children)
      }
    }
    collect(files)
    return result
  }, [files])

  const commands = useMemo<CommandItem[]>(() => {
    const fileItems: CommandItem[] = allFiles.map((f) => ({
      id: `file-${f.id}`,
      label: f.name,
      description: useHelixStore.getState().getFilePath(f.id),
      icon: <FileCode className="size-4 text-muted-foreground" />,
      action: () => {
        openFile(f.id)
        const expandParents = (nodes: FileNode[], targetId: string, parents: string[]) => {
          for (const n of nodes) {
            if (n.id === targetId) {
              parents.forEach(pid => {
                const s = useHelixStore.getState()
                if (!s.expandedFolders.has(pid)) s.toggleFolder(pid)
              })
              return true
            }
            if (n.children && expandParents(n.children, targetId, [...parents, n.id])) return true
          }
          return false
        }
        expandParents(useHelixStore.getState().files, f.id, [])
      },
      category: 'file' as const,
    }))

    const actionItems: CommandItem[] = [
      {
        id: 'action-new-file',
        label: '新建文件',
        description: '在根目录创建新文件',
        icon: <Plus className="size-4 text-emerald-400" />,
        action: () => {
          const name = prompt('输入文件名：')
          if (name?.trim()) {
            createFile(null, name.trim(), 'file')
            showToast({ type: 'success', title: '文件已创建', description: name.trim() })
          }
        },
        category: 'action',
        shortcut: 'Ctrl+Shift+N',
      },
      {
        id: 'action-new-folder',
        label: '新建文件夹',
        description: '在根目录创建新文件夹',
        icon: <FolderPlus className="size-4 text-amber-400" />,
        action: () => {
          const name = prompt('输入文件夹名：')
          if (name?.trim()) createFile(null, name.trim(), 'folder')
        },
        category: 'action',
      },
      {
        id: 'action-toggle-terminal',
        label: '切换终端',
        description: '显示或隐藏终端面板',
        icon: <Terminal className="size-4 text-amber-400" />,
        action: toggleTerminal,
        category: 'action',
        shortcut: getShortcutLabel('toggle-terminal', customShortcuts),
      },
      {
        id: 'action-clear-chat',
        label: '清空对话',
        description: '清空 AI 对话历史',
        icon: <MessageSquare className="size-4 text-blue-400" />,
        action: clearChat,
        category: 'action',
      },
      {
        id: 'action-save',
        label: '保存当前文件',
        description: activeTabId ? `保存 ${openTabs.find(t => t.id === activeTabId)?.name || ''}` : '没有打开的文件',
        icon: <Save className="size-4 text-blue-400" />,
        action: () => {
          if (activeTabId) {
            markTabSaved(activeTabId)
            const tab = openTabs.find(t => t.id === activeTabId)
            if (tab) showToast({ type: 'success', title: '已保存', description: tab.name })
          }
        },
        category: 'action',
        shortcut: 'Ctrl+S',
        disabled: !activeTabId,
      },
      {
        id: 'action-copy-path',
        label: '复制文件路径',
        description: activeTabId ? getFilePath(openTabs.find(t => t.id === activeTabId)?.fileId || '') : '没有打开的文件',
        icon: <Copy className="size-4 text-purple-400" />,
        action: () => {
          if (activeTabId) {
            const tab = openTabs.find(t => t.id === activeTabId)
            if (tab) {
              const path = getFilePath(tab.fileId)
              navigator.clipboard.writeText(path)
              showToast({ type: 'success', title: '路径已复制', description: path })
            }
          }
        },
        category: 'action',
        shortcut: 'Ctrl+Shift+C',
        disabled: !activeTabId,
      },
      {
        id: 'action-toggle-theme',
        label: '切换编辑器主题',
        description: `当前: ${editorTheme === 'vs-dark' ? '深色' : '浅色'}`,
        icon: editorTheme === 'vs-dark' ? <Moon className="size-4 text-indigo-400" /> : <Sun className="size-4 text-yellow-400" />,
        action: () => {
          const next = editorTheme === 'vs-dark' ? 'light' : 'vs-dark'
          setEditorTheme(next)
          showToast({ type: 'info', title: '主题已切换', description: next === 'vs-dark' ? '深色模式' : '浅色模式' })
        },
        category: 'action',
      },
      {
        id: 'action-shortcuts',
        label: '键盘快捷键',
        description: '查看所有可用的快捷键',
        icon: <Keyboard className="size-4 text-cyan-400" />,
        action: () => {
          showToast({ type: 'info', title: '快捷键', description: 'Ctrl+Shift+/ 快捷键帮助 · Ctrl+, 设置 · Ctrl+B 侧边栏 · Ctrl+J 终端 · Ctrl+F 查找 · Ctrl+[ ] 后退/前进 · F11 全屏', duration: 5000 })
        },
        category: 'action',
      },
    ]

    return [...fileItems, ...actionItems]
  }, [allFiles, openFile, toggleTerminal, clearChat, createFile, files, showToast, markTabSaved, activeTabId, openTabs, editorTheme, setEditorTheme, getFilePath, customShortcuts])

  // Fuzzy match
  const filtered = useMemo(() => {
    if (!query.trim()) return commands
    const q = query.toLowerCase()

    return commands
      .map(item => {
        const label = item.label.toLowerCase()
        const desc = (item.description || '').toLowerCase()
        const labelIdx = label.indexOf(q)
        const descIdx = desc.indexOf(q)

        // Fuzzy match for label
        let fuzzyScore = 0
        let qi = 0
        for (let i = 0; i < label.length && qi < q.length; i++) {
          if (label[i] === q[qi]) {
            fuzzyScore += (qi === 0 ? 10 : 1) + (i === qi ? 5 : 0)
            qi++
          }
        }
        const fuzzyMatch = qi === q.length

        if (labelIdx >= 0) return { item, score: 100 - labelIdx }
        if (descIdx >= 0) return { item, score: 50 - descIdx }
        if (fuzzyMatch) return { item, score: fuzzyScore }
        return null
      })
      .filter(Boolean)
      .sort((a, b) => (b?.score || 0) - (a?.score || 0))
      .map(r => r!.item)
  }, [query, commands])

  // Reset selection when query changes
  const prevQueryRef = useRef(query)
  let effectiveIndex = selectedIndexRef.current
  if (query !== prevQueryRef.current) {
    prevQueryRef.current = query
    selectedIndexRef.current = 0
    effectiveIndex = 0
  }

  useEffect(() => {
    if (showCommandPalette) {
      setQuery('')
      selectedIndexRef.current = 0
      // Delay focus to allow React to render the input
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [showCommandPalette])

  const handleSelect = useCallback(
    (item?: CommandItem) => {
      const target = item || filtered[effectiveIndex]
      if (target && !('disabled' in target)) {
        target.action()
        setCommandPaletteOpen(false)
      }
    },
    [filtered, effectiveIndex, setCommandPaletteOpen]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        selectedIndexRef.current = Math.min(selectedIndexRef.current + 1, filtered.length - 1)
        setQuery(q => q)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        selectedIndexRef.current = Math.max(selectedIndexRef.current - 1, 0)
        setQuery(q => q)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleSelect()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setCommandPaletteOpen(false)
      }
    },
    [filtered, handleSelect, setCommandPaletteOpen]
  )

  if (!showCommandPalette) return null

  // Separate files and actions for grouped display
  const fileResults = filtered.filter(c => c.category === 'file')
  const actionResults = filtered.filter(c => c.category === 'action')

  const renderSection = (title: string, items: CommandItem[], offset: number) => {
    if (items.length === 0) return null
    return (
      <div>
        {title && (
          <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 bg-muted/30">
            {title}
          </div>
        )}
        {items.map((item, idx) => {
          const globalIdx = offset + idx
          const isActive = globalIdx === effectiveIndex
          return (
            <div
              key={item.id}
              className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-foreground hover:bg-accent/50'
              }`}
              onClick={() => handleSelect(item)}
              onMouseEnter={() => { selectedIndexRef.current = globalIdx; setQuery(q => q) }}
            >
              {item.icon}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.label}</p>
                {item.description && (
                  <p className="text-xs text-muted-foreground truncate">
                    {item.description}
                  </p>
                )}
              </div>
              {item.category === 'file' && (
                <span className="text-[10px] text-muted-foreground bg-muted/50 px-2 py-0.5 rounded">
                  文件
                </span>
              )}
              {item.shortcut && (
                <span className="text-[10px] text-muted-foreground/60 bg-muted/30 px-1.5 py-0.5 rounded hidden sm:block">
                  {item.shortcut}
                </span>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => setCommandPaletteOpen(false)}
      />
      {/* Palette */}
      <div className="relative w-full max-w-lg bg-card border border-border/60 rounded-2xl shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 border-b border-border/60">
          <Search className="size-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索文件或输入命令..."
            className="flex-1 py-3.5 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden sm:flex items-center gap-0.5 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            ESC
          </kbd>
        </div>
        {/* Results */}
        <div className="max-h-80 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              没有找到匹配的结果
            </div>
          )}
          {renderSection('', fileResults, 0)}
          {fileResults.length > 0 && actionResults.length > 0 && (
            <div className="my-1 border-t border-border/30" />
          )}
          {renderSection('操作', actionResults, fileResults.length)}
        </div>
        {/* Footer */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border/60 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="bg-muted px-1 py-0.5 rounded">↑↓</kbd> 导航
          </span>
          <span className="flex items-center gap-1">
            <kbd className="bg-muted px-1 py-0.5 rounded">↵</kbd> 选择
          </span>
          <span className="flex items-center gap-1">
            <kbd className="bg-muted px-1 py-0.5 rounded">ESC</kbd> 关闭
          </span>
          <span className="ml-auto text-muted-foreground/50">
            {filtered.length} 个结果
          </span>
        </div>
      </div>
    </div>
  )
}