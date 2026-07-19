// Provider 配置 Store —— 多供应商模型配置的唯一真相来源。
//
// 关键能力：
// 1. flatModels()           —— 把所有 Provider 的 models 合并成一个扁平列表供下拉框使用。
// 2. findProviderByModel()  —— 给定模型名，反向查找它属于哪个 Provider。
// 3. resolveActiveModel()   —— 结合 activeModel + findProviderByModel，得到本次请求要用的
//                              完整配置（baseUrl + apiKey + model）。
//
// 这三者是「切换模型不 401」的根基：请求的认证信息永远来自「当前选中模型」，
// 而不是某个在初始化时写死的值。
import { create } from 'zustand'
import type { ProviderConfig, ResolvedModel, FlatModel } from './types'
import { generateId } from '@/lib/format'
import { warn } from '@/lib/logger'
import * as persistence from './persistence'

interface ProviderState {
  providers: ProviderConfig[]
  activeModel: string | null
  /** 是否已从 localStorage 完成水合（hydrate） */
  hydrated: boolean

  // ── Selectors（通过 get() 读取最新 state，绝不在闭包里缓存） ──
  flatModels: () => FlatModel[]
  findProviderByModel: (model: string) => ProviderConfig | undefined
  resolveActiveModel: () => ResolvedModel | null

  // ── Actions ──
  hydrate: () => Promise<void>
  addProvider: (input: Omit<ProviderConfig, 'id'>) => string
  updateProvider: (id: string, patch: Partial<Omit<ProviderConfig, 'id'>>) => void
  removeProvider: (id: string) => void
  setActiveModel: (model: string) => void
  persist: () => Promise<void>
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providers: [],
  activeModel: null,
  hydrated: false,

  /** 所有 Provider 的 models 合并成扁平列表，供下拉框渲染。 */
  flatModels: () => {
    const out: FlatModel[] = []
    for (const p of get().providers) {
      for (const m of p.models) {
        out.push({ model: m, providerId: p.id, providerName: p.name })
      }
    }
    return out
  },

  /** ★ 反向查找：模型名 → 所属 Provider */
  findProviderByModel: (model) => {
    return get().providers.find((p) => p.models.includes(model))
  },

  /**
   * ★ 核心：根据 activeModel 解析出本次请求要用的完整配置。
   * 每次调用都实时读取 state，所以切换模型后第一次请求拿到的一定是新 Provider 的
   * baseUrl + apiKey，而不是旧值。
   */
  resolveActiveModel: () => {
    const { activeModel, providers } = get()
    if (!activeModel) {
      warn('[provider-store] resolveActiveModel: activeModel 为空')
      return null
    }
    const provider = providers.find((p) => p.models.includes(activeModel))
    if (!provider) {
      warn('[provider-store] resolveActiveModel: 找不到包含模型', activeModel, '的 Provider')
      return null
    }
    return {
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: activeModel,
    }
  },

  /** 应用启动时调用：从 localStorage 读取配置并解密。 */
  hydrate: async () => {
    if (get().hydrated) return
    const providers = await persistence.loadProviders()
    let active = persistence.loadActiveModel()
    // 校验 activeModel 仍然合法（其所属 Provider 仍存在）
    if (active && !providers.some((p) => p.models.includes(active!))) {
      active = null
    }
    // 兜底：没有任何选中模型时，选默认 Provider 的第一个模型
    if (!active && providers.length > 0) {
      const def = providers.find((p) => p.isDefault) || providers[0]
      active = def.models[0] ?? null
    }
    set({ providers, activeModel: active, hydrated: true })
  },

  addProvider: (input) => {
    const id = generateId()
    const provider: ProviderConfig = { ...input, id }
    set((s) => ({ providers: [...s.providers, provider] }))
    void get().persist()
    // 若当前没有任何选中模型，自动选新 Provider 的第一个模型
    if (!get().activeModel && provider.models.length > 0) {
      get().setActiveModel(provider.models[0])
    }
    return id
  },

  updateProvider: (id, patch) => {
    set((s) => ({
      providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }))
    void get().persist()
  },

  removeProvider: (id) => {
    const removed = get().providers.find((p) => p.id === id)
    set((s) => ({ providers: s.providers.filter((p) => p.id !== id) }))
    // 若 activeModel 属于被删的 Provider，需要重新选一个，否则会 401
    if (removed && get().activeModel && removed.models.includes(get().activeModel!)) {
      const first = get().providers[0]
      get().setActiveModel(first?.models[0] ?? '')
    }
    void get().persist()
  },

  setActiveModel: (model) => {
    set({ activeModel: model || null })
    persistence.saveActiveModel(model || null)
  },

  persist: async () => {
    try {
      await persistence.saveProviders(get().providers)
    } catch (e) {
      warn('[provider-store] persist failed', e)
    }
  },
}))
