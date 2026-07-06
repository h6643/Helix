'use client'

import React, { useState, useCallback, useEffect } from 'react'
import dynamic from 'next/dynamic'
import {
  PanelLeftOpen,
  PanelRightOpen,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  HelpCircle,
  Minus,
  Square,
  Copy,
  X,
} from 'lucide-react'
import { Sidebar } from './sidebar'
import { AgentFlowPanel } from './agent-flow-panel'
import { CommandPalette } from './command-palette'
import { KeyboardShortcuts } from './keyboard-shortcuts'
import { ContextMenuProvider } from './context-menu'
import { ToastContainer } from './toast-container'
import { useHelixStore, type PendingChange } from '@/stores/helix-store'

// Dynamic imports for heavy components
const DiffPreview = dynamic(() => import('./diff-preview').then(m => ({ default: m.DiffPreview })), { ssr: false })
const SessionManager = dynamic(() => import('./session-manager').then(m => ({ default: m.SessionManager })), { ssr: false })
const ApiSettings = dynamic(() => import('./api-settings').then(m => ({ default: m.ApiSettings })), { ssr: false })
const SkillPanel = dynamic(() => import('./skill-panel').then(m => ({ default: m.SkillPanel })), { ssr: false })
const RightSidebar = dynamic(() => import('./right-sidebar').then(m => ({ default: m.RightSidebar })), { ssr: false })
const ArtifactPanel = dynamic(() => import('./artifact-panel').then(m => ({ default: m.ArtifactPanel })), { ssr: false })
const ScheduledTasksPanel = dynamic(() => import('./scheduled-tasks-panel').then(m => ({ default: m.ScheduledTasksPanel })), { ssr: false })
const CustomizePanel = dynamic(() => import('./customize-panel').then(m => ({ default: m.CustomizePanel })), { ssr: false })

