/**
 * API configuration slice — provider, model, profiles, history.
 */
import type { StateCreator } from "zustand";
import type { ApiConfig, ApiProfile, ProviderConfig } from "../helix-types";
import { generateId } from "@/lib/format";
import { warn } from "@/lib/logger";

/** Provider ids currently auto-fetching their model lists (in-flight guard). */
const fetchingProviderModels = new Set<string>();

export interface ApiConfigSlice {
  apiConfig: ApiConfig;
  apiHistory: ApiConfig[];
  apiProfiles: ApiProfile[];
  activeProfileId: string | null;
  availableModels: string[];
  /** Base URL the current `availableModels` was fetched from (provenance tag,
   *  so the model dropdown never mixes one provider's models into another). */
  availableModelsBaseUrl: string | null;
  /** Per-provider fetched model lists. Key = provider id. Clicking "获取模型列表"
   *  for a provider stores its models here, so switching providers automatically
   *  shows that provider's own list — no global cross-provider mixing. */
  providerModels: Record<string, string[]>;
  /** Multi-provider config backing the flattened model selector. */
  providers: ProviderConfig[];
  /** Currently selected model name (flat list item), */
  activeModel: string | null;
  /** The provider currently active in the model selector. The model dropdown
   *  shows ONLY this provider's models (requirement: no cross-provider mixing).
   *  Kept in sync with `activeModel` — whenever a model is selected, this is
   *  updated to the provider that owns it. */
  activeProviderId: string | null;
  setAvailableModels: (
    models: string[],
    baseUrl?: string,
    providerId?: string,
  ) => void;
  setApiConfig: (config: Partial<ApiConfig>) => void;
  getApiConfig: () => ApiConfig;
  /** Find which profile owns a given model name (reverse-lookup). */
  findProfileByModel: (model: string) => ApiProfile | undefined;
  /** Resolve which provider owns `model` **without mutating anything**: the
   *  provider's declared `models` array first, then the fetched per-provider
   *  list (providerModels), then the provider whose baseUrl matches
   *  apiConfig.baseUrl (hand-typed / fetched-only models).
   *
   *  The chat input's per-conversation model switch needs the owning provider's
   *  baseUrl / apiKey / apiFormat to register it in pi's models.json and to send
   *  the per-session set_model — but it must NOT write apiConfig,
   *  activeProviderId or the global default model. setActiveModel does that
   *  resolution as a side effect, which is exactly what made every conversation
   *  inherit the last input-bar selection. */
  resolveModelProvider: (model: string) => ProviderConfig | undefined;
  addApiHistory: (config: ApiConfig) => void;
  removeApiHistory: (index: number) => void;
  selectApiHistory: (index: number) => void;
  addApiProfile: (
    name: string,
    config: ApiConfig,
    models?: string[],
    modelContextWindows?: Record<string, number>,
  ) => string;
  updateApiProfileConfig: (
    id: string,
    config: ApiConfig,
    models?: string[],
    modelContextWindows?: Record<string, number>,
  ) => void;
  renameApiProfile: (id: string, name: string) => void;
  removeApiProfile: (id: string) => void;
  setActiveProfile: (id: string | null) => void;
  // ── Multi-provider actions ──
  /** Reverse-lookup the provider owning `model` and resolve the active config. */
  resolveActiveApiConfig: () => ApiConfig | null;
  /** Select a model: updates activeModel + mirrors the resolved config into apiConfig. */
  setActiveModel: (model: string) => void;
  /** Fetch a provider's model list from its endpoint and cache it (providerModels).
   *  No-op / resolves [] when the provider lacks baseUrl+apiKey or a fetch is
   *  already in flight. Used for auto-populating the model dropdown on switch. */
  fetchProviderModels: (providerId: string) => Promise<string[]>;
  /** Drop the cached fetched model list for a provider so the next open of the
   *  model selector re-fetches live instead of relying on a possibly-stale
   *  persisted list. Called on save to keep stored config free of a stale list. */
  clearProviderModels: (providerId: string) => void;
  /** Switch the active provider. If the current model doesn't belong to the new
   *  provider, reselect its defaultModel (or models[0]). Mirrors the new
   *  provider's credentials + model into apiConfig. */
  setActiveProvider: (id: string) => void;
  /** Create or update a provider (used by the Provider settings editor). */
  upsertProvider: (
    input: Omit<ProviderConfig, "id"> & { id?: string },
  ) => string;
  /** Remove a provider; reselects activeModel if it belonged to the removed one. */
  removeProvider: (id: string) => void;
  /**
   * Unified handler invoked by the model selector on switch.
   * 1) sets activeModel (which re-resolves apiConfig so Helix uses the new key);
   * 2) interrupts any in-flight session via session/cancel so the next prompt
   *    is built on a fresh session (use-helix detects the apiConfig hash change
   *    and repushes config + recreates the session).
   */
  onModelSwitched: (model: string) => void;
}

