'use client'

import React, { useState, useEffect } from 'react'
import { useHelixStore } from '@/stores/helix-store'
import { SettingRow, SettingGroup, SectionHeading } from './settings-ui'

type SearchProvider = {
  id: string
  name: string
  envKey: string
  description: string
  signupUrl: string
  freeQuota?: string
}

const SEARCH_PROVIDERS: SearchProvider[] = [
  {
    id: 'tavily',
    name: 'Tavily',
    envKey: 'TAVILY_API_KEY',
    description: '搜索 + 内容提取 + 爬虫',
    signupUrl: 'https://app.tavily.com/home',
    freeQuota: '1000 次/月',
  },
  {
    id: 'brave-free',
    name: 'Brave Search (免费)',
    envKey: 'BRAVE_SEARCH_API_KEY',
    description: 'Brave 搜索 API 免费版',
    signupUrl: 'https://brave.com/search/api/',
    freeQuota: '2000 次/月',
  },
  {
    id: 'exa',
    name: 'Exa',
    envKey: 'EXA_API_KEY',
    description: '语义搜索',
    signupUrl: 'https://exa.ai',
    freeQuota: '1000 次/月',
  },
  {
    id: 'ddgs',
    name: 'DuckDuckGo',
    envKey: '',
    description: '免费，无需 API Key',
    signupUrl: '',
    freeQuota: '无限制',
  },
  {
    id: 'searxng',
    name: 'SearXNG',
    envKey: '',
    description: '自托管搜索引擎',
    signupUrl: 'https://docs.searxng.org',
  },
]

export function WebSearchSettings() {
  const showToast = useHelixStore((s) => s.showToast)
  const [activeProviders, setActiveProviders] = useState<string[]>([])
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // Load current config from hermes config.yaml
  useEffect(() => {
    // For now, read from localStorage as a fallback
    const saved = localStorage.getItem('helix-web-search')
    if (saved) {
      try {
        const data = JSON.parse(saved)
        setActiveProviders(data.activeProviders || (data.activeProvider ? [data.activeProvider] : []))
        setApiKeys(data.apiKeys || {})
      } catch {}
    }
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      // Save to localStorage for now
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

      showToast({ type: 'success', title: '搜索配置已保存' })
    } catch (e) {
      showToast({ type: 'error', title: '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-1">
      <SectionHeading>网页搜索</SectionHeading>

      <SettingGroup title="搜索引擎">
        {SEARCH_PROVIDERS.map((provider) => {
          const isSelected = activeProviders.includes(provider.id)
          return (
            <div key={provider.id}>
              <div
                onClick={() => {
                  if (isSelected) {
                    setActiveProviders(activeProviders.filter(id => id !== provider.id))
                  } else {
                    setActiveProviders([...activeProviders, provider.id])
                  }
                }}
                className="flex items-center gap-3 py-2.5 px-1 -mx-1 rounded-md hover:bg-muted/30 transition-colors cursor-pointer"
              >
                <span className="text-sm text-foreground min-w-0 flex-1">{provider.name}</span>
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-muted-foreground/30'}`}>
                  {isSelected && (
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
              </div>
              {isSelected && (
                <div className="ml-6 pl-3 border-l-2 border-primary/20 py-2 space-y-2">
                  <p className="text-xs text-muted-foreground">{provider.description}</p>
                  {provider.freeQuota && (
                    <p className="text-xs text-muted-foreground">免费额度: {provider.freeQuota}</p>
                  )}
                  {provider.signupUrl && (
                    <a
                      href={provider.signupUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline"
                    >
                      获取 API Key →
                    </a>
                  )}
                  {provider.envKey && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground whitespace-nowrap">API Key</span>
                      <input
                        type="password"
                        value={apiKeys[provider.envKey] || ''}
                        onChange={(e) => setApiKeys({ ...apiKeys, [provider.envKey]: e.target.value })}
                        placeholder={`输入 ${provider.envKey}`}
                        className="flex-1 px-3 py-1.5 text-sm border rounded-md bg-background"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </SettingGroup>

      <div className="flex justify-end pt-2">
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-1.5 text-sm font-medium text-primary-foreground bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  )
}
