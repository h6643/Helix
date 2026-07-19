'use client'

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import dynamic from 'next/dynamic'
import { createPortal } from 'react-dom'
import {
  Minus,
  Square,
  Copy,
  X,
  Folder,
  Terminal,
  FileDiff,
  PanelLeft,
  ArrowLeft,
  ArrowRight,
  GripVertical,
  ChevronDown,
  FileText,
  Keyboard,
  Globe,
} from 'lucide-react'
import { Sidebar } from './sidebar'
import { AgentFlowPanel } from './agent-flow-panel'
import { CommandPalette } from './command-palette'
import { KeyboardShortcuts } from './keyboard-shortcuts'
import { ContextMenuProvider } from './context-menu'
import { ToastContainer } from './toast-container'
import { useHelixStore, type PendingChange } from '@/stores/helix-store'
import { useHermesStore } from '@/stores/hermes-store'
import { isElectron } from '@/lib/electron-bridge'
import { DEFAULT_SHORTCUTS } from '@/stores/helix-types'
import { startScheduledTaskRunner } from '@/lib/scheduled-task-runner'

function shortcutLabel(action: string, customShortcuts?: Record<string, { keys: string[] }>): string {
  const entry = customShortcuts?.[action] || DEFAULT_SHORTCUTS[action]
  if (!entry) return ''
  return entry.keys.join('+')
}

// Dynamic imports for heavy components
const DiffPreview = dynamic(() => import('./diff-preview').then(m => ({ default: m.DiffPreview })), { ssr: false })
const SessionManager = dynamic(() => import('./session-manager').then(m => ({ default: m.SessionManager })), { ssr: false })
const ApiSettings = dynamic(() => import('./api-settings').then(m => ({ default: m.ApiSettings })), { ssr: false })
const SkillPanel = dynamic(() => import('./skill-panel').then(m => ({ default: m.SkillPanel })), { ssr: false })
const ScheduledTasksPanel = dynamic(() => import('./scheduled-tasks-panel').then(m => ({ default: m.ScheduledTasksPanel })), { ssr: false })
const CustomizePanel = dynamic(() => import('./customize-panel').then(m => ({ default: m.CustomizePanel })), { ssr: false })
const RuntimePanel = dynamic(() => import('./runtime-panel').then(m => ({ default: m.RuntimePanel })), { ssr: false })
const TerminalPanel = dynamic(() => import('./terminal-panel').then(m => ({ default: m.TerminalPanel })), { ssr: false })
const WorktreePanel = dynamic(() => import('./worktree-panel').then(m => ({ default: m.WorktreePanel })), { ssr: false })

// ── Resizable sidebar constants ──────────────────────────────────────────
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 500
const SIDEBAR_COLLAPSED = 48
const SIDEBAR_DEFAULT = 300
const STORAGE_KEY = 'helix-sidebar-width'

function loadSidebarWidth(): number {
  if (typeof localStorage === 'undefined') return SIDEBAR_DEFAULT
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v) {
      const n = parseInt(v, 10)
      if (n >= SIDEBAR_MIN && n <= SIDEBAR_MAX) return n
    }
  } catch {}
  return SIDEBAR_DEFAULT
}

function saveSidebarWidth(w: number) {
  try { localStorage.setItem(STORAGE_KEY, String(w)) } catch {}
}

interface WindowMenuItem {
  label: string
  shortcut?: string
  action: () => void
}

