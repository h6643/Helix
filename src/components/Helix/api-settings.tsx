'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
  Settings, Sun, Moon, Plug, Archive, ChevronLeft, ChevronRight,
  Save, Eye, EyeOff, Trash2, Plus, Pencil,
  Globe, FileText, Keyboard, Terminal, Link,
  RefreshCw, GitBranch, GitCommit, GitPullRequest,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useHelixStore, DEFAULT_SHORTCUTS, type ApiConfig, type McpServerConfig } from '@/stores/helix-store'
import { getAllProviders, getModels, getBaseUrl } from '@/lib/helix/providers'
import { persistence, type PersistedSession } from '@/lib/persist'

const ALL_PROVIDERS = getAllProviders()

const TOP_PROVIDER_COUNT = 10
const CUSTOM_PROVIDER_ID = '__custom__'

interface SettingsProps {
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}

type SettingsPage = 'general' | 'appearance' | 'api' | 'shortcuts' | 'mcp' | 'archive' | 'git'

interface NavItem {
  id: SettingsPage
  label: string
  icon: typeof Settings
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
      { id: 'api', label: '配置', icon: Globe },
      { id: 'archive', label: '历史归档', icon: Archive },
      { id: 'shortcuts', label: '快捷键', icon: Keyboard },
    ],
  },
  {
    title: '集成',
    items: [
      { id: 'mcp', label: 'MCP 服务器', icon: Plug },
      { id: 'git', label: 'Git', icon: GitBranch },
    ],
  },
]

function ModelUsageStats() {
  const modelUsage = useHelixStore(s => s.modelUsage)
  const entries = Object.entries(modelUsage)

  if (entries.length === 0) return null

  const totalCost = entries.reduce((sum, [, u]) => sum + u.cost, 0)

  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium text-foreground">模型 Token 使用量</h3>
      <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
        <div className="grid grid-cols-4 gap-2 px-4 py-2 bg-muted/30 border-b border-border/50 text-xs font-medium text-foreground/60">
          <span>模型</span>
          <span className="text-right">输入</span>
          <span className="text-right">输出</span>
          <span className="text-right">成本</span>
        </div>
        {entries.sort((a, b) => b[1].total - a[1].total).map(([model, usage]) => (
          <div key={model} className="grid grid-cols-4 gap-2 px-4 py-2.5 border-b border-border/50 last:border-0 text-sm">
            <span className="font-mono text-foreground truncate">{model}</span>
            <span className="text-right text-foreground/70 font-mono">{formatTokens(usage.prompt)}</span>
            <span className="text-right text-foreground/70 font-mono">{formatTokens(usage.completion)}</span>
            <span className="text-right text-foreground/70 font-mono">${usage.cost.toFixed(4)}</span>
          </div>
        ))}
        <div className="grid grid-cols-4 gap-2 px-4 py-2.5 bg-muted/30 text-sm font-medium">
          <span>总计</span>
          <span className="text-right font-mono">{formatTokens(entries.reduce((s, [, u]) => s + u.prompt, 0))}</span>
          <span className="text-right font-mono">{formatTokens(entries.reduce((s, [, u]) => s + u.completion, 0))}</span>
          <span className="text-right font-mono">${totalCost.toFixed(4)}</span>
        </div>
      </div>
    </section>
  )
}

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

function UsageSummary() {
  const agentSteps = useHelixStore(s => s.agentExecutionSteps)
  const [usageHistory, setUsageHistory] = useState<Array<{ prompt: number; completion: number; cost: number; timestamp: number }>>([])

  useEffect(() => {
    const usages: Array<{ prompt: number; completion: number; cost: number; timestamp: number }> = []
    for (const step of agentSteps) {
      if (step.type === 'usage' && step.content) {
        const match = step.content.match(/Tokens: (\d+) total \| Cost: \$([\d.]+)/)
        if (match) {
          usages.push({
            prompt: 0,
            completion: 0,
            cost: parseFloat(match[2]),
            timestamp: step.timestamp,
          })
        }
      }
    }
    if (usages.length > 0) setUsageHistory(usages)
  }, [agentSteps])

  const totalCost = usageHistory.reduce((sum, u) => sum + u.cost, 0)
  const callCount = usageHistory.length

  if (callCount === 0) return null

  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium text-foreground">本次会话用量</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded-xl border border-border/50 bg-card/50 shadow-sm">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">API 调用</p>
          <p className="text-2xl font-semibold text-foreground mt-1">{callCount}</p>
        </div>
        <div className="p-3 rounded-xl border border-border/50 bg-card/50 shadow-sm">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">预估成本</p>
          <p className="text-2xl font-semibold text-foreground mt-1">${totalCost.toFixed(4)}</p>
        </div>
      </div>
      {totalCost > 1 && (
        <p className="text-xs text-amber-500">本次会话成本已超过 $1.00</p>
      )}
    </section>
  )
}

