'use client'

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
  GitBranch,
  Keyboard,
  Globe,
  ListTodo,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  MoreHorizontal,
  FolderTree,
    Users,
} from 'lucide-react'
import React, { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentVersion } from '@/hooks/use-check-update'
import { createPortal } from 'react-dom'
import { useProviderStore } from '@/hermes-ui/provider-store'
import { useCheckUpdate } from '@/hooks/use-check-update'
import { pushModelConfig, pushAgentConfigLive, pushConfigKeyValue } from '@/lib/config-sync'
import { isElectron, electronHermes, electronNotification, electronShell } from '@/lib/electron-bridge'
import { startScheduledTaskRunner } from '@/lib/scheduled-task-runner'
import { isServeActive, getServeClient } from '@/lib/serve-gateway'
import { speak, stripAcp } from '@/lib/voice-utils'
import { useHelixStore } from '@/stores/helix-store'
import { applyHelixPalette } from '@/lib/themes'
import { AgentFlowPanel } from './agent-flow-panel'
import { CommandPalette } from './command-palette'
import { Sidebar } from './sidebar'
import { KeyboardShortcuts } from './keyboard-shortcuts'
import { ContextMenuProvider } from './context-menu'
import { WakeWordAnimation } from './wake-word-animation'
import { ToastContainer } from './toast-container'
import { useHermesStore } from '@/stores/hermes-store'
import { DEFAULT_SHORTCUTS } from '@/stores/helix-types'

// Process-wide guard so the startup restore + Hermes sync runs exactly once.
// A component-local useRef resets whenever this layout remounts (e.g. tab
// switches that unmount/remount the tree), which would re-trigger
// restoreFromStorage() and overwrite the user's live model/provider selection
// with the persisted snapshot — the "sometimes stops working after a few
// clicks" symptom.
let startupSyncDone = false

function shortcutLabel(action: string, customShortcuts?: Record<string, { keys: string[] }>): string {
  const entry = customShortcuts?.[action] || DEFAULT_SHORTCUTS[action]
  if (!entry) return ''
  return entry.keys.join('+')
}

// Dynamic imports for heavy components (Next's next/dynamic ssr:false →
// React.lazy; a static Vite SPA is client-only anyway).
const SessionManager = lazy(() => import('./session-manager').then(m => ({ default: m.SessionManager })))
const ApiSettings = lazy(() => import('./api-settings').then(m => ({ default: m.ApiSettings })))
const SkillPanel = lazy(() => import('./skill-panel').then(m => ({ default: m.SkillPanel })))
const ScheduledTasksPanel = lazy(() => import('./scheduled-tasks-panel').then(m => ({ default: m.ScheduledTasksPanel })))
const TaskListPanel = lazy(() => import('./task-list-panel').then(m => ({ default: m.TaskListPanel })))
const CustomizePanel = lazy(() => import('./customize-panel').then(m => ({ default: m.CustomizePanel })))
const RuntimePanel = lazy(() => import('./runtime-panel').then(m => ({ default: m.RuntimePanel })))
const ActivityFeed = lazy(() => import('./activity-feed').then(m => ({ default: m.ActivityFeed })))
const Onboarding = lazy(() => import('./onboarding').then(m => ({ default: m.Onboarding })))
const BootOverlay = lazy(() => import('./boot-overlay').then(m => ({ default: m.BootOverlay })))
const ArtifactsBrowser = lazy(() => import('./artifacts-browser').then(m => ({ default: m.ArtifactsBrowser })))
const TerminalPanel = lazy(() => import('./terminal-panel').then(m => ({ default: m.TerminalPanel })))
const WorktreePanel = lazy(() => import('./worktree-panel').then(m => ({ default: m.WorktreePanel })))
const PluginManagerPanel = lazy(() => import('./plugin-manager').then(m => ({ default: m.PluginManager })))
const KanbanPanel = lazy(() => import('./kanban-panel').then(m => ({ default: m.KanbanPanel })))
const DelegationsPanel = lazy(() => import('./delegations-panel').then(m => ({ default: m.DelegationsPanel })))
const RightSidebar = lazy(() => import('./right-sidebar').then(m => ({ default: m.RightSidebar })))

// Local Suspense for the always-visible panel areas. Without a boundary the
// lazy panels' chunk load bubbles up to the root Suspense in main.tsx, which
// swaps the WHOLE app for "Loading Helix..." and unmounts every component.
// An in-panel spinner keeps the UI alive while the chunk + data load.
function PanelSuspense({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
          正在加载…
        </div>
      }
    >
      {children}
    </Suspense>
  )
}

// ── Resizable sidebar constants ──────────────────────────────────────────
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 500
const SIDEBAR_COLLAPSED = 48
const SIDEBAR_DEFAULT = 240
const STORAGE_KEY = 'helix-sidebar-width'

// Right sidebar (code editor / browser)
const RIGHT_SIDEBAR_MIN = 280
const RIGHT_SIDEBAR_MAX = 400
const RIGHT_SIDEBAR_DEFAULT = 240
// The chat/dialogue column must always keep a readable width. Cap the right
// sidebar so the dialogue area never shrinks into awkwardly short line wraps.
// (440 would over-constrain the drag range — 400 still keeps lines readable.)
const CHAT_MIN_WIDTH = 400
const RIGHT_STORAGE_KEY = 'helix-right-sidebar-width'

function rightSidebarCap(leftWidth: number): number {
  // Hard ceiling: regardless of how wide the window is, the right sidebar must
  // never exceed RIGHT_SIDEBAR_MAX. Only the *lower* bound is governed by the
  // window width (so the chat column keeps a minimum readable width).
  if (typeof window === 'undefined') return RIGHT_SIDEBAR_MAX
  const cap = window.innerWidth - leftWidth - CHAT_MIN_WIDTH
  return Math.max(RIGHT_SIDEBAR_MIN, Math.min(RIGHT_SIDEBAR_MAX, Math.floor(cap)))
}

