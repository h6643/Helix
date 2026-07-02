'use client'

import React, { useState, useCallback, useEffect } from 'react'
import {
  X, Save, Eye, EyeOff, RotateCcw, Zap, Trash2, Clock,
  Target, Brain, Cpu, FolderOpen, Moon, Sun, ChevronLeft, ZapOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useHelixStore, PROVIDER_PRESETS, type ApiProvider, type ApiConfig } from '@/stores/helix-store'

const QUICK_PRESETS: { provider: ApiProvider; label: string; baseUrl: string; model: string }[] = [
  { provider: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { provider: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { provider: 'mimo', label: 'MiMo', baseUrl: 'https://api.mimo.ai/v1', model: 'mimo-auto' },
]

function maskKey(key: string): string {
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

interface SettingsProps {
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}

export function ApiSettings({ theme, onToggleTheme }: SettingsProps) {
  const {
    apiConfig, apiHistory, setApiConfig, toggleSettings, showToast, persistToStorage,
    addApiHistory, removeApiHistory, setAvailableModels,
    showTaskPanel, showMemoryPanel, showSubAgentPanel,
    toggleTaskPanel, toggleMemoryPanel, toggleSubAgentPanel, toggleSessionManager,
    subAgents,
  } = useHelixStore()

  const [page, setPage] = useState<'main' | 'api'>('main')
  const [localConfig, setLocalConfig] = useState<ApiConfig>({ ...apiConfig })
  const [showApiKey, setShowApiKey] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [showModelDropdown, setShowModelDropdown] = useState(false)

  // Close model dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('[data-model-dropdown]')) {
        setShowModelDropdown(false)
      }
    }
    if (showModelDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showModelDropdown])

  const handleQuickPreset = useCallback((preset: typeof QUICK_PRESETS[number]) => {
    setLocalConfig(prev => ({
      ...prev,
      provider: preset.provider,
      baseUrl: preset.baseUrl,
      model: preset.model,
    }))
  }, [])

  // Fetch available models from API (via proxy to avoid CORS)
  const handleFetchModels = useCallback(async () => {
    if (!localConfig.apiKey.trim() || !localConfig.baseUrl.trim()) {
      showToast({ type: 'warning', title: '请先填写 Base URL 和 API Key' })
      return
    }

    setIsLoadingModels(true)
    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: localConfig.baseUrl,
          apiKey: localConfig.apiKey,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || `请求失败 (${response.status})`)
      }

      const models = data.models || []
      
      if (models.length === 0) {
        showToast({ type: 'warning', title: '未获取到模型，请检查 API 地址和密钥' })
      } else {
        setFetchedModels(models)
        setAvailableModels(models)
        showToast({ type: 'success', title: `获取到 ${models.length} 个模型` })
      }
    } catch (error) {
      console.error('Fetch models error:', error)
      const message = error instanceof Error ? error.message : '获取模型列表失败'
      showToast({ type: 'error', title: message })
      setFetchedModels([])
      setAvailableModels([])
    } finally {
      setIsLoadingModels(false)
    }
  }, [localConfig.apiKey, localConfig.baseUrl, showToast, setAvailableModels])

  const handleSaveApi = useCallback(async () => {
    if (!localConfig.apiKey.trim()) {
      showToast({ type: 'error', title: '请填写 API Key' })
      return
    }
    if (!localConfig.baseUrl.trim()) {
      showToast({ type: 'error', title: '请填写 Base URL' })
      return
    }
    if (!localConfig.model.trim()) {
      showToast({ type: 'error', title: '请填写模型名称' })
      return
    }
    setApiConfig(localConfig)
    addApiHistory(localConfig)
    await persistToStorage()
    showToast({ type: 'success', title: 'API 配置已保存' })
    setPage('main')
  }, [localConfig, setApiConfig, addApiHistory, persistToStorage, showToast])

  const handleSelectHistory = useCallback((index: number) => {
    const config = apiHistory[index]
    if (config) {
      setLocalConfig({ ...config })
    }
  }, [apiHistory])

  const handleRemoveHistory = useCallback(async (e: React.MouseEvent, index: number) => {
    e.stopPropagation()
    removeApiHistory(index)
    await persistToStorage()
  }, [removeApiHistory, persistToStorage])

  const handleResetApi = useCallback(() => {
    setLocalConfig({ provider: 'custom', apiKey: '', baseUrl: '', model: '' })
  }, [])

  const isActive = (h: ApiConfig) =>
    h.baseUrl === localConfig.baseUrl && h.apiKey === localConfig.apiKey && h.model === localConfig.model

  const panels = [
    { id: 'tasks', label: '任务', icon: Target, active: showTaskPanel, toggle: toggleTaskPanel },
    { id: 'memory', label: '记忆', icon: Brain, active: showMemoryPanel, toggle: toggleMemoryPanel },
    { id: 'sub-agents', label: '子任务', icon: Cpu, active: showSubAgentPanel, toggle: toggleSubAgentPanel },
    { id: 'sessions', label: '会话', icon: FolderOpen, active: false, toggle: toggleSessionManager },
  ]

  const hasApiConfig = !!apiConfig.apiKey

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            {page === 'api' && (
              <button
                onClick={() => setPage('main')}
                className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronLeft className="size-4" />
              </button>
            )}
            <h2 className="text-lg font-semibold text-foreground">
              {page === 'main' ? '设置' : 'API 配置'}
            </h2>
          </div>
          <button
            onClick={toggleSettings}
            className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {page === 'main' ? (
            <>
              {/* Theme */}
              <section>
                <h3 className="text-sm font-medium text-foreground mb-2">外观</h3>
                <button
                  onClick={onToggleTheme}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-muted/30 hover:bg-muted/50 transition-colors"
                >
                  <span className="text-xs text-foreground">主题</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {theme === 'dark' ? '深色' : '浅色'}
                    {theme === 'dark' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
                  </span>
                </button>
              </section>

              {/* Panels */}
              <section>
                <h3 className="text-sm font-medium text-foreground mb-2">面板</h3>
                <div className="space-y-1.5">
                  {panels.map(p => (
                    <button
                      key={p.id}
                      onClick={p.toggle}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border transition-colors ${
                        p.active
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <p.icon className="size-3.5" />
                        <span className="text-xs font-medium">{p.label}</span>
                      </div>
                      {p.active && <span className="text-[10px] bg-primary/20 px-1.5 py-0.5 rounded">已打开</span>}
                    </button>
                  ))}
                  {subAgents.some(a => a.status === 'running') && (
                    <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-primary">
                      <Cpu className="size-3 animate-pulse" />
                      {subAgents.filter(a => a.status === 'running').length} 个子任务运行中
                    </div>
                  )}
                </div>
              </section>

              {/* API Entry */}
              <section>
                <h3 className="text-sm font-medium text-foreground mb-2">模型</h3>
                <button
                  onClick={() => setPage('api')}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-border bg-muted/30 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {hasApiConfig ? <Zap className="size-3.5 text-primary" /> : <ZapOff className="size-3.5 text-muted-foreground" />}
                    <span className="text-xs text-foreground">API 配置</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {hasApiConfig ? (
                      <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded">{apiConfig.model}</span>
                    ) : (
                      <span className="text-[10px]">未配置</span>
                    )}
                    <ChevronLeft className="size-3 rotate-180" />
                  </div>
                </button>
              </section>
            </>
          ) : (
            /* API Config Page */
            <>
              {/* History */}
              {apiHistory.length > 0 && (
                <div>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-foreground mb-1.5">
                    <Clock className="size-3" />
                    历史配置
                  </label>
                  <div className="space-y-1 max-h-28 overflow-y-auto">
                    {apiHistory.map((h, i) => (
                      <div
                        key={`${h.baseUrl}-${h.apiKey}-${h.model}-${i}`}
                        onClick={() => handleSelectHistory(i)}
                        className={`flex items-center justify-between px-3 py-2 rounded-lg border cursor-pointer transition-colors group ${
                          isActive(h)
                            ? 'border-primary bg-primary/10'
                            : 'border-border bg-muted/20 hover:border-primary/50 hover:bg-muted/40'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium text-foreground truncate">{h.model}</span>
                            <span className="text-[10px] text-muted-foreground truncate">{h.baseUrl}</span>
                          </div>
                          <span className="text-[10px] text-muted-foreground/50 font-mono">{maskKey(h.apiKey)}</span>
                        </div>
                        <button
                          onClick={(e) => handleRemoveHistory(e, i)}
                          className="ml-2 p-1 rounded text-muted-foreground/30 hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quick presets */}
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">快速选择</label>
                <div className="flex gap-1.5">
                  {QUICK_PRESETS.map(preset => (
                    <button
                      key={preset.provider}
                      onClick={() => handleQuickPreset(preset)}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition-colors ${
                        localConfig.baseUrl === preset.baseUrl && localConfig.model === preset.model
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:border-primary/50'
                      }`}
                    >
                      <Zap className="size-2.5" />
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Base URL */}
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Base URL</label>
                <input
                  type="text"
                  value={localConfig.baseUrl}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, baseUrl: e.target.value }))}
                  placeholder="https://api.openai.com/v1"
                  className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                />
              </div>

              {/* API Key */}
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">API Key</label>
                <div className="relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={localConfig.apiKey}
                    onChange={(e) => setLocalConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                    placeholder="sk-..."
                    className="w-full px-3 py-2 pr-10 bg-muted border border-border rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                  >
                    {showApiKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
              </div>

              {/* Model */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-foreground">模型名称</label>
                  <button
                    type="button"
                    onClick={handleFetchModels}
                    disabled={isLoadingModels}
                    className="text-[10px] text-primary hover:text-primary/80 disabled:text-muted-foreground transition-colors"
                  >
                    {isLoadingModels ? '获取中...' : '获取模型列表'}
                  </button>
                </div>
                {fetchedModels.length > 0 ? (
                  <div className="relative" data-model-dropdown>
                    <input
                      type="text"
                      value={localConfig.model}
                      onChange={(e) => setLocalConfig(prev => ({ ...prev, model: e.target.value }))}
                      onFocus={() => setShowModelDropdown(true)}
                      placeholder="选择或输入模型名称"
                      className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                    />
                    {showModelDropdown && (
                      <div className="absolute top-full left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-white border border-border rounded-lg shadow-lg z-50">
                        {fetchedModels
                          .filter(m => m.toLowerCase().includes(localConfig.model.toLowerCase()))
                          .map(model => (
                            <button
                              key={model}
                              type="button"
                              onClick={() => {
                                setLocalConfig(prev => ({ ...prev, model }))
                                setShowModelDropdown(false)
                              }}
                              className={`w-full text-left px-3 py-1.5 text-[11px] font-mono hover:bg-muted transition-colors ${
                                localConfig.model === model ? 'bg-primary/10 text-primary' : 'text-foreground'
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
                    className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                  />
                )}
              </div>

              <p className="text-[10px] text-muted-foreground/50">
                API Key 仅存储在浏览器本地
              </p>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-muted/30 shrink-0">
          {page === 'api' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetApi}
              className="text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="size-3 mr-1.5" />
              清空
            </Button>
          ) : (
            <div />
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={toggleSettings}>
              {page === 'api' ? '返回' : '关闭'}
            </Button>
            {page === 'api' && (
              <Button size="sm" onClick={handleSaveApi}>
                <Save className="size-3 mr-1.5" />
                保存
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
