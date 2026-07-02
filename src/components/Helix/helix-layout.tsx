'use client'

import React, { useState, useCallback, useEffect } from 'react'
import dynamic from 'next/dynamic'
import {
  PanelLeftOpen,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  HelpCircle,
} from 'lucide-react'
import { Sidebar } from './sidebar'
import { AgentFlowPanel } from './agent-flow-panel'
import { useIsMobile } from '@/hooks/use-mobile'

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

export function HelixLayout() {
  const isMobile = useIsMobile()
  const [showSidebar, setShowSidebar] = useState(!isMobile)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
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

  useEffect(() => {
    if (pendingChanges.length > 0 && !showDiffPreview) {
      const timer = setTimeout(() => setShowDiffPreview(true), 100)
      return () => clearTimeout(timer)
    }
  }, [pendingChanges.length, showDiffPreview, setShowDiffPreview])

  // Close sidebar on mobile by default
  useEffect(() => {
    if (isMobile) {
      setShowSidebar(false)
    }
  }, [isMobile])

  return (
    <div className={`h-screen w-screen flex flex-col overflow-hidden ${
      theme === 'dark' ? 'dark bg-gray-900' : 'bg-white'
    }`}>
      <KeyboardShortcuts />
      <CommandPalette />
      <ContextMenuProvider />
      <ToastContainer />

      {/* Mobile sidebar overlay */}
      {isMobile && showSidebar && (
        <div 
          className="fixed inset-0 bg-black/50 z-40" 
          onClick={() => setShowSidebar(false)} 
        />
      )}

      {/* Top bar - minimal like Gateway */}
      <div className="flex items-center justify-between h-11 px-3 bg-[#FAF8F5] shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSidebar(!showSidebar)}
            className="p-1.5 text-[#2D2A24]/50 hover:text-[#2D2A24] hover:bg-[#EDE8E0] rounded-xl transition-colors"
          >
            <PanelLeftOpen className="size-4" />
          </button>
          {!isMobile && (
            <>
              <div className="w-px h-4 bg-[#EDE8E0] mx-1" />
              <button className="p-1.5 text-[#2D2A24]/50 hover:text-[#2D2A24] hover:bg-[#EDE8E0] rounded-xl transition-colors">
                <ArrowLeft className="size-4" />
              </button>
              <button className="p-1.5 text-[#2D2A24]/50 hover:text-[#2D2A24] hover:bg-[#EDE8E0] rounded-xl transition-colors">
                <ArrowRight className="size-4" />
              </button>
              <div className="w-px h-4 bg-[#EDE8E0] mx-1" />
              <button className="flex items-center gap-1 px-2 py-1.5 text-xs text-[#2D2A24]/50 hover:text-[#2D2A24] hover:bg-[#EDE8E0] rounded-xl transition-colors">
                <ExternalLink className="size-3.5" />
                窗口
              </button>
              <button className="flex items-center gap-1 px-2 py-1.5 text-xs text-[#2D2A24]/50 hover:text-[#2D2A24] hover:bg-[#EDE8E0] rounded-xl transition-colors">
                <HelpCircle className="size-3.5" />
                帮助
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {pendingChanges.length > 0 && (
            <button
              onClick={() => setShowDiffPreview(true)}
              className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 hover:bg-amber-100 px-2.5 py-1.5 rounded-xl transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              {pendingChanges.length} pending
            </button>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div
          className={`${
            isMobile ? 'fixed inset-y-11 left-0 z-50' : 'shrink-0'
          } overflow-hidden transition-all duration-200 ease-out`}
          style={{ width: showSidebar ? (isMobile ? '80vw' : 400) : 0 }}
        >
          <div className={`h-full rounded-r-2xl overflow-hidden bg-[#FAF8F5] ${isMobile ? 'w-[80vw]' : 'w-[400px]'}`}>
            <Sidebar />
          </div>
        </div>

        {/* Main area */}
        <div className="flex-1 h-full flex flex-col rounded-tr-2xl rounded-br-2xl border-r border-b border-[#F0ECE4] bg-[#FCFBF9] overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <AgentFlowPanel />
          </div>
        </div>
      </div>

      {showSessionManager && <SessionManager onClose={() => toggleSessionManager()} />}

      {showSkillPanel && <SkillPanel onClose={() => toggleSkillPanel()} />}

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