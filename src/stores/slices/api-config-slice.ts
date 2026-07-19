/**
 * API configuration slice — provider, model, profiles, history.
 */
import type { StateCreator } from 'zustand'
import type { ApiConfig, ApiProfile, ApiProvider, ProviderConfig } from '../helix-types'
import { PROVIDER_PRESETS } from '../helix-types'
import { generateId } from '@/lib/format'
import { electronHermes } from '@/lib/electron-bridge'
import { warn } from '@/lib/logger'

export interface ApiConfigSlice {
  apiConfig: ApiConfig
  apiHistory: ApiConfig[]
  apiProfiles: ApiProfile[]
  activeProfileId: string | null
  availableModels: string[]
  /** Multi-provider config backing the flattened model selector. */
  providers: ProviderConfig[]
  /** Currently selected model name (flat list item), e.g. "Ling-2.6-1T". */
  activeModel: string | null
  setAvailableModels: (models: string[]) => void
  setApiConfig: (config: Partial<ApiConfig>) => void
  getApiConfig: () => ApiConfig
  /** Find which profile owns a given model name (reverse-lookup). */
  findProfileByModel: (model: string) => ApiProfile | undefined
  addApiHistory: (config: ApiConfig) => void
  removeApiHistory: (index: number) => void
  selectApiHistory: (index: number) => void
  addApiProfile: (name: string, config: ApiConfig, models?: string[]) => string
  updateApiProfileConfig: (id: string, config: ApiConfig, models?: string[]) => void
  renameApiProfile: (id: string, name: string) => void
  removeApiProfile: (id: string) => void
  setActiveProfile: (id: string | null) => void
  // ── Multi-provider actions ──
  /** Reverse-lookup the provider owning `model` and resolve the active config. */
  resolveActiveApiConfig: () => ApiConfig | null
  /** Select a model: updates activeModel + mirrors the resolved config into apiConfig. */
  setActiveModel: (model: string) => void
  /** Create or update a provider (used by the Provider settings editor). */
  upsertProvider: (input: Omit<ProviderConfig, 'id'> & { id?: string }) => string
  /** Remove a provider; reselects activeModel if it belonged to the removed one. */
  removeProvider: (id: string) => void
  /**
   * Unified handler invoked by the model selector on switch.
   * 1) sets activeModel (which re-resolves apiConfig so Hermes uses the new key);
   * 2) interrupts any in-flight session via session/cancel so the next prompt
   *    is built on a fresh session (use-hermes detects the apiConfig hash change
   *    and repushes config + recreates the session).
   */
  onModelSwitched: (model: string) => void
}