export function HelixLayout() {
  const [showSidebar, setShowSidebar] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [isDragging, setIsDragging] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [isMaximized, setIsMaximized] = useState(false)
  const dragStartX = useRef(0)
  const dragStartW = useRef(0)

  // Refs for keyboard shortcut handler (avoids stale closures)
  const showSidebarRef = useRef(showSidebar)
  const setSidebarCollapsedRef = useRef(setSidebarCollapsed)
  const setShowSidebarRef = useRef(setShowSidebar)

  useEffect(() => {
    showSidebarRef.current = showSidebar
  }, [showSidebar])

  useEffect(() => {
    setSidebarCollapsedRef.current = setSidebarCollapsed
  }, [setSidebarCollapsed])

  useEffect(() => {
    setShowSidebarRef.current = setShowSidebar
  }, [setShowSidebar])

  // ── Sidebar resize drag ──────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    dragStartX.current = e.clientX
    dragStartW.current = sidebarWidth
  }, [sidebarWidth])

  useEffect(() => {
    if (!isDragging) return
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    let raf: number
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const delta = e.clientX - dragStartX.current
        const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, dragStartW.current + delta))
        setSidebarWidth(next)
      })
    }
    const onUp = () => {
      cancelAnimationFrame(raf)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      setIsDragging(false)
      setSidebarWidth(w => { saveSidebarWidth(w); return w })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      cancelAnimationFrame(raf)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isDragging])

  // State selectors (only re-render when this specific slice changes)
  const openTabs = useHelixStore(s => s.openTabs)
  const pendingChanges = useHelixStore(s => s.pendingChanges)
  const showDiffPreview = useHelixStore(s => s.showDiffPreview)
  const showSessionManager = useHelixStore(s => s.showSessionManager)
  const showSettings = useHelixStore(s => s.showSettings)
  const showSkillPanel = useHelixStore(s => s.showSkillPanel)
  const showScheduledTasksPanel = useHelixStore(s => s.showScheduledTasksPanel)
  const showCustomizePanel = useHelixStore(s => s.showCustomizePanel)
  const showRuntimePanel = useHelixStore(s => s.showRuntimePanel)
  const showWorktreePanel = useHelixStore(s => s.showWorktreePanel)
  const isTerminalOpen = useHelixStore(s => s.isTerminalOpen)
  const selectedWorkDir = useHelixStore(s => s.selectedWorkDir)
  const editorTheme = useHelixStore(s => s.editorTheme)
  const chatMessages = useHelixStore(s => s.chatMessages)
  const navigationHistory = useHelixStore(s => s.navigationHistory)
  const navigationIndex = useHelixStore(s => s.navigationIndex)
  const customShortcuts = useHelixStore(s => s.customShortcuts)
  // Stable action references — these never change so getState() is safe
  const storeActions = useMemo(() => useHelixStore.getState(), [])

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.classList.toggle('dark', next === 'dark')
    storeActions.setEditorTheme(next === 'dark' ? 'vs-dark' : 'light')
  }, [theme, storeActions.setEditorTheme])

  const handleApplyChange = useCallback((change: PendingChange) => {
    storeActions.applyPendingChange(change.id)
    storeActions.showToast({ type: 'success', title: '已应用', description: change.fileName })
  }, [storeActions.applyPendingChange, storeActions.showToast])

  const handleRejectChange = useCallback((change: PendingChange) => {
    storeActions.rejectPendingChange(change.id)
    storeActions.showToast({ type: 'info', title: '已拒绝', description: change.fileName })
  }, [storeActions.rejectPendingChange, storeActions.showToast])

  const handleApplyAll = useCallback(() => {
    storeActions.applyAllPendingChanges()
    storeActions.showToast({ type: 'success', title: '已应用', description: `${pendingChanges.length} 个文件` })
    storeActions.setShowDiffPreview(false)
  }, [storeActions.applyAllPendingChanges, storeActions.showToast, storeActions.setShowDiffPreview, pendingChanges.length])

  const handleRejectAll = useCallback(() => {
    storeActions.rejectAllPendingChanges()
    storeActions.setShowDiffPreview(false)
  }, [storeActions.rejectAllPendingChanges, storeActions.setShowDiffPreview])

  // Re-assert the frontend's restored model config into Hermes on startup so
  // the backend always matches the user's choice. This runs once after the
  // store rehydrates from IndexedDB: it (a) writes the active profile to the
  // cold-start cache and (b) pushes it to the running gateway. No hardcoded
  // pin — the value is whatever the user last saved (or the sensible default).
  const didStartupSync = useRef(false)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await storeActions.restoreFromStorage()
      if (cancelled || didStartupSync.current) return
      didStartupSync.current = true
      // Warn if no model is configured
      const st = useHelixStore.getState()
      if (!st.apiConfig?.apiKey) {
        setTimeout(() => {
          if (!cancelled) {
            storeActions.showToast({ type: 'warning', title: '尚未配置模型', description: '请在设置中配置 API Key 以使用 AI 功能', position: 'top-right' })
          }
        }, 1500)
      }
      if (!isElectron()) return
      const cfg = st.apiConfig
      if (!cfg || !cfg.model) return
      const resolved = {
        model: cfg.model,
        provider: cfg.provider && cfg.provider !== '__custom__' ? cfg.provider : 'custom',
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
      }
      try { await window.electron?.profile?.cacheConfig?.(resolved) } catch {}
      try { await window.electron?.hermes?.setConfig?.(resolved) } catch {}
    })()
    return () => { cancelled = true }
  }, [storeActions.restoreFromStorage])

  useEffect(() => {
    if (chatMessages.length > 0) {
      setShowSidebar(true)
    }
  }, [chatMessages.length])

  useEffect(() => {
    if (pendingChanges.length > 0 && !showDiffPreview) {
      const timer = setTimeout(() => storeActions.setShowDiffPreview(true), 100)
      return () => clearTimeout(timer)
    }
  }, [pendingChanges.length, showDiffPreview, storeActions.setShowDiffPreview])

  // Track window maximize/restore state via native events

  useEffect(() => {
    const win = (window as any).electron?.window
    if (!win) return
    win.isMaximized().then(setIsMaximized)
    const removeListener = win.onMaximizedChange((maximized: boolean) => setIsMaximized(maximized))
    return () => { try { removeListener?.() } catch {} }
  }, [])

  // ── Hermes gateway connection status ──────────────────────────────────
  // The connection dot next to the Settings button lives in the always-mounted
  // sidebar, but detection used to only live inside useHermes(), which is
  // mounted lazily (settings / skill panels). That is why the badge stayed on
  // "connecting" until the settings panel was opened. Detect here at the top
  // level so the badge reflects reality from startup onward.
  useEffect(() => {
    if (!isElectron()) return
    const hermes = (window as any).electron?.hermes
    if (!hermes?.status) return
    const unsubscribe = hermes.onEvent?.((event: string) => {
      if (event === 'gateway.ready') {
        useHermesStore.getState().setHermesConnected(true)
        useHermesStore.getState().setHermesError(null)
      } else if (event === 'gateway.disconnected') {
        useHermesStore.getState().setHermesConnected(false)
      }
    })
    const check = () => {
      hermes.status().then((st: { connected: boolean }) => {
        useHermesStore.getState().setHermesConnected(!!st?.connected)
      }).catch(() => {})
    }
    check()
    return () => { try { unsubscribe?.() } catch {} }
  }, [])

  const handleMaximizeToggle = useCallback(async () => {
    try {
      const win = (window as any).electron?.window
      if (!win) return
      const currentMaximized = await win.isMaximized()
      if (currentMaximized) {
        await win.unmaximize()
      } else {
        await win.maximize()
      }
    } catch (e) {
      console.error('[toggle] error:', e)
    }
  }, [])

  const handleOpenLocation = useCallback(async () => {
    if (!isElectron()) {
      storeActions.showToast({ type: 'info', title: '请选择项目目录' })
      return
    }
    const { electronDialog } = await import('@/lib/electron-bridge')
    const dir = await electronDialog.openDirectory()
    if (!dir) return
    try {
      await storeActions.setWorkDir(dir)
    } catch {
      storeActions.setSelectedWorkDir(dir)
    }
  }, [storeActions.setWorkDir, storeActions.setSelectedWorkDir, storeActions.showToast])

  const handleNewChat = useCallback(() => {
    useHelixStore.getState().flushSessionPersist()
    storeActions.clearChat()
    useHelixStore.getState().clearExecutionFlow()
    useHelixStore.getState().setCurrentSessionId(null)
  }, [storeActions.clearChat])

  // Window menu state
  const [windowMenuOpen, setWindowMenuOpen] = useState(false)
  const windowMenuButtonRef = useRef<HTMLButtonElement>(null)
  const windowMenuRef = useRef<HTMLDivElement>(null)

  // Help menu state
  const [helpMenuOpen, setHelpMenuOpen] = useState(false)
  const helpMenuButtonRef = useRef<HTMLButtonElement>(null)
  const helpMenuRef = useRef<HTMLDivElement>(null)

  const ZOOM_STEP = 0.1
  const zoomIn = useCallback(() => {
    const current = parseFloat(document.documentElement.style.zoom || '1')
    document.documentElement.style.zoom = Math.min(current + ZOOM_STEP, 2).toString()
  }, [])
  const zoomOut = useCallback(() => {
    const current = parseFloat(document.documentElement.style.zoom || '1')
    document.documentElement.style.zoom = Math.max(current - ZOOM_STEP, 0.5).toString()
  }, [])
  const zoomReset = useCallback(() => {
    document.documentElement.style.zoom = '1'
  }, [])
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      document.documentElement.requestFullscreen().catch(() => {})
    }
  }, [])

  const toggleWindowMenu = useCallback(() => setWindowMenuOpen(v => !v), [])
  const closeWindowMenu = useCallback(() => setWindowMenuOpen(false), [])

  // Click outside to close window menu
  useEffect(() => {
    if (!windowMenuOpen) return
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        windowMenuButtonRef.current?.contains(target) ||
        windowMenuRef.current?.contains(target)
      ) {
        return
      }
      setWindowMenuOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [windowMenuOpen])

  // Click outside to close help menu
  useEffect(() => {
    if (!helpMenuOpen) return
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        helpMenuButtonRef.current?.contains(target) ||
        helpMenuRef.current?.contains(target)
      ) {
        return
      }
      setHelpMenuOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [helpMenuOpen])

  // Window menu keyboard shortcuts
  useEffect(() => {
    const isInputFocused = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
    }
    const handler = (e: KeyboardEvent) => {
      if (isInputFocused(e.target)) return
      if (e.key === 'F11') {
        e.preventDefault()
        toggleFullscreen()
        return
      }
      const isMod = e.ctrlKey || e.metaKey
      if (!isMod) return
      const shift = e.shiftKey
      const alt = e.altKey
      if (!shift && !alt && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        if (!showSidebarRef.current) {
          // If sidebar is hidden, show it as narrow strip
          setShowSidebarRef.current(true)
          setSidebarCollapsedRef.current(true)
        } else {
          // If sidebar is visible, toggle collapsed state
          setSidebarCollapsedRef.current(v => !v)
        }
        return
      }
      if (!shift && !alt && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        setShowSidebarRef.current(v => !v)
        return
      }
      if (!shift && !alt && e.key.toLowerCase() === 't') {
        e.preventDefault()
        ;(window as any).electron?.window?.newWindow()
        return
      }
      if (shift && !alt && e.code === 'Equal') {
        e.preventDefault()
        zoomIn()
        return
      }
      if (!shift && !alt && e.code === 'Minus') {
        e.preventDefault()
        zoomOut()
        return
      }
      if (!shift && !alt && e.code === 'Digit0') {
        e.preventDefault()
        zoomReset()
        return
      }
      if (shift && !alt && e.code === 'BracketLeft') {
        e.preventDefault()
        storeActions.showToast({ type: 'info', title: '任务导航', description: '上一个任务功能尚未实现' })
        return
      }
      if (shift && !alt && e.code === 'BracketRight') {
        e.preventDefault()
        storeActions.showToast({ type: 'info', title: '任务导航', description: '下一个任务功能尚未实现' })
        return
      }
      // Ctrl+[ / Ctrl+] handled by keyboard-shortcuts.tsx (go-back / go-forward)
      if (!shift && alt && e.code === 'KeyB') {
        e.preventDefault()
        storeActions.toggleSubAgentPanel()
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [storeActions, zoomIn, zoomOut, zoomReset, toggleFullscreen])

  // Start global scheduled task runner
  useEffect(() => { startScheduledTaskRunner() }, [])

    const windowMenuItems: (WindowMenuItem | { divider: true })[] = useMemo(() => [
    { label: '新建窗口', shortcut: 'Ctrl+Shift+N', action: () => { window.open(window.location.href, '_blank'); closeWindowMenu() } },
    { label: '关闭窗口', shortcut: 'Ctrl+Shift+W', action: () => { window.close(); closeWindowMenu() } },
    { divider: true },
    { label: '折叠侧边栏', shortcut: 'Ctrl+B', action: () => {
      if (!showSidebar) {
        setShowSidebar(true)
        setSidebarCollapsed(true)
      } else {
        setSidebarCollapsed(v => !v)
      }
      closeWindowMenu()
    }},
    { label: '切换侧边栏', shortcut: 'Ctrl+L', action: () => { setShowSidebar(v => !v); closeWindowMenu() } },
    { label: '打开终端', shortcut: shortcutLabel('toggle-terminal', customShortcuts), action: () => { useHelixStore.setState({ isTerminalOpen: true }); closeWindowMenu() } },
    { label: '切换文件树', shortcut: shortcutLabel('toggle-file-tree', customShortcuts), action: () => { storeActions.toggleWorktreePanel(); closeWindowMenu() } },
    { divider: true },
    { label: '设置', shortcut: 'Ctrl+,', action: () => { storeActions.toggleSettings('api'); closeWindowMenu() } },
    { label: '重新加载页面', shortcut: shortcutLabel('reload-page', customShortcuts), action: () => { window.location.reload(); closeWindowMenu() } },
    { divider: true },
    { label: '查找', shortcut: shortcutLabel('search-chat', customShortcuts), action: () => { storeActions.toggleCommandPalette(); closeWindowMenu() } },
    { divider: true },
    { label: '后退', shortcut: shortcutLabel('go-back', customShortcuts), action: () => {
      const entry = storeActions.navigateBack()
      if (entry) {
        if (entry.type === 'chat') {
          if (showSettings) storeActions.toggleSettings()
          storeActions.navigateSession('back')
        } else {
          if (!showSettings) storeActions.toggleSettings(entry.page)
          else storeActions.setSettingsPage(entry.page)
        }
      }
      closeWindowMenu()
    }},
    { label: '前进', shortcut: shortcutLabel('go-forward', customShortcuts), action: () => {
      const entry = storeActions.navigateForward()
      if (entry) {
        if (entry.type === 'chat') {
          if (showSettings) storeActions.toggleSettings()
          storeActions.navigateSession('forward')
        } else {
          if (!showSettings) storeActions.toggleSettings(entry.page)
          else storeActions.setSettingsPage(entry.page)
        }
      }
      closeWindowMenu()
    }},
    { divider: true },
    { label: '切换全屏', shortcut: 'F11', action: () => { toggleFullscreen(); closeWindowMenu() } },
  ], [setShowSidebar, storeActions, toggleFullscreen, closeWindowMenu, customShortcuts])

  const sidebarExpanded = showSidebar

  return (
    <div className={`h-screen w-screen flex flex-col overflow-hidden ${
      theme === 'dark' ? 'dark bg-background' : 'bg-background'
    }`}>
      <KeyboardShortcuts />
      <CommandPalette />
      <ContextMenuProvider />
      <ToastContainer />

      {/* Title bar — frameless window drag region */}
      <div id="helix-titlebar" className="flex items-center justify-between h-10 px-3 bg-sidebar shrink-0 select-none">
        {/* Left: navigation buttons */}
        <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button
            onClick={() => setShowSidebar(v => !v)}
            className={`p-1.5 rounded-lg transition-colors ${showSidebar ? 'text-primary bg-primary/10' : 'text-foreground/50 hover:text-foreground hover:bg-accent/60'}`}
            title="侧边栏"
          >
            <PanelLeft className="size-4" />
          </button>
          <div className="w-px h-4 bg-border/40 mx-0.5" />
          <button
            onClick={() => {
              const entry = storeActions.navigateBack()
              if (!entry) return
              if (entry.type === 'chat') {
                // Load the chat session
                if (showSettings) storeActions.toggleSettings()
                storeActions.navigateSession('back')
              } else {
                // Open settings with the page
                if (!showSettings) storeActions.toggleSettings(entry.page)
                else storeActions.setSettingsPage(entry.page)
              }
            }}
            disabled={!storeActions.canGoBack()}
            className="p-1.5 text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors disabled:opacity-30"
            title="后退"
          >
            <ArrowLeft className="size-4" />
          </button>
          <button
            onClick={() => {
              const entry = storeActions.navigateForward()
              if (!entry) return
              if (entry.type === 'chat') {
                // Load the chat session
                if (showSettings) storeActions.toggleSettings()
                storeActions.navigateSession('forward')
              } else {
                // Open settings with the page
                if (!showSettings) storeActions.toggleSettings(entry.page)
                else storeActions.setSettingsPage(entry.page)
              }
            }}
            disabled={!storeActions.canGoForward()}
            className="p-1.5 text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors disabled:opacity-30"
            title="前进"
          >
            <ArrowRight className="size-4" />
          </button>
          <div className="w-px h-4 bg-border/40 mx-0.5" />
          <button
            ref={windowMenuButtonRef}
            onClick={toggleWindowMenu}
            className="px-2 py-1 text-xs font-medium text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
            title="窗口"
          >
            窗口
          </button>
          <button
            ref={helpMenuButtonRef}
            onClick={() => setHelpMenuOpen(v => !v)}
            className="px-2 py-1 text-xs font-medium text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
            title="帮助"
          >
            帮助
          </button>
          {helpMenuOpen && typeof window !== 'undefined' && createPortal(
            <div
              className="fixed z-[100]"
              style={{
                top: (helpMenuButtonRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                left: helpMenuButtonRef.current?.getBoundingClientRect().left ?? 0,
              }}
            >
              <div ref={helpMenuRef} className="w-56 bg-card border border-border/80 rounded-lg shadow-xl py-1">
                <button
                  className="w-full px-3 py-2 text-sm text-left hover:bg-accent/60 transition-colors flex items-center gap-2"
                  onClick={() => {
                    setHelpMenuOpen(false)
                    storeActions.toggleSettings('help')
                  }}
                >
                  <FileText className="size-4" />
                  帮助页面
                </button>
                <div className="h-px bg-border/60 my-1" />
                <button
                  className="w-full px-3 py-2 text-sm text-left hover:bg-accent/60 transition-colors flex items-center gap-2"
                  onClick={() => {
                    setHelpMenuOpen(false)
                    window.open('https://github.com/helix-ai/helix', '_blank')
                  }}
                >
                  <Globe className="size-4" />
                  GitHub
                </button>
              </div>
            </div>,
            document.body
          )}
          {windowMenuOpen && typeof window !== 'undefined' && createPortal(
            <div
              className="fixed z-[100]"
              style={{
                top: (windowMenuButtonRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                left: windowMenuButtonRef.current?.getBoundingClientRect().left ?? 0,
              }}
            >
              <div ref={windowMenuRef} className="w-56 bg-card border border-border/80 rounded-lg shadow-xl py-1">
                {windowMenuItems.map((item, i) => (
                  'divider' in item ? (
                    <div key={i} className="h-px bg-border/60 my-1" />
                  ) : (
                    <button
                      key={i}
                      onClick={item.action}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-foreground/80 hover:bg-accent/60 transition-colors"
                    >
                      <span>{item.label}</span>
                      {item.shortcut && <span className="text-foreground/40 ml-4">{item.shortcut}</span>}
                    </button>
                  )
                ))}
              </div>
            </div>,
            document.body
          )}
        </div>

        {/* Center: drag region */}
        <div className="flex-1 self-stretch" style={{ WebkitAppRegion: 'drag' } as any} />

        {/* Right: window controls */}
        <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <div className="flex items-center gap-4">
            <button
              onClick={() => (window as any).electron?.window?.minimize()}
              className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
              title="最小化"
            >
              <Minus className="size-3.5" />
            </button>
            <button
              onClick={handleMaximizeToggle}
              className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
              title={isMaximized ? '还原' : '最大化'}
            >
              {isMaximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
            </button>
            <button
              onClick={() => (window as any).electron?.window?.close()}
              className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-rose-500/20 hover:text-rose-400 rounded-lg transition-colors"
              title="关闭"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar with resize handle */}
        {showSidebar && (
          <div
            className={`shrink-0 overflow-hidden relative ${isDragging ? '' : 'transition-[width] duration-200 ease-out'}`}
            style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED : sidebarWidth }}
          >
            <div
              className="h-full overflow-hidden bg-sidebar border-r border-border/40"
              style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED : sidebarWidth }}
            >
              <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(v => !v)} />
            </div>

            {/* Resize handle — only visible when sidebar is expanded */}
            {!sidebarCollapsed && (
              <div
                className={`absolute top-0 -right-1 w-2 h-full cursor-col-resize z-30 group ${
                  isDragging ? 'bg-primary/20' : ''
                }`}
                onMouseDown={handleDragStart}
              >
                {/* Visual grip line — hidden until hover */}
                <div className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 transition-colors ${
                  isDragging ? 'bg-primary/40' : 'bg-transparent group-hover:bg-border/40'
                }`} />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <GripVertical className="size-3 text-primary/60" />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Main area */}
        <div className="flex-1 h-full flex flex-col overflow-hidden">
          {showScheduledTasksPanel ? (
            <ScheduledTasksPanel onClose={() => storeActions.toggleScheduledTasksPanel()} />
          ) : showSkillPanel ? (
            <SkillPanel onClose={() => storeActions.toggleSkillPanel()} />
          ) : showRuntimePanel ? (
            <RuntimePanel onClose={() => storeActions.toggleRuntimePanel()} />
          ) : showWorktreePanel ? (
            <WorktreePanel onClose={() => storeActions.toggleWorktreePanel()} />
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Conversation header — only visible when messages exist */}
                {chatMessages.length > 0 && (
                <div className="shrink-0 h-9 flex items-center justify-between gap-2 px-3 bg-background">
                <div className="flex items-center gap-1.5 min-w-0">
                <button
                  onClick={handleOpenLocation}
                  className="flex items-center gap-1.5 text-[12px] text-foreground/70 hover:text-foreground hover:bg-accent/60 px-2 py-1 rounded-lg transition-colors shrink-0"
                  title={selectedWorkDir || '选择位置'}
                >
                  <Folder className="size-3.5 text-amber-500" />
                  <span className="max-w-[200px] truncate">{selectedWorkDir ? (selectedWorkDir.split(/[\/\\]/).pop() || selectedWorkDir) : '未选择位置'}</span>
                </button>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => { if (pendingChanges.length > 0) storeActions.setShowDiffPreview(true); else storeActions.showToast({ type: 'info', title: '暂无待处理的更改' }) }}
                    className="relative p-1.5 text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
                    title="文件差异"
                  >
                    <FileDiff className="size-4" />
                    {pendingChanges.length > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-medium flex items-center justify-center">
                        {pendingChanges.length}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => storeActions.toggleTerminal()}
                    className={`p-1.5 rounded-lg transition-colors ${isTerminalOpen ? 'text-primary bg-primary/10' : 'text-foreground/50 hover:text-foreground hover:bg-accent/60'}`}
                    title="终端"
                  >
                    <Terminal className="size-4" />
                  </button>
                </div>
              </div>
              )}
              <div className="flex-1 overflow-hidden">
                <AgentFlowPanel />
              </div>
              <TerminalPanel onClose={storeActions.toggleTerminal} />
            </div>
          )}
        </div>
      </div>

      {/* Overlay panels */}
      {showSessionManager && <SessionManager onClose={() => storeActions.toggleSessionManager()} />}
      {showCustomizePanel && <CustomizePanel onClose={() => storeActions.toggleCustomizePanel()} />}
      {showSettings && (
        <ApiSettings
          theme={theme}
          onToggleTheme={toggleTheme}
          sidebarWidth={sidebarWidth}
          setSidebarWidth={setSidebarWidth}
          saveSidebarWidth={saveSidebarWidth}
          showSidebar={showSidebar}
          setShowSidebar={setShowSidebar}
          sidebarCollapsed={sidebarCollapsed}
          setSidebarCollapsed={setSidebarCollapsed}
        />
      )}
      {showDiffPreview && pendingChanges.length > 0 && (
        <DiffPreview
          changes={pendingChanges.map(({ id, ...rest }) => rest)}
          onApply={(change) => {
            const pending = pendingChanges.find(p => p.filePath === change.filePath)
            if (pending) handleApplyChange(pending)
          }}
          onApplyAll={handleApplyAll}
          onReject={(change) => {
            const pending = pendingChanges.find(p => p.filePath === change.filePath)
            if (pending) handleRejectChange(pending)
          }}
          onRejectAll={handleRejectAll}
          onClose={() => storeActions.setShowDiffPreview(false)}
        />
      )}
    </div>
  )
}
