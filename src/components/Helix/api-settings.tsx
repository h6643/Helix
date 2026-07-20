'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
  Settings, Sun, Moon, Plug, Archive, ChevronLeft, ChevronRight, ChevronDown, Search,
  Save, Eye, EyeOff, Trash2, Plus, Pencil, Sparkles,
  Globe, FileText, Keyboard, Terminal, Link, Wand2,
  RefreshCw, GitBranch, GitCommit, GitPullRequest, Zap, Anchor, Check, Activity, Loader2,
  ArrowDown, ArrowUp, Target, X, AlignLeft, Minimize2, AlertTriangle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useHelixStore, DEFAULT_SHORTCUTS, type ApiConfig, type McpServerConfig } from '@/stores/helix-store'
import { useHermesStore } from '@/stores/hermes-store'
import { getAllProviders, getModels, getBaseUrl } from '@/lib/providers'
import { formatTokens } from '@/lib/format'
import { isElectron } from '@/lib/electron-bridge'
import { persistence, type PersistedSession } from '@/lib/persist'
import { useHermes } from '@/hooks/use-hermes'
import { ShortcutsPage } from './shortcuts-page'
import { McpEditorForm, type McpFormData } from './mcp-editor-form'
import { ModelUsageStats, UsageSummary, UsageDetail, TokenUsagePanel } from './usage-stats'
import { HookSettings } from './hook-settings'

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-2 mb-4 ${className || ''}`}>
      <h3 className="text-lg font-bold text-foreground">{children}</h3>
    </div>
  )
}

const ALL_PROVIDERS = getAllProviders()

// Fallback personality presets — shown when the backend (Hermes config.yaml)
// doesn't return any, so the dropdown is never empty.
const BUILTIN_PERSONALITIES: Record<string, string> = {
  温柔: '你是一位温柔、耐心、善解人意的助手。语气柔和，多用共情与鼓励。',
  干练: '你是一位干练、利落的助手。直奔主题，结论先行，少铺垫。',
}

const PERSONALITY_LABELS: Record<string, string> = {}

const CUSTOM_PROVIDER_ID = '__custom__'

interface SettingsProps {
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  // Shared with the main layout so the settings nav width stays in sync with
  // the main sidebar (single source of truth: helix-layout's sidebarWidth).
  sidebarWidth: number
  setSidebarWidth: (w: number) => void
  saveSidebarWidth: (w: number) => void
  showSidebar: boolean
  setShowSidebar: (v: boolean | ((prev: boolean) => boolean)) => void
  sidebarCollapsed: boolean
  setSidebarCollapsed: (v: boolean | ((prev: boolean) => boolean)) => void
}

type SettingsPage = 'general' | 'appearance' | 'api' | 'shortcuts' | 'mcp' | 'archive' | 'git' | 'skills' | 'hook' | 'usage' | 'help'

interface NavItem {
  id: SettingsPage
  label: string
  icon: typeof Settings | React.FC<{ className?: string }>
}

interface NavGroup {
  title: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: '个人',
    items: [
      { id: 'general', label: '常规', icon: Settings },
      { id: 'appearance', label: '外观', icon: Sun },
      { id: 'archive', label: '历史归档', icon: Archive },
      { id: 'shortcuts', label: '快捷键', icon: Keyboard },
    ],
  },
  {
    title: '配置',
    items: [
      { id: 'api', label: '模型', icon: Globe },
      { id: 'mcp', label: 'MCP', icon: Plug },
      { id: 'usage', label: '用量', icon: Activity },
    ],
  },
  {
    title: '集成',
    items: [
      { id: 'git', label: 'Git', icon: GitBranch },
      { id: 'hook', label: 'Hooks', icon: Zap },
    ],
  },
]

// ─── settings search index ──────────────────────────────────────────────
const SETTINGS_SEARCH_INDEX: { page: string; label: string; desc: string }[] = [
  { page: 'general', label: '输出风格', desc: '简洁 / 详细 / 标准' },
  { page: 'general', label: '自动压缩上下文', desc: '对话上下文管理' },
  { page: 'general', label: '桌面通知', desc: '完成任务时通知' },
  { page: 'general', label: '提示音', desc: '完成时播放提示音' },
  { page: 'general', label: '恢复上次会话', desc: '启动时恢复' },
  { page: 'general', label: '默认工作目录', desc: '默认工作路径' },
  { page: 'general', label: '危险操作确认', desc: '执行前确认' },
  { page: 'general', label: '自动批准读取', desc: '无需逐次确认' },
  { page: 'general', label: 'Agent 预设', desc: '行为模式' },
  { page: 'general', label: '自定义指令', desc: '系统提示词' },
  { page: 'general', label: '数据管理', desc: '导入/导出配置' },
  { page: 'appearance', label: '主题', desc: '深色 / 浅色' },
  { page: 'appearance', label: '编辑器设置', desc: '代码字体字号' },
  { page: 'appearance', label: '界面设置', desc: 'UI 字体字号' },
  { page: 'appearance', label: '界面字体', desc: '菜单字体' },
  { page: 'api', label: '模型配置', desc: 'API 端点' },
  { page: 'api', label: '添加模型', desc: '新端点' },
  { page: 'api', label: '历史记录', desc: '已保存配置' },
  { page: 'mcp', label: 'MCP', desc: '服务器连接' },
  { page: 'mcp', label: 'MCP 配置', desc: '添加服务器' },
  { page: 'usage', label: 'Token 用量', desc: '统计' },
  { page: 'usage', label: '用量详情', desc: '消耗明细' },
  { page: 'archive', label: '历史归档', desc: '会话管理' },
  { page: 'shortcuts', label: '快捷键', desc: '自定义' },
  { page: 'git', label: 'Git', desc: '自动提交推送' },
  { page: 'git', label: '自动提交', desc: 'Git 自动提交' },
  { page: 'hook', label: 'Hooks', desc: '事件钩子' },
]

// ModelUsageStats, UsageSummary, UsageDetail, TokenUsagePanel — extracted to ./usage-stats.tsx

// ShortcutsPage — extracted to ./shortcuts-page.tsx
// McpEditorForm — extracted to ./mcp-editor-form.tsx

// ─── Shared components ──────────────────────────────────────────────────────
const Toggle = ({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) => (
  <button
    onClick={onToggle}
    className={`relative w-10 h-6 rounded-full transition-colors duration-200 ${
      enabled ? 'bg-primary' : 'bg-muted-foreground/20'
    }`}
  >
    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${
      enabled ? 'translate-x-4' : ''
    }`} />
  </button>
)

