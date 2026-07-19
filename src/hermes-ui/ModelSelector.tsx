// 模型下拉选择器 —— 扁平展示所有 Provider 下的所有模型。
//
// 显示格式：「模型名 · Provider名」，背后 value 是模型名，
// 选中后由调用方反查到对应 Provider 配置。
//
// 本组件是「展示型」的：providers / activeModel / onChange 都通过 props 传入，
// 因此既能被 hermes-ui 自带的 useProviderStore 使用，也能被主流程的
// useHelixStore 直接使用 —— 从而保持 hermes-ui 模块的独立性，不被拆散到各处。
'use client'

import { useMemo } from 'react'
import { useProviderStore } from './provider-store'

/** 任意「含 id/name/models」的 Provider 结构都可作为数据源（解耦具体 store 类型）。 */
export interface ProviderLike {
  id: string
  name: string
  models: string[]
}

export interface ModelSelectorProps {
  /** 扁平列表的数据源；不传则回退到 hermes-ui 自带 store（独立使用场景）。 */
  providers?: ProviderLike[]
  /** 当前选中的模型名；不传则回退到 hermes-ui 自带 store。 */
  activeModel?: string | null
  /** 切换模型时调用，通常由 store 的 onModelSwitched 传入（会 invalidate session + 取消在途）。 */
  onChange: (model: string) => void
  className?: string
}

export function ModelSelector({ providers, activeModel, onChange, className }: ModelSelectorProps) {
  // 主流程场景下 providers/activeModel 由 props 提供；独立场景下回退到自带 store。
  const storeProviders = useProviderStore((s) => s.providers)
  const storeActiveModel = useProviderStore((s) => s.activeModel)
  const source = providers ?? storeProviders
  const current = activeModel ?? storeActiveModel

  const flat = useMemo(() => {
    const out: { model: string; providerName: string }[] = []
    for (const p of source) {
      for (const m of p.models) out.push({ model: m, providerName: p.name })
    }
    return out
  }, [source])

  return (
    <select
      className={className}
      value={current ?? ''}
      onChange={(e) => onChange(e.target.value)}
    >
      {flat.length === 0 && <option value="">（无可用模型）</option>}
      {flat.map((m) => (
        <option key={m.model} value={m.model}>
          {m.model} · {m.providerName}
        </option>
      ))}
    </select>
  )
}