function loadSidebarWidth(): number {
  if (typeof localStorage === 'undefined') return SIDEBAR_DEFAULT
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v) {
      const n = parseInt(v, 10)
      // Migration: the old default was 300. Treat a stored width that equals the
      // old default as "unset" so the new smaller default (240) takes effect on
      // first launch — but any custom width the user dragged to is respected.
      if (n === 300) {
        try { localStorage.removeItem(STORAGE_KEY) } catch {}
        return SIDEBAR_DEFAULT
      }
      if (n >= SIDEBAR_MIN && n <= SIDEBAR_MAX) return n
    }
  } catch {}
  return SIDEBAR_DEFAULT
}

function saveSidebarWidth(w: number) {
  try { localStorage.setItem(STORAGE_KEY, String(w)) } catch {}
}

function loadRightSidebarWidth(): number {
  if (typeof localStorage === 'undefined') return RIGHT_SIDEBAR_DEFAULT
  const cap = rightSidebarCap(SIDEBAR_DEFAULT)
  try {
    const v = localStorage.getItem(RIGHT_STORAGE_KEY)
    if (v) {
      const n = parseInt(v, 10)
      if (n >= RIGHT_SIDEBAR_MIN && n <= cap) return n
    }
  } catch {}
  return Math.min(RIGHT_SIDEBAR_DEFAULT, cap)
}

function saveRightSidebarWidth(w: number) {
  try { localStorage.setItem(RIGHT_STORAGE_KEY, String(w)) } catch {}
}

interface WindowMenuItem {
  label: string
  shortcut?: string
  action: () => void
}