function ShortcutsPage() {
  const { customShortcuts, updateCustomShortcut, showToast } = useHelixStore()

  const shortcuts = Object.entries(customShortcuts)
  const defaultIds = Object.keys(DEFAULT_SHORTCUTS)
  const noopActions = new Set(['archive-chat', 'rename-chat', 'search-chats', 'next-chat', 'prev-chat', 'toggle-file-tree'])
  const systemShortcuts = shortcuts.filter(([id]) => defaultIds.includes(id) && !noopActions.has(id)).filter(([, s]) => s.keys.length > 0)

  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const startRecording = (id: string) => {
    setEditingId(id)
    setRecording(true)
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const handleRecordKeyDown = useCallback((e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const keys: string[] = []
    if (e.ctrlKey) keys.push('Ctrl')
    if (e.shiftKey) keys.push('Shift')
    if (e.altKey) keys.push('Alt')
    if (e.metaKey) keys.push('Meta')
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
      keys.push(key)
    }
    if (keys.length > 0) {
      const id = editingId
      if (id) {
        updateCustomShortcut(id, {
          ...customShortcuts[id],
          keys,
        })
        showToast({ type: 'success', title: '快捷键已更新', description: `${keys.join(' + ')} → ${customShortcuts[id].description}` })
      }
    }
    setRecording(false)
    setEditingId(null)
  }, [editingId, customShortcuts, updateCustomShortcut, showToast])

  useEffect(() => {
    if (recording) {
      window.addEventListener('keydown', handleRecordKeyDown, { capture: true })
      return () => window.removeEventListener('keydown', handleRecordKeyDown, { capture: true })
    }
  }, [recording, handleRecordKeyDown])

  const cancelRecording = () => {
    setRecording(false)
    setEditingId(null)
  }

  return (
    <div className="space-y-6">
      {systemShortcuts.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-base font-medium text-foreground">系统快捷键</h3>
          <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
            <div className="divide-y divide-border/50">
              {systemShortcuts.map(([id, s]) => (
                <div key={id} className="flex items-center px-4 py-2.5 hover:bg-accent/20 transition-colors group">
                  <span className="flex-1 text-sm text-foreground/60">{s.description}</span>
                  <span className="text-sm font-mono text-foreground/80 bg-muted px-2 py-1 rounded">{s.keys.join(' + ')}</span>
                  <button
                    onClick={() => startRecording(id)}
                    className="ml-3 p-1.5 rounded text-muted-foreground/20 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition-all"
                    title="编辑快捷键"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Recording overlay */}
      {recording && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-card/50 border border-border/50 rounded-xl p-6 shadow-xl max-w-sm w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-sm font-medium text-foreground">正在录制快捷键</span>
            </div>
            <div className="flex items-center justify-center gap-2 py-4 bg-muted rounded-lg mb-4">
              <input
                ref={inputRef}
                type="text"
                readOnly
                placeholder="按快捷键..."
                className="bg-transparent text-center text-lg font-mono text-foreground/80 outline-none w-full"
              />
            </div>
            <p className="text-xs text-foreground/40 text-center mb-3">按下新的按键组合，或按 Escape 取消</p>
            <button
              onClick={cancelRecording}
              className="w-full py-2 text-sm text-foreground/60 hover:text-foreground rounded-lg hover:bg-muted transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {shortcuts.length === 0 && (
        <p className="text-sm text-muted-foreground/50 text-center py-4">暂无快捷键</p>
      )}
    </div>
  )
}

// ─── MCP Form Component ────────────────────────────────────────────────────
interface McpFormData {
  name: string
  type: 'local' | 'remote'
  command: string
  url: string
  args: string
  env: Record<string, string>
  envPassthrough: boolean
  cwd: string
}

function McpEditorForm({
  form, onChange, onSave, onCancel, fullScreen,
}: {
  form: McpFormData
  onChange: (patch: Partial<McpFormData>) => void
  onSave: () => void
  onCancel: () => void
  fullScreen?: boolean
}) {
  const envEntries = Object.entries(form.env)
  const [newEnvKey, setNewEnvKey] = useState('')
  const [newEnvValue, setNewEnvValue] = useState('')

  const addEnvVar = () => {
    if (!newEnvKey.trim()) return
    onChange({ env: { ...form.env, [newEnvKey.trim()]: newEnvValue } })
    setNewEnvKey(''); setNewEnvValue('')
  }
  const removeEnvVar = (key: string) => {
    const { [key]: _, ...rest } = form.env
    onChange({ env: rest })
  }

  return (
    <div className={`rounded-2xl border border-border/60 bg-card overflow-hidden flex flex-col ${fullScreen ? 'flex-1' : ''}`}>
      <div className="px-4 py-3 bg-muted/30 border-b border-border/60 flex items-center gap-2">
        <Plug className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">
          {form.name ? `编辑 ${form.name}` : '添加 MCP 服务器'}
        </span>
      </div>

      <div className={`p-4 space-y-4 ${fullScreen ? 'flex-1 overflow-y-auto' : ''}`}>
        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">名称</label>
          <input type="text" value={form.name} onChange={e => onChange({ name: e.target.value })}
            placeholder="MCP server name"
            className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
        </div>

        {/* Type */}
        <div>
          <div className="flex gap-2">
            {([['local', 'STDIO', Terminal], ['remote', '流式 HTTP', Link]] as const).map(([t, label, Icon]) => (
              <button key={t} onClick={() => onChange({ type: t, command: '', url: '' })}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm transition-colors ${form.type === t ? 'border-primary bg-primary/10 text-primary' : 'border-border/50 text-muted-foreground hover:bg-accent/50'}`}>
                <Icon className="size-4" />{label}
              </button>
            ))}
          </div>
        </div>

        {/* Command / URL */}
        {form.type === 'local' ? (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">启动命令</label>
            <input type="text" value={form.command} onChange={e => onChange({ command: e.target.value })}
              placeholder="npx -y @modelcontextprotocol/server-filesystem ./data"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
          </div>
        ) : (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">URL</label>
            <input type="text" value={form.url} onChange={e => onChange({ url: e.target.value })}
              placeholder="http://localhost:3001/sse"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
          </div>
        )}

        {/* Args */}
        {form.type === 'local' && (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">参数</label>
            <input type="text" value={form.args} onChange={e => onChange({ args: e.target.value })}
              placeholder="--port 3000 --verbose"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
          </div>
        )}

        {/* Environment variables */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">环境变量</label>
          {envEntries.length > 0 && (
            <div className="space-y-1 mb-2">
              {envEntries.map(([key, val]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="text-xs font-mono text-foreground/60 bg-muted px-2 py-1 rounded flex-shrink-0">{key}</span>
                  <span className="text-xs text-foreground/30">=</span>
                  <span className="text-xs font-mono text-foreground/40 truncate flex-1">{val}</span>
                  <button onClick={() => removeEnvVar(key)} className="text-xs text-red-500 hover:text-red-600 shrink-0">删除</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input type="text" value={newEnvKey} onChange={e => setNewEnvKey(e.target.value)} placeholder="键"
              className="flex-1 px-2 py-1.5 bg-muted/50 border border-border/50 rounded text-xs font-mono" />
            <input type="text" value={newEnvValue} onChange={e => setNewEnvValue(e.target.value)} placeholder="值"
              className="flex-1 px-2 py-1.5 bg-muted/50 border border-border/50 rounded text-xs font-mono" />
            <button onClick={addEnvVar} className="px-2 py-1.5 bg-muted/50 border border-border/50 rounded text-xs hover:bg-accent/50 transition-colors">添加</button>
          </div>
          <label className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={form.envPassthrough} onChange={e => onChange({ envPassthrough: e.target.checked })}
              className="rounded border-border/50" />
            环境变量传递
          </label>
        </div>

        {/* Working directory */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">工作目录</label>
          <input type="text" value={form.cwd} onChange={e => onChange({ cwd: e.target.value })}
            placeholder="~/Helix"
            className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
        </div>
      </div>

      <div className="px-4 py-3 border-t border-border/50 bg-muted/10 flex justify-end gap-2 shrink-0">
        <Button variant="ghost" onClick={onCancel} size="sm">取消</Button>
        <Button onClick={onSave} size="sm" className="gap-1.5"><Save className="size-3.5" /> 保存</Button>
      </div>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────
export function ApiSettings({ theme, onToggleTheme }: SettingsProps) {
  const {
    apiConfig, apiHistory, setApiConfig, showToast, persistToStorage,
    addApiHistory, removeApiHistory, setAvailableModels, availableModels,
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
  } = useHelixStore()

  const [page, setPage] = useState<SettingsPage>('general')
  const [localConfig, setLocalConfig] = useState<ApiConfig>({ ...apiConfig })

  useEffect(() => {
    setIsCustomProvider(!!localConfig.provider && !ALL_PROVIDERS.some(p => p.id === localConfig.provider))
  }, [localConfig.provider])

  useEffect(() => {
    setLocalConfig({ ...apiConfig })
    setIsCustomProvider(!!apiConfig.provider && !ALL_PROVIDERS.some(p => p.id === apiConfig.provider))
  }, [apiConfig])

  const [showApiKey, setShowApiKey] = useState(false)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [isCustomProvider, setIsCustomProvider] = useState(false)
  const [customInputFocused, setCustomInputFocused] = useState(false)
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

  // Fetch MCP connection status
  const fetchMcpStatus = useCallback(() => {
    fetch('/api/mcp/status')
      .then(r => r.json())
      .then(data => {
        const statusMap: Record<string, boolean> = {}
        for (const s of data.servers || []) {
          statusMap[s.name] = s.connected
        }
        setMcpStatus(statusMap)
      })
      .catch(() => {})
  }, [])

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
    if (providerValue.trim().length > 0) {
      const match = ALL_PROVIDERS.find(p =>
        p.id.toLowerCase().includes(providerValue.trim().toLowerCase()) ||
        providerValue.trim().toLowerCase().includes(p.id.toLowerCase())
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

  const handleFetchModels = useCallback(async () => {
    if (!localConfig.apiKey.trim() || !localConfig.baseUrl.trim()) {
      showToast({ type: 'warning', title: '请先填写 Base URL 和 API Key' }); return
    }
    setIsLoadingModels(true)
    try {
      const response = await fetch('/api/models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: localConfig.baseUrl, apiKey: localConfig.apiKey }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`)
      const models = data.models || []
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

  const handleSaveApi = useCallback(async () => {
    if (!localConfig.apiKey.trim()) { showToast({ type: 'error', title: '请填写 API Key' }); return }
    if (!localConfig.baseUrl.trim()) { showToast({ type: 'error', title: '请填写 Base URL' }); return }
    if (!localConfig.model.trim()) { showToast({ type: 'error', title: '请填写模型名称' }); return }
    setApiConfig(localConfig); addApiHistory(localConfig); await persistToStorage()
    showToast({ type: 'success', title: 'API 配置已保存' })
  }, [localConfig, setApiConfig, addApiHistory, persistToStorage, showToast])

  const handleRemoveHistory = useCallback(async (e: React.MouseEvent, index: number) => {
    e.stopPropagation(); removeApiHistory(index); await persistToStorage()
  }, [removeApiHistory, persistToStorage])

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
    }))
    useHelixStore.getState().clearExecutionFlow()
    useHelixStore.setState({
      chatMessages: msgs,
      currentSessionId: session.id,
      selectedWorkDir: session.workDir || null,
    })
    showToast({ type: 'success', title: '已恢复', description: session.label })
  }, [showToast])

  // ── Git handlers ─────────────────────────────────────────────────────────
  const handleSaveGit = useCallback(async () => {
    await persistToStorage()
    showToast({ type: 'success', title: 'Git 设置已保存' })
  }, [persistToStorage, showToast])

  // ── Shared components ─────────────────────────────────────────────────────
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

  const SectionTitle = ({ children }: { children: React.ReactNode }) => (
    <div className="flex items-baseline gap-2 mb-4">
      <h3 className="text-lg font-semibold text-foreground">{children}</h3>
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
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <div className="px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center gap-2">
                  <FileText className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">项目提示词</span>
                </div>
                <div className="p-4">
                  <p className="text-xs text-muted-foreground/70 mb-3">
                    自定义指令，每次 LLM 调用时注入（支持 Helix.md 自动检测）
                  </p>
                  <textarea
                    value={customInstructions}
                    onChange={e => setCustomInstructions(e.target.value)}
                    placeholder="在此输入项目级自定义指令，例如：&#10;- 使用 pnpm 而非 npm&#10;- 遵循现有代码风格&#10;- 所有 API 需要错误处理"
                    className="w-full h-28 px-3 py-2 text-sm font-mono bg-muted/50 border border-border/50 rounded-lg resize-y
                      text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
            </section>

            <UsageSummary />
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
                <div className="px-4 py-3 bg-muted/30 border-b border-border/50">
                  <span className="text-sm font-medium text-foreground">编辑器设置</span>
                </div>
                <div className="divide-y divide-border">
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
                <div className="px-4 py-3 bg-muted/30 border-b border-border/50">
                  <span className="text-sm font-medium text-foreground">界面设置</span>
                </div>
                <div className="divide-y divide-border">
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
                      <p className="text-sm text-foreground">对话字号</p>
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
          <div className="max-w-2xl space-y-8">
            <SectionTitle>配置</SectionTitle>

            <section className="space-y-4">
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm">
                <div className="px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center gap-2">
                  <Globe className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">API 连接</span>
                </div>
                <div className="p-4 space-y-4 divide-y divide-border">
                  {/* Provider */}
                  <div className="pt-0 first:pt-0">
                    <label className="block text-sm font-medium text-foreground mb-1.5">Provider</label>
                    {!isCustomProvider ? (
                      <select
                        value={localConfig.provider}
                        onChange={(e) => handleSelectProvider(e.target.value)}
                        className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer appearance-none bg-[length:14px] bg-[right_10px_center] bg-no-repeat"
                        style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")` }}
                      >
                        <option value="">请选择 Provider</option>
                        {ALL_PROVIDERS.slice(0, TOP_PROVIDER_COUNT).map(p => (
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
                  <div className="pt-4">
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
                  <div className="pt-4">
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
                  <div className="pt-4">
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
                </div>
              </div>
            </section>

            {/* History */}
            {apiHistory.length > 0 && (
              <div>
                <label className="text-sm font-medium text-foreground mb-2 block">历史配置</label>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {apiHistory.map((h, i) => (
                    <div key={i} onClick={() => setLocalConfig({ ...h })}
                      className="flex items-center justify-between px-3.5 py-2.5 rounded-lg border border-border/50 bg-card/50 hover:border-primary/40 cursor-pointer transition-colors group">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{h.model}</p>
                        <p className="text-xs text-muted-foreground/70 truncate mt-0.5">{h.baseUrl}</p>
                      </div>
                      <button onClick={(e) => handleRemoveHistory(e, i)}
                        className="ml-2 p-1 rounded text-muted-foreground/20 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all">
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Model usage stats */}
            <ModelUsageStats />

            <div className="flex justify-center">
              <Button onClick={handleSaveApi} size="sm" className="gap-1.5">
                <Save className="size-3.5" /> 保存
              </Button>
            </div>
          </div>
        )

      case 'shortcuts':
        return (
          <div className="max-w-2xl">
            <ShortcutsPage />
          </div>
        )

      case 'mcp':
        if (isAddingMcp || editingMcpName) {
          return (
            <div className="max-w-2xl">
              <McpEditorForm
                form={mcpForm}
                onChange={handleMcpFormChange}
                onSave={handleSaveMcp}
                onCancel={() => { setIsAddingMcp(false); setEditingMcpName(null); resetMcpForm() }}
                fullScreen
              />
            </div>
          )
        }
        return (
          <div className="max-w-2xl space-y-6">
            <div className="flex items-center justify-between">
              <SectionTitle>MCP 服务器</SectionTitle>
              {!isAddingMcp && (
                <button
                  onClick={() => { setIsAddingMcp(true); resetMcpForm() }}
                  className="flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  <Plus className="size-4" /> 添加服务器
                </button>
              )}
            </div>

            {/* Server list */}
            <div className="space-y-2">
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

            {mcpServerNames.length === 0 && !isAddingMcp && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
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

            {isAddingMcp && (
              <McpEditorForm
                form={mcpForm}
                onChange={handleMcpFormChange}
                onSave={handleSaveMcp}
                onCancel={() => { setIsAddingMcp(false); setEditingMcpName(null); resetMcpForm() }}
              />
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
                <div className="px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center gap-2">
                  <GitCommit className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">自动提交</span>
                </div>
                <div className="p-4 space-y-4">
                  <SettingRow
                    icon={<GitCommit className="size-4 text-muted-foreground" />}
                    label="Agent 完成后自动 commit"
                    description="Agent 完成所有任务后，自动将变更提交到当前分支"
                  >
                    <Toggle enabled={gitAutoCommit} onToggle={() => setGitAutoCommit(!gitAutoCommit)} />
                  </SettingRow>

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
                </div>
              </div>

              {/* Auto-push */}
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <div className="px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center gap-2">
                  <GitPullRequest className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">自动推送</span>
                </div>
                <div className="p-4 space-y-4">
                  <SettingRow
                    icon={<GitPullRequest className="size-4 text-muted-foreground" />}
                    label="Commit 后自动 push"
                    description="自动提交后推送到远程仓库"
                  >
                    <Toggle enabled={gitAutoPush} onToggle={() => setGitAutoPush(!gitAutoPush)} />
                  </SettingRow>

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
                </div>
              </div>

              {/* Branch settings */}
              <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
                <div className="px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center gap-2">
                  <GitBranch className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">分支管理</span>
                </div>
                <div className="p-4 space-y-4">
                  <SettingRow
                    icon={<GitBranch className="size-4 text-muted-foreground" />}
                    label="自动创建特性分支"
                    description="Agent 开始时自动创建基于当前分支的特性分支"
                  >
                    <Toggle enabled={gitAutoBranch} onToggle={() => setGitAutoBranch(!gitAutoBranch)} />
                  </SettingRow>

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
                </div>
              </div>

              {/* Save */}
              <div className="flex justify-end pt-2">
                <Button onClick={handleSaveGit} size="sm" className="gap-1.5">
                  <Save className="size-3.5" /> 保存设置
                </Button>
              </div>
            </section>
          </div>
        )
    }
  }

  return (
    <div className="fixed top-11 left-0 right-0 bottom-0 z-50 flex bg-background">
      {/* Left nav */}
      <div className="w-[300px] bg-sidebar flex flex-col shrink-0 border-r border-border/40 h-full">
        <div className="px-4 py-2 border-b border-border/50">
          <button
            onClick={() => useHelixStore.getState().toggleSettings()}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-foreground/60 hover:text-foreground hover:bg-muted/80 rounded-xl transition-colors"
          >
            <ChevronLeft className="size-4" />
            返回
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {NAV_GROUPS.map(group => (
            <div key={group.title} className="mb-3">
              <p className="px-5 py-1.5 text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-[0.12em] select-none">
                {group.title}
              </p>
              {group.items.map(item => (
                <button
                  key={item.id}
                  onClick={() => setPage(item.id)}
                  className={`w-full flex items-center gap-2.5 pl-[26px] pr-4 py-2 text-sm rounded-xl transition-all ${
                    page === item.id
                      ? 'bg-muted font-medium'
                      : 'hover:bg-muted/50'
                  }`}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </div>

      {/* Right content */}
      <div className="flex-1 bg-background overflow-y-auto relative">
        <div className="px-8 pt-4 pb-8">
          {renderContent()}
        </div>
      </div>
    </div>
  )
}