export const createApiConfigSlice: StateCreator<
  ApiConfigSlice,
  [],
  [],
  ApiConfigSlice
> = (set, get) => ({
  apiConfig: {
    provider: "custom",
    apiKey: "",
    baseUrl: "",
    model: "",
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
    // explicit param → match by baseUrl → active provider. This guarantees
    // the saved key equals what the model selector reads (providerModels[pid]
    // where pid === activeProvider.id), so the list survives a restart.
    // baseUrl MUST be preferred over activeProviderId: the latter can be stale
    // (handleSaveApi/applyProfile don't always re-anchor it), and keying the
    // fetched list under the wrong provider hides those models from the
    // selector — the "获取到 2 个模型，切换后只剩 1 个" bug.
    const resolvePid = (state: any): string | undefined => {
      if (providerId) return providerId;
      if (baseUrl) {
        const match = state.providers.find((p: any) => p.baseUrl === baseUrl);
        if (match) return match.id;
      }
      if (state.activeProviderId) return state.activeProviderId;
      return undefined;
    };
    set((state) => {
      const pid = resolvePid(state);
      // Only overwrite the fetched list when we actually have models. An empty
      // array is a "reset display" signal (e.g. switching providers / profiles)
      // and must NOT wipe the persisted fetched list, or it would be lost on the
      // next persistToStorage / restart.
      const providerModels =
        pid && models.length > 0
          ? { ...state.providerModels, [pid]: models }
          : state.providerModels;
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
      };
    });
    import("@/lib/persist").then(({ persistence }) => {
      persistence.saveSetting("availableModels", models);
      // Persist the per-provider fetched model lists so they survive a restart.
      // Without this, `providerModels` resets to {} on every cold start and the
      // selector falls back to the single `config.model`, forcing the user to
      // re-click "获取模型列表" after each restart.
      const pid = resolvePid(get());
      if (pid && models.length > 0) {
        const next = { ...get().providerModels, [pid]: models };
        persistence.saveSetting("providerModels", next);
      }
    });
  },

  setApiConfig: (config) =>
    set((state) => {
      const apiConfig = { ...state.apiConfig, ...config };
      // Keep the target endpoint's provider credentials in sync with manual
      // edits from settings. We match by apiConfig.baseUrl, NOT by the previous
      // activeModel. Using activeModel would rewrite the provider that owns the
      // old model  to the new endpoint URL, polluting its
      // baseUrl and causing the dropdown to keep showing the old supplier's
      // models while the button shows the new model name.
      let providers = state.providers;
      if (apiConfig.baseUrl) {
        providers = providers.map((p) =>
          p.baseUrl === apiConfig.baseUrl
            ? { ...p, apiKey: apiConfig.apiKey }
            : p,
        );
      }
      return { apiConfig, providers };
    }),
  getApiConfig: () => get().apiConfig,

  findProfileByModel: (model) => {
    return get().apiProfiles.find(
      (p) => (p.models || []).includes(model) || p.config.model === model,
    );
  },

  addApiHistory: (config) =>
    set((state) => {
      // A history entry represents one CONFIG = baseUrl + apiKey (the list is
      // grouped by baseUrl, with entries inside a group differing by apiKey).
      // Switching models on the SAME connection must NOT create a new entry —
      // it updates that config's model in place. Dedup by baseUrl + apiKey.
      // Normalize empty/undefined values so they collapse together.
      const normKey = (k?: string) => (k ?? "").trim();
      const dupIndex = state.apiHistory.findIndex(
        (h) =>
          h.baseUrl === config.baseUrl &&
          normKey(h.apiKey) === normKey(config.apiKey),
      );
      if (dupIndex !== -1) {
        // Same connection → update the entry's model/provider to the latest
        // selection and move it to the front (most recently used).
        const updated = { ...state.apiHistory[dupIndex], ...config };
        const rest = state.apiHistory.filter((_, i) => i !== dupIndex);
        return { apiHistory: [updated, ...rest].slice(0, 20) };
      }
      const newHistory = [config, ...state.apiHistory].slice(0, 20);
      return { apiHistory: newHistory };
    }),

  removeApiHistory: (index) =>
    set((state) => ({
      apiHistory: state.apiHistory.filter((_, i) => i !== index),
    })),

  selectApiHistory: (index) =>
    set((state) => {
      const config = state.apiHistory[index];
      if (!config) return state;
      return { apiConfig: { ...config } };
    }),

  addApiProfile: (name, config, models?, modelContextWindows?) => {
    const id = generateId();
    set((state) => ({
      apiProfiles: [
        ...state.apiProfiles,
        { id, name, config, models, modelContextWindows },
      ],
    }));
    return id;
  },
  updateApiProfileConfig: (id, config, models?, modelContextWindows?) =>
    set((state) => ({
      apiProfiles: state.apiProfiles.map((p) =>
        p.id === id
          ? {
              ...p,
              config,
              ...(models ? { models } : {}),
              ...(modelContextWindows ? { modelContextWindows } : {}),
            }
          : p,
      ),
    })),
  renameApiProfile: (id, name) =>
    set((state) => ({
      apiProfiles: state.apiProfiles.map((p) =>
        p.id === id ? { ...p, name } : p,
      ),
    })),
  removeApiProfile: (id) =>
    set((state) => {
      const target = state.apiProfiles.find((p) => p.id === id);
      const baseUrl = target?.config?.baseUrl;
      const apiKey = target?.config?.apiKey ?? "";
      // Keep ALL selector-facing state in lockstep with apiProfiles. After the
      // restore-time unification, `providers` is built from the same set as
      // apiProfiles, but a settings-page delete only touched apiProfiles — the
      // provider entry (and its fetched model list) kept living in the dropdown,
      // and the matching apiHistory entries would resurrect the profile on the
      // next restart (restore re-promotes any history endpoint not covered by a
      // profile). Purge all three, keyed by baseUrl+apiKey so sibling profiles
      // on the same endpoint with a different key are untouched.
      const nextProviderModels = { ...state.providerModels };
      if (target && target.id in nextProviderModels) {
        delete nextProviderModels[target.id];
      }
      return {
        apiProfiles: state.apiProfiles.filter((p) => p.id !== id),
        providers: state.providers.filter((p) => p.id !== id),
        providerModels: nextProviderModels,
        apiHistory: baseUrl
          ? state.apiHistory.filter(
              (h) => !(h.baseUrl === baseUrl && (h.apiKey ?? "") === apiKey),
            )
          : state.apiHistory,
        activeProfileId:
          state.activeProfileId === id ? null : state.activeProfileId,
        activeProviderId:
          state.activeProviderId === id ? null : state.activeProviderId,
      };
    }),
  setActiveProfile: (id) => set({ activeProfileId: id }),

  // ── Multi-provider actions ──
  resolveActiveApiConfig: () => {
    const { activeModel, providers, providerModels } = get();
    if (!activeModel) return null;
    const provider =
      providers.find((p) => p.models.includes(activeModel)) ||
      providers.find((p) => (providerModels[p.id] || []).includes(activeModel));
    if (!provider) return null;
    return {
      provider: provider.name,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: activeModel,
    };
  },

  resolveModelProvider: (model) => {
    const { providers, providerModels, activeProviderId, apiConfig } = get();
    // A model may live in the fetched per-provider list (providerModels[pid])
    // rather than the provider's declared `models` array — e.g. after "获取模型列表".
    // Resolve the owning provider from BOTH sources so selecting a fetched model
    // works instead of silently no-op'ing (which made the input-bar selector look
    // frozen on the previous model).
    //
    // Resolution order matters: the SAME model id can be listed under several
    // endpoints (e.g. deepseek-ai/DeepSeek-V4-Flash on both shangtang and
    // 硅基流动). A blind first-match scan over `providers` always hits whichever
    // profile comes first in the list, so the selection silently re-anchors to
    // the wrong supplier. Prefer, in order:
    //   1) a provider on the CURRENT endpoint (apiConfig.baseUrl) that owns the
    //      model — the user is selecting from that endpoint's list;
    //   2) the active provider (activeProviderId) when it owns the model;
    //   3) global first-match (legacy behavior, last resort).
    const owns = (p: (typeof providers)[number]) =>
      p.models.includes(model) || (providerModels[p.id] || []).includes(model);
    let provider: (typeof providers)[number] | undefined;
    const currentUrl = apiConfig?.baseUrl;
    if (currentUrl) {
      provider = providers.find((p) => p.baseUrl === currentUrl && owns(p));
    }
    if (!provider && activeProviderId) {
      provider = providers.find(
        (p) => p.id === activeProviderId && owns(p),
      );
    }
    if (!provider) {
      provider = providers.find(owns);
    }
    if (!provider) {
      // Hand-typed / fetched-only models that appear in no provider's declared
      // `models` array: match by the current backend URL. Credentials still come
      // from that provider; the model NAME is kept exactly as chosen.
      provider = currentUrl
        ? providers.find((p) => p.baseUrl === currentUrl)
        : undefined;
    }
    return provider;
  },

  setActiveModel: (model) => {
    let provider = get().resolveModelProvider(model);
    if (!provider) {
        // No provider known for this endpoint at all — trust the selection and
        // mirror it straight into apiConfig without rewriting the model name.
        const fallbackId = get().apiConfig.provider || "custom";
        set({
          activeModel: model,
          activeProviderId: fallbackId,
          apiConfig: {
            ...get().apiConfig,
            model,
          },
        });
        // Record the activation into apiHistory so the settings model list can
        // highlight it. Without this, models activated through paths that bypass
        // the chat dropdown (bridge / helix-ui onModelSwitched / fallback
        // resolution) never appear in the history list — the active model is
        // selected but no entry matches it, so nothing highlights.
        get().addApiHistory({ ...get().apiConfig, model });
        import("@/lib/persist").then(({ persistence }) => {
          persistence.saveSetting("activeModel", model);
          persistence.saveSetting("activeProviderId", fallbackId);
        });
        try {
          localStorage.setItem("helix-active-model", model);
          localStorage.setItem("helix-active-provider-id", fallbackId);
        } catch { /* empty */}
        return;
    }
    if (!provider) {
      warn(
        "[api-config-slice] setActiveModel: 找不到包含模型",
        model,
        "的 Provider",
      );
      return;
    }
    // ── Option B: promote a history-only endpoint into a real apiProfile the
    // moment it's selected. A history endpoint (added via "添加模型", never saved
    // as a profile) only ever lives in apiHistory + a synthetic `hist-*` provider
    // entry, so the settings page (apiProfiles) and the model selector (providers =
    // apiProfiles ∪ historyProviders) diverge in count. Promoting here makes them
    // share one source of truth and removes the "半存在" state for good.
    const promoteBaseUrl = provider.baseUrl;
    const alreadyReal = !!get().apiProfiles.find(
      (p) => p.config?.baseUrl === promoteBaseUrl,
    );
    let promotedProfileId: string | null = null;
    if (!alreadyReal && promoteBaseUrl) {
      const hist = (get().apiHistory || []).filter(
        (h) => h.baseUrl === promoteBaseUrl,
      );
      const seed = hist.find((h) => h.model === model) || hist[0];
      if (seed) {
        const newProfile: ApiProfile = {
          id: generateId(),
          name:
            seed.provider && seed.provider !== "__custom__"
              ? seed.provider
              : "配置",
          config: {
            provider: seed.provider || "openai",
            apiKey: seed.apiKey || "",
            baseUrl: seed.baseUrl || promoteBaseUrl,
            model,
            contextWindow: seed.contextWindow,
            apiFormat: seed.apiFormat,
            engine: seed.engine,
          },
          models: Array.from(
            new Set(hist.map((h) => h.model).filter(Boolean) as string[]),
          ),
        };
        const oldProviderId = provider.id;
        const promoted: ProviderConfig = { ...provider, id: newProfile.id };
        set((s) => {
          const nextProviderModels = { ...s.providerModels };
          // Carry over any fetched model list keyed under the old synthetic id
          // so the dropdown keeps showing the full list under the new real id.
          if (nextProviderModels[oldProviderId]) {
            nextProviderModels[newProfile.id] =
              nextProviderModels[oldProviderId];
            delete nextProviderModels[oldProviderId];
          }
          return {
            apiProfiles: [...s.apiProfiles, newProfile],
            // Replace the synthetic hist-* entry with the real profile so the
            // selector never shows the same endpoint twice within the session.
            providers: s.providers.map((p) =>
              p.id === oldProviderId ? promoted : p,
            ),
            providerModels: nextProviderModels,
          };
        });
        provider = promoted;
        promotedProfileId = newProfile.id;
        // Persist so a cold restart keeps the promoted profile (restoreFromStorage
        // reads apiProfiles first and will skip synthesizing a hist-* for it).
        import("@/lib/persist").then(({ persistence }) => {
          persistence.saveSetting("apiProfiles", get().apiProfiles);
        });
      }
    }
    // Mirror the resolved provider config into apiConfig (what Helix backend reads).
    // Keep activeProviderId in sync so the dropdown stays scoped to this provider.
    // When we just promoted a history endpoint, also re-anchor activeProfileId to
    // the new real profile (the model's true owner).
    const patch: Partial<ApiConfigSlice> = {
      activeModel: model,
      activeProviderId: provider.id,
      apiConfig: {
        ...get().apiConfig,
        provider: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model,
      },
    };
    if (promotedProfileId) patch.activeProfileId = promotedProfileId;
    set(patch);
    // Keep the settings model list in sync: the model just activated must show
    // up (highlighted) on the config page. addApiHistory dedups by baseUrl +
    // apiKey + model, so re-activating the same model is idempotent.
    get().addApiHistory({ ...get().apiConfig, model });
    import("@/lib/persist").then(({ persistence }) => {
      persistence.saveSetting("activeModel", model);
      persistence.saveSetting("activeProviderId", provider.id);
      if (promotedProfileId) {
        persistence.saveSetting("activeProfileId", promotedProfileId);
      }
    });
    // Synchronous backup — if the async IndexedDB write above is still pending
    // when the app exits, we lose the last model. localStorage.setItem is
    // synchronous on the main thread, so it's a reliable fallback for the next
    // cold start.
    try {
      localStorage.setItem("helix-active-model", model);
      localStorage.setItem("helix-active-provider-id", provider.id);
    } catch { /* empty */}
    // Auto-fetch the newly-active provider's model list when we have no cached
    // copy yet, so the input-bar dropdown shows its full list without the user
    // having to open settings and click "获取模型列表".
    if (
      provider.baseUrl &&
      provider.apiKey &&
      !(get().providerModels?.[provider.id] ?? []).length
    ) {
      get().fetchProviderModels(provider.id);
    }
  },

  // ── Auto-fetch provider model lists ──────────────────────────────────────
  fetchProviderModels: async (providerId) => {
    const provider = get().providers.find((p) => p.id === providerId);
    if (!provider?.baseUrl || !provider.apiKey) return [];
    if (fetchingProviderModels.has(providerId)) {
      // Already fetching — return whatever cache we have now (the in-flight
      // fetch will update providerModels when it lands).
      return get().providerModels?.[providerId] ?? [];
    }
    fetchingProviderModels.add(providerId);
    try {
      if (
        typeof window === "undefined" ||
        !(window as any).electron?.helix?.fetchModels
      )
        return [];
      const result = await (window as any).electron.helix.fetchModels({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      });
      if (result?.error) throw new Error(result.error);
      const models = Array.isArray(result?.models)
        ? result.models.filter((m: unknown) => typeof m === "string" && m)
        : [];
      if (models.length > 0) {
        get().setAvailableModels(models, provider.baseUrl, provider.id);
      }
      return models;
    } catch (e) {
      warn("[api-config-slice] 自动获取模型失败:", provider.name, e);
      return [];
    } finally {
      fetchingProviderModels.delete(providerId);
    }
  },

  clearProviderModels: (providerId) => {
    set((state) => {
      const next = { ...state.providerModels };
      delete next[providerId];
      return { providerModels: next };
    });
  },

  setActiveProvider: (id) => {
    const provider = get().providers.find((p) => p.id === id);
    if (!provider) {
      warn("[api-config-slice] setActiveProvider: 找不到 Provider", id);
      return;
    }
    // Keep the current model if it still belongs to the new provider; otherwise
    // reselect the provider's default (or first) model. A provider with no models
    // leaves activeModel null — the UI shows the "no models" placeholder.
    // Consult the fetched list (providerModels) as well as the declared models,
    // since a model selected from "获取模型列表" may only live in providerModels.
    const cur = get().activeModel;
    const ownsModel = (pid: string, m?: string | null) =>
      !!m &&
      (provider.models.includes(m) ||
        (get().providerModels[pid] || []).includes(m));
    const keepModel = ownsModel(provider.id, cur);
    const model = keepModel
      ? cur
      : provider.defaultModel || provider.models[0] || null;
    set({
      activeProviderId: id,
      activeModel: model,
      apiConfig: {
        ...get().apiConfig,
        provider: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: model || "",
      },
    });
    import("@/lib/persist").then(({ persistence }) => {
      persistence.saveSetting("activeProviderId", id);
      if (model) persistence.saveSetting("activeModel", model);
    });
  },

  upsertProvider: (input) => {
    const id = input.id || generateId();
    const providers = get().providers;
    const exists = providers.some((p) => p.id === id);
    const next = exists
      ? providers.map((p) => (p.id === id ? { ...p, ...input, id } : p))
      : [...providers, { ...input, id }];
    set({ providers: next });
    // If nothing is selected yet, auto-pick this provider's default model.
    if (!get().activeModel && next.length > 0) {
      const idx = exists
        ? providers.findIndex((p) => p.id === id)
        : next.length - 1;
      const def = next[idx];
      const firstModel = def?.models?.[0];
      if (firstModel) get().setActiveModel(firstModel);
      else if (def && !get().activeProviderId)
        set({ activeProviderId: def.id });
    }
    import("@/lib/persist").then(({ persistence }) => {
      persistence.saveSetting("providers", next);
    });
    return id;
  },

  removeProvider: (id) => {
    const providers = get().providers.filter((p) => p.id !== id);
    set({ providers });
    const active = get().activeModel;
    const activeStillValid =
      !!active && providers.some((p) => p.models.includes(active));
    if (activeStillValid) {
      // The model survived in another provider — re-anchor activeProviderId to it.
      const owner = providers.find((p) => p.models.includes(active!));
      if (owner && get().activeProviderId !== owner.id)
        set({ activeProviderId: owner.id });
    } else {
      const first = providers[0];
      if (first?.models?.length) get().setActiveModel(first.models[0]);
      else set({ activeModel: null, activeProviderId: null });
    }
    import("@/lib/persist").then(({ persistence }) => {
      persistence.saveSetting("providers", providers);
    });
  },

  onModelSwitched: (model) => {
    // 1) Re-resolve apiConfig for the new model (Helix will use the new key).
    get().setActiveModel(model);
    // 2) Interrupt any in-flight session so the next prompt is built fresh.
    //    (use-helix detects the apiConfig hash change on next send → invalidate + repush.)
    // 3) Persist the switch (apiConfig + apiHistory + activeModel). This path is
    //    reached by the helix-layout bridge for OUT-OF-BAND switches (helix-ui
    //    ModelSelector), which otherwise never call persistToStorage — leaving a
    //    restart with an apiHistory that doesn't contain the newly-selected model.
    import("@/lib/persist").then(({ persistence }) => {
      const s = get();
      persistence.saveSetting("apiHistory", s.apiHistory);
      persistence.saveSetting("apiConfig", s.apiConfig);
      persistence.saveSetting("activeModel", s.activeModel);
      persistence.saveSetting("activeProviderId", s.activeProviderId);
    });
  },
});
