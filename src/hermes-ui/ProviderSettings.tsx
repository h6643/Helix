// Provider 配置界面 —— 表格/卡片展示所有 Provider，支持增删改。
//
// 模型列用法：逗号分隔输入，例如 "Ling-2.6-1T, Ling-2.6-Pro, Ling-2.6-Max"，
// 失焦时解析为数组。这些模型会自动出现在对话界面的下拉列表中。
//
// 本组件是「展示型」的：providers / activeModel / onUpsert / onRemove /
// onSelectModel 都通过 props 传入，因此既能被主流程的 useHelixStore 使用，
// 也能在独立场景下回退到 hermes-ui 自带的 useProviderStore —— 从而保持
// hermes-ui 模块的独立性，不被拆散到主流程各处。
'use client'

import { useState } from 'react'
import { Globe, Plus, Trash2, Eye, EyeOff, Check } from 'lucide-react'
import { useProviderStore } from './provider-store'
import type { ProviderConfig } from './types'

/** 来自主流程或独立 store 的 Provider 数据，结构需与 ProviderConfig 兼容。 */
export interface ProviderSettingsProps {
  /** Provider 列表数据源；不传则回退到 hermes-ui 自带 store（独立使用场景）。 */
  providers?: ProviderConfig[]
  /** 当前选中的模型名；用于高亮其所属 Provider。 */
  activeModel?: string | null
  /** 新增或更新一个 Provider（id 存在即更新，否则新增）；不传则回退到自带 store。 */
  onUpsert?: (input: Omit<ProviderConfig, 'id'> & { id?: string }) => void
  /** 删除一个 Provider；不传则回退到自带 store。 */
  onRemove?: (id: string) => void
  /** 选中某个模型作为当前模型（更新 activeModel）。 */
  onSelectModel?: (model: string) => void
  className?: string
}

function parseModels(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// ── 单个 Provider 卡片（内联可编辑） ────────────────────────────────────────
function ProviderCard({
  provider,
  activeModel,
  onUpsert,
  onRemove,
  onSelectModel,
}: {
  provider: ProviderConfig
  activeModel: string | null
  onUpsert: (input: Omit<ProviderConfig, 'id'> & { id?: string }) => void
  onRemove: (id: string) => void
  onSelectModel: (model: string) => void
}) {
  const [name, setName] = useState(provider.name)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [apiKey, setApiKey] = useState(provider.apiKey)
  const [modelsText, setModelsText] = useState(provider.models.join(', '))
  const [showKey, setShowKey] = useState(false)

  const commit = (patch: Partial<Omit<ProviderConfig, 'id'>>) =>
    onUpsert({ ...provider, ...patch })

  const isActiveProvider = !!activeModel && provider.models.includes(activeModel)

  return (
    <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Globe className="size-4 text-muted-foreground shrink-0" />
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); commit({ name: e.target.value }) }}
            placeholder="Provider 名称"
            className="bg-transparent text-sm font-medium text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring rounded px-1 py-0.5 font-mono"
          />
          {isActiveProvider && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary shrink-0">
              当前
            </span>
          )}
        </div>
        <button
          onClick={() => onRemove(provider.id)}
          className="p-1.5 rounded-lg text-muted-foreground/40 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 transition-colors shrink-0"
          title="删除 Provider"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <div className="p-4 space-y-3">
        {/* Base URL */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Base URL</label>
          <input
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); commit({ baseUrl: e.target.value }) }}
            placeholder="https://api.example.com/v1"
            className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          />
        </div>

        {/* API Key */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">API Key</label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); commit({ apiKey: e.target.value }) }}
              placeholder="sk-..."
              className="w-full px-3 py-2 pr-10 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground/50 hover:text-foreground transition-colors"
            >
              {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>

        {/* Models（逗号分隔） */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            模型（逗号分隔）
          </label>
          <input
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
            onBlur={() => commit({ models: parseModels(modelsText) })}
            placeholder="Ling-2.6-1T, Ling-2.6-Pro, Ling-2.6-Max"
            className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          />
        </div>

        {/* 模型快捷选择（点击即设为当前） */}
        {provider.models.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {provider.models.map((m) => {
              const active = m === activeModel
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => onSelectModel(m)}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-mono transition-colors ${
                    active
                      ? 'bg-primary/15 text-primary'
                      : 'bg-muted/60 text-foreground/70 hover:bg-muted'
                  }`}
                  title={active ? '当前模型' : '设为当前模型'}
                >
                  {active && <Check className="size-3" />}
                  {m}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 主组件 ─────────────────────────────────────────────────────────────────
export function ProviderSettings(props: ProviderSettingsProps) {
  // 主流程场景：providers / 回调由 props 提供；独立场景回退到自带 store。
  const storeProviders = useProviderStore((s) => s.providers)
  const storeUpdate = useProviderStore((s) => s.updateProvider)
  const storeAdd = useProviderStore((s) => s.addProvider)
  const storeRemove = useProviderStore((s) => s.removeProvider)
  const storeSelect = useProviderStore((s) => s.setActiveModel)

  const providers = props.providers ?? storeProviders
  const activeModel = props.activeModel ?? null
  const upsert: (input: Omit<ProviderConfig, 'id'> & { id?: string }) => void =
    props.onUpsert ?? ((input) => {
      if (input.id) storeUpdate(input.id, input)
      else storeAdd(input)
    })
  const remove: (id: string) => void = props.onRemove ?? storeRemove
  const select: (model: string) => void = props.onSelectModel ?? storeSelect

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelsText, setModelsText] = useState('')

  const onAdd = () => {
    if (!name.trim() || !baseUrl.trim()) return
    upsert({
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      models: parseModels(modelsText),
    })
    setName('')
    setBaseUrl('')
    setApiKey('')
    setModelsText('')
  }

  return (
    <div className={`space-y-3 ${props.className ?? ''}`}>
      {providers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-card/30 px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground/70">暂无 Provider 配置</p>
          <p className="text-xs text-muted-foreground/50 mt-1">
            在下方添加，模型会自动出现在对话界面的下拉选择器中
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              activeModel={activeModel}
              onUpsert={upsert}
              onRemove={remove}
              onSelectModel={select}
            />
          ))}
        </div>
      )}

      {/* 新增 Provider 表单 */}
      <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
        <div className="px-4 py-2.5 bg-muted/30 border-b border-border/50 flex items-center gap-2">
          <Plus className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">添加 Provider</span>
        </div>
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 Ling"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">API Key</label>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-muted-foreground mb-1">Base URL</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              模型（逗号分隔）
            </label>
            <input
              value={modelsText}
              onChange={(e) => setModelsText(e.target.value)}
              placeholder="Ling-2.6-1T, Ling-2.6-Pro"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <button
              onClick={onAdd}
              disabled={!name.trim() || !baseUrl.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Plus className="size-4" /> 添加 Provider
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
