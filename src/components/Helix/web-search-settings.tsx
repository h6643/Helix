'use client'

import React, { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { useHelixStore } from '@/stores/helix-store'
import { isElectron } from '@/lib/electron-bridge'

type SearchProvider = {
  id: string
  // 对应 hermes 插件目录名（plugins/web/<pluginName>），用于和实际安装的插件对齐
  pluginName: string
  name: string
  envKey: string
  description: string
  signupUrl: string
  freeQuota?: string
}

const SEARCH_PROVIDERS: SearchProvider[] = [
  {
    id: 'tavily',
    pluginName: 'tavily',
    name: 'Tavily',
    envKey: 'TAVILY_API_KEY',
    description: '搜索 + 内容提取 + 爬虫',
    signupUrl: 'https://app.tavily.com/home',
    freeQuota: '1000 次/月',
  },
  {
    id: 'brave-free',
    pluginName: 'brave_free',
    name: 'Brave Search (免费)',
    envKey: 'BRAVE_SEARCH_API_KEY',
    description: 'Brave 搜索 API 免费版',
    signupUrl: 'https://brave.com/search/api/',
    freeQuota: '2000 次/月',
  },
  {
    id: 'exa',
    pluginName: 'exa',
    name: 'Exa',
    envKey: 'EXA_API_KEY',
    description: '语义搜索',
    signupUrl: 'https://exa.ai',
    freeQuota: '1000 次/月',
  },
  {
    id: 'ddgs',
    pluginName: 'ddgs',
    name: 'DuckDuckGo',
    envKey: '',
    description: '免费，无需 API Key',
    signupUrl: '',
    freeQuota: '无限制',
  },
  {
    id: 'searxng',
    pluginName: 'searxng',
    name: 'SearXNG',
    envKey: '',
    description: '自托管搜索引擎',
    signupUrl: 'https://docs.searxng.org',
  },
]

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-2 mb-4 ${className || ''}`}>
      <h3 className="ui-text text-foreground">{children}</h3>
    </div>
  )
}

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

// 后端有几个 web 插件就显示几个：
// - null（未加载 / 非 Tauri 环境）→ 兜底显示前端硬编码的全部候选
// - 非空数组 → 以「后端实际安装的插件」为准，逐一渲染；
//   若某个插件前端没有候选元信息（name/描述/signup 等），用插件名兜底展示
function buildDisplayProviders(available: string[] | null): SearchProvider[] {
  if (!available) return SEARCH_PROVIDERS
  return available.map((name) => {
    const known = SEARCH_PROVIDERS.find((p) => p.pluginName === name)
    if (known) return known
    return {
      id: name,
      pluginName: name,
      name,
      envKey: '',
      description: '后端已安装此搜索后端，前端暂未提供其配置项',
      signupUrl: '',
    }
  })
}

export function WebSearchSettings() {
  const showToast = useHelixStore((s) => s.showToast)
  const [activeProviders, setActiveProviders] = useState<string[]>([])
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  // null = 尚未从后端拿到可用插件列表（非 Tauri 环境或加载中），此时显示全部候选
  const [availableProviders, setAvailableProviders] = useState<string[] | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Load current config from hermes config.yaml via Tauri
  useEffect(() => {
    const loadConfig = async () => {
      if (!isElectron()) {
        // Fallback to localStorage for non-Tauri environments
        const saved = localStorage.getItem('helix-web-search')
        if (saved) {
          try {
            const data = JSON.parse(saved)
            setActiveProviders(data.activeProviders || (data.activeProvider ? [data.activeProvider] : []))
            setApiKeys(data.apiKeys || {})
          } catch {}
        }
        return
      }

      try {
        const api = (window as any).electron?.webSearch
        if (!api?.getConfig) return
        const result = await api.getConfig()
        if (result?.ok && result.config) {
          const { search_backend, apiKeys: keys } = result.config
          // Map search_backend to active providers
          const providers: string[] = []
          if (search_backend === 'tavily' || keys?.tavily) providers.push('tavily')
          if (search_backend === 'brave' || keys?.brave) providers.push('brave-free')
          if (search_backend === 'exa' || keys?.exa) providers.push('exa')
          if (search_backend === 'ddgs') providers.push('ddgs')
          if (search_backend === 'searxng') providers.push('searxng')
          setActiveProviders(providers)
          setApiKeys(keys || {})
          if (Array.isArray((result as any).availableProviders)) {
            setAvailableProviders((result as any).availableProviders as string[])
          }
        }
      } catch (e) {
        console.error('[WebSearchSettings] Failed to load config:', e)
      }
    }
    loadConfig()
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      // Determine search_backend from active providers
      let searchBackend = ''
      if (activeProviders.includes('tavily')) searchBackend = 'tavily'
      else if (activeProviders.includes('brave-free')) searchBackend = 'brave'
      else if (activeProviders.includes('exa')) searchBackend = 'exa'
      else if (activeProviders.includes('ddgs')) searchBackend = 'ddgs'
      else if (activeProviders.includes('searxng')) searchBackend = 'searxng'

      const config = {
        backend: searchBackend,
        search_backend: searchBackend,
        apiKeys: apiKeys,
      }

      if (isElectron()) {
        const api = (window as any).electron?.webSearch
        if (api?.setConfig) {
          await api.setConfig(config)
        }
      } else {
        // Fallback to localStorage
        localStorage.setItem('helix-web-search', JSON.stringify({
          activeProviders,
          apiKeys,
        }))
        // Also set environment variables for the current session
        for (const [key, value] of Object.entries(apiKeys)) {
          if (value) {
            process.env[key] = value
          }
        }
      }

      showToast({ type: 'success', title: '搜索配置已保存' })
    } catch (e) {
      showToast({ type: 'error', title: '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  const displayProviders = buildDisplayProviders(availableProviders)

  return (
    <div className="max-w-3xl space-y-4">
      <SectionTitle>搜索引擎</SectionTitle>

      {availableProviders !== null && displayProviders.length === 0 ? (
        <p className="text-xs text-muted-foreground/60">
          暂无后端搜索插件，请在 hermes 中安装 plugins/web/&lt;name&gt; 后再来此处配置。
        </p>
      ) : (
        <div className="border border-border/50 rounded-xl overflow-hidden divide-y divide-border/50">
          {displayProviders.map((provider) => {
            const isSelected = activeProviders.includes(provider.id)
            const known = SEARCH_PROVIDERS.some((p) => p.pluginName === provider.pluginName)
            return (
              <div key={provider.id}>
                <div className="flex items-center justify-between p-4 hover:bg-accent/30 transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="ui-text font-medium text-foreground">{provider.name}</p>
                    <p className="text-xs text-muted-foreground/60 mt-0.5">{provider.description}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-4">
                    <button
                      onClick={() => setExpandedId(expandedId === provider.id ? null : provider.id)}
                      className="px-3 py-1.5 text-xs font-medium text-foreground border border-border/50 rounded-lg hover:bg-accent/60 transition-colors"
                    >
                      {expandedId === provider.id ? '收起' : '配置'}
                    </button>
                    <Toggle
                      enabled={isSelected}
                      onToggle={() => {
                        if (isSelected) {
                          setActiveProviders(activeProviders.filter(id => id !== provider.id))
                        } else {
                          setActiveProviders([...activeProviders, provider.id])
                        }
                      }}
                    />
                  </div>
                </div>
                {expandedId === provider.id && (
                  <div className="px-4 pb-4 pt-2 bg-muted/20 space-y-3">
                    {provider.freeQuota && (
                      <p className="text-xs text-muted-foreground">免费额度: {provider.freeQuota}</p>
                    )}
                    {provider.signupUrl && (
                      <a
                        href={provider.signupUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline block"
                      >
                        获取 API Key →
                      </a>
                    )}
                    {provider.envKey ? (
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          API Key ({provider.envKey})
                        </label>
                        <input
                          type="password"
                          value={apiKeys[provider.envKey] || ''}
                          onChange={(e) => setApiKeys({ ...apiKeys, [provider.envKey]: e.target.value })}
                          placeholder={`输入 ${provider.envKey}`}
                          className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground text-center placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground/60">
                        {known
                          ? '此引擎无需 API Key，开启开关即可使用。'
                          : '前端暂未配置此引擎的 API Key 字段，请在后端插件中设置。'}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="flex justify-end pt-2">
        <Button size="sm" variant="outline" onClick={save} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </Button>
      </div>
    </div>
  )
}