export function HelixLayout() {
  useCheckUpdate()
  const [showSidebar, setShowSidebar] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [isDragging, setIsDragging] = useState(false)
  const [rightSidebarWidth, setRightSidebarWidth] = useState(loadRightSidebarWidth)
  const [isRightDragging, setIsRightDragging] = useState(false)
  // Mirror sidebarWidth so the right-sidebar resize clamp can read it live
  // without re-subscribing the drag effect on every sidebar width change.
  const sidebarWidthRef = useRef(sidebarWidth)
  sidebarWidthRef.current = sidebarWidth
  const [isMaximized, setIsMaximized] = useState(false)
  const [hasTaskList, setHasTaskList] = useState(false)
  const [showTaskListPanel, setShowTaskListPanel] = useState(false)
  const dragStartX = useRef(0)
  const dragStartW = useRef(0)
  const rightDragStartX = useRef(0)
  const rightDragStartW = useRef(0)

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

  // ── Right sidebar resize drag ────────────────────────────────────────
  const handleRightDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsRightDragging(true)
    rightDragStartX.current = e.clientX
    rightDragStartW.current = rightSidebarWidth
  }, [rightSidebarWidth])

  useEffect(() => {
    if (!isRightDragging) return
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    let raf: number
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const delta = rightDragStartX.current - e.clientX
        const cap = rightSidebarCap(sidebarWidthRef.current)
        const next = Math.max(RIGHT_SIDEBAR_MIN, Math.min(cap, rightDragStartW.current + delta))
        setRightSidebarWidth(next)
      })
    }
    const onUp = () => {
      cancelAnimationFrame(raf)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      setIsRightDragging(false)
      setRightSidebarWidth(w => { saveRightSidebarWidth(w); return w })
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
  }, [isRightDragging])

  // State selectors (only re-render when this specific slice changes)
  const openTabs = useHelixStore(s => s.openTabs)
  const showSessionManager = useHelixStore(s => s.showSessionManager)
  const showSettings = useHelixStore(s => s.showSettings)
  const showSkillPanel = useHelixStore(s => s.showSkillPanel)
  const showScheduledTasksPanel = useHelixStore(s => s.showScheduledTasksPanel)
  const showCustomizePanel = useHelixStore(s => s.showCustomizePanel)
  const showRuntimePanel = useHelixStore(s => s.showRuntimePanel)
  const showWorktreePanel = useHelixStore(s => s.showWorktreePanel)
  const showKanbanPanel = useHelixStore(s => s.showKanbanPanel)
  const showSubAgentPanel = useHelixStore(s => s.showSubAgentPanel)
  const showActivityFeed = useHelixStore(s => s.showActivityFeed)
  const showArtifactsBrowser = useHelixStore(s => s.showArtifactsBrowser)
  const showPluginManager = useHelixStore(s => s.showPluginManager)
  // 打开任一主区覆盖页（计划/插件管理/技能/运行时/工作树）时，聊天区用
  // display:none 隐藏而不是卸载。run 由 AgentFlowPanel 驱动，卸载会冻结流式
  // 画面并让暂停按钮消失（看起来像"点击插件把运行终止了"）。保持挂载即可在
  // 切页面时让模型继续在后台运行，返回后还能接着看。
  const sidePanelOpen = showScheduledTasksPanel || showPluginManager || showSkillPanel || showRuntimePanel || showWorktreePanel || showKanbanPanel || showSubAgentPanel
  const rightSidebarTab = useHelixStore(s => s.rightSidebarTab)
  const isTerminalOpen = useHelixStore(s => s.isTerminalOpen)
  const selectedWorkDir = useHelixStore(s => s.selectedWorkDir)
  const editorTheme = useHelixStore(s => s.editorTheme)
  const themeStyle = useHelixStore(s => s.themeStyle)
  const setThemeStyle = useHelixStore(s => s.setThemeStyle)
  const chatMessages = useHelixStore(s => s.chatMessages)
  const currentSessionId = useHelixStore(s => s.currentSessionId)
  const navigationHistory = useHelixStore(s => s.navigationHistory)
  const navigationIndex = useHelixStore(s => s.navigationIndex)
  const customShortcuts = useHelixStore(s => s.customShortcuts)
  const hermesTodos = useHelixStore(s => s.hermesTodos)
  // Stable action references — these never change so getState() is safe
  const storeActions = useMemo(() => useHelixStore.getState(), [])
  const [todoPopoverOpen, setTodoPopoverOpen] = useState(false)
  const [delegations, setDelegations] = useState<Array<{id: string; tasks: Array<{name: string; modified: number}>}>>([])
  const [delegationsPopoverOpen, setDelegationsPopoverOpen] = useState(false)
  const delegationsPopoverRef = useRef<HTMLDivElement>(null)
  // Close the todo popover when clicking outside of it
  const todoPopoverRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!todoPopoverOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (todoPopoverRef.current && !todoPopoverRef.current.contains(e.target as Node)) {
        setTodoPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [todoPopoverOpen])

  // Close delegations popover when clicking outside
  useEffect(() => {
    if (!delegationsPopoverOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (delegationsPopoverRef.current && !delegationsPopoverRef.current.contains(e.target as Node)) {
        setDelegationsPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [delegationsPopoverOpen])

  // Load delegations data
  useEffect(() => {
    if (!isElectron()) return
    const loadDelegations = async () => {
      try {
        const api = (window as any).electron as any
        const res = await api?.delegations?.list?.()
        if (res?.ok) {
          setDelegations(res.delegations || [])
        }
      } catch {}
    }
    loadDelegations()
    // Refresh every 10 seconds
    const interval = setInterval(loadDelegations, 10000)
    return () => clearInterval(interval)
  }, [isElectron()])

  // Apply the selected theme style (Catppuccin flavor or built-in cream) by
  // writing inline CSS variables onto <html>. Runs on mount and whenever the
  // style changes — including when the light/dark toggle switches to a paired
  // flavor. Editor theme follows the resolved light/dark state (a flavor's
  // mode, or the built-in's 亮色/暗色 choice) so it never goes stale after a
  // 深色 flavor → 内置 switch.
  useEffect(() => {
    applyHelixPalette(themeStyle)
    storeActions.setEditorTheme(
      document.documentElement.classList.contains('dark') ? 'vs-dark' : 'light',
    )
  }, [themeStyle])

  // Re-assert the frontend's restored model config into Hermes on startup so
  // the backend always matches the user's choice. This runs once after the
  // store rehydrates from IndexedDB: it (a) writes the active profile to the
  // cold-start cache and (b) pushes it to the running gateway. No hardcoded
  // pin — the value is whatever the user last saved (or the sensible default).
  useEffect(() => {
    if (startupSyncDone) return
    startupSyncDone = true
    let cancelled = false
    ;(async () => {
      await storeActions.restoreFromStorage()
      if (cancelled) return
      const st = useHelixStore.getState()
      if (!isElectron()) return
      const cfg = st.apiConfig
      if (!cfg || !cfg.model) return
      pushModelConfig({
        model: cfg.model,
        provider: cfg.provider && cfg.provider !== '__custom__' ? cfg.provider : 'custom',
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
      })
    })()
    return () => { cancelled = true }
  }, [storeActions.restoreFromStorage])

  // Sync agent settings to Hermes via live config.set (no gateway restart).
  // personality + reasoningEffort + fastMode are pushed instantly.
  // Removed: temperature, maxOutputTokens, customInstructions, Chinese language injection.
  const agentSettingsSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!isElectron()) return
    const pushAgentConfig = () => {
      const s = useHelixStore.getState()
      pushAgentConfigLive({
        personality: s.personality || undefined,
        reasoningEffort: s.reasoningEffort,
        fastMode: s.fastMode,
      })
    }
    pushAgentConfig()
    const unsub = useHelixStore.subscribe((state, prevState) => {
      const changed =
        state.personality !== prevState.personality ||
        state.reasoningEffort !== prevState.reasoningEffort ||
        state.fastMode !== prevState.fastMode
      if (!changed) return
      if (agentSettingsSyncTimer.current) clearTimeout(agentSettingsSyncTimer.current)
      agentSettingsSyncTimer.current = setTimeout(pushAgentConfig, 150)
    })
    return () => {
      unsub()
      if (agentSettingsSyncTimer.current) clearTimeout(agentSettingsSyncTimer.current)
    }
  }, [])

  // ── Reasoning-effort: live push via config.set (no restart, no translation) ──
  // Uses Hermes native effort scale (none/minimal/low/medium/high/xhigh/max/ultra)
  // directly — no toBackendReasoningEffort translation needed.
  const reasoningFastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!isElectron()) return
    const unsub = useHelixStore.subscribe((state, prevState) => {
      if (state.reasoningEffort === prevState.reasoningEffort) return
      if (reasoningFastTimer.current) clearTimeout(reasoningFastTimer.current)
      reasoningFastTimer.current = setTimeout(() => {
        const effort = useHelixStore.getState().reasoningEffort
        pushConfigKeyValue('agent.reasoning_effort', effort)
        // Also live-update current session if idle
        const hermes = useHermesStore.getState()
        if (hermes.hermesSessionId && !useHelixStore.getState().isChatLoading) {
          if (isServeActive()) {
            // serve 网关没有 ACP 控制令牌语义：直接 config.set，避免被当成用户消息执行
            getServeClient()?.rpc('config.set', { key: 'agent.reasoning_effort', value: effort, session_id: hermes.hermesSessionId })
              .catch(() => {})
          } else {
            window.electron?.hermes?.send?.('session/prompt', {
              session_id: hermes.hermesSessionId,
              prompt: [{ type: 'text', text: `__hermes_set_reasoning__:${effort}` }],
            }).catch(() => {})
          }
        }
      }, 150)
    })
    return () => {
      unsub()
      if (reasoningFastTimer.current) clearTimeout(reasoningFastTimer.current)
    }
  }, [])

  // ── Bridge: hermes-ui useProviderStore → Helix useHelixStore ───────────────
  // The user can switch the active model from the hermes-ui ProviderSettings /
  // ModelSelector panels (which write to useProviderStore and push to Hermes).
  // Those are a SEPARATE store from useHelixStore (the one the input-bar model
  // selector reads). Without this bridge the input bar keeps showing the old
  // model even after a backend-side switch. Mirror the active model (and its
  // owning provider's config) into useHelixStore whenever it changes out-of-band.
  useEffect(() => {
    if (!isElectron()) return
    // On the FIRST fire (which is the hermes-ui hydration), the Helix store has
    // already restored its own active model — and unlike hermes-ui it knows about
    // fetched-only models. If hermes-ui hydrated to a declared default (pro) while
    // Helix restored a fetched model (flash), don't let hermes-ui clobber Helix.
    // Instead sync hermes-ui to Helix so the two agree, then return.
    let firstFire = true
    const unsub = useProviderStore.subscribe((state, prev) => {
      const model = state.activeModel
      if (model === prev.activeModel) return
      if (!model) return
      const helix = useHelixStore.getState()
      if (firstFire) {
        firstFire = false
        const helixModel = helix.apiConfig?.model
        if (helixModel && helixModel !== model) {
          useProviderStore.getState().setActiveModel(helixModel)
          return
        }
      }
      // Reuse the canonical resolver so the mirrored config matches a normal
      // in-panel switch (credentials + session invalidation handled there).
      const provider = state.providers.find((p) => p.models.includes(model))
      if (provider) {
        // Mirror into Helix store via onModelSwitched so activeModel/activeProviderId
        // and apiConfig all stay consistent and the stale session is cancelled.
        helix.onModelSwitched(model)
        // Keep the selected provider's credentials in sync too, in case the
        // hermes-ui provider carries a different key/baseUrl.
        const existing = helix.providers.find((p) => p.models.includes(model))
        if (existing && (existing.apiKey !== provider.apiKey || existing.baseUrl !== provider.baseUrl)) {
          useHelixStore.setState({
            providers: helix.providers.map((p) =>
              p.id === existing.id ? { ...p, apiKey: provider.apiKey, baseUrl: provider.baseUrl } : p,
            ),
          })
        }
        // onModelSwitched only updates the store. Mirror the input-bar switch
        // path (agent-flow-panel.syncConfigToBackend): cancel any in-flight
        // session, drop the cached id, and push the resolved config so the
        // backend picks up the new key immediately. Without this, an out-of-band
        // switch (hermes-ui ModelSelector / settings) only takes effect on the
        // next sendPrompt via the configHash check, and a run in flight keeps
        // streaming against the old endpoint.
        const hs = useHermesStore.getState()
        const sid = hs.hermesSessionId
        if (sid) {
          try { electronHermes.notify('session/cancel', { session_id: sid }) } catch {}
        }
        hs.setHermesSessionId(null)
        const s = useHelixStore.getState()
        const cfg = s.apiConfig
        const ap = s.activeProviderId ? s.providers.find((p) => p.id === s.activeProviderId) : undefined
        const resolvedKey = ap?.apiKey || cfg.apiKey || ''
        pushModelConfig({
          model: cfg.model,
          provider: cfg.provider && cfg.provider !== '__custom__' ? cfg.provider : 'custom',
          baseUrl: cfg.baseUrl,
          apiKey: resolvedKey,
        })
      } else {
        // Model not declared in Helix providers (e.g. fetched list only) — at
        // least reflect it in apiConfig so the selector label updates, avoiding
        // a frozen "always same model" display. Also set activeModel so the
        // dropdown highlight and the backend-mirror guard (`activeModel ||
        // cur.model`) don't stay pinned to the previous model.
        useHelixStore.setState({
          activeModel: model,
          apiConfig: { ...useHelixStore.getState().apiConfig, model },
        })
      }
    })
    return () => { try { unsub() } catch {} }
  }, [])

  useEffect(() => {
    if (chatMessages.length > 0) {
      setShowSidebar(true)
    }
  }, [chatMessages.length])

  // ── System tray: "最近对话" menu item ────────────────────────────────
  useEffect(() => {
    const unlisten = listen('tray:show-recent', () => {
      setShowSidebar(true)
    })
    return () => { unlisten.then(fn => fn()) }
  }, [])

  // DiffPreview no longer auto-pops: per-file change stats (+green / -red) are
  // rendered inline in the conversation transcript (FileChangeSummary). The
  // top-right diff button still opens the review modal on demand.

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
    let timer: any = null
    let startupTimer: any = null
    let stopped = false
    const unsubscribe = hermes.onEvent?.((event: string, params?: any) => {
      if (event === 'gateway.ready') {
        useHermesStore.getState().setHermesConnected(true)
        useHermesStore.getState().setHermesError(null)
        useHelixStore.getState().setGatewayStatus('ready')
        if (timer) { clearTimeout(timer); timer = null }
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null }
      } else if (event === 'gateway.disconnected') {
        useHermesStore.getState().setHermesConnected(false)
        useHelixStore.getState().setGatewayStatus('disconnected')
      } else if (event === 'gateway.retry') {
        const phase = params?.phase as 'error' | 'retrying' | 'recovered' | undefined
        if (phase === 'recovered') {
          useHermesStore.getState().setHermesConnected(true)
          useHelixStore.getState().setGatewayStatus('ready')
        } else {
          useHermesStore.getState().setHermesConnected(false)
          useHelixStore.getState().setGatewayStatus('connecting')
        }
      }
    })
    const tryConnect = async (retries = 0) => {
      if (stopped) return
      try {
        const st = await hermes.status()
        if (st?.connected) {
          useHermesStore.getState().setHermesConnected(true)
          useHelixStore.getState().setGatewayStatus('ready')
          if (timer) { clearTimeout(timer); timer = null }
          if (startupTimer) { clearTimeout(startupTimer); startupTimer = null }
          return
        }
        useHermesStore.getState().setHermesConnected(false)
      } catch {
        useHermesStore.getState().setHermesConnected(false)
      }
      useHelixStore.getState().setGatewayStatus('connecting')
      // Continue polling with increasing intervals: 1.5s for first 12, then 3s up to 60s total
      const delay = retries < 12 ? 1500 : 3000
      if (timer === null) {
        timer = setTimeout(() => { timer = null; tryConnect(retries + 1) }, delay)
      }
    }
    tryConnect()
    // Startup safety timeout: if gateway never becomes ready within 60s,
    // transition to 'disconnected' so the user sees a retry button instead
    // of being stuck on the blocking overlay forever.
    startupTimer = setTimeout(() => {
      const current = useHelixStore.getState().gatewayStatus
      if (current !== 'ready') {
        useHelixStore.getState().setGatewayStatus('disconnected')
      }
    }, 60_000)
    return () => {
      stopped = true
      try { unsubscribe?.() } catch {}
      if (timer) clearTimeout(timer)
      if (startupTimer) clearTimeout(startupTimer)
    }
  }, [])

  // ── Auto-speak latest assistant reply when a run completes ─────────────
  // Driven by the persisted `voiceAutoSpeak` setting (moved out of the old
  // standalone Voice panel into Settings). Always mounted so it works with no
  // panel open.
  useEffect(() => {
    let lastRunning = useHelixStore.getState().isAgentRunning
    let lastSpokenId: string | null = null
    const unsub = useHelixStore.subscribe((st) => {
      const running = st.isAgentRunning
      if (lastRunning && !running && st.voiceAutoSpeak) {
        const msgs = st.chatMessages
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant' && last.id !== lastSpokenId) {
          lastSpokenId = last.id
          const text = stripAcp(last.content)
          if (text) speak(text)
        }
      }
      lastRunning = running
    })
    return unsub
  }, [])

  // Native OS notification when an agent run finishes — respects desktopNotifications setting
  useEffect(() => {
    let prev = useHelixStore.getState().isAgentRunning
    const unsub = useHelixStore.subscribe((s) => {
      if (prev && !s.isAgentRunning && s.desktopNotifications) {
        electronNotification.notify('Helix', 'Agent 任务已完成')
      }
      prev = s.isAgentRunning
    })
    return unsub
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
      return
    }
    // If a project directory is already selected, open it in File Explorer.
    // Only fall back to the folder picker when nothing is selected yet.
    if (selectedWorkDir) {
      try {
        await electronShell.openPath(selectedWorkDir)
      } catch (e) {
        console.error('[handleOpenLocation] openPath failed:', e)
      }
      return
    }
    const { electronDialog } = await import('@/lib/electron-bridge')
    const dir = await electronDialog.openDirectory(selectedWorkDir || undefined)
    if (!dir) return
    try {
      await storeActions.setWorkDir(dir)
    } catch {
      storeActions.setSelectedWorkDir(dir)
    }
  }, [storeActions.setWorkDir, storeActions.setSelectedWorkDir, storeActions.showToast, selectedWorkDir])

  const handleNewChat = useCallback(() => {
    useHelixStore.getState().flushSessionPersist()
    storeActions.clearChat()
    useHelixStore.getState().clearExecutionFlow()
    useHelixStore.getState().setCurrentSessionId(null)
  }, [storeActions.clearChat])

  // ── System tray: "新建对话" menu item ──────────────────────────────
  useEffect(() => {
    const unlisten = listen('tray:new-conversation', () => {
      handleNewChat()
    })
    return () => { unlisten.then(fn => fn()) }
  }, [handleNewChat])

  // Window menu state
  const [windowMenuOpen, setWindowMenuOpen] = useState(false)
  const windowMenuButtonRef = useRef<HTMLButtonElement>(null)
  const windowMenuRef = useRef<HTMLDivElement>(null)

  // Help menu state
  const [helpMenuOpen, setHelpMenuOpen] = useState(false)
  const helpMenuButtonRef = useRef<HTMLButtonElement>(null)
  const helpMenuRef = useRef<HTMLDivElement>(null)
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    getCurrentVersion().then((v) => v && setAppVersion(v))
  }, [])

  // Browser "more" menu state (the ••• button next to the browser toggle)
  const [browserMenuOpen, setBrowserMenuOpen] = useState(false)
  const browserMenuButtonRef = useRef<HTMLButtonElement>(null)
  const browserMenuRef = useRef<HTMLDivElement>(null)

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

  // Click outside to close browser menu
  useEffect(() => {
    if (!browserMenuOpen) return
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        browserMenuButtonRef.current?.contains(target) ||
        browserMenuRef.current?.contains(target)
      ) {
        return
      }
      setBrowserMenuOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [browserMenuOpen])

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
        return
      }
      if (shift && !alt && e.code === 'BracketRight') {
        e.preventDefault()
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

  // Check if Hermes backend has a task list
  useEffect(() => {
    if (!isElectron()) return
    let cancelled = false
    electronHermes.send('hermes:getTasks').then((result: any) => {
      if (cancelled) return
      const list = Array.isArray(result) ? result : result?.tasks ?? result?.items ?? []
      setHasTaskList(Array.isArray(list) && list.length > 0)
    }).catch(() => {
      // Backend may not support this method — silently hide the button
    })
    return () => { cancelled = true }
  }, [])

    const windowMenuItems: (WindowMenuItem | { divider: true })[] = useMemo(() => [
    { label: '新建窗口', shortcut: 'Ctrl+Shift+N', action: () => { window.open(window.location.href, '_blank'); closeWindowMenu() } },
    { label: '关闭窗口', shortcut: 'Ctrl+Shift+W', action: () => { window.close(); closeWindowMenu() } },
    { divider: true },
    { label: '打开浏览器侧边栏', shortcut: '', action: () => { storeActions.setRightSidebarTab('browser'); closeWindowMenu() } },
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
    { label: '切换文件树', shortcut: shortcutLabel('toggle-file-tree', customShortcuts), action: () => { storeActions.setRightSidebarTab(storeActions.rightSidebarTab === 'files' ? null : 'files'); closeWindowMenu() } },
    { label: '打开代码编辑器', action: () => { storeActions.setRightSidebarTab('code'); closeWindowMenu() } },
    { divider: true },
    { label: '设置', shortcut: 'Ctrl+,', action: () => { storeActions.toggleSettings('api'); closeWindowMenu() } },
    { label: '重新加载页面', shortcut: shortcutLabel('reload-page', customShortcuts), action: () => { window.location.reload(); closeWindowMenu() } },
    { divider: true },
    { label: '查找', shortcut: shortcutLabel('search-chat', customShortcuts), action: () => { window.dispatchEvent(new CustomEvent('helix:conversation-search')); closeWindowMenu() } },
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
    <div className={`relative h-screen w-screen flex flex-col overflow-hidden ${
      'bg-gradient-to-br from-background via-background to-primary/5'
    }`}>
      <KeyboardShortcuts />
      <CommandPalette />
      <ContextMenuProvider />
      <ToastContainer />
      <WakeWordAnimation show={useHelixStore(s => s.showWakeAnimation)} onComplete={() => useHelixStore.getState().setShowWakeAnimation(false)} />

      {/* Title bar — part of the background */}
      <div id="helix-titlebar" className="flex items-center justify-between h-10 px-3 shrink-0 select-none">
        {/* Left: navigation buttons */}
        <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button
            onClick={() => setShowSidebar(v => !v)}
            className={`p-1.5 rounded-lg transition-colors ${showSidebar ? 'text-primary bg-primary/10' : 'text-foreground/40 hover:text-foreground/80 hover:bg-accent/50'}`}
            title="侧边栏"
          >
            <PanelLeft className="size-4" />
          </button>
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
                <div className="px-3 py-2 text-xs text-muted-foreground/60">
                    版本 v{appVersion || '0.3.8'}
                  </div>
                  <button
                    className="w-full px-3 py-2 text-sm text-left hover:bg-accent/60 transition-colors flex items-center gap-2"
                    onClick={async () => {
                      setHelpMenuOpen(false)
                      try {
                        const res = await fetch('https://api.github.com/repos/h6643/Helix/releases/latest', {
                          signal: AbortSignal.timeout(8000),
                        })
                        if (!res.ok) {
                          useHelixStore.getState().showToast({ type: 'error', title: '检查更新失败', description: '无法连接 GitHub' })
                          return
                        }
                        const data = await res.json()
                        const latest = (data.tag_name || data.name || '').replace(/^v/i, '')
                        const current = (await getCurrentVersion()) || '0.3.8'
                        const curParts = current.split('.').map(Number)
                        const latParts = latest.split('.').map(Number)
                        let isNewer = false
                        for (let i = 0; i < Math.max(curParts.length, latParts.length); i++) {
                          const a = curParts[i] || 0
                          const b = latParts[i] || 0
                          if (b > a) { isNewer = true; break }
                          if (b < a) break
                        }
                        if (isNewer) {
                          useHelixStore.getState().showToast({ type: 'info', title: '有新版本可用', description: 'v' + latest + ' 已发布', duration: 8000, onClick: () => window.open('https://github.com/NousResearch/hermes-agent/releases/latest', '_blank') })
                        } else {
                          useHelixStore.getState().showToast({ type: 'success', title: '已是最新版本', description: 'v' + current })
                        }
                      } catch {
                        useHelixStore.getState().showToast({ type: 'error', title: '检查更新失败', description: '网络异常' })
                      }
                    }}
                  >
                    <FileText className="size-4" />
                    检查更新
                  </button>
                <div className="h-px bg-border/60 my-1" />
                <button
                  className="w-full px-3 py-2 text-sm text-left hover:bg-accent/60 transition-colors flex items-center gap-2"
                  onClick={() => {
                    setHelpMenuOpen(false)
                    window.open('https://github.com/NousResearch/hermes-agent', '_blank')
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

        {/* Center: drag region (Tauri uses data-tauri-drag-region; the Electron
            -webkit-app-region CSS is a no-op on Tauri and leaves the window
            undraggable) */}
        <div className="flex-1 self-stretch" data-tauri-drag-region="" />

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
              className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-destructive/10 hover:text-destructive rounded-lg transition-colors"
              title="关闭"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Content area: sidebar + floating card */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar — part of the background */}
        {showSidebar && (
          <div
            className={`shrink-0 overflow-hidden relative ${isDragging ? '' : 'transition-[width] duration-200 ease-out'}`}
            style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED : sidebarWidth }}
          >
            <div
              className="h-full overflow-hidden"
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

        {/* Floating cards container */}
        <div className="flex-1 flex flex-row m-3 ml-0 overflow-hidden">
        {/* Floating card — main content */}
        <div className="flex-1 flex flex-col rounded-2xl border border-border/50 bg-card shadow-2xl shadow-primary/5 overflow-hidden">
          {/* Main area */}
          <div className="relative flex-1 h-full flex flex-col overflow-hidden">
          <div className={`flex-1 flex flex-row overflow-hidden ${sidePanelOpen ? 'hidden' : ''}`}>
              <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              {/* Conversation header — only visible when an active conversation has messages */}
                {(chatMessages.length > 0 && !!currentSessionId) && (
                  <div className="shrink-0 h-9 flex items-center justify-between gap-2 px-3">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <button
                        onClick={handleOpenLocation}
                        className="flex items-center gap-1.5 text-[12px] text-foreground/70 hover:text-foreground hover:bg-accent/60 px-2 py-1 rounded-lg transition-colors shrink-0"
                        title={selectedWorkDir ? '在资源管理器中打开' : '选择位置'}
                      >
                        <Folder className="size-3.5 text-muted-foreground" />
                        <span className="max-w-[200px] truncate">{selectedWorkDir ? (selectedWorkDir.split(/[\/\\]/).pop() || selectedWorkDir) : '未选择位置'}</span>
                      </button>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                  {(hermesTodos.length > 0 || hasTaskList) && (
                    <div className="relative" ref={todoPopoverRef}>
                      <button
                        onClick={() => {
                          if (hermesTodos.length > 0) setTodoPopoverOpen(o => !o)
                          else if (hasTaskList) setShowTaskListPanel(true)
                        }}
                        className={`relative p-1.5 rounded-lg transition-colors ${todoPopoverOpen ? 'text-primary bg-primary/10' : 'text-foreground/50 hover:text-foreground hover:bg-accent/60'}`}
                        title="任务清单"
                      >
                        <ListTodo className="size-4" />
                        {hermesTodos.length > 0 && (
                          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-medium flex items-center justify-center">
                            {hermesTodos.length}
                          </span>
                        )}
                      </button>
                      {todoPopoverOpen && hermesTodos.length > 0 && (
                        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-72 max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
                          <div className="sticky top-0 flex items-center justify-between px-3 py-2 border-b border-border bg-popover rounded-t-xl">
                            <span className="text-[12px] font-semibold">任务清单</span>
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] text-foreground/50">
                                {hermesTodos.filter(t => t.status === 'completed').length}/{hermesTodos.length}
                              </span>
                              {hasTaskList && (
                                <button
                                  onClick={() => { setTodoPopoverOpen(false); setShowTaskListPanel(true) }}
                                  className="text-[11px] text-primary hover:underline"
                                  title="编辑任务"
                                >
                                  编辑
                                </button>
                              )}
                            </div>
                          </div>
                          <ul className="py-1">
                            {hermesTodos.map((todo) => (
                              <li key={todo.id} className="flex items-start gap-2 px-3 py-1.5 text-[12px]">
                                {todo.status === 'completed' ? (
                                  <CheckCircle2 className="size-4 text-green-500 shrink-0 mt-0.5" />
                                ) : todo.status === 'in_progress' ? (
                                  <Loader2 className="size-4 text-primary shrink-0 mt-0.5 animate-spin" />
                                ) : todo.status === 'cancelled' ? (
                                  <XCircle className="size-4 text-muted-foreground shrink-0 mt-0.5" />
                                ) : (
                                  <Circle className="size-4 text-foreground/40 shrink-0 mt-0.5" />
                                )}
                                <span className={todo.status === 'completed' ? 'line-through text-foreground/50' : todo.status === 'cancelled' ? 'line-through text-foreground/40' : 'text-foreground/90'}>
                                  {todo.content}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Delegations button */}
                  {isElectron() && delegations.length > 0 && (
                    <div className="relative" ref={delegationsPopoverRef}>
                      <button
                        onClick={() => setDelegationsPopoverOpen(v => !v)}
                        className={`p-1.5 rounded-lg transition-colors ${delegationsPopoverOpen ? 'text-primary bg-primary/10' : 'text-foreground/50 hover:text-foreground hover:bg-accent/60'}`}
                        title={`${delegations.length} 个子 Agent`}
                      >
                        <Users className="size-4" />
                        <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-primary text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                          {delegations.length}
                        </span>
                      </button>
                      {delegationsPopoverOpen && (
                        <div className="absolute right-0 top-full mt-1 w-72 bg-card border border-border/80 rounded-lg shadow-xl z-50">
                          <div className="px-3 py-2 border-b border-border/50">
                            <h3 className="text-xs font-semibold text-foreground">子 Agent</h3>
                          </div>
                          <div className="max-h-64 overflow-auto">
                            {delegations.map((del) => (
                              <div key={del.id} className="px-3 py-2 border-b border-border/30 last:border-b-0">
                                <div className="flex items-center gap-2">
                                  <Terminal className="size-3 text-primary" />
                                  <span className="text-xs font-mono text-foreground/80 truncate">{del.id}</span>
                                </div>
                                <div className="mt-1 text-[10px] text-muted-foreground">
                                  {del.tasks.length} 个任务
                                </div>
                              </div>
                            ))}
                          </div>
                          <div className="px-3 py-2 border-t border-border/50">
                            <button
                              onClick={() => { storeActions.toggleSubAgentPanel(); setDelegationsPopoverOpen(false) }}
                              className="w-full text-xs text-primary hover:underline"
                            >
                              查看详情
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    onClick={() => storeActions.toggleTerminal()}
                    className={`p-1.5 rounded-lg transition-colors ${isTerminalOpen ? 'text-primary bg-primary/10' : 'text-foreground/50 hover:text-foreground hover:bg-accent/60'}`}
                    title="终端"
                  >
                    <Terminal className="size-4" />
                  </button>
                  {(rightSidebarTab !== 'browser' && rightSidebarTab !== 'files' && rightSidebarTab !== 'diff') && (
                  <button
                    ref={browserMenuButtonRef}
                    onClick={() => setBrowserMenuOpen(v => !v)}
                    className={`p-1.5 rounded-lg transition-colors ${browserMenuOpen ? 'text-primary bg-primary/10' : 'text-foreground/50 hover:text-foreground hover:bg-accent/60'}`}
                    title="更多操作"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                  )}
                  {browserMenuOpen && typeof window !== 'undefined' && createPortal(
                    <div
                      className="fixed z-[100]"
                      style={{
                        top: (browserMenuButtonRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                        left: browserMenuButtonRef.current?.getBoundingClientRect().right ? browserMenuButtonRef.current!.getBoundingClientRect().right - 208 : 0,
                      }}
                    >
                      <div ref={browserMenuRef} className="w-52 bg-card border border-border/80 rounded-lg shadow-xl py-1">
                        <button
                          onClick={() => { storeActions.setRightSidebarTab(rightSidebarTab === 'browser' ? null : 'browser'); setBrowserMenuOpen(false) }}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/60 transition-colors ${rightSidebarTab === 'browser' ? 'text-primary' : 'text-foreground/80'}`}
                        >
                          <Globe className="size-3.5" />
                          <span className="flex-1 text-left">浏览器</span>
                          {rightSidebarTab === 'browser' && <CheckCircle2 className="size-3.5" />}
                        </button>
                        <button
                          onClick={() => { storeActions.setRightSidebarTab(rightSidebarTab === 'files' ? null : 'files'); setBrowserMenuOpen(false) }}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/60 transition-colors ${rightSidebarTab === 'files' ? 'text-primary' : 'text-foreground/80'}`}
                        >
                          <FolderTree className="size-3.5" />
                          <span className="flex-1 text-left">目录</span>
                          {rightSidebarTab === 'files' && <CheckCircle2 className="size-3.5" />}
                        </button>
                        
                        <button
                          onClick={() => { storeActions.setRightSidebarTab(rightSidebarTab === 'diff' ? null : 'diff'); setBrowserMenuOpen(false) }}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/60 transition-colors ${rightSidebarTab === 'diff' ? 'text-primary' : 'text-foreground/80'}`}
                        >
                          <FileDiff className="size-3.5" />
                          <span className="flex-1 text-left">变更</span>
                          {rightSidebarTab === 'diff' && <CheckCircle2 className="size-3.5" />}
                        </button>
                      </div>
                    </div>,
                    document.body
                  )}
                </div>
              </div>
                )}
              <div className="flex-1 min-h-0 min-w-0 flex flex-col">
                <AgentFlowPanel />
              </div>
              <TerminalPanel onClose={storeActions.toggleTerminal} />
              </div>
            </div>
          </div>
        </div>

        {/* Floating card — right sidebar */}
        {rightSidebarTab && (
          <div className="relative shrink-0" style={{ width: rightSidebarWidth }}>
            <div
              className={`absolute top-0 -left-1 w-2 h-full cursor-col-resize z-30 group ${isRightDragging ? 'bg-primary/20' : ''}`}
              onMouseDown={handleRightDragStart}
            >
              <div className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 transition-colors ${isRightDragging ? 'bg-primary/40' : 'bg-transparent group-hover:bg-border/40'}`} />
            </div>
            <div className="h-full rounded-2xl border border-border/50 bg-card shadow-2xl shadow-primary/5 overflow-hidden">
              <RightSidebar key={rightSidebarTab} />
            </div>
          </div>
        )}
        </div>
      </div>
        {showScheduledTasksPanel && (
            <div className="absolute inset-0 z-20">
              <PanelSuspense>
                <ScheduledTasksPanel onClose={() => storeActions.toggleScheduledTasksPanel()} />
              </PanelSuspense>
            </div>
          )}
          {showPluginManager && (
            <div className="absolute inset-0 z-20">
              <PanelSuspense>
                <PluginManagerPanel onClose={() => storeActions.togglePluginManager()} />
              </PanelSuspense>
            </div>
          )}
          {showSkillPanel && (
            <div className="absolute inset-0 z-20">
              <PanelSuspense>
                <SkillPanel onClose={() => storeActions.toggleSkillPanel()} />
              </PanelSuspense>
            </div>
          )}
          {showRuntimePanel && (
            <div className="absolute inset-0 z-20">
              <PanelSuspense>
                <RuntimePanel onClose={() => storeActions.toggleRuntimePanel()} />
              </PanelSuspense>
            </div>
          )}
          {showWorktreePanel && (
            <div className="absolute inset-0 z-20">
              <PanelSuspense>
                <WorktreePanel onClose={() => storeActions.toggleWorktreePanel()} />
              </PanelSuspense>
            </div>
          )}
          <div className={`absolute inset-0 z-20 ${showKanbanPanel ? '' : 'hidden'}`}>
            <PanelSuspense>
              <KanbanPanel />
            </PanelSuspense>
          </div>
          <div className={`absolute inset-0 z-20 ${showSubAgentPanel ? '' : 'hidden'}`}>
            <PanelSuspense>
              <DelegationsPanel onClose={() => storeActions.toggleSubAgentPanel()} />
            </PanelSuspense>
          </div>

      {/* Overlay panels */}
      <Suspense fallback={null}>
        {showTaskListPanel && <TaskListPanel onClose={() => setShowTaskListPanel(false)} />}

        {showSessionManager && <SessionManager onClose={() => storeActions.toggleSessionManager()} />}
        {showCustomizePanel && <CustomizePanel onClose={() => storeActions.toggleCustomizePanel()} />}
        {showSettings && (
          <ApiSettings
            themeStyle={themeStyle}
            onSelectThemeStyle={setThemeStyle}
            sidebarWidth={sidebarWidth}
            setSidebarWidth={setSidebarWidth}
            saveSidebarWidth={saveSidebarWidth}
            showSidebar={showSidebar}
            setShowSidebar={setShowSidebar}
            sidebarCollapsed={sidebarCollapsed}
            setSidebarCollapsed={setSidebarCollapsed}
          />
        )}
        {/* New surfaces */}
        {showActivityFeed && <ActivityFeed onClose={() => storeActions.toggleActivityFeed()} />}
        {showArtifactsBrowser && <ArtifactsBrowser onClose={() => storeActions.toggleArtifactsBrowser()} />}
        <Onboarding />
        <BootOverlay />
      </Suspense>
    </div>
  )
}
