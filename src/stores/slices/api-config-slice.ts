/**
 * API configuration slice — provider, model, profiles, history.
 */
import type { StateCreator } from 'zustand'
import { generateId } from '@/lib/format'
import { warn } from '@/lib/logger'
import type { ApiConfig, ApiProfile, ProviderConfig } from '../helix-types'
import { isModelProviderMismatch } from '@/lib/provider-match'

/** Provider ids currently auto-fetching their model lists (in-flight guard). */
const fetchingProviderModels = new Set<string>()

export interface ApiConfigSlice {
  apiConfig: ApiConfig
  apiHistory: ApiConfig[]
  apiProfiles: ApiProfile[]
  activeProfileId: string | null
  availableModels: string[]
  /** Base URL the current `availableModels` was fetched from (provenance tag,
   *  so the model dropdown never mixes one provider's models into another). */
  availableModelsBaseUrl: string | null
  /** Per-provider fetched model lists. Key = provider id. Clicking "获取模型列表"
   *  for a provider stores its models here, so switching providers automatically
   *  shows that provider's own list — no global cross-provider mixing. */
  providerModels: Record<string, string[]>
  /** Multi-provider config backing the flattened model selector. */
  providers: ProviderConfig[]
  /** Currently selected model name (flat list item), e.g. "Ling-2.6-1T". */
  activeModel: string | null
  /** The provider currently active in the model selector. The model dropdown
   *  shows ONLY this provider's models (requirement: no cross-provider mixing).
   *  Kept in sync with `activeModel` — whenever a model is selected, this is
   *  updated to the provider that owns it. */
  activeProviderId: string | null
  setAvailableModels: (models: string[], baseUrl?: string, providerId?: string) => void
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
  /** Fetch a provider's model list from its endpoint and cache it (providerModels).
   *  No-op / resolves [] when the provider lacks baseUrl+apiKey or a fetch is
   *  already in flight. Used for auto-populating the model dropdown on switch. */
  fetchProviderModels: (providerId: string) => Promise<string[]>
  /** Switch the active provider. If the current model doesn't belong to the new
   *  provider, reselect its defaultModel (or models[0]). Mirrors the new
   *  provider's credentials + model into apiConfig. */
  setActiveProvider: (id: string) => void
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
    provider: 'custom',
    apiKey: '',
    baseUrl: 'https://api.ant-ling.com/v1',
    model: 'Ling-2.6-1T',
  },
  apiHistory: [],
  apiProfiles: [],
  activeProfileId: null,
  availableModels: [],
  availableModelsBaseUrl: null,
  providerModels: {},
  providers: [],
  activeModel: null,
  activeProviderId: null,

  setAvailableModels: (models, baseUrl, providerId) => {
    // Resolve the provider id that scopes this fetched list. Priority:
    // explicit param → active provider → match by baseUrl. This guarantees
    // the saved key equals what the model selector reads (providerModels[pid]
    // where pid === activeProvider.id), so the list survives a restart.
    const resolvePid = (state: any): string | undefined => {
      if (providerId) return providerId
      if (state.activeProviderId) return state.activeProviderId
      if (baseUrl) {
        const match = state.providers.find((p: any) => p.baseUrl === baseUrl)
        if (match) return match.id
      }
      return undefined
    }
    set((state) => {
      const pid = resolvePid(state)
      // Only overwrite the fetched list when we actually have models. An empty
      // array is a "reset display" signal (e.g. switching providers / profiles)
      // and must NOT wipe the persisted fetched list, or it would be lost on the
      // next persistToStorage / restart.
      const providerModels = (pid && models.length > 0)
        ? { ...state.providerModels, [pid]: models }
        : state.providerModels
      // NOTE: We intentionally do NOT merge fetched models into
      // providers[].models here. The provider's `models` field is the
      // *declared* list (static); providerModels[pid] is the *fetched*
      // list (dynamic, per-endpoint). Merging them would pollute a
      // single provider's model array with models from unrelated
      // endpoints whenever the caller reuses activeProviderId as the
      // key — which is exactly what caused "all models from every
      // supplier showing in one dropdown". Instead, keep them separate
      // and consult providerModels at read-time (setActiveModel /
      // resolveActiveApiConfig / restoreFromStorage).
      return {
        availableModels: models,
        availableModelsBaseUrl: baseUrl ?? null,
        providerModels,
      }
    })
    import('@/lib/persist').then(({ persistence }) => {
      persistence.saveSetting('availableModels', models)
      // Persist the per-provider fetched model lists so they survive a restart.
      // Without this, `providerModels` resets to {} on every cold start and the
      // selector falls back to the single `config.model`, forcing the user to
      // re-click "获取模型列表" after each restart.
      const pid = resolvePid(get())
      if (pid && models.length > 0) {
        const next = { ...get().providerModels, [pid]: models }
        persistence.saveSetting('providerModels', next)
      }
    })
  },

  setApiConfig: (config) =>
    set((state) => {
      let apiConfig = { ...state.apiConfig, ...config }
      // Guard against storing a model/baseUrl mismatch (e.g. a poisoned
      // apiHistory entry that says model=Ling but baseUrl=deepseek). If the
      // requested model does not belong to the requested endpoint, snap to the
      // endpoint's first available model so the backend never receives the
      // wrong model name and the dropdown never shows one supplier's models
      // while the button shows another supplier's name. Uses the shared
      // classifier so ALL families are covered (k3/Kimi, glm/Zhipu, ...),
      // not just the Ling↔DeepSeek pair the old inline check handled.
      if (apiConfig.baseUrl && apiConfig.model) {
        if (isModelProviderMismatch(apiConfig.model, apiConfig.baseUrl)) {
          const owner = state.providers.find((p) => p.baseUrl === apiConfig.baseUrl)
          const ownerModels = owner
            ? [...new Set([...(owner.models || []), ...(state.providerModels?.[owner.id] || [])])]
            : []
          const fallback = ownerModels[0] || owner?.defaultModel || apiConfig.model
          if (fallback && fallback !== apiConfig.model) {
            warn('[api-config-slice] setApiConfig: model/baseUrl mismatch, snapping', apiConfig.model, '→', fallback, 'for', apiConfig.baseUrl)
            apiConfig = { ...apiConfig, model: fallback }
          }
        }
      }
      // Keep the target endpoint's provider credentials in sync with manual
      // edits from settings. We match by apiConfig.baseUrl, NOT by the previous
      // activeModel. Using activeModel would rewrite the provider that owns the
      // old model (e.g. Ling provider) to the new endpoint URL, polluting its
      // baseUrl and causing the dropdown to keep showing the old supplier's
      // models while the button shows the new model name.
      let providers = state.providers
      if (apiConfig.baseUrl) {
        providers = providers.map((p) =>
          p.baseUrl === apiConfig.baseUrl
            ? { ...p, apiKey: apiConfig.apiKey }
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
      // Refuse to record a poisoned entry where the model name clearly belongs
      // to a different supplier than the endpoint (e.g. k3/Kimi under a DeepSeek
      // base URL). Such records are exactly the "脏数据" that previously showed
      // one supplier's model under another's config group. We drop it before it
      // ever enters apiHistory; the user keeps using their current selection.
      if (isModelProviderMismatch(config.model, config.baseUrl)) {
        warn('[api-config-slice] addApiHistory: 跳过模型/端点不匹配的记录', config.model, config.baseUrl)
        return state
      }
      // Deduplicate by baseUrl + apiKey + model. The same endpoint with the
      // same key AND the same model name is one logical entry; a different
      // model on the same endpoint is a separate entry so it shows up in the
      // config list. Normalize empty/undefined values so they collapse together.
      const normKey = (k?: string) => (k ?? '').trim()
      const dupIndex = state.apiHistory.findIndex(
        (h) =>
          h.baseUrl === config.baseUrl &&
          normKey(h.apiKey) === normKey(config.apiKey) &&
          normKey(h.model) === normKey(config.model),
      )
      if (dupIndex !== -1) {
        // Move the existing entry to the front instead of adding a duplicate.
        const moved = state.apiHistory[dupIndex]
        const rest = state.apiHistory.filter((_, i) => i !== dupIndex)
        return { apiHistory: [moved, ...rest].slice(0, 20) }
      }
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
    const { activeModel, providers, providerModels } = get()
    if (!activeModel) return null
    const provider =
      providers.find((p) => p.models.includes(activeModel)) ||
      providers.find((p) => (providerModels[p.id] || []).includes(activeModel))
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
    // A model may live in the fetched per-provider list (providerModels[pid])
    // rather than the provider's declared `models` array — e.g. after "获取模型列表".
    // Resolve the owning provider from BOTH sources so selecting a fetched model
    // works instead of silently no-op'ing (which made the input-bar selector look
    // frozen on the previous model).
    let provider = providers.find((p) => p.models.includes(model))
    if (!provider) {
      const { providerModels, activeProviderId } = get()
      const search = (pid?: string | null) =>
        pid && providerModels[pid]?.includes(model)
          ? providers.find((p) => p.id === pid)
          : undefined
      provider =
        search(activeProviderId) ||
        providers.find((p) => (providerModels[p.id] || []).includes(model))
    }
    if (!provider) {
      // Final fallback: match by the current backend URL for hand-typed models.
      // Only keep the requested model if it actually belongs to that provider;
      // otherwise snap to the provider's default/first model. This prevents the
      // common mismatch where a stale Ling model lingers after the endpoint was
      // switched to deepseek, causing the backend to send Ling to deepseek's API.
      const currentUrl = get().apiConfig?.baseUrl
      if (currentUrl) {
        provider = providers.find((p) => p.baseUrl === currentUrl)
      }
      if (provider) {
        const providerModelList = [
          ...(provider.models || []),
          ...(get().providerModels?.[provider.id] || []),
        ]
        if (!providerModelList.includes(model)) {
          const fallbackModel = provider.defaultModel || provider.models[0] || providerModelList[0] || null
          if (fallbackModel) {
            model = fallbackModel
          } else {
            warn('[api-config-slice] setActiveModel: 当前 Provider 无可用模型，无法选择', model)
            return
          }
        }
      }
    }
    if (!provider) {
      warn('[api-config-slice] setActiveModel: 找不到包含模型', model, '的 Provider')
      return
    }
    // Mirror the resolved provider config into apiConfig (what Hermes backend reads).
    // Keep activeProviderId in sync so the dropdown stays scoped to this provider.
    set({
      activeModel: model,
      activeProviderId: provider.id,
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
      persistence.saveSetting('activeProviderId', provider.id)
    })
    // Synchronous backup — if the async IndexedDB write above is still pending
    // when the app exits, we lose the last model. localStorage.setItem is
    // synchronous on the main thread, so it's a reliable fallback for the next
    // cold start.
    try {
      localStorage.setItem('helix-active-model', model)
      localStorage.setItem('helix-active-provider-id', provider.id)
    } catch {}
    // Auto-fetch the newly-active provider's model list when we have no cached
    // copy yet, so the input-bar dropdown shows its full list without the user
    // having to open settings and click "获取模型列表".
    if (provider.baseUrl && provider.apiKey && !(get().providerModels?.[provider.id] ?? []).length) {
      get().fetchProviderModels(provider.id)
    }
  },

  // ── Auto-fetch provider model lists ──────────────────────────────────────
  fetchProviderModels: async (providerId) => {
    const provider = get().providers.find((p) => p.id === providerId)
    if (!provider?.baseUrl || !provider.apiKey) return []
    if (fetchingProviderModels.has(providerId)) {
      // Already fetching — return whatever cache we have now (the in-flight
      // fetch will update providerModels when it lands).
      return get().providerModels?.[providerId] ?? []
    }
    fetchingProviderModels.add(providerId)
    try {
      if (typeof window === 'undefined' || !(window as any).electron?.hermes?.fetchModels) return []
      const result = await (window as any).electron.hermes.fetchModels({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      })
      if (result?.error) throw new Error(result.error)
      const models = Array.isArray(result?.models)
        ? result.models.filter((m: unknown) => typeof m === 'string' && m)
        : []
      if (models.length > 0) {
        get().setAvailableModels(models, provider.baseUrl, provider.id)
      }
      return models
    } catch (e) {
      warn('[api-config-slice] 自动获取模型失败:', provider.name, e)
      return []
    } finally {
      fetchingProviderModels.delete(providerId)
    }
  },

  setActiveProvider: (id) => {
    const provider = get().providers.find((p) => p.id === id)
    if (!provider) {
      warn('[api-config-slice] setActiveProvider: 找不到 Provider', id)
      return
    }
    // Keep the current model if it still belongs to the new provider; otherwise
    // reselect the provider's default (or first) model. A provider with no models
    // leaves activeModel null — the UI shows the "no models" placeholder.
    // Consult the fetched list (providerModels) as well as the declared models,
    // since a model selected from "获取模型列表" may only live in providerModels.
    const cur = get().activeModel
    const ownsModel = (pid: string, m?: string | null) =>
      !!m && (provider.models.includes(m) || (get().providerModels[pid] || []).includes(m))
    const keepModel = ownsModel(provider.id, cur)
    const model = keepModel ? cur : (provider.defaultModel || provider.models[0] || null)
    set({
      activeProviderId: id,
      activeModel: model,
      apiConfig: {
        ...get().apiConfig,
        provider: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: model || '',
      },
    })
    import('@/lib/persist').then(({ persistence }) => {
      persistence.saveSetting('activeProviderId', id)
      if (model) persistence.saveSetting('activeModel', model)
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
      else if (def && !get().activeProviderId) set({ activeProviderId: def.id })
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
    const activeStillValid = !!active && providers.some((p) => p.models.includes(active))
    if (activeStillValid) {
      // The model survived in another provider — re-anchor activeProviderId to it.
      const owner = providers.find((p) => p.models.includes(active!))
      if (owner && get().activeProviderId !== owner.id) set({ activeProviderId: owner.id })
    } else {
      const first = providers[0]
      if (first?.models?.length) get().setActiveModel(first.models[0])
      else set({ activeModel: null, activeProviderId: null })
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
  },
})