export const createApiConfigSlice: StateCreator<ApiConfigSlice, [], [], ApiConfigSlice> = (set, get) => ({
  apiConfig: {
    provider: 'agnes-ai',
    apiKey: '',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
  },
  apiHistory: [],
  apiProfiles: [],
  activeProfileId: null,
  availableModels: [],
  providers: [],
  activeModel: null,

  setAvailableModels: (models) => {
    set({ availableModels: models })
    import('@/lib/persist').then(({ persistence }) => {
      persistence.saveSetting('availableModels', models)
    })
  },

  setApiConfig: (config) =>
    set((state) => {
      const apiConfig = { ...state.apiConfig, ...config }
      // Keep the active provider's credentials in sync with manual edits from
      // settings, so the flattened selector and Hermes always agree.
      let providers = state.providers
      const active = state.activeModel
      if (active) {
        providers = providers.map((p) =>
          p.models.includes(active)
            ? { ...p, baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey }
            : p,
        )
      }
      return { apiConfig, providers }
    }),
  getApiConfig: () => get().apiConfig,

  findProfileByModel: (model) => {
    return get().apiProfiles.find(p =>
      (p.models || []).includes(model) || p.config.model === model
    )
  },

  addApiHistory: (config) =>
    set((state) => {
      const exists = state.apiHistory.some(
        h => h.baseUrl === config.baseUrl && h.apiKey === config.apiKey && h.model === config.model
      )
      if (exists) return state
      const newHistory = [config, ...state.apiHistory].slice(0, 20)
      return { apiHistory: newHistory }
    }),

  removeApiHistory: (index) =>
    set((state) => ({
      apiHistory: state.apiHistory.filter((_, i) => i !== index),
    })),

  selectApiHistory: (index) =>
    set((state) => {
      const config = state.apiHistory[index]
      if (!config) return state
      return { apiConfig: { ...config } }
    }),

  addApiProfile: (name, config, models?) => {
    const id = generateId()
    set((state) => ({ apiProfiles: [...state.apiProfiles, { id, name, config, models }] }))
    return id
  },
  updateApiProfileConfig: (id, config, models?) =>
    set((state) => ({
      apiProfiles: state.apiProfiles.map((p) => (p.id === id ? { ...p, config, ...(models ? { models } : {}) } : p)),
    })),
  renameApiProfile: (id, name) =>
    set((state) => ({
      apiProfiles: state.apiProfiles.map((p) => (p.id === id ? { ...p, name } : p)),
    })),
  removeApiProfile: (id) =>
    set((state) => ({
      apiProfiles: state.apiProfiles.filter((p) => p.id !== id),
      activeProfileId: state.activeProfileId === id ? null : state.activeProfileId,
    })),
  setActiveProfile: (id) => set({ activeProfileId: id }),

  // ── Multi-provider actions ──
  resolveActiveApiConfig: () => {
    const { activeModel, providers } = get()
    if (!activeModel) return null
    const provider = providers.find((p) => p.models.includes(activeModel))
    if (!provider) return null
    return {
      provider: provider.name,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: activeModel,
    }
  },

  setActiveModel: (model) => {
    const providers = get().providers
    const provider = providers.find((p) => p.models.includes(model))
    if (!provider) {
      warn('[api-config-slice] setActiveModel: 找不到包含模型', model, '的 Provider')
      return
    }
    // Mirror the resolved provider config into apiConfig (what Hermes backend reads).
    set({
      activeModel: model,
      apiConfig: {
        ...get().apiConfig,
        provider: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model,
      },
    })
    import('@/lib/persist').then(({ persistence }) => {
      persistence.saveSetting('activeModel', model)
    })
  },

  upsertProvider: (input) => {
    const id = input.id || generateId()
    const providers = get().providers
    const exists = providers.some((p) => p.id === id)
    const next = exists
      ? providers.map((p) => (p.id === id ? { ...p, ...input, id } : p))
      : [...providers, { ...input, id }]
    set({ providers: next })
    // If nothing is selected yet, auto-pick this provider's default model.
    if (!get().activeModel && next.length > 0) {
      const idx = exists ? providers.findIndex((p) => p.id === id) : next.length - 1
      const def = next[idx]
      const firstModel = def?.models?.[0]
      if (firstModel) get().setActiveModel(firstModel)
    }
    import('@/lib/persist').then(({ persistence }) => {
      persistence.saveSetting('providers', next)
    })
    return id
  },

  removeProvider: (id) => {
    const providers = get().providers.filter((p) => p.id !== id)
    set({ providers })
    const active = get().activeModel
    // If the active model belonged to the removed provider, reselect.
    if (active && !providers.some((p) => p.models.includes(active))) {
      const first = providers[0]
      if (first?.models?.length) get().setActiveModel(first.models[0])
      else set({ activeModel: null })
    }
    import('@/lib/persist').then(({ persistence }) => {
      persistence.saveSetting('providers', providers)
    })
  },

  onModelSwitched: (model) => {
    // 1) Re-resolve apiConfig for the new model (Hermes will use the new key).
    get().setActiveModel(model)
    // 2) Interrupt any in-flight session so the next prompt is built fresh.
    //    (use-hermes detects the apiConfig hash change on next send → invalidate + repush.)
    import('@/stores/hermes-store').then(({ useHermesStore }) => {
      const sid = useHermesStore.getState().hermesSessionId
      if (sid) {
        try {
          electronHermes.notify('session/cancel', { session_id: sid })
        } catch {
          /* noop */
        }
      }
      useHermesStore.setState({ isChatLoading: false })
    }).catch(() => {})
  },
})
