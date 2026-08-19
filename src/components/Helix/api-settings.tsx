'use client'

import {
  Settings, Sun, Plug, Archive, ChevronLeft, Search,
  X,
  Globe, Keyboard, GitBranch, Zap, Brain, Bot, Activity, Workflow,
  MessageSquare,
} from 'lucide-react'
import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { useHermes } from '@/hooks/use-hermes'
import { pushModelConfig } from '@/lib/config-sync'
import { isElectron, hermesApi, electronFS, electronDialog, electronApp } from '@/lib/electron-bridge'
import { getCurrentVersion } from '@/hooks/use-check-update'
import { persistence } from '@/lib/persist'
import { getAllProviders, getBaseUrl } from '@/lib/providers'
import { useHelixStore, type ApiConfig, type BrowserBookmark } from '@/stores/helix-store'
import { useHermesStore } from '@/stores/hermes-store'
import { AgentsSettings } from './agents-settings'
import { AppearanceSettingsPanel } from './appearance-settings-panel'
import { GeneralSettingsPanel } from './general-settings-panel'
import { GitSettingsPanel } from './git-settings-panel'
import { HookSettings } from './hook-settings'
import { LearningView } from './learning-view'
import { MemorySettings } from './memory-settings'
import { McpEditorForm, type McpFormData } from './mcp-editor-form'
import { ShortcutsPage } from './shortcuts-page'
import { ModelUsageStats, UsageSummary, UsageDetail, TokenUsagePanel } from './usage-stats'
import { PopupSelect, SettingGroup } from './settings-ui'
import { WebSearchSettings } from './web-search-settings'
import { VisionModelSettings } from './vision-model-settings'

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-2 mb-4 ${className || ''}`}>
      <h3 className="ui-title font-semibold text-foreground">{children}</h3>
    </div>
  )
}

// ── Chrome bookmark import ──────────────────────────────────────────────────────
function parseChromeBookmarks(content: string): BrowserBookmark[] {
  try {
    const data = JSON.parse(content)
    const bar = (data?.roots?.bookmark_bar?.children ?? []) as any[]
    const norm = (n: any): BrowserBookmark | null => {
      if (!n) return null
      if (n.type === 'url') return { name: String(n.name ?? ''), type: 'url', url: String(n.url ?? '') }
      if (n.type === 'folder') return { name: String(n.name ?? ''), type: 'folder', children: (n.children ?? []).map(norm).filter(Boolean) as BrowserBookmark[] }
      return null
    }
    return bar.map(norm).filter(Boolean) as BrowserBookmark[]
  } catch {
    return []
  }
}

// Chrome's default User Data directory on this machine. Used as both the first
// auto-detect path and the directory picker's starting location.
const CHROME_DEFAULT_DIR = 'C:/Users/hyt/AppData/Local/Google/Chrome/User Data/Default'

async function tryReadBookmarks(dir: string): Promise<string | null> {
  if (typeof window === 'undefined' || !window.electron?.hermesSkills) return null
  for (const cand of [`${dir}/Bookmarks`, `${dir}/Default/Bookmarks`]) {
    const c = await window.electron.hermesSkills.readFile(cand)
    if (c) return c
  }
  return null
}

async function importChromeBookmarks(): Promise<void> {
  const toast = useHelixStore.getState().showToast
  try {
    // 1. Try the default path without a dialog (most users have it there).
    let content = await tryReadBookmarks(CHROME_DEFAULT_DIR)
    // 2. Otherwise let the user pick the Chrome "Default" or "User Data" dir.
    if (!content) {
      const picked = await electronDialog.openDirectory(CHROME_DEFAULT_DIR)
      if (!picked) return // user cancelled
      content = await tryReadBookmarks(picked)
    }
    if (!content) {
      toast({ type: 'warning', title: '未找到书签', description: '该目录中未发现 Chrome 的 Bookmarks 文件' })
      return
    }
    const items = parseChromeBookmarks(content)
    if (items.length === 0) {
      toast({ type: 'warning', title: '没有可导入的书签', description: '书签栏为空' })
      return
    }
    useHelixStore.getState().setBrowserBookmarks(items)
    toast({ type: 'success', title: '已导入书签', description: `从 Chrome 导入了 ${items.length} 个书签项` })
  } catch (e: any) {
    toast({ type: 'error', title: '导入失败', description: String(e?.message ?? e) })
  }
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

/** Derive a readable provider name from its base URL instead of the legacy
 *  "配置 · <model>" pattern, which becomes meaningless once a profile accumulates
 *  models from multiple endpoints. */
function deriveProviderName(baseUrl?: string, fallback?: string): string {
  if (!baseUrl) return fallback || '配置'
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (/ant-ling|agnes|ant-/.test(host)) return 'Ling'
    if (host.includes('deepseek')) return 'DeepSeek'
    if (host.includes('openai')) return 'OpenAI'
    if (host.includes('anthropic')) return 'Anthropic'
    if (host.includes('google')) return 'Gemini'
    return host.replace(/^www\./, '') || fallback || '配置'
  } catch {
    return fallback || '配置'
  }
}

interface SettingsProps {
  themeStyle: string
  onSelectThemeStyle: (styleId: string) => void
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

type SettingsPage = 'general' | 'appearance' | 'api' | 'shortcuts' | 'mcp' | 'archive' | 'browser' | 'git' | 'skills' | 'hook' | 'usage' | 'help' | 'agents' | 'learning' | 'channels'

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
      { id: 'learning', label: '记忆', icon: Brain },
      { id: 'shortcuts', label: '快捷键', icon: Keyboard },
    ],
  },
  {
    title: '配置',
    items: [
      { id: 'api', label: '模型', icon: Globe },
      { id: 'mcp', label: 'MCP', icon: Plug },
      { id: 'usage', label: '用量', icon: Activity },
      { id: 'agents', label: 'Subagent', icon: Bot },
    ],
  },
   {
    title: '集成',
    items: [
      { id: 'channels', label: 'Channels', icon: MessageSquare },
      { id: 'git', label: 'Git', icon: GitBranch },
      { id: 'hook', label: 'Hooks', icon: Workflow },
      { id: 'browser', label: '浏览器', icon: Globe },
      { id: 'archive', label: '历史归档', icon: Archive },
    ],
  },
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

// ─── Channels settings ──────────────────────────────────────────────────────
interface ChannelConfig {
  id: string
  name: string
  description: string
  enabled: boolean
  config: Record<string, string>
  envKeys?: string[]
}

function ChannelsSettings() {
  const showToast = useHelixStore(s => s.showToast)
  const [channels, setChannels] = useState<ChannelConfig[]>([])
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null)
  const [savingChannels, setSavingChannels] = useState(false)

  // Load from .env via Tauri or fallback to localStorage
  useEffect(() => {
    const loadChannels = async () => {
      if (isElectron()) {
        try {
          const api = (window as any).electron?.channels
          if (!api?.list) return
          const result = await api.list()
          if (result?.ok && result.channels) {
            setChannels(result.channels)
            return
          }
        } catch (e) {
          console.error('[ChannelsSettings] Failed to load from Tauri:', e)
        }
      }
      // Fallback to localStorage
      try {
        const saved = localStorage.getItem('helix-channels')
        if (saved) {
          const data = JSON.parse(saved)
          if (data.channels) setChannels(data.channels)
        }
      } catch {}
    }
    loadChannels()
  }, [])

  const handleToggle = (id: string) => {
    setChannels(prev => prev.map(ch => ch.id === id ? { ...ch, enabled: !ch.enabled } : ch))
  }

  const handleConfigChange = (id: string, key: string, value: string) => {
    setChannels(prev => prev.map(ch => ch.id === id ? { ...ch, config: { ...ch.config, [key]: value } } : ch))
  }

  const addChannel = () => {
    const id = `ch_${Date.now()}`
    setChannels(prev => [...prev, { id, name: 'New Channel', description: '', enabled: false, config: {}, envKeys: [] }])
  }

  const removeChannel = async (id: string) => {
    const remaining = channels.filter(ch => ch.id !== id)
    setChannels(remaining)
    if (expandedChannel === id) setExpandedChannel(null)
    // 立即持久化删除——否则重进设置页会从 channels.json 读回旧数据（"过一会又回来"）。
    try {
      await persistChannels(remaining)
      showToast({ type: 'success', title: '渠道已删除' })
    } catch {
      showToast({ type: 'error', title: '删除保存失败' })
    }
  }

  const updateChannelMeta = (id: string, patch: Partial<Pick<ChannelConfig, 'name' | 'description'>>) => {
    setChannels(prev => prev.map(ch => ch.id === id ? { ...ch, ...patch } : ch))
  }

  const renameConfigKey = (id: string, oldKey: string, newKey: string) => {
    const key = newKey.trim()
    if (!key || key === oldKey) return
    setChannels(prev => prev.map(ch => {
      if (ch.id !== id) return ch
      const config: Record<string, string> = {}
      for (const [k, v] of Object.entries(ch.config)) config[k === oldKey ? key : k] = v
      return { ...ch, config, envKeys: Object.keys(config) }
    }))
  }

  const addConfigKey = (id: string) => {
    setChannels(prev => prev.map(ch => {
      if (ch.id !== id) return ch
      const key = `NEW_KEY_${Object.keys(ch.config).length + 1}`
      return { ...ch, config: { ...ch.config, [key]: '' }, envKeys: [...Object.keys(ch.config), key] }
    }))
  }

  const removeConfigKey = (id: string, key: string) => {
    setChannels(prev => prev.map(ch => {
      if (ch.id !== id) return ch
      const config = { ...ch.config }
      delete config[key]
      return { ...ch, config, envKeys: Object.keys(config) }
    }))
  }

  // 持久化给定的渠道列表（删除/添加/编辑后即时调用，避免重进设置页时从
  // channels.json 读回旧数据——"删除过一会又回来"的根因）。
  const persistChannels = async (list: ChannelConfig[]) => {
    setSavingChannels(true)
    try {
      // Ensure envKeys stays in sync with the actual config keys before persisting.
      const payload = list.map(ch => ({ ...ch, envKeys: Object.keys(ch.config) }))
      if (isElectron()) {
        const api = (window as any).electron?.channels
        if (api?.save) {
          await api.save(payload)
        }
      } else {
        // Fallback to localStorage
        localStorage.setItem('helix-channels', JSON.stringify({ channels: payload }))
      }
    } finally {
      setSavingChannels(false)
    }
  }

  const saveChannels = async () => {
    await persistChannels(channels)
    showToast({ type: 'success', title: '渠道配置已保存' })
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle>Channels</SectionTitle>
        <button onClick={addChannel} className="flex items-center gap-1.5 text-[length:var(--helix-transcript-size)] font-medium text-primary hover:text-primary/80 transition-colors">
          + 添加渠道
        </button>
      </div>
      <div className="space-y-3">
        {channels.map(channel => (
          <div key={channel.id} className="border border-border/50 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between p-4 hover:bg-accent/30 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">{channel.name || channel.id}</p>
                <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60 mt-0.5">{channel.description}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-4">
                <button
                  onClick={() => setExpandedChannel(expandedChannel === channel.id ? null : channel.id)}
                  className="px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground border border-border/50 rounded-lg hover:bg-accent/60 transition-colors"
                >
                  Configure
                </button>
                <Toggle enabled={channel.enabled} onToggle={() => handleToggle(channel.id)} />
                <button
                  onClick={() => removeChannel(channel.id)}
                  className="px-2 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-red-600/80 border border-border/50 rounded-lg hover:bg-red-500/10 transition-colors"
                >
                  删除
                </button>
              </div>
            </div>
            {expandedChannel === channel.id && (
              <div className="px-4 pb-4 pt-2 border-t border-border/30 bg-muted/20 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-muted-foreground mb-1">名称</label>
                    <input
                      value={channel.name}
                      onChange={e => updateChannelMeta(channel.id, { name: e.target.value })}
                      className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground text-center focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="block text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-muted-foreground mb-1">描述</label>
                    <input
                      value={channel.description}
                      onChange={e => updateChannelMeta(channel.id, { description: e.target.value })}
                      className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground text-center focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="block text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-muted-foreground">配置字段（环境变量）</label>
                  {Object.entries(channel.config).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2">
                      <input
                        value={key}
                        onChange={e => renameConfigKey(channel.id, key, e.target.value)}
                        className="w-2/5 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground text-center font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <input
                        type={key.toLowerCase().includes('secret') || key.toLowerCase().includes('token') || key.toLowerCase().includes('password') ? 'password' : 'text'}
                        value={value}
                        onChange={e => handleConfigChange(channel.id, key, e.target.value)}
                        placeholder={`Enter ${key.replace(/_/g, ' ')}`}
                        className="flex-1 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                      />
                      <button
                        onClick={() => removeConfigKey(channel.id, key)}
                        className="px-2 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-red-600/80 border border-border/50 rounded-lg hover:bg-red-500/10"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {Object.keys(channel.config).length === 0 && (
                    <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">暂无配置字段，点击下方添加。</p>
                  )}
                  <button
                    onClick={() => addConfigKey(channel.id)}
                    className="px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground border border-border/50 rounded-lg hover:bg-accent/60 transition-colors"
                  >
                    + 添加字段
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {channels.length === 0 && (
          <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">尚无渠道，点击右上角「添加渠道」。</p>
        )}
      </div>
      <div className="flex justify-end pt-2">
        <Button size="sm" variant="outline" onClick={saveChannels} disabled={savingChannels}>
          {savingChannels ? '保存中...' : '保存'}
        </Button>
      </div>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────
export function ApiSettings({ themeStyle, onSelectThemeStyle, sidebarWidth, setSidebarWidth, saveSidebarWidth, showSidebar, setShowSidebar, sidebarCollapsed, setSidebarCollapsed }: SettingsProps) {
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
    mcpServers, removeMcpServer, toggleMcpServer,
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
  } = useHelixStore()

  const settingsPage = useHelixStore(s => s.settingsPage)
  const setSettingsPage = useHelixStore(s => s.setSettingsPage)
  const pushNavigation = useHelixStore(s => s.pushNavigation)
  const setBrowserBookmarks = useHelixStore(s => s.setBrowserBookmarks)
  const browserBookmarks = useHelixStore(s => s.browserBookmarks)
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
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    getCurrentVersion().then((v) => v && setAppVersion(v))
  }, [])

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
      const store = useHelixStore.getState()
      const cur = store.apiConfig
      // ★ Critical: if the user has explicitly selected a different model in the
      // chat input (activeModel), do NOT let the backend config.yaml overwrite it.
      // Without this guard, opening Settings would revert apiConfig.model to the
      // backend default (e.g. Ling-3.0-flash) even though the chat is actively
      // using a different model — causing the settings list to highlight the wrong
      // entry and creating a visual/actual mismatch.
      const frontendModel = store.activeModel || cur.model
      const effectiveModel = frontendModel || r.model
      // Reject the broken ant-ling endpoint if it ever surfaces in the backend.
      const baseUrl = /ant-ling/i.test(r.baseUrl || '') ? cur.baseUrl : (r.baseUrl || cur.baseUrl)
      setApiConfig({
        provider: r.provider || cur.provider,
        apiKey: cur.apiKey, // never overwrite the saved key with ''
        baseUrl,
        model: effectiveModel,
      })
      // Intentionally NOT calling persistToStorage(): mirroring must not write
      // back to IndexedDB (that would wipe the persisted profile's key).
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Self-heal: make sure the CURRENT model always appears (and therefore
  // highlights) in the history list. If a model was activated through a path
  // that never recorded it into apiHistory (or a stale persisted copy dropped
  // it), opening Settings would show no highlighted entry at all. addApiHistory
  // dedups by baseUrl + apiKey + model, so re-adding the current config is
  // idempotent.
  useEffect(() => {
    const st = useHelixStore.getState()
    const cfg = st.apiConfig
    if (cfg?.baseUrl && cfg?.model) {
      st.addApiHistory({ ...cfg })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [showApiKey, setShowApiKey] = useState(false)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [isCustomProvider, setIsCustomProvider] = useState(false)
  const [customInputFocused, setCustomInputFocused] = useState(false)
  const [showAddModelModal, setShowAddModelModal] = useState(false)
  type ModelTab = 'main' | 'vision'
  const [modelTab, setModelTab] = useState<ModelTab>('main')

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
  const selectedWorkDir = useHelixStore(s => s.selectedWorkDir)
  const [defaultMcpCwd, setDefaultMcpCwd] = useState('')
  useEffect(() => {
    let alive = true
    electronApp.getDataRoot()
      .then((info) => {
        if (alive && info?.dataRoot) {
          setDefaultMcpCwd(`${info.dataRoot.replace(/[\\/]+$/, '')}/sessions`)
        }
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  const resolveDefaultMcpCwd = useCallback(
    () => selectedWorkDir || defaultMcpCwd || '',
    [selectedWorkDir, defaultMcpCwd],
  )
  const [mcpForm, setMcpForm] = useState<McpFormData>({
    name: '', type: 'local', command: '', url: '', args: '',
  })
  const mcpServerNames = Object.keys(mcpServers)
  const [mcpStatus, setMcpStatus] = useState<Record<string, boolean>>({})
  // Gateway MCP servers — read-only view of config.yaml `mcp_servers` (loaded
  // by the gateway at startup; separate from the app-managed list above, which
  // is persisted locally and sent per-session via session/new).
  const [gatewayMcp, setGatewayMcp] = useState<Record<string, any>>({})
  const [gatewayMcpLoaded, setGatewayMcpLoaded] = useState(false)
  // Name of a gateway (config.yaml mcp_servers) server being edited — opens
  // the shared McpEditorForm with its config; null = not editing.
  const [gatewayEditing, setGatewayEditing] = useState<string | null>(null)

  // MCP status - query tools/list to detect which MCP servers are connected
  // Reactive: subscribes to hermesSessionId so the check re-runs once a session
  // exists (previously it only ran on mount, leaving every server stuck on
  // "检测中" when the settings page opened with no active session).
  const hermesSessionId = useHermesStore(s => s.hermesSessionId)
  const [mcpStatusAttempt, setMcpStatusAttempt] = useState(0)
  const fetchMcpStatus = useCallback(async () => {
    try {
      if (!hermesSessionId) {
        // No active session yet — keep previous status (don't wipe to {} which
        // would render every server as "检测中" forever). The effect below
        // re-runs automatically once a session id appears.
        return
      }
      const result = await hermesApi()!.send('tools/list', { session_id: hermesSessionId }) as any
      const tools: string[] = result?.tools?.map((t: any) => t.name) || result?.map((t: any) => t.name) || []
      // Match tool names to MCP server names (e.g. "tavily_search" -> "tavily").
      // Hermes exposes gateway MCP tools as `mcp__<server>__<tool>` with
      // hyphens→underscores, so a bare prefix match misses e.g. "ssh-bridge"
      // → "mcp__ssh_bridge__remote_exec".
      const norm = (s: string) => s.toLowerCase().replace(/-/g, '_')
      const status: Record<string, boolean> = {}
      const allNames = [...new Set([...Object.keys(mcpServers), ...Object.keys(gatewayMcp)])]
      for (const name of allNames) {
        const n = norm(name)
        status[name] = tools.some(t => {
          const tl = t.toLowerCase()
          return tl.startsWith(n) || tl.startsWith('mcp__' + n + '__')
        })
      }
      setMcpStatus(status)
      setMcpStatusAttempt(0)  // success resets the retry counter
    } catch {
      // Transient failure (WS not ready, RPC timeout): keep last status and
      // schedule a retry instead of wiping to {} (which shows "检测中" forever).
      setMcpStatusAttempt(a => a + 1)
    }
  }, [mcpServers, gatewayMcp, hermesSessionId])

  // Run on mount + whenever session id / server list changes.
  useEffect(() => {
    fetchMcpStatus()
  }, [fetchMcpStatus])

  // Bounded retry with backoff (2s, 4s, 8s, 16s, 32s) after a failed probe.
  useEffect(() => {
    if (mcpStatusAttempt === 0) return
    if (mcpStatusAttempt > 5) return
    const delay = 2000 * Math.pow(2, mcpStatusAttempt - 1)
    const t = setTimeout(() => { fetchMcpStatus() }, delay)
    return () => clearTimeout(t)
  }, [mcpStatusAttempt, fetchMcpStatus])

  // Gentle polling while a session is live so status reflects late MCP
  // discovery / reconnects without needing to reopen the settings page.
  useEffect(() => {
    if (!hermesSessionId) return
    const t = setInterval(() => { fetchMcpStatus() }, 15000)
    return () => clearInterval(t)
  }, [hermesSessionId, fetchMcpStatus])

  // Load gateway MCP servers from config.yaml (Tauri IPC)
  const reloadGatewayMcp = useCallback(async () => {
    if (!isElectron()) { setGatewayMcpLoaded(true); return }
    try {
      const api = (window as any).electron?.mcpConfig
      if (!api?.list) { setGatewayMcpLoaded(true); return }
      const r = await api.list()
      if (r?.ok && r.servers) setGatewayMcp(r.servers || {})
    } catch {
      // settings page must not break on IPC failure
    } finally {
      setGatewayMcpLoaded(true)
    }
  }, [])

  useEffect(() => { reloadGatewayMcp() }, [reloadGatewayMcp])

  // Archive state
  const [archives, setArchives] = useState<Array<{ id: string; label: string; savedAt: number; messageCount: number }>>([])

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
        // Scope the fetched list to the endpoint being probed (baseUrl), NOT the
        // (possibly stale) activeProviderId. Without this, setAvailableModels
        // keys the list under the previous provider and the model selector —
        // which reads providerModels[activeProvider.id] — can't see it, dropping
        // the fetched list to just the single declared model.
        setAvailableModels(models, localConfig.baseUrl)
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
    // 同步 activeModel 到该 profile 的模型：applyProfile 之前只更新 apiConfig /
    // activeProviderId / activeProfileId，漏了 activeModel —— 重启时
    // restoreFromStorage 以 activeModel 为准（builtActiveModel），残留的旧模型
    // （如 deepseek-v4-flash）会把一切拉回旧端点（"每次重启都是 deepseek"）。
    if (p.config.model) {
      useHelixStore.setState({ activeModel: p.config.model })
    }
    // Re-anchor activeProviderId to the profile's endpoint. applyProfile used to
    // leave it at the previously-active provider, so the chat dropdown's open
    // refetch hit the wrong endpoint and the selector dropped to 1 model.
    useHelixStore.setState((s) => {
      const pid = s.providers.find((pr) => pr.baseUrl === s.apiConfig.baseUrl)?.id
      return pid ? { activeProviderId: pid } : {}
    })
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
        // serve 模式：hermes:setConfig 是 no-op（main.js 直接 return success），
        // 必须走 pushModelConfig —— 内部按模式分流：serve → setModel 写
        // config.yaml（生效）；acp → setConfig + cacheConfig（行为不变）。
        // 否则在设置里切换 profile 永远到不了网关，config.yaml 残留旧配置
        // （如 deepseek+Ling 错配 → 400 无输出）。
        pushModelConfig(cfg)
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
    // Store ONLY the single chosen model — NOT the full fetched list. The model
    // list is fetched live when the selector is opened (renderModelSelector), so
    // persisting the fetched list here would only create a stale cache that hides
    // newly-added models (e.g. ling-pro) until the next manual refresh.
    const profileModels = [localConfig.model].filter(Boolean) as string[]
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
        const name = deriveProviderName(localConfig.baseUrl, localConfig.model ? `配置 · ${localConfig.model}` : `配置 ${apiProfiles.length + 1}`)
        const id = addApiProfile(name, localConfig, profileModels)
        setActiveProfile(id)
      }
    }
    setApiConfig(localConfig)
    // Keep activeModel in sync with the saved model. Without this the chat
    // dropdown highlight (activeModel-first) and the settings backend mirror
    // (which guards on activeModel || cur.model) would keep pinning the
    // PREVIOUS model — e.g. after saving Ling-2.6-1T while flash was active,
    // the dropdown would never highlight Ling and the mirror would revert the
    // backend model back to flash. Use the POST-snap apiConfig.model (setApiConfig
    // may correct a model/baseUrl mismatch), so activeModel can't drift from it.
    // Also re-anchor activeProviderId to the endpoint just saved: leaving it at
    // the PREVIOUS provider makes the chat dropdown's open-refetch hit the wrong
    // endpoint and scopes providerModels reads to the wrong key — the "fetched 2
    // models, selector shows only 1" bug.
    useHelixStore.setState((s) => {
      const pid = s.providers.find((p) => p.baseUrl === s.apiConfig.baseUrl)?.id
      return {
        activeModel: s.apiConfig.model,
        ...(pid ? { activeProviderId: pid } : {}),
      }
    })
    // Persist the snapped (mismatch-corrected) config into history so a
    // model/baseUrl split can never be re-saved as a new history entry.
    const snapped = useHelixStore.getState().apiConfig
    addApiHistory(snapped)
    // Clear any stale per-provider fetched model cache for this endpoint so the
    // next open of the chat model selector re-fetches live (per user request:
    // "保存时不存储模型列表"). The live fetch on open repopulates it.
    {
      const st = useHelixStore.getState()
      const pid = st.providers.find((p) => p.baseUrl === localConfig.baseUrl)?.id
      if (pid) st.clearProviderModels(pid)
    }
    await persistToStorage()

    // Sync to Hermes if running in Electron or Tauri
    const hermes = (window as any).electron?.hermes
    if (isElectron() || hermes?.setConfig) {
      try {
        const cfg = {
          model: localConfig.model,
          provider: localConfig.provider && localConfig.provider !== '__custom__' ? localConfig.provider : 'custom',
          baseUrl: localConfig.baseUrl,
          apiKey: localConfig.apiKey,
        }
        await hermes.setConfig(cfg)
        // Persist the active profile so the next cold start re-asserts it
        // into Hermes config.yaml (no hardcoded pin, free switching preserved).
        await (window as any).electron?.profile?.cacheConfig?.(cfg)
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
  const mcpArgText = useCallback((v: unknown) => {
    if (typeof v === 'string') return v
    if (v === null || v === undefined) return ''
    try { return JSON.stringify(v) } catch { return String(v) }
  }, [])

  const resetMcpForm = useCallback(() => {
    setMcpForm({ name: '', type: 'local', command: '', url: '', args: '' })
  }, [])

  const handleSaveMcp = useCallback(async () => {
    const name = mcpForm.name.trim()
    if (!name) { showToast({ type: 'error', title: '请填写服务器名称' }); return }
    if (mcpForm.type === 'local' && !mcpForm.command.trim()) { showToast({ type: 'error', title: '请填写启动命令' }); return }
    if (mcpForm.type === 'remote' && !mcpForm.url.trim()) { showToast({ type: 'error', title: '请填写 URL' }); return }
    const api = (window as any).electron?.mcpConfig
    if (!api?.save) { showToast({ type: 'error', title: '当前环境不支持写入 config.yaml' }); return }
    const cmdParts = [mcpForm.command.trim(), ...mcpForm.args.trim().split(/\s+/)].filter(Boolean)
    const nextCwd = mcpServers[editingMcpName || name]?.cwd || resolveDefaultMcpCwd()
    const old = mcpServers[editingMcpName || name] || {}
    const gatewayEntry: Record<string, any> = {
      enabled: old.enabled ?? true,
      ...(mcpForm.type === 'remote' ? { url: mcpForm.url.trim() } : { command: cmdParts[0] || '' }),
      ...(mcpForm.type === 'local' && cmdParts.length > 1 ? { args: cmdParts.slice(1) } : {}),
      ...(Object.keys(old.environment || {}).length > 0 ? { env: old.environment } : {}),
      ...(old.envPassthrough ? { env_passthrough: true } : {}),
      ...(mcpForm.type === 'local' && nextCwd ? { cwd: nextCwd } : {}),
      ...(Object.keys(old.headers || {}).length > 0 ? { headers: old.headers } : {}),
      ...(typeof old.timeout === 'number' ? { timeout: old.timeout } : {}),
    }
    const servers: Record<string, any> = { ...gatewayMcp }
    if (editingMcpName && editingMcpName !== name) delete servers[editingMcpName]
    servers[name] = gatewayEntry

    try {
      const r = await api.save(servers)
      if (!r?.ok) { showToast({ type: 'error', title: `保存失败：${r?.error || '未知错误'}` }); return }
      // 新加的服务器只留在 config.yaml（网关级），不重复放进应用列表。
      if (editingMcpName && editingMcpName !== name) removeMcpServer(editingMcpName)
      else if (mcpServers[name]) removeMcpServer(name)
      await persistToStorage()
      await reloadGatewayMcp()
      showToast({ type: 'success', title: `服务器 "${name}" 已保存到 config.yaml` })
      setEditingMcpName(null); setIsAddingMcp(false); resetMcpForm()
      setTimeout(fetchMcpStatus, 1000)
    } catch (e) {
      showToast({ type: 'error', title: `保存失败：${(e as Error)?.message || e}` })
    }
  }, [mcpForm, editingMcpName, mcpServers, gatewayMcp, removeMcpServer, persistToStorage, reloadGatewayMcp, showToast, resetMcpForm, fetchMcpStatus, resolveDefaultMcpCwd])

  const handleEditMcp = useCallback((name: string) => {
    const config = mcpServers[name]; if (!config) return
    setEditingMcpName(name)
    const cmdParts = Array.isArray(config.command) ? config.command : (config.command ? [config.command] : [])
    setMcpForm({
      name, type: config.type,
      command: cmdParts[0] || '',
      url: config.url || '',
      args: cmdParts.slice(1).map(mcpArgText).filter(Boolean).join(' '),
    })
  }, [mcpServers, setEditingMcpName, mcpArgText])

  const handleDeleteMcp = useCallback(async (name: string) => {
    removeMcpServer(name); await persistToStorage(); showToast({ type: 'info', title: `服务器 "${name}" 已删除` })
  }, [removeMcpServer, persistToStorage, showToast])

  const handleToggleMcp = useCallback(async (name: string) => {
    toggleMcpServer(name); await persistToStorage()
  }, [toggleMcpServer, persistToStorage])

  // ── Gateway MCP (config.yaml mcp_servers) edit handlers ────────────────
  const handleEditGatewayMcp = useCallback((name: string) => {
    const cfg = gatewayMcp[name]; if (!cfg) return
    setGatewayEditing(name)
    const cmdParts = Array.isArray(cfg.command) ? cfg.command : (cfg.command ? [cfg.command] : [])
    const argsArr = Array.isArray(cfg.args) ? cfg.args : []
    setMcpForm({
      name,
      type: cfg.url ? 'remote' : 'local',
      command: cmdParts[0] || '',
      url: cfg.url || '',
      args: [...cmdParts.slice(1), ...argsArr].map(mcpArgText).filter(Boolean).join(' '),
    })
  }, [gatewayMcp, mcpArgText])

  const handleSaveGatewayMcp = useCallback(async () => {
    const name = mcpForm.name.trim()
    if (!name) { showToast({ type: 'error', title: '请填写服务器名称' }); return }
    if (mcpForm.type === 'local' && !mcpForm.command.trim()) { showToast({ type: 'error', title: '请填写启动命令' }); return }
    if (mcpForm.type === 'remote' && !mcpForm.url.trim()) { showToast({ type: 'error', title: '请填写 URL' }); return }
    const api = (window as any).electron?.mcpConfig
    if (!api?.save) { showToast({ type: 'error', title: '当前环境不支持保存' }); return }

    const cmdParts = [mcpForm.command.trim(), ...mcpForm.args.trim().split(/\s+/)].filter(Boolean)
    const oldName = gatewayEditing
    const oldCfg = (oldName && gatewayMcp[oldName]) || {}

    // Full-block write: carry over the original cfg so scalar overrides
    // (enabled/timeout/auth/headers) survive an edit; delete keys the form
    // cleared. env is NOT sent when untouched — the Rust side then carries
    // the old env block over, so secrets never get clobbered by a display
    // round trip (config.yaml env values are hidden from the renderer).
    const merged: Record<string, any> = { ...oldCfg }
    if (mcpForm.type === 'remote') {
      merged.url = mcpForm.url.trim()
      delete merged.command; delete merged.args
    } else {
      merged.command = cmdParts[0] || ''
      if (cmdParts.length > 1) merged.args = cmdParts.slice(1)
      else delete merged.args
    }
    const nextCwd = oldCfg.cwd || resolveDefaultMcpCwd()
    if (nextCwd) merged.cwd = nextCwd
    else delete merged.cwd

    const servers: Record<string, any> = { ...gatewayMcp }
    if (oldName && oldName !== name) delete servers[oldName]
    servers[name] = merged

    try {
      const r = await api.save(servers)
      if (!r?.ok) { showToast({ type: 'error', title: `保存失败：${r?.error || '未知错误'}` }); return }
      showToast({ type: 'success', title: `服务器 "${name}" 已保存` })
      setGatewayEditing(null); setIsAddingMcp(false); resetMcpForm()
      await reloadGatewayMcp()
      setTimeout(fetchMcpStatus, 1000)
    } catch (e) {
      showToast({ type: 'error', title: `保存失败：${(e as Error)?.message || e}` })
    }
  }, [mcpForm, gatewayEditing, gatewayMcp, showToast, resetMcpForm, reloadGatewayMcp, fetchMcpStatus, resolveDefaultMcpCwd])

  const handleDeleteGatewayMcp = useCallback(async (name: string) => {
    const api = (window as any).electron?.mcpConfig
    if (!api?.save) { showToast({ type: 'error', title: '当前环境不支持保存' }); return }
    const servers: Record<string, any> = { ...gatewayMcp }
    delete servers[name]
    try {
      const r = await api.save(servers)
      if (!r?.ok) { showToast({ type: 'error', title: `删除失败：${r?.error || '未知错误'}` }); return }
      await reloadGatewayMcp()
      setTimeout(fetchMcpStatus, 1000)
      showToast({ type: 'info', title: `服务器 "${name}" 已删除` })
    } catch (e) {
      showToast({ type: 'error', title: `删除失败：${(e as Error)?.message || e}` })
    }
  }, [gatewayMcp, reloadGatewayMcp, fetchMcpStatus, showToast])

  const handleMcpFormChange = useCallback((patch: Partial<McpFormData>) => {
    setMcpForm(prev => ({ ...prev, ...patch }))
  }, [])

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
      blocks: msg.blocks,
    }))
    useHelixStore.getState().clearExecutionFlow()
    useHelixStore.setState({
      chatMessages: msgs,
      activeSessionWorkDir: session.workDir ?? null,
    })
    // selectedWorkDir 同步到恢复的对话所属项目，让 Git 分支选择器等 UI 跟随对话。
    if (session.workDir) {
      useHelixStore.getState().setSelectedWorkDir(session.workDir)
    }
    useHelixStore.getState().setCurrentSessionId(session.id)
    pushNavigation({ type: 'chat', sessionId: session.id })
    // 恢复 = 取消归档：把 isArchived 置回 false，让会话回到侧边栏主列表。
    // 之前只加载内容不改归档标记 → toast 显示"已恢复"但会话仍留在归档里，
    // 主列表看不到 → "实际没效果"。
    if (session.isArchived) {
      await persistence.saveSession({
        ...session,
        isArchived: false,
        savedAt: Date.now(),
      })
    }
    await persistToStorage()
    await loadArchives()
    showToast({ type: 'success', title: '已恢复', description: session.label })
  }, [showToast, persistToStorage, loadArchives])

  // ── Shared components ─────────────────────────────────────────────────────
  const SettingRow = ({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border/40 last:border-b-0 gap-3 transition-colors duration-150">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span className="text-muted-foreground shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">{label}</p>
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
        className="flex-1 px-3 py-2 bg-transparent text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/40 focus:outline-none font-mono"
      />
      {suffix && <span className="pr-3">{suffix}</span>}
    </div>
  ))
  InputField.displayName = 'InputField'

  // ── Render content ────────────────────────────────────────────────────────
  const ModelHistoryList = () => {
    if (apiHistory.length === 0) {
      return null
    }

    // Group by baseUrl (preserve first-appearance order). Within a group the
    // entries share the same endpoint but may carry different apiKeys — the
    // addApiHistory dedup already collapses same baseUrl+apiKey, so each item
    // here is a distinct (baseUrl, apiKey) pair. Grouping keeps one endpoint's
    // many keys visually together instead of scattered across the flat list.
    type HistoryItem = { h: typeof apiHistory[number]; index: number }
    const groups: { baseUrl: string; items: HistoryItem[] }[] = []
    const groupPos = new Map<string, number>()
    apiHistory.forEach((h, index) => {
      const url = h.baseUrl || '(无 baseUrl)'
      let pos = groupPos.get(url)
      if (pos === undefined) {
        pos = groups.length
        groupPos.set(url, pos)
        groups.push({ baseUrl: url, items: [] })
      }
      groups[pos].items.push({ h, index })
    })

    // Whether the CURRENT connection (baseUrl + apiKey) exists in history at
    // all. Computed ONCE per render, not per entry (renderItem). The list
    // groups entries by baseUrl only, so one endpoint can hold entries saved
    // under different apiKeys. When the current connection IS present, highlight
    // only the exact key; when it's NOT (legacy keys only), fall back to
    // baseUrl+model so the highlight never orphans the whole group.
    const activeCfg = useHelixStore.getState().apiConfig
    const connPresent =
      !!activeCfg?.baseUrl &&
      !!activeCfg?.apiKey &&
      apiHistory.some((x) => x.baseUrl === activeCfg.baseUrl && x.apiKey === activeCfg.apiKey)

    const renderItem = ({ h, index }: HistoryItem) => {
      // Use the same unified criterion as the chat input's model selector
      // (activeModel || apiConfig.model) so both pages always agree on which
      // model is "current". Without this, selecting a model in chat would leave
      // the settings list highlighting a stale entry (or nothing at all).
      const store = useHelixStore.getState()
      const displayModel = store.activeModel || apiConfig.model
      const isActive =
        !!activeCfg?.baseUrl &&
        activeCfg.baseUrl === h.baseUrl &&
        displayModel === h.model &&
        (connPresent ? !!h.apiKey && h.apiKey === activeCfg.apiKey : true)
      return (
        <div key={index}
          onClick={async () => {
            // Write the history entry through setApiConfig first: it guards
            // against model/baseUrl mismatches (poisoned history) and snaps
            // the model to the endpoint it actually belongs to.
            setApiConfig({ ...h })
            // Then anchor activeModel/activeProviderId directly to this history
            // entry's endpoint. Don't use setActiveModel here: its model-name-based
            // resolution can pick the wrong provider when a model name also exists
            // in another provider's fetched list (e.g. cross-endpoint pollution),
            // causing an explicit deepseek click to snap back to Ling.
            const state = useHelixStore.getState()
            let match = state.providers.find((p) => p.baseUrl === h.baseUrl)
            if (!match) {
              // This endpoint lives only in history (no saved Profile). Upsert a
              // runtime provider so the input-bar model list can resolve to it and
              // the active model stays pinned instead of snapping to the default
              // provider (Ling) after a refresh.
              const exists = state.providers.some((p) => p.baseUrl === h.baseUrl)
              useHelixStore.setState((s) => ({
                providers: exists
                  ? s.providers.map((p) =>
                      p.baseUrl === h.baseUrl
                        ? { ...p, models: Array.from(new Set([...(p.models || []), h.model])) }
                        : p,
                    )
                  : [
                      ...s.providers,
                      {
                        id: `hist-${h.baseUrl}`,
                        name: h.provider || (() => { try { return new URL(h.baseUrl).hostname } catch { return '配置' } })(),
                        baseUrl: h.baseUrl,
                        apiKey: h.apiKey || '',
                        models: [h.model],
                        isDefault: false,
                      } as any,
                    ],
              }))
              match = useHelixStore.getState().providers.find((p) => p.baseUrl === h.baseUrl) as any
            }
            useHelixStore.setState({
              activeModel: h.model,
              activeProviderId: match?.id || null,
              apiConfig: {
                ...state.apiConfig,
                ...h,
                provider: match?.name || h.provider || 'custom',
                model: h.model,
              },
            })
            const final = useHelixStore.getState().apiConfig
            setLocalConfig({ ...final })
            await persistToStorage()
            const hermes = (window as any).electron?.hermes
            if (isElectron() || hermes?.setConfig) {
              try {
                const cfg = { model: final.model, provider: final.provider && final.provider !== '__custom__' ? final.provider : 'custom', baseUrl: final.baseUrl, apiKey: final.apiKey }
                await hermes.setConfig(cfg)
                await (window as any).electron?.profile?.cacheConfig?.(cfg)
                useHermesStore.getState().setHermesSessionId(null)
              } catch {}
            }
            showToast({ type: 'success', title: `已切换到 ${final.model}` })
          }}
          className={`flex items-center justify-between px-3 py-1.5 rounded-xl bg-card shadow-sm cursor-pointer transition-colors group ${isActive ? 'ring-1 ring-primary/30 bg-primary/5' : 'hover:bg-muted/40'}`}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {isActive && <span className="size-1.5 rounded-full bg-primary shrink-0" />}
              <p className={`text-[length:var(--helix-transcript-size)] truncate ${isActive ? 'font-semibold text-primary' : 'font-medium text-foreground'}`}>{h.model}</p>
            </div>
            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60 truncate mt-0.5 font-mono">{h.baseUrl}</p>
          </div>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
            <button onClick={(e) => { e.stopPropagation(); setLocalConfig({ ...h }); setShowAddModelModal(true) }}
              className="ml-2 p-1 rounded text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/20 hover:text-foreground hover:bg-accent transition-all">
              编辑
            </button>
            <button onClick={async (e) => { e.stopPropagation(); removeApiHistory(index); await persistToStorage() }}
              className="ml-1 p-1 rounded text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/20 hover:text-red-500 transition-all">
              删除
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="space-y-1.5">
        {groups.flatMap((g) => g.items).map(renderItem)}
      </div>
    )
  }

  const renderContent = () => {
    switch (page) {
      case 'general':
        return <GeneralSettingsPanel />

      case 'appearance':
        return <AppearanceSettingsPanel themeStyle={themeStyle} onSelectThemeStyle={onSelectThemeStyle} />

      case 'api':
        return (
          <div className="space-y-6">
            {/* Title bar with sub-tabs */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1 bg-muted/60 rounded-full p-1">
                <button
                  onClick={() => setModelTab('main')}
                  className={`px-3.5 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium rounded-full transition-colors ${
                    modelTab === 'main'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  主模型
                </button>
                <button
                  onClick={() => setModelTab('vision')}
                  className={`px-3.5 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium rounded-full transition-colors ${
                    modelTab === 'vision'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  视觉模型
                </button>
              </div>
              {modelTab === 'main' && !showAddModelModal && (
                <button
                  onClick={() => {
                    setLocalConfig({ provider: '', apiKey: '', baseUrl: '', model: '' })
                    setIsCustomProvider(false)
                    setAvailableModels([])
                    setShowModelDropdown(false)
                    setShowAddModelModal(true)
                  }}
                  className="flex items-center gap-1.5 text-[length:var(--helix-transcript-size)] font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  添加模型
                </button>
              )}
              {modelTab === 'main' && showAddModelModal && (
                <button
                  onClick={() => setShowAddModelModal(false)}
                  className="text-[length:var(--helix-transcript-size)] text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg px-2 py-1 transition-colors"
                  data-tip="关闭"
                >
                  关闭
                </button>
              )}
            </div>

            {modelTab === 'main' ? (
              !showAddModelModal ? (
                <div className="max-w-3xl space-y-6">
                  <ModelHistoryList />
                  <ModelUsageStats />
                </div>
              ) : (
                /* Add model form */
              <SettingGroup>
                <div className="p-4 space-y-3">
                  {/* Provider */}
                  <div>
                    <label className="block ui-text font-medium text-foreground mb-1.5">Provider</label>
                    {!isCustomProvider ? (
                      <PopupSelect
                        value={localConfig.provider}
                        onChange={handleSelectProvider}
                        placeholder="请选择 Provider"
                        className="w-full ui-text text-foreground border border-border/50 bg-muted/50 rounded-lg px-3 py-2"
                        options={[
                          ...ALL_PROVIDERS.map(p => ({ label: `${p.name} (${p.id})`, value: p.id })),
                          { label: '＋ 自定义', value: CUSTOM_PROVIDER_ID },
                        ]}
                      />
                    ) : (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={localConfig.provider}
                          onChange={(e) => handleCustomProviderChange(e.target.value)}
                          onFocus={() => setCustomInputFocused(true)}
                          onBlur={handleBlurCustomInput}
                          placeholder="输入 Provider 名称"
                          className="flex-1 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={() => { setIsCustomProvider(false); setCustomInputFocused(false) }}
                          className="px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground hover:bg-accent/50 transition-colors"
                          data-tip="返回列表"
                        >
                          返回
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Base URL */}
                  <div>
                    <label className="block ui-text font-medium text-foreground mb-1.5">Base URL</label>
                    <input
                      type="text"
                      value={localConfig.baseUrl}
                      onChange={(e) => setLocalConfig(prev => ({ ...prev, baseUrl: e.target.value }))}
                      placeholder="https://api.openai.com/v1"
                      className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                    />
                  </div>

                  {/* API Key */}
                  <div>
                    <label className="block ui-text font-medium text-foreground mb-1.5">API Key</label>
                    <div className="relative">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        value={localConfig.apiKey}
                        onChange={(e) => setLocalConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                        placeholder="sk-..."
                        className="w-full px-3 py-2 pr-10 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/50 hover:text-foreground transition-colors"
                      >
                        {showApiKey ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </div>

                  {/* Model */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block ui-text font-medium text-foreground">模型名称</label>
                      <button
                        type="button"
                        onClick={handleFetchModels}
                        disabled={isLoadingModels}
                        className="flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.8571)] text-primary hover:text-primary/80 disabled:text-muted-foreground transition-colors"
                      >
                        {isLoadingModels ? '获取中...' : '获取模型列表'}
                      </button>
                    </div>
                    {availableModels.length > 0 ? (
                      <div className="relative" ref={modelDropdownRef}>
                        <button
                          type="button"
                          onClick={() => setShowModelDropdown(!showModelDropdown)}
                          className="w-full flex items-center justify-between ui-text text-foreground border border-border/50 bg-muted/50 rounded-lg px-3 py-2 transition-colors"
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
                                className={`w-full text-left px-3 py-2 rounded-md text-[length:var(--helix-transcript-size)] font-mono transition-colors ${
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
                        className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                      />
                    )}
                  </div>

                  {/* Save button — inside card, bottom-right */}
                  <div className="flex justify-end pt-2">
                    <Button onClick={async () => { await handleSaveApi(); setShowAddModelModal(false) }} size="sm" variant="outline">
                      保存
                    </Button>
                  </div>
                </div>
              </SettingGroup>
            )
            ) : (
              <VisionModelSettings />
            )}
          </div>
        )

      case 'shortcuts':
        return (
          <div className="max-w-3xl">
            <ShortcutsPage />
          </div>
        )

      case 'mcp':
        return (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-[calc(var(--helix-transcript-size)*1.2857)] font-semibold text-foreground">MCP</h3>
              {!isAddingMcp && !editingMcpName && !gatewayEditing ? (
                <button
                  onClick={() => { setIsAddingMcp(true); resetMcpForm() }}
                  className="flex items-center gap-1.5 text-[length:var(--helix-transcript-size)] font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  添加服务器
                </button>
              ) : (
                <button
                  onClick={() => { setIsAddingMcp(false); setEditingMcpName(null); setGatewayEditing(null); resetMcpForm() }}
                  className="text-[length:var(--helix-transcript-size)] text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg px-2 py-1 transition-colors"
                  data-tip="关闭"
                >
                  关闭
                </button>
              )}
            </div>

            {/* Gateway-loaded MCP servers (config.yaml mcp_servers) — editable */}
            {gatewayMcpLoaded && !isAddingMcp && !editingMcpName && !gatewayEditing && (
              <section className="space-y-2">
                {Object.keys(gatewayMcp).length === 0 ? (
                  <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/50 px-4 py-3 border border-dashed border-border/40 rounded-lg">
                    config.yaml 未配置 mcp_servers —— 在该文件的 mcp_servers 段添加的网关级服务器会显示在这里
                  </p>
                ) : (
                  <div className="max-w-3xl space-y-2">
                    {Object.entries(gatewayMcp).map(([name, cfg]) => {
                      const connected = mcpStatus[name]
                      const cmd = [cfg?.command, ...(cfg?.args || [])].filter(Boolean).join(' ')
                      return (
                        <div key={name} className="flex items-center gap-3 px-4 py-3 border border-border/20 bg-muted/20 rounded-lg group">
                          <div className="relative shrink-0">
                            <div className={`w-2.5 h-2.5 rounded-full ${cfg?.enabled === false ? 'bg-gray-300' : connected ? 'bg-green-500' : connected === false ? 'bg-red-400' : 'bg-amber-400'}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">{name}</span>
                              <span className={`text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded-full font-medium ${cfg?.url ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'}`}>
                                {cfg?.url ? '远程' : '本地'}
                              </span>
                            </div>
                            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 font-mono truncate mt-0.5">
                              {cfg?.url || cmd || '(环境变量式配置)'}
                            </p>
                          </div>
                          <button onClick={() => handleEditGatewayMcp(name)}
                            className="px-1.5 py-1 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/40 hover:text-foreground hover:bg-accent opacity-0 group-hover:opacity-100 transition-all shrink-0">
                            编辑
                          </button>
                          <button onClick={() => handleDeleteGatewayMcp(name)}
                            className="px-1.5 py-1 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/40 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                            删除
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            )}

            {!isAddingMcp && !editingMcpName && !gatewayEditing ? (
              <>
                {/* Server list */}
                <div className="max-w-3xl space-y-2">
                  {mcpServerNames.map(name => {
                    const config = mcpServers[name]
                    const connected = mcpStatus[name]
                    return (
                      <div
                        key={name}
                        className="flex items-center gap-3 px-4 py-3 border-b border-border/30 last:border-b-0 hover:bg-muted/40 transition-colors group">
                        <div className="relative shrink-0">
                          <div className={`w-2.5 h-2.5 rounded-full ${config.enabled === false ? 'bg-gray-300' : connected ? 'bg-green-500' : connected === false ? 'bg-red-400' : 'bg-amber-400'}`} />
                          {config.enabled !== false && connected && (
                            <span className="absolute inset-0 w-2.5 h-2.5 rounded-full bg-green-500 animate-ping opacity-30" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">{name}</span>
                            <span className={`text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded-full font-medium ${config.type === 'local' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'}`}>
                              {config.type === 'local' ? '本地' : '远程'}
                            </span>
                          </div>
                          <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 font-mono truncate mt-0.5">
                            {config.type === 'local' ? config.command?.join(' ') : config.url}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Toggle enabled={config.enabled !== false} onToggle={() => handleToggleMcp(name)} />
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                            <button onClick={() => handleEditMcp(name)} className="px-1 py-1 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-colors">
                              编辑
                            </button>
                            <button onClick={() => handleDeleteMcp(name)} className="px-1 py-1 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/40 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">
                              删除
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {mcpServerNames.length === 0 && (
                  <div className="max-w-3xl flex flex-col items-center justify-center py-12 text-center">
                    <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground/60">暂无 MCP 服务器</p>
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
                    onSave={gatewayEditing ? handleSaveGatewayMcp : handleSaveMcp}
                    onCancel={() => { setIsAddingMcp(false); setEditingMcpName(null); setGatewayEditing(null); resetMcpForm() }}
                  />
                </div>
              </div>
            )}
          </div>
        )

      case 'archive':
        return (
          <div className="max-w-3xl space-y-6">
            <SectionTitle className="mb-0">历史归档</SectionTitle>

            {/* Archived sessions */}
            <section className="space-y-3">
              {archives.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground/60">暂无归档记录</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                    {archives.map(a => (
                      <div key={a.id}
                        onClick={() => handleLoadArchive(a.id)}
                        className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-card shadow-sm cursor-pointer transition-colors group hover:bg-muted/40">
                        <div className="flex-1 min-w-0">
                          <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground truncate">{a.label}</p>
                          <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 mt-0.5">{a.messageCount} 条消息</p>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteArchive(a.id) }}
                          className="p-1 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/20 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                          删除
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </section>
          </div>
        )

      case 'browser':
        return (
          <div className="space-y-4">
            <SectionTitle>浏览器</SectionTitle>
            <div className="border border-border/50 rounded-xl overflow-hidden">
              <SettingRow icon={<Globe className="size-4 text-foreground/60" />} label="从 Chrome 导入书签">
                <div className="ml-auto flex items-center">
                  {browserBookmarks.length > 0 && (
                    <span className="mr-3 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">已导入 {browserBookmarks.length} 个书签项</span>
                  )}
                  <Button variant="outline" size="sm" onClick={() => importChromeBookmarks()}>
                    选择 Chrome 数据目录
                  </Button>
                </div>
              </SettingRow>
            </div>

            <WebSearchSettings />
          </div>
        )

      case 'git':
        return <GitSettingsPanel />

      case 'usage':
        return (
          <div className="max-w-3xl space-y-6">
            <SectionTitle>用量</SectionTitle>
            <TokenUsagePanel />
          </div>
        )

      case 'hook':
        return <HookSettings />

      case 'help':
        return (
          <div className="max-w-3xl space-y-8">
            <SectionTitle>帮助</SectionTitle>

            {/* About */}
            <section className="space-y-3">
              <div className="overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() => setCollapsedSections(s => {
                    const next = new Set(s)
                    next.has('about') ? next.delete('about') : next.add('about')
                    return next
                  })}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">关于</span>
                  </div>
                </button>
                <div className={`p-4 space-y-4 ${collapsedSections.has('about') ? 'hidden' : ''}`}>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[length:var(--helix-transcript-size)] text-muted-foreground">版本</span>
                      <span className="text-[length:var(--helix-transcript-size)] font-mono text-foreground">v{appVersion || '0.1.2'}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[length:var(--helix-transcript-size)] text-muted-foreground">许可证</span>
                      <span className="text-[length:var(--helix-transcript-size)] text-foreground">MIT License</span>
                    </div>
                  </div>
                  <div className="pt-2 border-t border-border/50 flex justify-end">
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

      case 'agents':
        return <AgentsSettings />
      case 'learning':
        return (
          <div className="space-y-6">
            <MemorySettings />
            <LearningView />
          </div>
        )
      case 'channels':
        return <ChannelsSettings />
    }
  }

  return (
    <div className="fixed top-10 left-0 right-0 bottom-0 z-50 flex bg-background">
      {/* Left nav — width synced with the main sidebar */}
      {showSidebar && (
        <div
          className={`relative flex flex-col shrink-0 h-full overflow-hidden ${isResizing ? '' : 'transition-[width] duration-200 ease-out'}`}
          style={{ width: sidebarCollapsed ? 48 : navWidth }}
        >
          {sidebarCollapsed ? (
            <div className="flex-1 flex flex-col items-center pt-2 gap-1 overflow-y-auto">
              <button
                onClick={() => useHelixStore.getState().toggleSettings()}
                data-tip="返回"
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
                  data-tip={item.label}
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
              <div className="px-4 pt-2 pb-1 space-y-2">
                <button
                  onClick={() => useHelixStore.getState().toggleSettings()}
                  className="flex items-center gap-2 w-full px-3 py-2 text-[calc(var(--helix-transcript-size)*0.9286)] text-foreground/60 hover:text-foreground hover:bg-muted/80 rounded-xl transition-colors"
                >
                  <ChevronLeft className="size-4" />
                  返回
                </button>
                <div className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg border border-border/50 bg-transparent transition-all duration-150 focus-within:border-primary/40 focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_10%,transparent)] hover:border-border/70">
                  <Search className="size-3.5 text-muted-foreground/25 shrink-0" />
                  <input ref={navSearchRef} value={navSearch} onChange={e => setNavSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') { setNavSearch(''); (e.target as HTMLInputElement).blur() } }}
                    placeholder="搜索设置..." className="flex-1 bg-transparent text-[calc(var(--helix-transcript-size)*0.9286)] text-foreground placeholder:text-muted-foreground/30 focus:outline-none min-w-0" />
                  {navSearch && <button onClick={() => setNavSearch('')} className="text-muted-foreground/20 hover:text-foreground/60 shrink-0"><X className="size-3" /></button>}
                </div>
              </div>
              {(() => {
                const q = navSearch.trim().toLowerCase()
                const filtered = q
                  ? NAV_GROUPS.map(g => ({ ...g, items: g.items.filter(i => i.label.toLowerCase().includes(q)) })).filter(g => g.items.length)
                  : NAV_GROUPS
                if (!filtered.length) return <div className="px-5 py-8 text-center text-[calc(var(--helix-transcript-size)*0.9286)] text-muted-foreground/40">未找到匹配项</div>
                return (
                  <nav className="flex-1 overflow-y-auto pt-1 pb-2">
                    {filtered.map(group => (
                      <div key={group.title} className="mb-2">
                        <p className="px-5 py-1.5 text-[calc(var(--helix-transcript-size)*0.9286)] font-semibold text-muted-foreground/40 uppercase tracking-[0.12em] select-none">
                          {group.title}
                        </p>
                        <div className="space-y-0.5 px-2">
                        {group.items.map(item => (
                          <button
                            key={item.id}
                            onClick={() => {
                              setPage(item.id)
                              pushNavigation({ type: 'settings', page: item.id })
                              setNavSearch('')
                            }}
                            className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 text-[calc(var(--helix-transcript-size)*0.9286)] rounded-md transition-colors duration-100 ${
                              page === item.id
                                ? 'bg-muted text-foreground font-medium'
                                : 'text-foreground/65 hover:bg-muted/50 hover:text-foreground'
                            }`}
                          >
                            <item.icon className="size-4" />
                            {item.label}
                          </button>
                        ))}
                        </div>
                      </div>
                    ))}
                  </nav>
                )
              })()}
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

      {/* Right content — floating card */}
      <div className="flex-1 mt-3 mb-px ml-0 mr-px rounded-2xl border-0 bg-card shadow-2xl shadow-primary/5 overflow-y-auto relative">
        <div className="flex justify-center">
          <div className="px-8 pt-5 pb-10 w-full max-w-3xl">
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  )
}
