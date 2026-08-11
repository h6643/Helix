'use client'

import React, { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { useHelixStore } from '@/stores/helix-store'
import { PopupSelect, SettingGroup } from './settings-ui'
import { isElectron } from '@/lib/electron-bridge'
import { getAllProviders } from '@/lib/providers'

const VISION_PROVIDERS = [
  { id: 'auto', name: '自动（探测主 provider 视觉能力）' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'nous', name: 'Nous' },
  { id: 'gemini', name: 'Gemini' },
  { id: 'zai', name: 'Zhipu AI (z.ai) / GLM' },
  { id: 'openai', name: 'OpenAI（别名→custom）' },
  { id: 'codex', name: 'Codex' },
  { id: 'ollama-cloud', name: 'Ollama Cloud' },
  { id: 'main', name: '主 Provider' },
  { id: '__custom__', name: '＋ 自定义（本地/自建，填 base_url）' },
]

export function VisionModelSettings() {
  const showToast = useHelixStore((s) => s.showToast)
  const [provider, setProvider] = useState('auto')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const load = async () => {
      if (!isElectron()) {
        const saved = localStorage.getItem('helix-vision-model')
        if (saved) {
          try {
            const d = JSON.parse(saved)
            setProvider(d.provider || 'auto')
            setModel(d.model || '')
            setBaseUrl(d.baseUrl || '')
            setApiKey(d.apiKey || '')
          } catch {}
        }
        return
      }
      try {
        const api = (window as any).electron?.vision
        if (!api?.getConfig) return
        const r = await api.getConfig()
        if (r?.ok && r.config) {
          setProvider(r.config.provider || 'auto')
          setModel(r.config.model || '')
          setBaseUrl(r.config.baseUrl || '')
          setApiKey(r.config.apiKey || '')
        }
      } catch (e) {
        console.error('[VisionModelSettings] load failed:', e)
      }
    }
    load()
  }, [])

  const isCustom = provider === '__custom__'
  const openrouterModels = getAllProviders().find((p) => p.id === 'openrouter')?.models ?? []
  // 各 provider 的视觉模型候选：仅这些 key 在下拉中给出可选模型，其余（auto/nous/codex/main 等）需手填
  const geminiModels = getAllProviders().find((p) => p.id === 'gemini')?.models ?? []
  const VISION_MODELS: Record<string, string[]> = {
    openrouter: openrouterModels,
    gemini: Array.from(new Set([...geminiModels, 'gemini-3.6-flash'])),
    zai: ['glm-5v-turbo', 'glm-4v-flash', 'glm-4v-plus'],
  }

  const save = async () => {
    setSaving(true)
    try {
      const config = {
        provider: isCustom ? 'custom' : provider,
        model,
        baseUrl: isCustom ? baseUrl : '',
        apiKey: isCustom ? apiKey : '',
      }
      if (isElectron()) {
        const api = (window as any).electron?.vision
        if (api?.setConfig) await api.setConfig(config)
      } else {
        localStorage.setItem('helix-vision-model', JSON.stringify(config))
      }
      showToast({ type: 'success', title: '视觉模型配置已保存' })
    } catch (e) {
      showToast({ type: 'error', title: '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-1">
      <SettingGroup title="视觉模型（独立后端）">
        <p className="text-xs text-muted-foreground mb-3">
          主模型不支持看图时，图片会先送独立视觉模型识别成文字再交给主模型。全部留空则禁用视觉理解。
        </p>

        {/* Provider */}
        <div className="mb-3">
          <label className="block text-sm font-medium text-foreground mb-1.5">Provider</label>
          <PopupSelect
            value={provider}
            onChange={setProvider}
            placeholder="选择视觉 Provider"
            popupWidth={340}
            className="w-full px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md text-xs font-mono text-foreground/70 focus:outline-none focus:border-primary/30 transition-colors"
            options={VISION_PROVIDERS.map((p) => ({ label: p.name, value: p.id }))}
          />
        </div>

        {/* Model */}
        <div className="mb-3">
          <label className="block text-sm font-medium text-foreground mb-1.5">模型名称</label>
          {(VISION_MODELS[provider]?.length ?? 0) > 0 ? (
            <PopupSelect
              value={model}
              onChange={setModel}
              placeholder="选择模型"
              popupWidth={340}
              className="w-full px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md text-xs font-mono text-foreground/70 focus:outline-none focus:border-primary/30 transition-colors"
              options={VISION_MODELS[provider].map((m) => ({ label: m, value: m }))}
            />
          ) : (
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="如 openai/gpt-4o、glm-5v-turbo、gemini-2.5-pro-0325"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          )}
        </div>

        {/* Custom only: base_url + api_key */}
        {isCustom && (
          <>
            <div className="mb-3">
              <label className="block text-sm font-medium text-foreground mb-1.5">Base URL</label>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://your-vlm-endpoint/v1"
                className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
              />
            </div>
            <div className="mb-3">
              <label className="block text-sm font-medium text-foreground mb-1.5">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
              />
            </div>
          </>
        )}
      </SettingGroup>

      <div className="flex justify-end pt-2">
        <Button size="sm" variant="outline" onClick={save} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </Button>
      </div>
    </div>
  )
}