export function HelixLayout() {
  const [showSidebar, setShowSidebar] = useState(false)
  const [showRightSidebar, setShowRightSidebar] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [isMaximized, setIsMaximized] = useState(false)
  const {
    openTabs,
    editorTheme,
    setEditorTheme,
    pendingChanges,
    showDiffPreview,
    setShowDiffPreview,
    applyPendingChange,
    rejectPendingChange,
    applyAllPendingChanges,
    rejectAllPendingChanges,
    showToast,
    showSessionManager,
    toggleSessionManager,
    toggleSettings,
    showSettings,
    showSkillPanel,
    toggleSkillPanel,
    restoreFromStorage,
    showArtifactsPanel,
    toggleArtifactsPanel,
    showScheduledTasksPanel,
    toggleScheduledTasksPanel,
    showCustomizePanel,
    toggleCustomizePanel,
  } = useHelixStore()

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.classList.toggle('dark', next === 'dark')
    setEditorTheme(next === 'dark' ? 'vs-dark' : 'light')
  }, [theme, setEditorTheme])

  const handleApplyChange = useCallback((change: PendingChange) => {
    applyPendingChange(change.id)
    showToast({ type: 'success', title: '已应用', description: change.fileName })
  }, [applyPendingChange, showToast])

  const handleRejectChange = useCallback((change: PendingChange) => {
    rejectPendingChange(change.id)
    showToast({ type: 'info', title: '已拒绝', description: change.fileName })
  }, [rejectPendingChange, showToast])

  const handleApplyAll = useCallback(() => {
    applyAllPendingChanges()
    showToast({ type: 'success', title: '全部应用', description: `${pendingChanges.length} 个文件` })
    setShowDiffPreview(false)
  }, [applyAllPendingChanges, showToast, setShowDiffPreview, pendingChanges.length])

  const handleRejectAll = useCallback(() => {
    rejectAllPendingChanges()
    setShowDiffPreview(false)
  }, [rejectAllPendingChanges, setShowDiffPreview])

  useEffect(() => {
    restoreFromStorage()
  }, [restoreFromStorage])

  const chatMessages = useHelixStore(s => s.chatMessages)

  useEffect(() => {
    if (chatMessages.length > 0) {
      setShowSidebar(true)
    }
  }, [chatMessages.length])

  useEffect(() => {
    if (pendingChanges.length > 0 && !showDiffPreview) {
      const timer = setTimeout(() => setShowDiffPreview(true), 100)
      return () => clearTimeout(timer)
    }
  }, [pendingChanges.length, showDiffPreview, setShowDiffPreview])

  // Track window maximize/restore state via native events
  useEffect(() => {
    const win = (window as any).electron?.window
    if (!win) return
    win.isMaximized().then(setIsMaximized)
    win.onMaximizedChange((maximized: boolean) => setIsMaximized(maximized))
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

  return (
    <div className={`h-screen w-screen flex flex-col overflow-hidden ${
      theme === 'dark' ? 'dark bg-background' : 'bg-background'
    }`}>
      <KeyboardShortcuts />
      <CommandPalette />
      <ContextMenuProvider />
      <ToastContainer />

      {/* Top bar - drag region for frameless window */}
      <div id="helix-titlebar" className="flex items-center justify-between h-10 px-3 bg-muted/40 border-b border-border/40 shrink-0 select-none">
        <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button
            onClick={() => setShowSidebar(!showSidebar)}
            className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
            title="侧边栏"
          >
            <PanelLeftOpen className="size-3.5" />
          </button>
          <button className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors">
            <ChevronLeft className="size-3.5" />
          </button>
          <button className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors">
            <ChevronRight className="size-3.5" />
          </button>
          <button className="flex items-center gap-1 px-2 py-1 text-[11px] text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors">
            <ExternalLink className="size-3.5" />
            窗口
          </button>
          <button className="flex items-center gap-1 px-2 py-1 text-[11px] text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors">
            <HelpCircle className="size-3.5" />
            帮助
          </button>
        </div>

        {/* Drag region - empty area between button groups */}
        <div className="flex-1 self-stretch" style={{ WebkitAppRegion: 'drag' } as any} />

        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
          {pendingChanges.length > 0 && (
            <button
              onClick={() => setShowDiffPreview(true)}
              className="flex items-center gap-1.5 text-[11px] font-medium text-amber-600/80 bg-amber-500/10 hover:bg-amber-500/15 px-2.5 py-1 rounded-lg transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500/80" />
              {pendingChanges.length} pending
            </button>
          )}
          {chatMessages.length > 0 && !showSettings && (
            <button
              onClick={() => setShowRightSidebar(!showRightSidebar)}
              className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
              title="右侧边栏"
            >
              <PanelRightOpen className="size-3.5" />
            </button>
          )}
          <div className="flex items-center gap-2 pl-2">
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
              className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
              title="关闭"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className={`flex-1 flex overflow-hidden ${showSettings ? 'invisible' : ''}`}>
        {/* Sidebar */}
        <div
          className="shrink-0 overflow-hidden transition-all duration-200 ease-out"
          style={{ width: showSidebar ? 300 : 0 }}
        >
          <div className="h-full overflow-hidden bg-sidebar w-[300px] border-r border-border/40">
            <Sidebar />
          </div>
        </div>

        {/* Main area */}
        <div className="flex-1 h-full flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <AgentFlowPanel />
          </div>
        </div>

        {/* Right sidebar */}
        <div
          className="shrink-0 overflow-hidden transition-all duration-200 ease-out"
          style={{ width: showRightSidebar ? 300 : 0 }}
        >
          <div className="h-full overflow-hidden bg-sidebar w-[300px] border-l border-border/40">
            <RightSidebar />
          </div>
        </div>
      </div>

      {showSessionManager && <SessionManager onClose={() => toggleSessionManager()} />}

      {showSkillPanel && <SkillPanel onClose={() => toggleSkillPanel()} />}

      {showArtifactsPanel && <ArtifactPanel onClose={() => toggleArtifactsPanel()} />}

      {showScheduledTasksPanel && <ScheduledTasksPanel onClose={() => toggleScheduledTasksPanel()} />}

      {showCustomizePanel && <CustomizePanel onClose={() => toggleCustomizePanel()} />}

      {showSettings && <ApiSettings theme={theme} onToggleTheme={toggleTheme} />}

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
          onClose={() => setShowDiffPreview(false)}
        />
      )}
    </div>
  )
}