// ─── Main component ──────────────────────────────────────────────────────────
export function ApiSettings({ theme, onToggleTheme, sidebarWidth, setSidebarWidth, saveSidebarWidth, showSidebar, setShowSidebar, sidebarCollapsed, setSidebarCollapsed }: SettingsProps) {
  const {
    apiConfig, apiProfiles, activeProfileId,
    apiHistory, addApiHistory, removeApiHistory,
    providers, activeModel, upsertProvider, removeProvider, setActiveModel,
    setApiConfig, addApiProfile, updateApiProfileConfig, renameApiProfile, removeApiProfile, setActiveProfile,
    showToast, persistToStorage,
    setAvailableModels, availableModels,
    fontFamily, setFontFamily, fontSize, setFontSize,
    interfaceFont, setInterfaceFont,
    transcriptFontSize, setTranscriptFontSize,
    mcpServers, addMcpServer, removeMcpServer, toggleMcpServer,
    customInstructions, setCustomInstructions,
    // Git
    gitAutoCommit, setGitAutoCommit,
    gitAutoPush, setGitAutoPush,
    gitPushConfirm, setGitPushConfirm,
    gitAutoBranch, setGitAutoBranch,
    gitRemoteUrl, setGitRemoteUrl,
    gitCommitTemplate, setGitCommitTemplate,
    gitBranchPrefix, setGitBranchPrefix,
    // Hermes config-backed toggles
    personality, setPersonality,
    // Agent settings
    autoCompactContext, setAutoCompactContext,
    outputStyle, setOutputStyle,
    // Notification settings
    desktopNotifications, setDesktopNotifications,
    soundEnabled, setSoundEnabled,
    // Startup behavior
    restoreLastSession, setRestoreLastSession,
    defaultWorkDir, setDefaultWorkDir,
    // Language
    language, setLanguage,
    // Security
    confirmDangerousActions, setConfirmDangerousActions,
    autoApproveRead, setAutoApproveRead,
  } = useHelixStore()

  const settingsPage = useHelixStore(s => s.settingsPage)
  const setSettingsPage = useHelixStore(s => s.setSettingsPage)
  const pushNavigation = useHelixStore(s => s.pushNavigation)
  const [page, setPage] = useState<SettingsPage>((settingsPage as SettingsPage) || 'general')
  const [navSearch, setNavSearch] = useState('')
  const navSearchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k' && !e.shiftKey) {
        e.preventDefault()
        navSearchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  useEffect(() => {
    if (settingsPage) {
      setPage(settingsPage as SettingsPage)
      setSettingsPage(null)
    }
  }, [settingsPage, setSettingsPage])
  const [localConfig, setLocalConfig] = useState<ApiConfig>({ ...apiConfig })
  const [gitSaving, setGitSaving] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())

  // ── Settings nav resize (synced with the main sidebar width) ──────────────
  // The main sidebar width lives in helix-layout and is the single source of
  // truth. We mirror it here so the settings nav matches, and let the user drag
  // this handle to resize — which also resizes the main sidebar live.
  const SETTINGS_NAV_MIN = 200
  const SETTINGS_NAV_MAX = 500
  const navWidth = Math.max(SETTINGS_NAV_MIN, Math.min(SETTINGS_NAV_MAX, sidebarWidth))
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartX = useRef(0)
  const resizeStartW = useRef(navWidth)
  const latestNavW = useRef(navWidth)

  const startNavResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizeStartX.current = e.clientX
    resizeStartW.current = navWidth
    latestNavW.current = navWidth
    setIsResizing(true)
  }, [navWidth])

  useEffect(() => {
    if (!isResizing) return
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    let raf = 0
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const delta = e.clientX - resizeStartX.current
        const next = Math.max(SETTINGS_NAV_MIN, Math.min(SETTINGS_NAV_MAX, resizeStartW.current + delta))
        latestNavW.current = next
        setSidebarWidth(next)
      })
    }
    const onUp = () => {
      cancelAnimationFrame(raf)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      setIsResizing(false)
      saveSidebarWidth(latestNavW.current)
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
  }, [isResizing, setSidebarWidth, saveSidebarWidth])

  useEffect(() => {
    setIsCustomProvider(!!localConfig.provider && !ALL_PROVIDERS.some(p => p.id === localConfig.provider))
  }, [localConfig.provider])

  useEffect(() => {
    setLocalConfig({ ...apiConfig })
    setIsCustomProvider(!!apiConfig.provider && !ALL_PROVIDERS.some(p => p.id === apiConfig.provider))
  }, [apiConfig])

  // Mirror the backend's actual config when running in Electron so the form
  // shows what Hermes is really using.
  //
  // CRITICAL: the backend's hermes:getConfig does NOT return the API key — the
  // key lives in Hermes's .env and is never echoed back over IPC (security).
  // So we must PRESERVE the key already in the store instead of clobbering it
  // with ''. And we must NOT call persistToStorage() here: this is a read-only
  // mirror. Persisting would overwrite the saved profile with an empty key and
  // force the user to reconfigure the model after every restart / every time
  // they open Settings (the old behaviour).
  useEffect(() => {
    if (!isElectron()) return
    const h = (window as any).electron?.hermes
    if (!h?.getConfig) return
    h.getConfig().then((r: any) => {
      if (!r || !r.model) return
      // Read the latest store value at resolve time (restoreFromStorage may have
      // just rehydrated it). Preserve its key; only fill backend-known fields.
      const cur = useHelixStore.getState().apiConfig
      // Reject the broken ant-ling endpoint if it ever surfaces in the backend.
      const baseUrl = /ant-ling/i.test(r.baseUrl || '') ? cur.baseUrl : (r.baseUrl || cur.baseUrl)
      setApiConfig({
        provider: r.provider || cur.provider,
        apiKey: cur.apiKey, // never overwrite the saved key with ''
        baseUrl,
        model: r.model || cur.model,
      })
      // Intentionally NOT calling persistToStorage(): mirroring must not write
      // back to IndexedDB (that would wipe the persisted profile's key).
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [showApiKey, setShowApiKey] = useState(false)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [isCustomProvider, setIsCustomProvider] = useState(false)
  const [customInputFocused, setCustomInputFocused] = useState(false)
  const [showAddModelModal, setShowAddModelModal] = useState(false)

  // Hermes config-backed toggles (streaming / compression / guardrails / stt / personality)
  const { dispatchCommand, setHermesPersonality } = useHermes()
  const [personalities, setPersonalities] = useState<Record<string, string>>(BUILTIN_PERSONALITIES)
  useEffect(() => {
    if (!isElectron) return
    window.electron.hermes.listPersonalities()
      .then((r: any) => {
        const got = r?.personalities
        if (r?.success && got && Object.keys(got).length > 0) {
          // Only keep allowed personalities
          const allowed = ['温柔', '干练']
          const filtered: Record<string, string> = {}
          for (const key of allowed) {
            if (got[key]) filtered[key] = got[key]
          }
          if (Object.keys(filtered).length > 0) setPersonalities(filtered)
        }
      })
      .catch(() => {})
  }, [])

  const applyYamlKey = useCallback(async (key: string, value: boolean) => {
    if (!isElectron) return
    try {
      const r: any = await window.electron.hermes.setYamlKey(key, value)
      if (r?.success && r?.changed) {
        showToast({ title: '设置已保存', description: 'Hermes 已重启生效', type: 'success' })
      } else if (!r?.success) {
        showToast({ title: '保存失败', description: r?.error || '未知错误', type: 'error' })
      }
    } catch (e: any) {
      showToast({ title: '保存失败', description: e?.message || String(e), type: 'error' })
    }
  }, [showToast])
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const modelDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showModelDropdown) return
    const handleClick = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showModelDropdown])

  // MCP state
  const [editingMcpName, setEditingMcpName] = useState<string | null>(null)
  const [isAddingMcp, setIsAddingMcp] = useState(false)
  const [mcpForm, setMcpForm] = useState<McpFormData>({
    name: '', type: 'local', command: '', url: '', args: '', env: {}, envPassthrough: false, cwd: '~/Helix',
  })
  const mcpServerNames = Object.keys(mcpServers)
  const [mcpStatus, setMcpStatus] = useState<Record<string, boolean>>({})

  // MCP status - query tools/list to detect which MCP servers are connected
  const fetchMcpStatus = useCallback(async () => {
    try {
      const sessionId = useHermesStore.getState().hermesSessionId
      if (!sessionId) { setMcpStatus({}); return }
      const result = await window.electron.hermes.send('tools/list', { session_id: sessionId }) as any
      const tools: string[] = result?.tools?.map((t: any) => t.name) || result?.map((t: any) => t.name) || []
      // Match tool names to MCP server names (e.g. "tavily_search" -> "tavily")
      const status: Record<string, boolean> = {}
      for (const name of Object.keys(mcpServers)) {
        status[name] = tools.some(t => t.toLowerCase().startsWith(name.toLowerCase()))
      }
      setMcpStatus(status)
    } catch {
      setMcpStatus({})
    }
  }, [mcpServers])

  useEffect(() => {
    fetchMcpStatus()
  }, [fetchMcpStatus])

  // Archive state
  const [archives, setArchives] = useState<Array<{ id: string; label: string; savedAt: number; messageCount: number }>>([])
  const [archiving, setArchiving] = useState(false)

  const loadArchives = useCallback(async () => {
    try {
      const sessions = await persistence.loadSessions()
      setArchives(sessions.filter(s => s.isArchived).sort((a, b) => b.savedAt - a.savedAt).map(s => ({
        id: s.id, label: s.label, savedAt: s.savedAt, messageCount: s.chatMessages.length,
      })))
    } catch {}
  }, [])

  useEffect(() => { loadArchives() }, [loadArchives])

  // ── API handlers ──────────────────────────────────────────────────────────
  const handleSelectProvider = useCallback((providerId: string) => {
    setAvailableModels([])
    if (providerId === CUSTOM_PROVIDER_ID) {
      setIsCustomProvider(true)
      setLocalConfig(prev => ({ ...prev, provider: '', baseUrl: '', model: '' }))
      return
    }
    setIsCustomProvider(false)
    setCustomInputFocused(false)
    const provider = ALL_PROVIDERS.find(p => p.id === providerId)
    setLocalConfig(prev => ({
      ...prev, provider: providerId,
      baseUrl: getBaseUrl(providerId) || prev.baseUrl,
      model: provider?.models[0] || prev.model,
    }))
  }, [])

  const handleCustomProviderChange = useCallback((providerValue: string) => {
    setLocalConfig(prev => ({ ...prev, provider: providerValue }))
    // Only auto-switch if user's input exactly matches a known provider ID
    if (providerValue.trim().length > 0) {
      const match = ALL_PROVIDERS.find(p =>
        p.id.toLowerCase() === providerValue.trim().toLowerCase()
      )
      if (match) {
        setIsCustomProvider(false)
        setCustomInputFocused(false)
        setLocalConfig(prev => ({
          ...prev, provider: match.id,
          baseUrl: getBaseUrl(match.id) || prev.baseUrl,
          model: match.models[0] || prev.model,
        }))
      }
    }
  }, [])

  const handleBlurCustomInput = useCallback(() => {
    setCustomInputFocused(false)
    if (!localConfig.provider) {
      setIsCustomProvider(false)
      setLocalConfig(prev => ({ ...prev, provider: '' }))
    }
  }, [localConfig.provider])

  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)
  const [apiView, setApiView] = useState<'list' | 'edit'>('list')

  const handleFetchModels = useCallback(async () => {
    if (!localConfig.apiKey.trim() || !localConfig.baseUrl.trim()) {
      showToast({ type: 'warning', title: '请先填写 Base URL 和 API Key' }); return
    }
    setIsLoadingModels(true)
    try {
      let models: string[] = []
      if (isElectron()) {
        // Use Electron IPC to fetch models (Hermes backend)
        const result = await window.electron.hermes.fetchModels({
          baseUrl: localConfig.baseUrl,
          apiKey: localConfig.apiKey,
        }) as any
        if (result.error) throw new Error(result.error)
        models = result.models || []
      } else {
        // Browser mode has no backend to probe models — surface a clear error
        // instead of hitting a deleted /api/models route (404).
        throw new Error('模型列表获取仅在桌面端可用')
      }
      if (models.length === 0) {
        showToast({ type: 'warning', title: '未获取到模型' })
      } else {
        setAvailableModels(models)
        showToast({ type: 'success', title: `获取到 ${models.length} 个模型` })
      }
    } catch (error) {
      showToast({ type: 'error', title: error instanceof Error ? error.message : '获取失败' })
      setAvailableModels([])
    } finally { setIsLoadingModels(false) }
  }, [localConfig.apiKey, localConfig.baseUrl, showToast, setAvailableModels])

  const applyProfile = useCallback(async (id: string) => {
    const p = apiProfiles.find((x) => x.id === id)
    if (!p) return
    setLocalConfig({ ...p.config })
    setApiConfig({ ...p.config })
    setActiveProfile(id)
    // Clear stale available models from the previous provider so the dropdown
    // only shows models fetched from the NEW endpoint.
    setAvailableModels([])
    // Persist the selection so it survives a cold restart (otherwise the active
    // profile is forgotten and restoreFromStorage reverts to the old apiConfig).
    try { await persistToStorage() } catch {}
    // Invalidate the cached Hermes session so the next prompt rebuilds it with
    // the newly-selected profile's model/key (prevents stale-session 401s).
    useHermesStore.getState().setHermesSessionId(null)
    if (isElectron()) {
      try {
        const cfg = {
          model: p.config.model,
          provider: p.config.provider && p.config.provider !== '__custom__' ? p.config.provider : 'custom',
          baseUrl: p.config.baseUrl,
          apiKey: p.config.apiKey,
        }
        await window.electron.hermes.setConfig(cfg)
        // Persist the active profile so the next cold start re-asserts it
        // into Hermes config.yaml (no hardcoded pin, free switching preserved).
        await window.electron.profile.cacheConfig(cfg)
      } catch {}
    }
  }, [apiProfiles, setLocalConfig, setApiConfig, setActiveProfile, persistToStorage])

  const handleAddProfile = useCallback(() => {
    setEditingProfileId(null)
    setLocalConfig({ provider: '', apiKey: '', baseUrl: '', model: '' })
    setIsCustomProvider(false)
    setAvailableModels([])
    setShowModelDropdown(false)
    setApiView('edit')
  }, [])

  const handleRemoveProfile = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation(); removeApiProfile(id); await persistToStorage()
  }, [removeApiProfile, persistToStorage])

  const handleEditProfile = useCallback((id: string) => {
    const p = apiProfiles.find((x) => x.id === id)
    if (!p) return
    setEditingProfileId(id)
    setLocalConfig({ ...p.config })
    setIsCustomProvider(!!p.config.provider && !ALL_PROVIDERS.some((pr) => pr.id === p.config.provider))
    setAvailableModels([])
    setShowModelDropdown(false)
    setApiView('edit')
  }, [apiProfiles])

  const handleBackToList = useCallback(() => {
    setApiView('list')
    setEditingProfileId(null)
  }, [])

  const handleSaveApi = useCallback(async () => {
    if (!localConfig.baseUrl.trim()) { showToast({ type: 'error', title: '请填写 Base URL' }); return }
    if (!localConfig.model.trim()) { showToast({ type: 'error', title: '请填写模型名称' }); return }
    const keyMissing = !localConfig.apiKey.trim()
    // Collect all models for this profile: fetched models + the current model
    const profileModels = [...new Set([localConfig.model, ...availableModels].filter(Boolean))]
    // Bind to current profile: update the active one, otherwise reuse a matching
    // profile or create a new named one.
    if (editingProfileId) {
      updateApiProfileConfig(editingProfileId, localConfig, profileModels)
      setActiveProfile(editingProfileId)
    } else {
      const dup = apiProfiles.find(
        (p) => p.config.baseUrl === localConfig.baseUrl && p.config.apiKey === localConfig.apiKey
      )
      if (dup) {
        // Same endpoint — merge models into existing profile
        const mergedModels = [...new Set([...(dup.models || []), ...profileModels])]
        updateApiProfileConfig(dup.id, localConfig, mergedModels)
        setActiveProfile(dup.id)
      } else {
        const name = localConfig.model ? `配置 · ${localConfig.model}` : `配置 ${apiProfiles.length + 1}`
        const id = addApiProfile(name, localConfig, profileModels)
        setActiveProfile(id)
      }
    }
    setApiConfig(localConfig)
    addApiHistory(localConfig)
    await persistToStorage()

    // Sync to Hermes if running in Electron
    if (isElectron()) {
      try {
        const cfg = {
          model: localConfig.model,
          provider: localConfig.provider && localConfig.provider !== '__custom__' ? localConfig.provider : 'custom',
          baseUrl: localConfig.baseUrl,
          apiKey: localConfig.apiKey,
        }
        await window.electron.hermes.setConfig(cfg)
        // Persist the active profile so the next cold start re-asserts it
        // into Hermes config.yaml (no hardcoded pin, free switching preserved).
        await window.electron.profile.cacheConfig(cfg)
        // Invalidate the cached session so the next prompt creates a fresh one
        // with the updated config. Without this, a stale session ID could be
        // reused against a restarted gateway, producing 401 errors.
        useHermesStore.getState().setHermesSessionId(null)
        showToast({ type: 'success', title: keyMissing ? '已保存并同步到 Hermes（复用其已配置密钥）' : 'API 配置已保存（已同步到 Hermes）' })
      } catch (err) {
        showToast({ type: 'warning', title: 'API 配置已保存（Hermes 同步失败）' })
      }
    } else {
      showToast({ type: 'success', title: 'API 配置已保存' })
    }
    setApiView('list')
  }, [localConfig, editingProfileId, apiProfiles, setApiConfig, addApiProfile, updateApiProfileConfig, setActiveProfile, addApiHistory, persistToStorage, showToast])

  const hasApiConfig = !!apiConfig.apiKey

  // ── MCP handlers ─────────────────────────────────────────────────────────
  const resetMcpForm = useCallback(() => {
    setMcpForm({ name: '', type: 'local', command: '', url: '', args: '', env: {}, envPassthrough: false, cwd: '~/Helix' })
  }, [])

  const handleSaveMcp = useCallback(async () => {
    const name = mcpForm.name.trim()
    if (!name) { showToast({ type: 'error', title: '请填写服务器名称' }); return }
    if (mcpForm.type === 'local' && !mcpForm.command.trim()) { showToast({ type: 'error', title: '请填写启动命令' }); return }
    if (mcpForm.type === 'remote' && !mcpForm.url.trim()) { showToast({ type: 'error', title: '请填写 URL' }); return }
    if (editingMcpName && editingMcpName !== name) removeMcpServer(editingMcpName)
    const cmdParts = [mcpForm.command.trim(), ...mcpForm.args.trim().split(/\s+/)].filter(Boolean)
    const config: McpServerConfig = {
      type: mcpForm.type, enabled: mcpServers[editingMcpName || name]?.enabled ?? true,
      ...(mcpForm.type === 'local' ? { command: cmdParts } : { url: mcpForm.url }),
      ...(Object.keys(mcpForm.env).length > 0 ? { environment: mcpForm.env } : {}),
      ...(mcpForm.cwd ? { cwd: mcpForm.cwd } : {}),
    }
    addMcpServer(name, config); await persistToStorage()
    showToast({ type: 'success', title: `服务器 "${name}" 已保存` })
    setEditingMcpName(null); setIsAddingMcp(false); resetMcpForm()
    // Refresh MCP status after save
    setTimeout(fetchMcpStatus, 1000)
  }, [mcpForm, editingMcpName, mcpServers, addMcpServer, removeMcpServer, persistToStorage, showToast, resetMcpForm, fetchMcpStatus])

  const handleEditMcp = useCallback((name: string) => {
    const config = mcpServers[name]; if (!config) return
    setEditingMcpName(name)
    const cmdParts = Array.isArray(config.command) ? config.command : (config.command ? [config.command] : [])
    setMcpForm({
      name, type: config.type,
      command: cmdParts[0] || '',
      url: config.url || '',
      args: cmdParts.slice(1).join(' '),
      env: config.environment || {},
      envPassthrough: (config as any).envPassthrough ?? false,
      cwd: config.cwd || '',
    })
  }, [mcpServers, setEditingMcpName])

  const handleDeleteMcp = useCallback(async (name: string) => {
    removeMcpServer(name); await persistToStorage(); showToast({ type: 'info', title: `服务器 "${name}" 已删除` })
  }, [removeMcpServer, persistToStorage, showToast])

  const handleToggleMcp = useCallback(async (name: string) => {
    toggleMcpServer(name); await persistToStorage()
  }, [toggleMcpServer, persistToStorage])

  const handleMcpFormChange = useCallback((patch: Partial<McpFormData>) => {
    setMcpForm(prev => ({ ...prev, ...patch }))
  }, [])

  // ── Archive handlers ──────────────────────────────────────────────────────
  const handleArchiveCurrent = useCallback(async () => {
    const state = useHelixStore.getState()
    if (state.chatMessages.length === 0) { showToast({ type: 'info', title: '当前没有对话内容' }); return }
    setArchiving(true)
    try {
      const collectFiles = (nodes: typeof state.files): PersistedSession['files'] =>
        nodes.map(n => ({ id: n.id, name: n.name, type: n.type, content: n.content, language: n.language, children: n.children ? collectFiles(n.children) : undefined }))
      const label = new Date().toLocaleString('zh-CN')
      await persistence.saveSession({
        label, workDir: state.selectedWorkDir, goal: state.goal, memories: state.memories, tasks: state.tasks,
        notes: state.notes, checkpoints: state.checkpoints,
        isArchived: true,
        chatMessages: state.chatMessages.map(m => ({ id: m.id, sessionId: 'session-' + Date.now(), role: m.role, content: m.content, timestamp: m.timestamp, isStreaming: m.isStreaming ?? false })),
        files: collectFiles(state.files),
        openTabs: state.openTabs.map(tab => ({
          id: tab.id, fileId: tab.fileId, name: tab.name, language: tab.language, isDirty: tab.isDirty,
        })),
      })
      showToast({ type: 'success', title: '已归档' }); await loadArchives()
    } catch { showToast({ type: 'error', title: '归档失败' }) } finally { setArchiving(false) }
  }, [showToast, loadArchives])

  const handleDeleteArchive = useCallback(async (id: string) => {
    await persistence.deleteSession(id); showToast({ type: 'success', title: '已删除' }); await loadArchives()
  }, [showToast, loadArchives])

  const handleLoadArchive = useCallback(async (sessionId: string) => {
    const sessions = await persistence.loadSessions()
    const session = sessions.find(s => s.id === sessionId)
    if (!session) { showToast({ type: 'error', title: '加载失败' }); return }
    const msgs = session.chatMessages.map(msg => ({
      id: msg.id,
      role: msg.role as 'user' | 'assistant' | 'system',
      content: msg.content,
      timestamp: msg.timestamp,
      reasoning: msg.reasoning,
      steps: msg.steps,
    }))
    useHelixStore.getState().clearExecutionFlow()
    useHelixStore.setState({
      chatMessages: msgs,
      selectedWorkDir: session.workDir || null,
    })
    useHelixStore.getState().setCurrentSessionId(session.id)
    pushNavigation({ type: 'chat', sessionId: session.id })
    await persistToStorage()
    showToast({ type: 'success', title: '已恢复', description: session.label })
  }, [showToast, persistToStorage])

  // ── Git handlers ─────────────────────────────────────────────────────────
  const handleSaveGit = useCallback(async () => {
    setGitSaving(true)
    try {
      await persistToStorage()
      showToast({ type: 'success', title: 'Git 设置已保存' })
    } finally {
      setGitSaving(false)
    }
  }, [persistToStorage, showToast])

  // ── Shared components ─────────────────────────────────────────────────────
  const SettingRow = ({ icon, label, description, children }: { icon: React.ReactNode; label: string; description: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between px-4 py-3.5 rounded-xl border border-border/50 bg-card/50 shadow-sm gap-3">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span className="text-muted-foreground shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground/70 mt-0.5">{description}</p>
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )


  const InputField = React.forwardRef<HTMLInputElement, {
    value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
    className?: string; prefix?: React.ReactNode; suffix?: React.ReactNode
  }>(({ value, onChange, placeholder, type = 'text', className = '', prefix, suffix }, ref) => (
    <div className={`flex items-center gap-0 bg-muted/50 border border-border/50 rounded-lg focus-within:ring-2 focus-within:ring-ring ${className}`}>
      {prefix && <span className="pl-3 text-muted-foreground">{prefix}</span>}
      <input
        ref={ref}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 px-3 py-2 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none font-mono"
      />
      {suffix && <span className="pr-3">{suffix}</span>}
    </div>
  ))
  InputField.displayName = 'InputField'

  // ── Render content ────────────────────────────────────────────────────────
  const renderContent = () => {
    switch (page) {
      case 'general':
        return (
          <div className="max-w-2xl space-y-8">
            <SectionTitle>常规</SectionTitle>

            <section className="space-y-3">
              {/* Output style */}
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('outputStyle') ? next.delete('outputStyle') : next.add('outputStyle')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <AlignLeft className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">输出风格</span>
                  </div>
                  {collapsedSections.has('outputStyle')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`p-4 space-y-3 ${collapsedSections.has('outputStyle') ? 'hidden' : ''}`}>
                  <p className="text-xs text-muted-foreground/70">
                    控制 Agent 回复的详细程度和风格
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { value: 'default', label: '默认', desc: '平衡详细度和简洁性' },
                      { value: 'concise', label: '简洁', desc: '精简回复，直奔主题' },
                      { value: 'detailed', label: '详细', desc: '包含更多解释和背景' },
                      { value: 'technical', label: '技术性', desc: '侧重技术细节和实现' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setOutputStyle(opt.value as typeof outputStyle)}
                        className={`p-3 rounded-lg border text-left transition-colors ${
                          outputStyle === opt.value
                            ? 'border-primary bg-primary/5 text-foreground'
                            : 'border-border/50 bg-card/50 hover:border-primary/30 text-foreground/70'
                        }`}
                      >
                        <p className="text-sm font-medium">{opt.label}</p>
                        <p className="text-xs text-muted-foreground/70 mt-0.5">{opt.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Auto compact */}
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('compact') ? next.delete('compact') : next.add('compact')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <Minimize2 className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">上下文管理</span>
                  </div>
                  {collapsedSections.has('compact')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`p-4 space-y-4 ${collapsedSections.has('compact') ? 'hidden' : ''}`}>
                  <SettingRow
                    icon={<Minimize2 className="size-4 text-muted-foreground" />}
                    label="自动压缩上下文"
                    description="当对话接近上下文限制时，自动压缩历史消息以释放空间"
                  >
                    <Toggle enabled={autoCompactContext} onToggle={() => setAutoCompactContext(!autoCompactContext)} />
                  </SettingRow>
                </div>
              </div>
            </section>

            {/* Notification settings */}
            <section className="space-y-3">
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('notification') ? next.delete('notification') : next.add('notification')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <Zap className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">通知设置</span>
                  </div>
                  {collapsedSections.has('notification')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`p-4 space-y-4 ${collapsedSections.has('notification') ? 'hidden' : ''}`}>
                  <SettingRow
                    icon={<Zap className="size-4 text-muted-foreground" />}
                    label="桌面通知"
                    description="Agent 完成任务时显示桌面通知"
                  >
                    <Toggle enabled={desktopNotifications} onToggle={() => setDesktopNotifications(!desktopNotifications)} />
                  </SettingRow>
                  <SettingRow
                    icon={<Zap className="size-4 text-muted-foreground" />}
                    label="提示音"
                    description="Agent 完成任务时播放提示音"
                  >
                    <Toggle enabled={soundEnabled} onToggle={() => setSoundEnabled(!soundEnabled)} />
                  </SettingRow>
                </div>
              </div>
            </section>

            {/* Startup behavior */}
            <section className="space-y-3">
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('startup') ? next.delete('startup') : next.add('startup')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <RefreshCw className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">启动行为</span>
                  </div>
                  {collapsedSections.has('startup')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`p-4 space-y-4 ${collapsedSections.has('startup') ? 'hidden' : ''}`}>
                  <SettingRow
                    icon={<RefreshCw className="size-4 text-muted-foreground" />}
                    label="恢复上次会话"
                    description="启动时自动恢复上次的对话"
                  >
                    <Toggle enabled={restoreLastSession} onToggle={() => setRestoreLastSession(!restoreLastSession)} />
                  </SettingRow>
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">默认工作目录</label>
                    <input
                      type="text"
                      value={defaultWorkDir}
                      onChange={e => setDefaultWorkDir(e.target.value)}
                      placeholder="留空使用上次的工作目录"
                      className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                    />
                  </div>
                </div>
              </div>
            </section>

            {/* Language settings */}
            <section className="space-y-3">
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('language') ? next.delete('language') : next.add('language')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <Globe className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">语言设置</span>
                  </div>
                  {collapsedSections.has('language')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`p-4 space-y-4 ${collapsedSections.has('language') ? 'hidden' : ''}`}>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { value: 'zh', label: '中文', desc: '界面显示中文' },
                      { value: 'en', label: 'English', desc: 'Display in English' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setLanguage(opt.value as typeof language)}
                        className={`p-3 rounded-lg border text-left transition-colors ${
                          language === opt.value
                            ? 'border-primary bg-primary/5 text-foreground'
                            : 'border-border/50 bg-card/50 hover:border-primary/30 text-foreground/70'
                        }`}
                      >
                        <p className="text-sm font-medium">{opt.label}</p>
                        <p className="text-xs text-muted-foreground/70 mt-0.5">{opt.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* Security settings */}
            <section className="space-y-3">
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('security') ? next.delete('security') : next.add('security')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">安全设置</span>
                  </div>
                  {collapsedSections.has('security')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`p-4 space-y-4 ${collapsedSections.has('security') ? 'hidden' : ''}`}>
                  <SettingRow
                    icon={<AlertTriangle className="size-4 text-muted-foreground" />}
                    label="危险操作确认"
                    description="执行删除、覆盖等危险操作前弹出确认对话框"
                  >
                    <Toggle enabled={confirmDangerousActions} onToggle={() => setConfirmDangerousActions(!confirmDangerousActions)} />
                  </SettingRow>
                  <SettingRow
                    icon={<Eye className="size-4 text-muted-foreground" />}
                    label="自动批准读取"
                    description="自动批准文件读取操作，无需逐次确认"
                  >
                    <Toggle enabled={autoApproveRead} onToggle={() => setAutoApproveRead(!autoApproveRead)} />
                  </SettingRow>
                </div>
              </div>
            </section>

            {/* Data management */}
            <section className="space-y-3">
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('data') ? next.delete('data') : next.add('data')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <Archive className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">数据管理</span>
                  </div>
                  {collapsedSections.has('data')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`p-4 space-y-4 ${collapsedSections.has('data') ? 'hidden' : ''}`}>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          const data = {
                            apiConfig,
                            apiProfiles,
                            activeProfileId,
                            providers,
                            activeModel,
                            fontFamily,
                            fontSize,
                            interfaceFont,
                            transcriptFontSize,
                            customInstructions,
                            mcpServers,
                            gitAutoCommit,
                            gitAutoPush,
                            gitPushConfirm,
                            gitAutoBranch,
                            gitRemoteUrl,
                            gitCommitTemplate,
                            gitBranchPrefix,
                          }
                          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = `helix-config-${new Date().toISOString().slice(0, 10)}.json`
                          a.click()
                          URL.revokeObjectURL(url)
                          showToast({ type: 'success', title: '配置已导出' })
                        } catch (e) {
                          showToast({ type: 'error', title: '导出失败' })
                        }
                      }}
                    >
                      导出配置
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const input = document.createElement('input')
                        input.type = 'file'
                        input.accept = '.json'
                        input.onchange = async (e) => {
                          const file = (e.target as HTMLInputElement).files?.[0]
                          if (!file) return
                          try {
                            const text = await file.text()
                            const data = JSON.parse(text)
                            if (data.apiConfig) setApiConfig(data.apiConfig)
                            if (data.fontFamily) setFontFamily(data.fontFamily)
                            if (data.fontSize) setFontSize(data.fontSize)
                            if (data.interfaceFont) setInterfaceFont(data.interfaceFont)
                            if (data.transcriptFontSize) setTranscriptFontSize(data.transcriptFontSize)
                            if (data.customInstructions) setCustomInstructions(data.customInstructions)
                            await persistToStorage()
                            showToast({ type: 'success', title: '配置已导入' })
                          } catch {
                            showToast({ type: 'error', title: '导入失败：文件格式无效' })
                          }
                        }
                        input.click()
                      }}
                    >
                      导入配置
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        if (confirm('确定要重置所有设置吗？此操作不可撤销。')) {
                          localStorage.clear()
                          window.location.reload()
                        }
                      }}
                    >
                      重置所有设置
                    </Button>
                  </div>
                </div>
              </div>
            </section>


          </div>
        )

      case 'appearance':
        return (
          <div className="max-w-2xl space-y-8">
            <SectionTitle>外观</SectionTitle>

            <section className="space-y-4">
              <SettingRow
                icon={theme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
                label="主题"
                description={theme === 'dark' ? '深色模式' : '浅色模式'}
              >
                <Toggle enabled={theme === 'dark'} onToggle={onToggleTheme} />
              </SettingRow>

              {/* Editor settings */}
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('editor') ? next.delete('editor') : next.add('editor')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <FileText className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">编辑器设置</span>
                  </div>
                  {collapsedSections.has('editor')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`divide-y divide-border ${collapsedSections.has('editor') ? 'hidden' : ''}`}>
                  <div className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-foreground">代码字体</p>
                        <p className="text-xs text-muted-foreground/70 mt-0.5">代码编辑器字体</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}
                        className="flex-1 px-3 py-2 rounded-lg border border-border/50 bg-card text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer appearance-none bg-[length:14px] bg-[right_10px_center] bg-no-repeat"
                        style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")` }}>
                        {[
                          { label: '默认', value: "'Geist Mono', 'Fira Code', 'Consolas', monospace" },
                          { label: 'Monaco', value: 'Monaco, monospace' },
                          { label: 'JetBrains Mono', value: '"JetBrains Mono", monospace' },
                          { label: 'Fira Code', value: '"Fira Code", monospace' },
                          { label: 'Consolas', value: 'Consolas, monospace' },
                          { label: 'SF Mono', value: '"SF Mono", monospace' },
                        ].map(f => (
                          <option key={f.value} value={f.value}>{f.label}</option>
                        ))}
                      </select>
                      <input type="text" value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}
                        placeholder="自定义"
                        className="w-28 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
                    </div>
                    <div className="flex items-center justify-between pt-2">
                      <p className="text-sm text-foreground">编辑器字号</p>
                      <div className="flex items-center gap-2">
                        <button onClick={() => setFontSize(Math.max(10, fontSize - 1))}
                          className="w-7 h-7 rounded-md bg-muted/50 border border-border/50 text-muted-foreground/60 hover:text-foreground transition-colors text-sm flex items-center justify-center">−</button>
                        <span className="w-8 text-center text-sm font-mono text-foreground">{fontSize}</span>
                        <button onClick={() => setFontSize(Math.min(32, fontSize + 1))}
                          className="w-7 h-7 rounded-md bg-muted/50 border border-border/50 text-muted-foreground/60 hover:text-foreground transition-colors text-sm flex items-center justify-center">+</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Interface settings */}
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('interface') ? next.delete('interface') : next.add('interface')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <Settings className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">界面设置</span>
                  </div>
                  {collapsedSections.has('interface')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`divide-y divide-border ${collapsedSections.has('interface') ? 'hidden' : ''}`}>
                  <div className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-foreground">界面字体</p>
                        <p className="text-xs text-muted-foreground/70 mt-0.5">菜单、侧边栏和聊天的字体</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <select value={interfaceFont} onChange={(e) => setInterfaceFont(e.target.value)}
                        className="flex-1 px-3 py-2 rounded-lg border border-border/50 bg-card text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer appearance-none bg-[length:14px] bg-[right_10px_center] bg-no-repeat"
                        style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")` }}>
                        {[
                          { label: '默认', value: 'var(--font-geist-sans)' },
                          { label: 'Inter', value: '"Inter", sans-serif' },
                          { label: 'SF Pro', value: '"-apple-system", "SF Pro", sans-serif' },
                          { label: 'Segoe UI', value: '"Segoe UI", sans-serif' },
                          { label: 'Monaco', value: 'Monaco, monospace' },
                          { label: 'JetBrains Mono', value: '"JetBrains Mono", monospace' },
                          { label: 'Consolas', value: 'Consolas, monospace' },
                        ].map(f => (
                          <option key={f.value} value={f.value}>{f.label}</option>
                        ))}
                      </select>
                      <input type="text" value={interfaceFont} onChange={(e) => setInterfaceFont(e.target.value)}
                        placeholder="自定义"
                        className="w-28 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
                    </div>
                    <div className="flex items-center justify-between pt-2">
                      <p className="text-sm text-foreground">界面字号</p>
                      <div className="flex items-center gap-2">
                        <button onClick={() => setTranscriptFontSize(Math.max(10, transcriptFontSize - 1))}
                          className="w-7 h-7 rounded-md bg-muted/50 border border-border/50 text-muted-foreground/60 hover:text-foreground transition-colors text-sm flex items-center justify-center">−</button>
                        <span className="w-8 text-center text-sm font-mono text-foreground">{transcriptFontSize}</span>
                        <button onClick={() => setTranscriptFontSize(Math.min(28, transcriptFontSize + 1))}
                          className="w-7 h-7 rounded-md bg-muted/50 border border-border/50 text-muted-foreground/60 hover:text-foreground transition-colors text-sm flex items-center justify-center">+</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )

      case 'api':
        return (
          <div className="space-y-6">
            {/* Title bar — always visible */}
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-foreground">模型</h3>
              {!showAddModelModal ? (
                <button
                  onClick={() => setShowAddModelModal(true)}
                  className="flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  <Plus className="size-4" /> 添加模型
                </button>
              ) : (
                <button
                  onClick={() => setShowAddModelModal(false)}
                  className="p-1.5 text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
                  title="关闭"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>

            {!showAddModelModal ? (
              /* History list view */
              <div className="max-w-2xl space-y-6">
                {apiHistory.length > 0 ? (
                  <div className="space-y-1.5">
                    {apiHistory.map((h, i) => {
                      const isActive = apiConfig.model === h.model
                      return (
                        <div
                          key={i}
                          onClick={async () => {
                            setLocalConfig({ ...h })
                            setApiConfig({ ...h })
                            setActiveModel(h.model)
                            await persistToStorage()
                            if (isElectron()) {
                              try {
                                const cfg = { model: h.model, provider: h.provider && h.provider !== '__custom__' ? h.provider : 'custom', baseUrl: h.baseUrl, apiKey: h.apiKey }
                                await window.electron.hermes.setConfig(cfg)
                                await window.electron.profile.cacheConfig(cfg)
                                useHermesStore.getState().setHermesSessionId(null)
                              } catch (e) {}
                            }
                            showToast({ type: 'success', title: `已切换到 ${h.model}` })
                          }}
                          className={`flex items-center justify-between px-3.5 py-2.5 rounded-lg cursor-pointer transition-colors group ${isActive ? 'bg-primary/10 ring-1 ring-primary/30' : 'bg-card/50 hover:bg-card'}`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              {isActive && <span className="size-1.5 rounded-full bg-primary shrink-0" />}
                              <p className={`text-sm truncate ${isActive ? 'font-semibold text-primary' : 'font-medium text-foreground'}`}>{h.model}</p>
                            </div>
                            <p className="text-xs text-muted-foreground/70 truncate mt-0.5">{h.baseUrl}</p>
                          </div>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                            <button onClick={(e) => { e.stopPropagation(); setLocalConfig({ ...h }); setShowAddModelModal(true) }}
                              className="ml-2 p-1 rounded text-muted-foreground/20 hover:text-foreground hover:bg-accent transition-all">
                              <Pencil className="size-3.5" />
                            </button>
                            <button onClick={async (e) => { e.stopPropagation(); removeApiHistory(i); await persistToStorage() }}
                              className="ml-1 p-1 rounded text-muted-foreground/20 hover:text-red-500 transition-all">
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="text-center py-12 text-sm text-muted-foreground/50">
                    暂无配置，点击右上角「添加模型」
                  </div>
                )}
                <ModelUsageStats />
              </div>
            ) : (
              /* Add model form — normal flow, centered card */
              <div className="flex justify-center py-4">
                <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm p-6 space-y-5 w-full max-w-2xl">
                  {/* Provider */}
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">Provider</label>
                    {!isCustomProvider ? (
                      <select
                        value={localConfig.provider}
                        onChange={(e) => handleSelectProvider(e.target.value)}
                        className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer appearance-none bg-[length:14px] bg-[right_10px_center] bg-no-repeat"
                        style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")` }}
                      >
                        <option value="">请选择 Provider</option>
                        {ALL_PROVIDERS.map(p => (
                          <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                        ))}
                        <option value={CUSTOM_PROVIDER_ID}>＋ 自定义</option>
                      </select>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={localConfig.provider}
                          onChange={(e) => handleCustomProviderChange(e.target.value)}
                          onFocus={() => setCustomInputFocused(true)}
                          onBlur={handleBlurCustomInput}
                          placeholder="输入 Provider 名称"
                          className="flex-1 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={() => { setIsCustomProvider(false); setCustomInputFocused(false) }}
                          className="px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-foreground hover:bg-accent/50 transition-colors"
                          title="返回列表"
                        >
                          <ChevronLeft className="size-4" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Base URL */}
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">Base URL</label>
                    <input
                      type="text"
                      value={localConfig.baseUrl}
                      onChange={(e) => setLocalConfig(prev => ({ ...prev, baseUrl: e.target.value }))}
                      placeholder="https://api.openai.com/v1"
                      className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                    />
                  </div>

                  {/* API Key */}
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">API Key</label>
                    <div className="relative">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        value={localConfig.apiKey}
                        onChange={(e) => setLocalConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                        placeholder="sk-..."
                        className="w-full px-3 py-2 pr-10 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground/50 hover:text-foreground transition-colors"
                      >
                        {showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Model */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-sm font-medium text-foreground">模型名称</label>
                      <button
                        type="button"
                        onClick={handleFetchModels}
                        disabled={isLoadingModels}
                        className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 disabled:text-muted-foreground transition-colors"
                      >
                        <RefreshCw className={`size-3 ${isLoadingModels ? 'animate-spin' : ''}`} />
                        {isLoadingModels ? '获取中...' : '获取模型列表'}
                      </button>
                    </div>
                    {availableModels.length > 0 ? (
                      <div className="relative" ref={modelDropdownRef}>
                        <button
                          type="button"
                          onClick={() => setShowModelDropdown(!showModelDropdown)}
                          className="w-full flex items-center justify-between px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground hover:bg-accent/50 transition-colors font-mono"
                        >
                          <span>{localConfig.model || '选择模型'}</span>
                          <svg className={`size-4 text-muted-foreground transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                        </button>
                        {showModelDropdown && (
                          <div className="absolute bottom-full left-0 right-0 mb-1 max-h-48 overflow-y-auto bg-card border border-border/50 rounded-lg shadow-lg z-50 p-1">
                            {availableModels.map(model => (
                              <button
                                key={model}
                                type="button"
                                onClick={() => { setLocalConfig(prev => ({ ...prev, model })); setShowModelDropdown(false) }}
                                className={`w-full text-left px-3 py-2 rounded-md text-sm font-mono transition-colors ${
                                  localConfig.model === model
                                    ? 'bg-primary/10 text-primary'
                                    : 'text-foreground/70 hover:bg-muted'
                                }`}
                              >
                                {model}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={localConfig.model}
                        onChange={(e) => setLocalConfig(prev => ({ ...prev, model: e.target.value }))}
                        placeholder="gpt-4o-mini"
                        className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                      />
                    )}
                  </div>

                  {/* Save button — inside card, bottom-right */}
                  <div className="flex justify-end pt-2">
                    <Button onClick={async () => { await handleSaveApi(); setShowAddModelModal(false) }} size="sm" className="gap-1.5">
                      <Save className="size-3.5" /> 保存
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )

      case 'shortcuts':
        return (
          <div className="max-w-2xl">
            <ShortcutsPage />
          </div>
        )

      case 'mcp':
        return (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-foreground">MCP</h3>
              {!isAddingMcp && !editingMcpName ? (
                <button
                  onClick={() => { setIsAddingMcp(true); resetMcpForm() }}
                  className="flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  <Plus className="size-4" /> 添加服务器
                </button>
              ) : (
                <button
                  onClick={() => { setIsAddingMcp(false); setEditingMcpName(null); resetMcpForm() }}
                  className="p-1.5 text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
                  title="关闭"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>

            {!isAddingMcp && !editingMcpName ? (
              <>
                {/* Server list */}
                <div className="max-w-2xl space-y-2">
                  {mcpServerNames.map(name => {
                    const config = mcpServers[name]
                    const connected = mcpStatus[name]
                    return (
                      <div
                        key={name}
                        className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border/50 bg-card/50 shadow-sm hover:border-primary/20 transition-colors group">
                        <div className="relative shrink-0">
                          <div className={`w-2.5 h-2.5 rounded-full ${config.enabled === false ? 'bg-gray-300' : connected ? 'bg-green-500' : connected === false ? 'bg-red-400' : 'bg-amber-400'}`} />
                          {config.enabled !== false && connected && (
                            <span className="absolute inset-0 w-2.5 h-2.5 rounded-full bg-green-500 animate-ping opacity-30" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">{name}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${config.type === 'local' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'}`}>
                              {config.type === 'local' ? '本地' : '远程'}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground/70 font-mono truncate mt-0.5">
                            {config.type === 'local' ? config.command?.join(' ') : config.url}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Toggle enabled={config.enabled !== false} onToggle={() => handleToggleMcp(name)} />
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                            <button onClick={() => handleEditMcp(name)} className="p-1.5 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-colors">
                              <Pencil className="size-3.5" />
                            </button>
                            <button onClick={() => handleDeleteMcp(name)} className="p-1.5 rounded-md text-muted-foreground/40 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {mcpServerNames.length === 0 && (
                  <div className="max-w-2xl flex flex-col items-center justify-center py-12 text-center">
                    <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mb-3">
                      <Plug className="size-6 text-muted-foreground/40" />
                    </div>
                    <p className="text-sm font-medium text-foreground/60">暂无 MCP 服务器</p>
                    <p className="text-xs text-muted-foreground/40 mt-1">添加服务器以扩展 AI 能力</p>
                    <button onClick={() => { setIsAddingMcp(true); resetMcpForm() }}
                      className="mt-4 flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80 transition-colors">
                      <Plus className="size-4" /> 添加第一个服务器
                    </button>
                  </div>
                )}
              </>
            ) : (
              /* Editor — centered card, similar to model add */
              <div className="flex justify-center py-4">
                <div className="w-full max-w-2xl">
                  <McpEditorForm
                    form={mcpForm}
                    onChange={handleMcpFormChange}
                    onSave={handleSaveMcp}
                    onCancel={() => { setIsAddingMcp(false); setEditingMcpName(null); resetMcpForm() }}
                  />
                </div>
              </div>
            )}
          </div>
        )

      case 'archive':
        return (
          <div className="max-w-2xl space-y-6">
            <SectionTitle>历史归档</SectionTitle>

            {archives.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mb-3">
                  <Archive className="size-6 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium text-foreground/60">暂无归档记录</p>
                <p className="text-xs text-muted-foreground/40 mt-1">会话归档后可随时恢复</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                  {archives.map(a => (
                    <div key={a.id}
                      onClick={() => handleLoadArchive(a.id)}
                      className="flex items-center justify-between px-4 py-3 rounded-xl border border-border/50 bg-card/50 shadow-sm hover:border-primary/30 hover:bg-accent/30 transition-colors group cursor-pointer">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{a.label}</p>
                        <p className="text-xs text-muted-foreground/70 mt-0.5">{a.messageCount} 条消息</p>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); handleDeleteArchive(a.id) }}
                        className="p-1.5 rounded-md text-muted-foreground/20 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )

      case 'git':
        return (
          <div className="max-w-2xl space-y-6">
            <SectionTitle>Git</SectionTitle>

            <section className="space-y-4">
              {/* Auto-commit */}
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('commit') ? next.delete('commit') : next.add('commit')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <GitCommit className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">自动提交</span>
                  </div>
                  {collapsedSections.has('commit')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`p-4 space-y-4 ${collapsedSections.has('commit') ? 'hidden' : ''}`}>
                  <SettingRow
                    icon={<GitCommit className="size-4 text-muted-foreground" />}
                    label="Agent 完成后自动 commit"
                    description="Agent 完成所有任务后，自动将变更提交到当前分支"
                  >
                    <Toggle enabled={gitAutoCommit} onToggle={() => setGitAutoCommit(!gitAutoCommit)} />
                  </SettingRow>

                  {gitAutoCommit && (
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1.5">自动提交信息模板</label>
                      <input
                        type="text"
                        value={gitCommitTemplate}
                        onChange={e => setGitCommitTemplate(e.target.value)}
                        placeholder="如: chore: auto-commit changes"
                        className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                      />
                      <p className="text-xs text-muted-foreground/50 mt-1">
                        {gitCommitTemplate || 'chore: auto-commit'}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Auto-push */}
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('push') ? next.delete('push') : next.add('push')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <GitPullRequest className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">自动推送</span>
                  </div>
                  {collapsedSections.has('push')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`p-4 space-y-4 ${collapsedSections.has('push') ? 'hidden' : ''}`}>
                  <SettingRow
                    icon={<GitPullRequest className="size-4 text-muted-foreground" />}
                    label="Commit 后自动 push"
                    description="自动提交后推送到远程仓库"
                  >
                    <Toggle enabled={gitAutoPush} onToggle={() => setGitAutoPush(!gitAutoPush)} />
                  </SettingRow>

                  {gitAutoPush && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-foreground mb-1.5">远程仓库 URL</label>
                        <input
                          type="text"
                          value={gitRemoteUrl}
                          onChange={e => setGitRemoteUrl(e.target.value)}
                          placeholder="https://github.com/user/repo.git"
                          className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                        />
                      </div>

                      <SettingRow
                        icon={<Terminal className="size-4 text-muted-foreground" />}
                        label="Push 前确认"
                        description="推送前弹出确认对话框"
                      >
                        <Toggle enabled={gitPushConfirm} onToggle={() => setGitPushConfirm(!gitPushConfirm)} />
                      </SettingRow>
                    </>
                  )}
                </div>
              </div>

              {/* Branch settings */}
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('branch') ? next.delete('branch') : next.add('branch')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <GitBranch className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">分支管理</span>
                  </div>
                  {collapsedSections.has('branch')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`p-4 space-y-4 ${collapsedSections.has('branch') ? 'hidden' : ''}`}>
                  <SettingRow
                    icon={<GitBranch className="size-4 text-muted-foreground" />}
                    label="自动创建特性分支"
                    description="Agent 开始时自动创建基于当前分支的特性分支"
                  >
                    <Toggle enabled={gitAutoBranch} onToggle={() => setGitAutoBranch(!gitAutoBranch)} />
                  </SettingRow>

                  {gitAutoBranch && (
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1.5">分支命名前缀</label>
                      <input
                        type="text"
                        value={gitBranchPrefix}
                        onChange={e => setGitBranchPrefix(e.target.value)}
                        placeholder="feature/"
                        className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Save */}
              <div className="flex justify-end pt-2">
                <Button onClick={handleSaveGit} size="sm" className="gap-1.5" disabled={gitSaving}>
                  {gitSaving
                    ? <><Loader2 className="size-3.5 animate-spin" /> 保存中…</>
                    : <><Save className="size-3.5" /> 保存设置</>}
                </Button>
              </div>
            </section>
          </div>
        )

      case 'usage':
        return (
          <div className="max-w-2xl space-y-6">
            <SectionTitle>Token 用量</SectionTitle>
            <TokenUsagePanel />
          </div>
        )

      case 'hook':
        return <HookSettings />

      case 'help':
        return (
          <div className="max-w-2xl space-y-8">
            <SectionTitle>帮助</SectionTitle>

            {/* About */}
            <section className="space-y-3">
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('about') ? next.delete('about') : next.add('about')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <Settings className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">关于</span>
                  </div>
                  {collapsedSections.has('about')
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </button>
                <div className={`p-4 space-y-4 ${collapsedSections.has('about') ? 'hidden' : ''}`}>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">版本</span>
                      <span className="text-sm font-mono text-foreground">v0.2.0</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">许可证</span>
                      <span className="text-sm text-foreground">MIT License</span>
                    </div>
                  </div>
                  <div className="pt-2 border-t border-border/50">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        window.open('https://github.com/helix-ai/helix', '_blank')
                      }}
                    >
                      访问 GitHub
                    </Button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )

    }
  }

  return (
    <div className="fixed top-10 left-0 right-0 bottom-0 z-50 flex bg-background">
      {/* Left nav — width synced with the main sidebar */}
      {showSidebar && (
        <div
          className={`relative bg-sidebar flex flex-col shrink-0 border-r border-border/40 h-full overflow-hidden ${isResizing ? '' : 'transition-[width] duration-200 ease-out'}`}
          style={{ width: sidebarCollapsed ? 48 : navWidth }}
        >
          {sidebarCollapsed ? (
            <div className="flex-1 flex flex-col items-center pt-2 gap-1 overflow-y-auto">
              <button
                onClick={() => useHelixStore.getState().toggleSettings()}
                title="返回"
                className="p-2.5 rounded-lg text-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                <ChevronLeft className="size-[18px]" />
              </button>
              {NAV_GROUPS.flatMap(group => group.items).map(item => (
                <button
                  key={item.id}
                  onClick={() => {
                    setPage(item.id)
                    pushNavigation({ type: 'settings', page: item.id })
                  }}
                  title={item.label}
                  className={`p-2.5 rounded-lg transition-colors ${
                    page === item.id
                      ? 'bg-muted text-foreground'
                      : 'text-foreground/60 hover:text-foreground hover:bg-muted/50'
                  }`}
                >
                  <item.icon className="size-[18px]" />
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="px-4 py-2 space-y-2">
                <button
                  onClick={() => useHelixStore.getState().toggleSettings()}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-foreground/60 hover:text-foreground hover:bg-muted/80 rounded-xl transition-colors"
                >
                  <ChevronLeft className="size-4" />
                  返回
                </button>
                <div className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg border border-border/50 bg-transparent">
                  <Search className="size-3.5 text-muted-foreground/25 shrink-0" />
                  <input ref={navSearchRef} value={navSearch} onChange={e => setNavSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') { setNavSearch(''); (e.target as HTMLInputElement).blur() } }}
                    placeholder="搜索设置..." className="flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none min-w-0" />
                  {navSearch && <button onClick={() => setNavSearch('')} className="text-muted-foreground/20 hover:text-foreground/60 shrink-0"><X className="size-3" /></button>}
                </div>
              </div>
              {(() => {
                const q = navSearch.trim().toLowerCase()
                if (!q) {
                  return (
                    <nav className="flex-1 overflow-y-auto py-2">
                      {NAV_GROUPS.map(group => (
                        <div key={group.title} className="mb-3">
                          <p className="px-5 py-1.5 text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-[0.12em] select-none">{group.title}</p>
                          {group.items.map(item => (
                            <button key={item.id} onClick={() => { setPage(item.id); pushNavigation({ type: 'settings', page: item.id }) }}
                              title={item.label}
                              className={`flex items-center gap-3 w-full px-5 py-2 text-sm transition-colors ${page === item.id ? 'text-primary bg-muted/60 font-medium' : 'text-foreground/70 hover:text-foreground hover:bg-muted/40'}`}>
                              <item.icon className="size-4 shrink-0" />
                              <span>{item.label}</span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </nav>
                  )
                }
                const searchHits = SETTINGS_SEARCH_INDEX.filter(x => x.label.includes(q) || x.desc.includes(q) || x.page.includes(q))
                if (!searchHits.length) return <div className="px-5 py-8 text-center text-[13px] text-muted-foreground/40">未找到匹配项</div>
                const seen = new Set<string>()
                const uniqueHits = searchHits.filter(h => { if (seen.has(h.page)) return false; seen.add(h.page); return true })
                return (
                  <nav className="flex-1 overflow-y-auto py-2">
                    {uniqueHits.map((hit, idx) => {
                      const navItem = NAV_GROUPS.flatMap(g => g.items).find(i => i.id === hit.page)
                      return (
                        <button key={hit.page + idx} onClick={() => { setPage(hit.page); pushNavigation({ type: 'settings', page: hit.page }); setNavSearch('') }}
                          className={`flex flex-col items-start gap-0.5 w-full px-5 py-2.5 text-left transition-colors rounded-lg mx-2 mb-1 ${
                            page === hit.page ? 'bg-muted/60' : 'hover:bg-muted/30'
                          }`}>
                          <div className="flex items-center gap-2.5">
                            {navItem?.icon && React.createElement(navItem.icon, { className: 'size-4 shrink-0 text-muted-foreground/50' })}
                            <span className="text-sm font-medium text-foreground">{hit.label}</span>
                          </div>
                          <span className="text-xs text-muted-foreground/50 pl-6.5">{hit.desc}</span>
                        </button>
                      )
                    })}
                  </nav>
                )})()}
            </>
          )}

        {/* Resize handle — drag to resize the settings nav (also resizes the
            main sidebar, since they share one width). */}
        {!sidebarCollapsed && (
          <div
            className={`absolute top-0 -right-1 w-2 h-full cursor-col-resize z-30 group ${
              isResizing ? 'bg-primary/20' : ''
            }`}
            onMouseDown={startNavResize}
          >
            <div className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 transition-colors ${
              isResizing ? 'bg-primary/40' : 'bg-transparent group-hover:bg-border/40'
            }`} />
          </div>
        )}
      </div>
      )}

      {/* Right content */}
      <div className="flex-1 bg-background overflow-y-auto relative">
        <div className={`px-8 pt-4 pb-8 ${sidebarCollapsed ? 'max-w-3xl mx-auto' : ''}`}>
          {renderContent()}
        </div>
      </div>
    </div>
  )
}
