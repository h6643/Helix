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
  const [activeProvider, setActiveProvider] = useState<string>('')
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // Load current config from hermes config.yaml
  useEffect(() => {
    // For now, read from localStorage as a fallback
    const saved = localStorage.getItem('helix-web-search')
    if (saved) {
      try {
        const data = JSON.parse(saved)
        setActiveProvider(data.activeProvider || '')
        setApiKeys(data.apiKeys || {})
      } catch {}
    }
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      // Save to localStorage for now
      localStorage.setItem('helix-web-search', JSON.stringify({
        activeProvider,
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
        {SEARCH_PROVIDERS.map((provider) => (
          <SettingRow key={provider.id} label={provider.name}>
            <div className="flex items-center gap-2">
              <input
                type="radio"
                name="search-provider"
                checked={activeProvider === provider.id}
                onChange={() => setActiveProvider(provider.id)}
                className="w-4 h-4 text-primary"
              />
            </div>
          </SettingRow>
        ))}
      </SettingGroup>

      {activeProvider && (() => {
        const provider = SEARCH_PROVIDERS.find(p => p.id === activeProvider)
        if (!provider) return null

        return (
          <SettingGroup title={`${provider.name} 配置`}>
            <div className="px-1 py-2 space-y-2">
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
                <SettingRow label="API Key">
                  <input
                    type="password"
                    value={apiKeys[provider.envKey] || ''}
                    onChange={(e) => setApiKeys({ ...apiKeys, [provider.envKey]: e.target.value })}
                    placeholder={`输入 ${provider.envKey}`}
                    className="w-64 px-3 py-1.5 text-sm border rounded-md bg-background"
                  />
                </SettingRow>
              )}
            </div>
          </SettingGroup>
        )
      })()}

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
