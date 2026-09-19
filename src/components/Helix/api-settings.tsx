"use client";

import {
  Settings,
  Sun,
  Plug,
  Archive,
  ChevronLeft,
  Search,
  X,
  GripVertical,
  Globe,
  Keyboard,
  Zap,
  Bot,
  Activity,
  Workflow,
  RefreshCw,
} from "lucide-react";
import React, {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
} from "react";
import { AgentsSettings } from "./agents-settings";
import { AppearanceSettingsPanel } from "./appearance-settings-panel";
import { GeneralSettingsPanel } from "./general-settings-panel";
import { HookSettings } from "./hook-settings";
import { ImageModelSettings } from "./image-model-settings";
import { McpEditorForm, type McpFormData } from "./mcp-editor-form";
import { PageHeader, PopupSelect, SettingGroup, SaveBar } from "./settings-ui";
import { ShortcutsPage } from "./shortcuts-page";
import {
  ModelUsageStats,
  UsageSummary,
  UsageDetail,
  TokenUsagePanel,
} from "./usage-stats";
import { VisionModelSettings } from "./vision-model-settings";
import { Button } from "@/components/ui/button";
import { getCurrentVersion } from "@/hooks/use-check-update";
import { pushModelConfig, pushModelConfigWithKey } from "@/lib/config-sync";
import {
  isElectron,
  helixApi,
  electronFS,
  electronDialog,
  electronApp,
} from "@/lib/electron-bridge";
import { persistence } from "@/lib/persist";
import { getAllProviders, getBaseUrl } from "@/lib/providers";
import { useGatewayStore } from "@/stores/gateway-store";
import { useHelixStore, type ApiConfig } from "@/stores/helix-store";

const ALL_PROVIDERS = getAllProviders();

// 供应商的 API 格式 —— 写入 pi models.json 的 provider `api` 字段。
// 取值与 pi-ai 的协议枚举一致，拼错会导致该 provider 的所有请求走错协议。
const API_FORMATS = [
  { label: "Anthropic Messages (/v1/messages)", value: "openai-completions" },
  { label: "Responses (/responses)", value: "openai-responses" },
  { label: "Chat Completions (/chat/completions)", value: "anthropic-messages" },
];
const DEFAULT_API_FORMAT = "openai-completions";

const PERSONALITY_LABELS: Record<string, string> = {};

const CUSTOM_PROVIDER_ID = "__custom__";

/* Derives a friendly provider name from a baseUrl hostname, falling back to the
 *  "配置 · <model>" pattern, which becomes meaningless once a profile accumulates
 *  models from multiple endpoints. */


interface SettingsProps {
  themeStyle: string;
  onSelectThemeStyle: (styleId: string) => void;
  // Shared with the main layout so the settings nav width stays in sync with
  // the main sidebar (single source of truth: helix-layout's sidebarWidth).
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
  saveSidebarWidth: (w: number) => void;
  showSidebar: boolean;
  setShowSidebar: (v: boolean | ((prev: boolean) => boolean)) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean | ((prev: boolean) => boolean)) => void;
}

type SettingsPage =
  | "general"
  | "appearance"
  | "api"
  | "shortcuts"
  | "mcp"
  | "archive"
  | "hook"
  | "usage"
  | "help"
  | "agents";

interface NavItem {
  id: SettingsPage;
  label: string;
  icon: typeof Settings | React.FC<{ className?: string }>;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: "个人",
    items: [
      { id: "general", label: "常规", icon: Settings },
      { id: "appearance", label: "外观", icon: Sun },
      { id: "shortcuts", label: "快捷键", icon: Keyboard },
    ],
  },
  {
    title: "配置",
    items: [
      { id: "api", label: "模型", icon: Globe },
      { id: "mcp", label: "MCP", icon: Plug },
      { id: "usage", label: "用量", icon: Activity },
      { id: "agents", label: "子智能体", icon: Bot },
    ],
  },
  {
    title: "集成",
    items: [
      { id: "hook", label: "Hook", icon: Workflow },
      { id: "archive", label: "历史归档", icon: Archive },
    ],
  },
];

// ModelUsageStats, UsageSummary, UsageDetail, TokenUsagePanel — extracted to ./usage-stats.tsx

// ShortcutsPage — extracted to ./shortcuts-page.tsx
// McpEditorForm — extracted to ./mcp-editor-form.tsx

// ─── Shared components ──────────────────────────────────────────────────────
const Toggle = ({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) => (
  <button
    onClick={onToggle}
    className={`relative w-10 h-6 rounded-full transition-colors duration-200 ${
      enabled ? "bg-primary" : "bg-muted-foreground/20"
    }`}
  >
    <span
      className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${
        enabled ? "translate-x-4" : ""
      }`}
    />
  </button>
);

// ─── Main component ──────────────────────────────────────────────────────────
export function ApiSettings({
  themeStyle,
  onSelectThemeStyle,
  sidebarWidth,
  setSidebarWidth,
  saveSidebarWidth,
  showSidebar,
  setShowSidebar,
  sidebarCollapsed,
  setSidebarCollapsed,
}: SettingsProps) {
  const {
    apiConfig,
    apiProfiles,
    activeProfileId,
    apiHistory,
    addApiHistory,
    removeApiHistory,
    providers,
    activeModel,
    upsertProvider,
    removeProvider,
    setActiveModel,
    setApiConfig,
    addApiProfile,
    updateApiProfileConfig,
    renameApiProfile,
    removeApiProfile,
    setActiveProfile,
    showToast,
    persistToStorage,
    setAvailableModels,
    availableModels,
    fontFamily,
    setFontFamily,
    fontSize,
    setFontSize,
    interfaceFont,
    setInterfaceFont,
    transcriptFontSize,
    setTranscriptFontSize,
    mcpServers,
    removeMcpServer,
    toggleMcpServer,
    // Helix config-backed toggles
    personality,
    setPersonality,
    // Agent settings
    autoCompactContext,
    setAutoCompactContext,
  } = useHelixStore();

  const settingsPage = useHelixStore((s) => s.settingsPage);
  const setSettingsPage = useHelixStore((s) => s.setSettingsPage);
  const pushNavigation = useHelixStore((s) => s.pushNavigation);
  const [page, setPage] = useState<SettingsPage>(
    (settingsPage as SettingsPage) || "general",
  );
  const [navSearch, setNavSearch] = useState("");
  const navSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k" && !e.shiftKey) {
        e.preventDefault();
        navSearchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  useEffect(() => {
    if (settingsPage) {
      setPage(settingsPage as SettingsPage);
      setSettingsPage(null);
    }
  }, [settingsPage, setSettingsPage]);
  const [localConfig, setLocalConfig] = useState<ApiConfig>({ ...apiConfig });
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    new Set(),
  );
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getCurrentVersion().then((v) => v && setAppVersion(v));
  }, []);

  // ── Settings nav resize (synced with the main sidebar width) ──────────────
  // The main sidebar width lives in helix-layout and is the single source of
  // truth. We mirror it here so the settings nav matches, and let the user drag
  // this handle to resize — which also resizes the main sidebar live.
  const SETTINGS_NAV_MIN = 200;
  const SETTINGS_NAV_MAX = 500;
  const uiFontSize = useHelixStore((s) => s.fontSize);
  const navWidth = Math.max(
    SETTINGS_NAV_MIN,
    Math.min(SETTINGS_NAV_MAX, sidebarWidth),
  );
  const navVisualWidth = navWidth * (uiFontSize / 14);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(navWidth);
  const latestNavW = useRef(navWidth);

  const startNavResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeStartX.current = e.clientX;
      resizeStartW.current = navWidth;
      latestNavW.current = navWidth;
      setIsResizing(true);
    },
    [navWidth],
  );

  useEffect(() => {
    if (!isResizing) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const delta = e.clientX - resizeStartX.current;
        const next = Math.max(
          SETTINGS_NAV_MIN,
          Math.min(SETTINGS_NAV_MAX, resizeStartW.current + delta),
        );
        latestNavW.current = next;
        setSidebarWidth(next);
      });
    };
    const onUp = () => {
      cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setIsResizing(false);
      saveSidebarWidth(latestNavW.current);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isResizing, setSidebarWidth, saveSidebarWidth]);

  useEffect(() => {
    setLocalConfig({ ...apiConfig });
  }, [apiConfig]);

  // 挂载时把 activeProfile 自动带进供应商列表 + 右侧编辑表单，用户一打开
  // 设置就能看到当前生效的供应商及其已添加的模型，不必先在左侧手动点一下
  // 才把 addedModels 灌进来。保存后 activeProfile 会指向刚保存的那一条，
  // 下次打开设置直接命中，符合"保存后回来看应该还在"的预期。
  useEffect(() => {
    if (!activeProfileId || apiProfiles.length === 0) return;
    const p = apiProfiles.find((x) => x.id === activeProfileId);
    if (!p) return;
    setSelectedProviderId(p.id);
    setEditingProfileId(p.id);
    setLocalConfig({ ...p.config });
    setAddedModels((p.models || []).map((id) => ({ id })));
  }, [activeProfileId, apiProfiles]);

  // Mirror the backend's actual config when running in Electron so the form
  // shows what Helix is really using.
  //
  // CRITICAL: the backend's helix:getConfig does NOT return the API key — the
  // key lives in config.yaml (vision.apiKey / image.apiKey) or pi's auth.json
  // and is never echoed back over IPC (security).
  // So we must PRESERVE the key already in the store instead of clobbering it
  // with ''. And we must NOT call persistToStorage() here: this is a read-only
  // mirror. Persisting would overwrite the saved profile with an empty key and
  // force the user to reconfigure the model after every restart / every time
  // they open Settings (the old behaviour).
  useEffect(() => {
    if (!isElectron()) return;
    const h = (window as any).electron?.helix;
    if (!h?.getConfig) return;
    h.getConfig()
      .then((r: any) => {
        if (!r || !r.model) return;
        // Read the latest store value at resolve time (restoreFromStorage may have
        // just rehydrated it). Preserve its key; only fill backend-known fields.
        const store = useHelixStore.getState();
        const cur = store.apiConfig;
        // ★ Critical: if the user has explicitly selected a different model in the
        // chat input (activeModel), do NOT let the backend config.yaml overwrite it.
        // Without this guard, opening Settings would revert apiConfig.model to the
        // backend default (e.g. deepseek-v4-flash) even though the chat is actively
        // using a different model — causing the settings list to highlight the wrong
        // entry and creating a visual/actual mismatch.
        const frontendModel = store.activeModel || cur.model;
        const effectiveModel = frontendModel || r.model;
        const baseUrl = r.baseUrl || cur.baseUrl;
        setApiConfig({
          provider: r.provider || cur.provider,
          apiKey: cur.apiKey, // never overwrite the saved key with ''
          baseUrl,
          model: effectiveModel,
        });
        // Intentionally NOT calling persistToStorage(): mirroring must not write
        // back to IndexedDB (that would wipe the persisted profile's key).
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Self-heal: make sure the CURRENT model always appears (and therefore
  // highlights) in the history list. If a model was activated through a path
  // that never recorded it into apiHistory (or a stale persisted copy dropped
  // it), opening Settings would show no highlighted entry at all. addApiHistory
  // dedups by baseUrl + apiKey + model, so re-adding the current config is
  // idempotent.
  useEffect(() => {
    const st = useHelixStore.getState();
    const cfg = st.apiConfig;
    if (cfg?.baseUrl && cfg?.model) {
      st.addApiHistory({ ...cfg });
    }
     
  }, []);

  const [showApiKey, setShowApiKey] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [showAddModelModal, setShowAddModelModal] = useState(false);
  // 已添加的模型（第一个是默认模型）。每项的 contextWindow 单独落到
  // models.json 里对应模型条目上，所以不能复用 localConfig.contextWindow。
  const [addedModels, setAddedModels] = useState<
    { id: string; contextWindow?: number }[]
  >([]);
  const [showAddModelDialog, setShowAddModelDialog] = useState(false);
  const [pickedModel, setPickedModel] = useState("");
  const [pickedContext, setPickedContext] = useState("");
  const [manualModel, setManualModel] = useState("");
  type ModelTab = "main" | "vision" | "image";
  const [modelTab, setModelTab] = useState<ModelTab>("main");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  // ── Pi-backed model list ──────────────────────────────────────────────────
  // The dropdowns used to render only Helix's own static provider table plus
  // whatever a manual `/v1/models` probe returned. Neither reflects what the Pi
  // backend can actually run (Pi resolves models from ~/.pi/agent/settings.json
  // + custom-providers.json), so a user could pick a model Pi has never heard
  // of. Pull Pi's authoritative list via the `get_available_models` RPC.
  type PiModel = {
    id: string;
    provider: string;
    name?: string;
    baseUrl?: string;
    api?: string;
    reasoning?: boolean;
    contextWindow?: number;
  };
  const [piModels, setPiModels] = useState<PiModel[]>([]);
  const [isLoadingPiModels, setIsLoadingPiModels] = useState(false);

  const loadPiModels = useCallback(async () => {
    if (!isElectron()) return;
    setIsLoadingPiModels(true);
    try {
      const r = await window.electron.helix.piGetAvailableModels();
      const list = Array.isArray(r?.models) ? (r.models as PiModel[]) : [];
      setPiModels(list.filter((m) => m?.id && m?.provider));
    } catch {
      // Pi may still be spawning (gateway not INITIALIZED yet) — degrade to the
      // manual probe path silently instead of firing a scary toast on open.
      setPiModels([]);
    } finally {
      setIsLoadingPiModels(false);
    }
  }, []);

  // Refresh whenever the add-model form opens so the list can't go stale after
  // the user edits ~/.pi/agent/custom-providers.json outside Helix.
  useEffect(() => {
    if (showAddModelModal) void loadPiModels();
  }, [showAddModelModal, loadPiModels]);

  /** Providers Pi actually has configured, with their model counts. */
  const piProviders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of piModels) {
      counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
    }
    return [...counts.entries()].map(([id, count]) => ({ id, count }));
  }, [piModels]);

  /** Provider dropdown: Pi's live providers first (they're the ones that will
   *  actually work), then the static table, then the custom escape hatch. */
  const providerOptions = useMemo(() => {
    const piIds = new Set(piProviders.map((p) => p.id));
    return [
      ...piProviders.map((p) => ({
        label: `${p.id} · Pi (${p.count})`,
        value: p.id,
      })),
      ...ALL_PROVIDERS.filter((p) => !piIds.has(p.id)).map((p) => ({
        label: `${p.name} (${p.id})`,
        value: p.id,
      })),
      { label: "＋ 自定义", value: CUSTOM_PROVIDER_ID },
    ];
  }, [piProviders]);

  /** Pi model ids scoped to the selected provider. Helix prefixes custom
   *  providers with `custom:` to avoid colliding with built-in env-var names,
   *  while Pi stores them under the bare name — strip it before matching. */
  const piModelIds = useMemo(() => {
    const prov = localConfig.provider.trim().replace(/^custom:/, "");
    const scoped = prov
      ? piModels.filter((m) => m.provider === prov)
      : piModels;
    return [...new Set(scoped.map((m) => m.id))];
  }, [piModels, localConfig.provider]);

  /** Union of the endpoint probe result and Pi's configured list, so neither
   *  source hides the other (probe first — the user asked for it explicitly). */
  const modelOptions = useMemo(() => {
    const out = [...availableModels];
    for (const id of piModelIds) if (!out.includes(id)) out.push(id);
    return out;
  }, [availableModels, piModelIds]);

  /** Ids that came from Pi and were NOT in the probe result — tagged in the UI
   *  so the user can tell which entries the backend already knows about. */
  const piOnlyIds = useMemo(
    () => new Set(piModelIds.filter((id) => !availableModels.includes(id))),
    [piModelIds, availableModels],
  );

  const applyYamlKey = useCallback(
    async (key: string, value: boolean) => {
      if (!isElectron) return;
      try {
        const r: any = await window.electron.helix.setYamlKey(key, value);
        if (r?.success && r?.changed) {
          showToast({
            title: "设置已保存",
            description: "Helix 已重启生效",
            type: "success",
          });
        } else if (!r?.success) {
          showToast({
            title: "保存失败",
            description: r?.error || "未知错误",
            type: "error",
          });
        }
      } catch (e: any) {
        showToast({
          title: "保存失败",
          description: e?.message || String(e),
          type: "error",
        });
      }
    },
    [showToast],
  );
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [modelSort, setModelSort] = useState<"asc" | "desc" | "none">("asc");

  // Search-filtered + sorted view of the model list (the dropdown renders this,
  // not the raw availableModels, so the search box and sort buttons compose).
  const sortedModelOptions = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    const filtered = q
      ? availableModels.filter((m) => m.toLowerCase().includes(q))
      : availableModels;
    const copy = [...filtered];
    copy.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return modelSort === "desc" ? copy.reverse() : copy;
  }, [availableModels, modelSearch, modelSort]);

  useEffect(() => {
    if (!showModelDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (
        modelDropdownRef.current &&
        !modelDropdownRef.current.contains(e.target as Node)
      ) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showModelDropdown]);

  // MCP state
  const [editingMcpName, setEditingMcpName] = useState<string | null>(null);
  const [isAddingMcp, setIsAddingMcp] = useState(false);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpSaveState, setMcpSaveState] = useState<null | "ok" | "err">(null);
  const [mcpSaveErr, setMcpSaveErr] = useState<string | null>(null);
  const selectedWorkDir = useHelixStore((s) => s.selectedWorkDir);
  const [defaultMcpCwd, setDefaultMcpCwd] = useState("");
  useEffect(() => {
    let alive = true;
    electronApp
      .getDataRoot()
      .then((info) => {
        if (alive && info?.dataRoot) {
          setDefaultMcpCwd(`${info.dataRoot.replace(/[\\/]+$/, "")}/sessions`);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const resolveDefaultMcpCwd = useCallback(
    () => selectedWorkDir || defaultMcpCwd || "",
    [selectedWorkDir, defaultMcpCwd],
  );
  const [mcpForm, setMcpForm] = useState<McpFormData>({
    name: "",
    type: "local",
    command: "",
    url: "",
    args: "",
  });
  const mcpServerNames = Object.keys(mcpServers);
  const [mcpStatus, setMcpStatus] = useState<Record<string, string>>({});
  // Gateway MCP servers — read-only view of config.yaml `mcp_servers` (loaded
  // by the gateway at startup; separate from the app-managed list above, which
  // is persisted locally and sent per-session via session/new).
  const [gatewayMcp, setGatewayMcp] = useState<Record<string, any>>({});
  const [gatewayMcpLoaded, setGatewayMcpLoaded] = useState(false);
  // Name of a gateway (config.yaml mcp_servers) server being edited — opens
  // the shared McpEditorForm with its config; null = not editing.
  const [gatewayEditing, setGatewayEditing] = useState<string | null>(null);

  // MCP status - read the REAL runtime connection state from the backend via
  // `mcp.servers.status` (session-independent; covers both config.yaml servers
  // and session-injected servers). Replaces the old tools/list tool-name probe.
  const helixSessionId = useGatewayStore((s) => s.helixSessionId);
  const [mcpStatusAttempt, setMcpStatusAttempt] = useState(0);
  const fetchMcpStatus = useCallback(async () => {
    try {
      const result = (await helixApi()!.send("mcp.servers.status", {})) as any;
      const servers: any[] = result?.servers || [];
      const status: Record<string, string> = {};
      for (const s of servers) {
        if (s?.name)
          status[s.name] =
            s.status || (s.connected ? "connected" : "configured");
      }
      setMcpStatus(status);
      setMcpStatusAttempt(0); // success resets the retry counter
    } catch {
      // Transient failure (WS not ready, RPC timeout): keep last status and
      // schedule a retry instead of wiping to {} (which shows "检测中" forever).
      setMcpStatusAttempt((a) => a + 1);
    }
  }, [mcpServers, gatewayMcp, helixSessionId]);

  // Run on mount + whenever session id / server list changes.
  useEffect(() => {
    fetchMcpStatus();
  }, [fetchMcpStatus]);

  // Bounded retry with backoff (2s, 4s, 8s, 16s, 32s) after a failed probe.
  useEffect(() => {
    if (mcpStatusAttempt === 0) return;
    if (mcpStatusAttempt > 5) return;
    const delay = 2000 * Math.pow(2, mcpStatusAttempt - 1);
    const t = setTimeout(() => {
      fetchMcpStatus();
    }, delay);
    return () => clearTimeout(t);
  }, [mcpStatusAttempt, fetchMcpStatus]);

  // Gentle polling so status reflects late MCP discovery / reconnects without
  // needing to reopen the settings page. Session-independent: runs whenever the
  // gateway is reachable.
  useEffect(() => {
    const t = setInterval(() => {
      fetchMcpStatus();
    }, 15000);
    return () => clearInterval(t);
  }, [fetchMcpStatus]);

  // Load gateway MCP servers from config.yaml (Tauri IPC)
  const reloadGatewayMcp = useCallback(async () => {
    if (!isElectron()) {
      setGatewayMcpLoaded(true);
      return;
    }
    try {
      const api = (window as any).electron?.mcpConfig;
      if (!api?.list) {
        setGatewayMcpLoaded(true);
        return;
      }
      const r = await api.list();
      if (r?.ok && r.servers) setGatewayMcp(r.servers || {});
    } catch {
      // settings page must not break on IPC failure
    } finally {
      setGatewayMcpLoaded(true);
    }
  }, []);

  useEffect(() => {
    reloadGatewayMcp();
  }, [reloadGatewayMcp]);

  // Archive state
  const [archives, setArchives] = useState<
    Array<{ id: string; label: string; savedAt: number; messageCount: number }>
  >([]);

  const loadArchives = useCallback(async () => {
    try {
      const sessions = await persistence.loadSessions();
      setArchives(
        sessions
          .filter((s) => s.isArchived)
          .sort((a, b) => b.savedAt - a.savedAt)
          .map((s) => ({
            id: s.id,
            label: s.label,
            savedAt: s.savedAt,
            messageCount: s.chatMessages.length,
          })),
      );
    } catch { /* empty */}
  }, []);

  useEffect(() => {
    loadArchives();
  }, [loadArchives]);

  // ── API handlers ──────────────────────────────────────────────────────────
  const handleCustomProviderChange = useCallback((providerValue: string) => {
    setLocalConfig((prev) => ({ ...prev, provider: providerValue }));
    // 输入恰好命中已知 provider 时自动补 Base URL，省得再查一遍地址。
    if (providerValue.trim().length > 0) {
      const match = ALL_PROVIDERS.find(
        (p) => p.id.toLowerCase() === providerValue.trim().toLowerCase(),
      );
      if (match) {
        setLocalConfig((prev) => ({
          ...prev,
          provider: match.id,
          baseUrl: getBaseUrl(match.id) || prev.baseUrl,
          model: prev.model,
        }));
      }
    }
  }, []);

  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [apiView, setApiView] = useState<"list" | "edit">("list");

  const handleFetchModels = useCallback(async () => {
    // Pi's list needs no credentials, so refresh it unconditionally — it is the
    // list the backend can actually serve.
    void loadPiModels();
    if (!localConfig.apiKey.trim() || !localConfig.baseUrl.trim()) {
      // Only nag when Pi gave us nothing either; otherwise the dropdown is
      // already usable and a warning would just be noise.
      if (piModels.length === 0) {
        showToast({ type: "warning", title: "请先填写 Base URL 和 API Key" });
      }
      return;
    }
    setIsLoadingModels(true);
    try {
      let models: string[] = [];
      if (isElectron()) {
        // Use Electron IPC to fetch models (Helix backend)
        const result = (await window.electron.helix.fetchModels({
          baseUrl: localConfig.baseUrl,
          apiKey: localConfig.apiKey,
        })) as any;
        if (result.error) throw new Error(result.error);
        models = result.models || [];
      } else {
        // Browser mode has no backend to probe models — surface a clear error
        // instead of hitting a deleted /api/models route (404).
        throw new Error("模型列表获取仅在桌面端可用");
      }
      if (models.length === 0) {
        showToast({ type: "warning", title: "未获取到模型" });
      } else {
        // Scope the fetched list to the endpoint being probed (baseUrl), NOT the
        // (possibly stale) activeProviderId. Without this, setAvailableModels
        // keys the list under the previous provider and the model selector —
        // which reads providerModels[activeProvider.id] — can't see it, dropping
        // the fetched list to just the single declared model.
        setAvailableModels(models, localConfig.baseUrl);
        showToast({ type: "success", title: `获取到 ${models.length} 个模型` });
      }
    } catch (error) {
      showToast({
        type: "error",
        title: error instanceof Error ? error.message : "获取失败",
      });
      setAvailableModels([]);
    } finally {
      setIsLoadingModels(false);
    }
  }, [localConfig.apiKey, localConfig.baseUrl, showToast, setAvailableModels]);

  const applyProfile = useCallback(
    async (id: string) => {
      const p = apiProfiles.find((x) => x.id === id);
      if (!p) return;
      setLocalConfig({ ...p.config });
      setApiConfig({ ...p.config });
      // 同步 activeModel 到该 profile 的模型：applyProfile 之前只更新 apiConfig /
      // activeProviderId / activeProfileId，漏了 activeModel —— 重启时
      // restoreFromStorage 以 activeModel 为准（builtActiveModel），残留的旧模型
      // （如 deepseek-v4-flash）会把一切拉回旧端点（"每次重启都是 deepseek"）。
      if (p.config.model) {
        useHelixStore.setState({ activeModel: p.config.model });
      }
      // Re-anchor activeProviderId to the profile's endpoint. applyProfile used to
      // leave it at the previously-active provider, so the chat dropdown's open
      // refetch hit the wrong endpoint and the selector dropped to 1 model.
      useHelixStore.setState((s) => {
        const pid = s.providers.find(
          (pr) => pr.baseUrl === s.apiConfig.baseUrl,
        )?.id;
        return pid ? { activeProviderId: pid } : {};
      });
      setActiveProfile(id);
      // Clear stale available models from the previous provider so the dropdown
      // only shows models fetched from the NEW endpoint.
      setAvailableModels([]);
      // Persist the selection so it survives a cold restart (otherwise the active
      // profile is forgotten and restoreFromStorage reverts to the old apiConfig).
      try {
        await persistToStorage();
      } catch { /* empty */}
      // Invalidate the cached Helix session so the next prompt rebuilds it with
      // the newly-selected profile's model/key (prevents stale-session 401s).
      useGatewayStore.getState().setHelixSessionId(null);
      if (isElectron()) {
        try {
          const cfg = {
            model: p.config.model,
            provider:
              p.config.provider && p.config.provider !== "__custom__"
                ? p.config.provider
                : "custom",
            baseUrl: p.config.baseUrl,
            apiKey: p.config.apiKey,
          };
          // serve 模式：helix:setConfig 是 no-op（main.js 直接 return success），
          // 必须走 pushModelConfigWithKey —— 内部按模式分流：serve → setModel 写
          // config.yaml（生效）；acp → setConfig + cacheConfig（行为不变）。
          // 否则在设置里切换 profile 永远到不了网关，config.yaml 残留旧配置
          // （如 deepseek+Kimi 错配 → 400 无输出）。这是用户显式切换 profile 的
          // 动作，key 走一次性通道（cacheConfig 落盘时会剥掉 key）。
          pushModelConfigWithKey(cfg);
          // Persist the active profile so the next cold start re-asserts it
          // into Helix config.yaml (no hardcoded pin, free switching preserved).
          await window.electron.profile.cacheConfig(cfg);
        } catch { /* empty */}
      }
    },
    [
      apiProfiles,
      setLocalConfig,
      setApiConfig,
      setActiveProfile,
      persistToStorage,
    ],
  );

  const handleAddProfile = useCallback(() => {
    setEditingProfileId(null);
    setLocalConfig({ provider: "", apiKey: "", baseUrl: "", model: "" });
    setAvailableModels([]);
    setShowModelDropdown(false);
    setApiView("edit");
  }, []);

  const handleRemoveProfile = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      removeApiProfile(id);
      await persistToStorage();
    },
    [removeApiProfile, persistToStorage],
  );

  const handleEditProfile = useCallback(
    (id: string) => {
      const p = apiProfiles.find((x) => x.id === id);
      if (!p) return;
      setEditingProfileId(id);
      setLocalConfig({ ...p.config });
      setAvailableModels([]);
      setShowModelDropdown(false);
      // 编辑既有供应商时把已保存的模型带进卡片，否则列表会显示为空、
      // 保存一次就把 models 数组清空。
      setAddedModels((p.models || []).map((id) => ({ id })));
      setApiView("edit");
    },
    [apiProfiles],
  );

  const handleBackToList = useCallback(() => {
    setApiView("list");
    setEditingProfileId(null);
  }, []);

  // 把弹窗里选/填的模型加入当前供应商的模型列表。
  const confirmAddModel = useCallback(() => {
    const id = pickedModel.trim() || manualModel.trim();
    if (!id) {
      showToast({ type: "error", title: "请先获取并选择模型，或手动输入名称" });
      return;
    }
    const raw = pickedContext.trim();
    const contextWindow = raw ? Number(raw) : undefined;
    if (
      contextWindow !== undefined &&
      (!Number.isFinite(contextWindow) ||
        !Number.isInteger(contextWindow) ||
        contextWindow <= 0)
    ) {
      showToast({ type: "error", title: "模型上下文限制必须是正整数" });
      return;
    }
    setAddedModels((prev) => [
      ...prev.filter((m) => m.id !== id),
      { id, contextWindow },
    ]);
    setPickedModel("");
    setManualModel("");
    setPickedContext("");
    setModelSearch("");
    setShowAddModelDialog(false);
  }, [pickedModel, manualModel, pickedContext, showToast]);

  // 保存状态（与「保存 Hooks 配置」一致的行内反馈，不依赖 toast）
  const [apiSaving, setApiSaving] = useState(false);
  const [apiSaveState, setApiSaveState] = useState<null | "ok" | "err">(null);
  const [apiSaveErr, setApiSaveErr] = useState<string | null>(null);

  const handleSaveApi = useCallback(async () => {
    setApiSaving(true);
    setApiSaveState(null);
    setApiSaveErr(null);
    let failed = false;
    try {
    if (!localConfig.baseUrl.trim()) {
      failed = true;
      setApiSaveErr("请填写 Base URL");
      setApiSaveState("err");
      return;
    }
    const savedModels = addedModels
      .map((m) => m.id.trim())
      .filter(Boolean);
    if (savedModels.length === 0) {
      failed = true;
      setApiSaveErr("请至少添加一个模型");
      setApiSaveState("err");
      return;
    }
    if (
      addedModels.some(
        (m) =>
          m.contextWindow !== undefined &&
          (!Number.isFinite(m.contextWindow) ||
            !Number.isInteger(m.contextWindow) ||
            m.contextWindow <= 0),
      )
    ) {
      failed = true;
      setApiSaveErr("模型上下文限制必须是正整数");
      setApiSaveState("err");
      return;
    }
    // 第一个模型是默认模型（写入 settings.json 的 defaultModel），其余只进
    // models.json 的模型列表；每个模型的上下文限制落在各自条目上。
    const firstModel = addedModels.find((m) => m.id.trim())!;
    const finalConfig: ApiConfig = {
      ...localConfig,
      apiFormat: localConfig.apiFormat || DEFAULT_API_FORMAT,
      model: firstModel.id,
      contextWindow: firstModel.contextWindow,
    };
    // Persist the whole added list (the fetched list stays in-memory: it is
    // re-fetched whenever the selector opens, so caching it would only hide
    // newly added models until a manual refresh).
    const profileModels = savedModels;
    // Bind to current profile: update the active one, otherwise reuse a matching
    // profile or create a new named one.
    const profileName = localConfig.provider.trim().replace(/^custom:/, "") || "配置";
    if (editingProfileId) {
      updateApiProfileConfig(editingProfileId, finalConfig, profileModels);
      renameApiProfile(editingProfileId, profileName);
      setActiveProfile(editingProfileId);
    } else {
      const dup = apiProfiles.find(
        (p) =>
          p.config.baseUrl === finalConfig.baseUrl &&
          p.config.apiKey === finalConfig.apiKey,
      );
      if (dup) {
        // Same endpoint — reuse that profile and let this card's list be the
        // provider's authoritative model list (deletions in the card apply).
        updateApiProfileConfig(dup.id, finalConfig, profileModels);
        renameApiProfile(dup.id, profileName);
        setActiveProfile(dup.id);
      } else {
        const id = addApiProfile(profileName, finalConfig, profileModels);
        setActiveProfile(id);
      }
    }
    // 让聊天输入框的两级模型选择器立刻看到这个供应商。`providers` 只在启动
    // 恢复时从 apiProfiles 重建，不同步的话保存完得重启才看得到刚加的模型。
    // 按 baseUrl 复用已有条目，避免重复保存一次就多一张重复的供应商卡片。
    {
      const st = useHelixStore.getState();
      const existing =
        st.providers.find(
          (p) =>
            p.baseUrl === finalConfig.baseUrl &&
            (!finalConfig.apiKey || p.apiKey === finalConfig.apiKey),
        ) || st.providers.find((p) => p.baseUrl === finalConfig.baseUrl);
      upsertProvider({
        id: existing?.id,
        name: finalConfig.provider.trim(),
        baseUrl: finalConfig.baseUrl,
        // 留空就沿用该条目已有的 key，别把已保存的密钥覆盖成空串。
        apiKey: finalConfig.apiKey.trim() || existing?.apiKey || "",
        models: profileModels,
        defaultModel: profileModels[0],
      });
    }
    setApiConfig(finalConfig);
    // Keep activeModel in sync with the saved model. Without this the chat
    // dropdown highlight (activeModel-first) and the settings backend mirror
    // (which guards on activeModel || cur.model) would keep pinning the
    // PREVIOUS model — e.g. after saving deepseek-v4-flash while a different
    // model was active, the dropdown would never highlight it and the mirror
    // would revert the backend model back. Use the POST-snap apiConfig.model (setApiConfig
    // may correct a model/baseUrl mismatch), so activeModel can't drift from it.
    // Also re-anchor activeProviderId to the endpoint just saved: leaving it at
    // the PREVIOUS provider makes the chat dropdown's open-refetch hit the wrong
    // endpoint and scopes providerModels reads to the wrong key — the "fetched 2
    // models, selector shows only 1" bug.
    useHelixStore.setState((s) => {
      const pid = s.providers.find(
        (p) => p.baseUrl === s.apiConfig.baseUrl,
      )?.id;
      return {
        activeModel: s.apiConfig.model,
        ...(pid ? { activeProviderId: pid } : {}),
      };
    });
    // Persist the snapped (mismatch-corrected) config into history so a
    // model/baseUrl split can never be re-saved as a new history entry.
    const snapped = useHelixStore.getState().apiConfig;
    addApiHistory(snapped);
    // Clear any stale per-provider fetched model cache for this endpoint so the
    // next open of the chat model selector re-fetches live (per user request:
    // "保存时不存储模型列表"). The live fetch on open repopulates it.
    {
      const st = useHelixStore.getState();
      const pid = st.providers.find(
        (p) => p.baseUrl === finalConfig.baseUrl,
      )?.id;
      if (pid) st.clearProviderModels(pid);
    }
    await persistToStorage();

    // Sync to Helix if running in Electron or Tauri
    const helix = (window as any).electron?.helix;
    if (isElectron() || helix?.setConfig) {
      try {
        const cfg = {
          model: finalConfig.model,
          provider:
            finalConfig.provider && finalConfig.provider !== "__custom__"
              ? finalConfig.provider
              : "custom",
          baseUrl: finalConfig.baseUrl,
          apiKey: finalConfig.apiKey,
          contextWindow: finalConfig.contextWindow,
          api: finalConfig.apiFormat,
        };
        // Register the whole model list first (per-model contextWindow + the
        // API format), then point pi's default at the first model.
        if (typeof helix?.setProviderModels === "function") {
          await helix.setProviderModels({
            provider: cfg.provider,
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            api: cfg.api,
            models: addedModels
              .filter((m) => m.id.trim())
              .map((m) => ({
                id: m.id.trim(),
                contextWindow: m.contextWindow,
              })),
          });
        }
        await helix.setConfig(cfg);
        // Persist the active profile so the next cold start re-asserts it
        // into Helix config.yaml (no hardcoded pin, free switching preserved).
        await (window as any).electron?.profile?.cacheConfig?.(cfg);
        // Invalidate the cached session so the next prompt creates a fresh one
        // with the updated config. Without this, a stale session ID could be
        // reused against a restarted gateway, producing 401 errors.
        useGatewayStore.getState().setHelixSessionId(null);
      } catch {
        failed = true;
        setApiSaveErr("配置已保存，但 Helix 同步失败");
      }
    }
    if (!failed) {
      setApiSaveState("ok");
      setTimeout(() => setApiSaveState(null), 2000);
    } else {
      setApiSaveState("err");
    }
    } finally {
      setApiSaving(false);
    }
  }, [
    localConfig,
    addedModels,
    editingProfileId,
    apiProfiles,
    setApiConfig,
    addApiProfile,
    updateApiProfileConfig,
    setActiveProfile,
    addApiHistory,
    upsertProvider,
    persistToStorage,
    showToast,
  ]);

  const hasApiConfig = !!apiConfig.apiKey;

  // ── MCP handlers ─────────────────────────────────────────────────────────
  const mcpArgText = useCallback((v: unknown) => {
    if (typeof v === "string") return v;
    if (v === null || v === undefined) return "";
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }, []);

  const resetMcpForm = useCallback(() => {
    setMcpForm({ name: "", type: "local", command: "", url: "", args: "" });
  }, []);

  const handleSaveMcp = useCallback(async () => {
    const name = mcpForm.name.trim();
    if (!name) {
      setMcpSaveState("err");
      setMcpSaveErr("请填写服务器名称");
      return;
    }
    if (mcpForm.type === "local" && !mcpForm.command.trim()) {
      setMcpSaveState("err");
      setMcpSaveErr("请填写启动命令");
      return;
    }
    if (mcpForm.type === "remote" && !mcpForm.url.trim()) {
      setMcpSaveState("err");
      setMcpSaveErr("请填写 URL");
      return;
    }
    const api = (window as any).electron?.mcpConfig;
    if (!api?.save) {
      setMcpSaveState("err");
      setMcpSaveErr("当前环境不支持写入 mcp.json");
      return;
    }
    setMcpSaving(true);
    setMcpSaveState(null);
    setMcpSaveErr(null);
    const cmdParts = [
      mcpForm.command.trim(),
      ...mcpForm.args.trim().split(/\s+/),
    ].filter(Boolean);
    const nextCwd =
      mcpServers[editingMcpName || name]?.cwd || resolveDefaultMcpCwd();
    const old = mcpServers[editingMcpName || name] || {};
    const gatewayEntry: Record<string, any> = {
      enabled: old.enabled ?? true,
      ...(mcpForm.type === "remote"
        ? { url: mcpForm.url.trim() }
        : { command: cmdParts[0] || "" }),
      ...(mcpForm.type === "local" && cmdParts.length > 1
        ? { args: cmdParts.slice(1) }
        : {}),
      ...(Object.keys(old.environment || {}).length > 0
        ? { env: old.environment }
        : {}),
      ...(old.envPassthrough ? { env_passthrough: true } : {}),
      ...(mcpForm.type === "local" && nextCwd ? { cwd: nextCwd } : {}),
      ...(Object.keys(old.headers || {}).length > 0
        ? { headers: old.headers }
        : {}),
      ...(typeof old.timeout === "number" ? { timeout: old.timeout } : {}),
    };
    const servers: Record<string, any> = { ...gatewayMcp };
    if (editingMcpName && editingMcpName !== name)
      delete servers[editingMcpName];
    servers[name] = gatewayEntry;

    try {
      const r = await api.save(servers);
      if (!r?.ok) {
        setMcpSaveState("err");
        setMcpSaveErr(`保存失败：${r?.error || "未知错误"}`);
        return;
      }
      // 新加的服务器只留在 config.yaml（网关级），不重复放进应用列表。
      if (editingMcpName && editingMcpName !== name)
        removeMcpServer(editingMcpName);
      else if (mcpServers[name]) removeMcpServer(name);
      await persistToStorage();
      await reloadGatewayMcp();
      setMcpSaveState("ok");
      setTimeout(fetchMcpStatus, 1000);
    } catch (e) {
      setMcpSaveState("err");
      setMcpSaveErr(`保存失败：${(e as Error)?.message || e}`);
    } finally {
      setMcpSaving(false);
    }
  }, [
    mcpForm,
    editingMcpName,
    mcpServers,
    gatewayMcp,
    removeMcpServer,
    persistToStorage,
    reloadGatewayMcp,
    fetchMcpStatus,
    resolveDefaultMcpCwd,
  ]);

  const handleEditMcp = useCallback(
    (name: string) => {
      const config = mcpServers[name];
      if (!config) return;
      setEditingMcpName(name);
      const cmdParts = Array.isArray(config.command)
        ? config.command
        : config.command
          ? [config.command]
          : [];
      setMcpForm({
        name,
        type: config.type,
        command: cmdParts[0] || "",
        url: config.url || "",
        args: cmdParts.slice(1).map(mcpArgText).filter(Boolean).join(" "),
      });
    },
    [mcpServers, setEditingMcpName, mcpArgText],
  );

  const handleDeleteMcp = useCallback(
    async (name: string) => {
      removeMcpServer(name);
      await persistToStorage();
      showToast({ type: "info", title: `服务器 "${name}" 已删除` });
    },
    [removeMcpServer, persistToStorage, showToast],
  );

  const handleToggleMcp = useCallback(
    async (name: string) => {
      toggleMcpServer(name);
      await persistToStorage();
    },
    [toggleMcpServer, persistToStorage],
  );

  // ── Gateway MCP (config.yaml mcp_servers) edit handlers ────────────────
  const handleEditGatewayMcp = useCallback(
    (name: string) => {
      const cfg = gatewayMcp[name];
      if (!cfg) return;
      setGatewayEditing(name);
      const cmdParts = Array.isArray(cfg.command)
        ? cfg.command
        : cfg.command
          ? [cfg.command]
          : [];
      const argsArr = Array.isArray(cfg.args) ? cfg.args : [];
      setMcpForm({
        name,
        type: cfg.url ? "remote" : "local",
        command: cmdParts[0] || "",
        url: cfg.url || "",
        args: [...cmdParts.slice(1), ...argsArr]
          .map(mcpArgText)
          .filter(Boolean)
          .join(" "),
      });
    },
    [gatewayMcp, mcpArgText],
  );

  const handleSaveGatewayMcp = useCallback(async () => {
    const name = mcpForm.name.trim();
    if (!name) {
      setMcpSaveState("err");
      setMcpSaveErr("请填写服务器名称");
      return;
    }
    if (mcpForm.type === "local" && !mcpForm.command.trim()) {
      setMcpSaveState("err");
      setMcpSaveErr("请填写启动命令");
      return;
    }
    if (mcpForm.type === "remote" && !mcpForm.url.trim()) {
      setMcpSaveState("err");
      setMcpSaveErr("请填写 URL");
      return;
    }
    const api = (window as any).electron?.mcpConfig;
    if (!api?.save) {
      setMcpSaveState("err");
      setMcpSaveErr("当前环境不支持保存");
      return;
    }
    setMcpSaving(true);
    setMcpSaveState(null);
    setMcpSaveErr(null);
    const cmdParts = [
      mcpForm.command.trim(),
      ...mcpForm.args.trim().split(/\s+/),
    ].filter(Boolean);
    const oldName = gatewayEditing;
    const oldCfg = (oldName && gatewayMcp[oldName]) || {};

    // Full-block write: carry over the original cfg so scalar overrides
    // (enabled/timeout/auth/headers) survive an edit; delete keys the form
    // cleared. env is NOT sent when untouched — the Rust side then carries
    // the old env block over, so secrets never get clobbered by a display
    // round trip (config.yaml env values are hidden from the renderer).
    const merged: Record<string, any> = { ...oldCfg };
    if (mcpForm.type === "remote") {
      merged.url = mcpForm.url.trim();
      delete merged.command;
      delete merged.args;
    } else {
      merged.command = cmdParts[0] || "";
      if (cmdParts.length > 1) merged.args = cmdParts.slice(1);
      else delete merged.args;
    }
    const nextCwd = oldCfg.cwd || resolveDefaultMcpCwd();
    if (nextCwd) merged.cwd = nextCwd;
    else delete merged.cwd;

    const servers: Record<string, any> = { ...gatewayMcp };
    if (oldName && oldName !== name) delete servers[oldName];
    servers[name] = merged;

    try {
      const r = await api.save(servers);
      if (!r?.ok) {
        setMcpSaveState("err");
        setMcpSaveErr(`保存失败：${r?.error || "未知错误"}`);
        return;
      }
      setMcpSaveState("ok");
      await reloadGatewayMcp();
      setTimeout(fetchMcpStatus, 1000);
    } catch (e) {
      setMcpSaveState("err");
      setMcpSaveErr(`保存失败：${(e as Error)?.message || e}`);
    } finally {
      setMcpSaving(false);
    }
  }, [
    mcpForm,
    gatewayEditing,
    gatewayMcp,
    reloadGatewayMcp,
    fetchMcpStatus,
    resolveDefaultMcpCwd,
  ]);

  const handleDeleteGatewayMcp = useCallback(
    async (name: string) => {
      const api = (window as any).electron?.mcpConfig;
      if (!api?.save) {
        showToast({ type: "error", title: "当前环境不支持保存" });
        return;
      }
      const servers: Record<string, any> = { ...gatewayMcp };
      delete servers[name];
      try {
        const r = await api.save(servers);
        if (!r?.ok) {
          showToast({
            type: "error",
            title: `删除失败：${r?.error || "未知错误"}`,
          });
          return;
        }
        await reloadGatewayMcp();
        setTimeout(fetchMcpStatus, 1000);
        showToast({ type: "info", title: `服务器 "${name}" 已删除` });
      } catch (e) {
        showToast({
          type: "error",
          title: `删除失败：${(e as Error)?.message || e}`,
        });
      }
    },
    [gatewayMcp, reloadGatewayMcp, fetchMcpStatus, showToast],
  );

  const handleMcpFormChange = useCallback((patch: Partial<McpFormData>) => {
    setMcpForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleDeleteArchive = useCallback(
    async (id: string) => {
      await persistence.deleteSession(id);
      showToast({ type: "success", title: "已删除" });
      await loadArchives();
    },
    [showToast, loadArchives],
  );

  const handleLoadArchive = useCallback(
    async (sessionId: string) => {
      const sessions = await persistence.loadSessions();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) {
        showToast({ type: "error", title: "加载失败" });
        return;
      }
      const msgs = session.chatMessages.map((msg) => ({
        id: msg.id,
        role: msg.role as "user" | "assistant" | "system",
        content: msg.content,
        timestamp: msg.timestamp,
        reasoning: msg.reasoning,
        steps: msg.steps,
        fileChanges: msg.fileChanges,
        blocks: msg.blocks,
      }));
      useHelixStore.getState().clearExecutionFlow();
      useHelixStore.setState({
        chatMessages: msgs,
        activeSessionWorkDir: session.workDir ?? null,
      });
      // selectedWorkDir 同步到恢复的对话所属项目，让 Git 分支选择器等 UI 跟随对话。
      if (session.workDir) {
        useHelixStore.getState().setSelectedWorkDir(session.workDir);
      }
      useHelixStore.getState().setCurrentSessionId(session.id);
      // 恢复 = 取消归档：把 isArchived 置回 false，让会话回到侧边栏主列表。
      // 之前只加载内容不改归档标记 → toast 显示"已恢复"但会话仍留在归档里，
      // 主列表看不到 → "实际没效果"。恢复不是新对话——savedAt 保持最后一条
      // 消息的时间。
      if (session.isArchived) {
        await persistence.saveSession({
          ...session,
          isArchived: false,
        });
      }
      await persistToStorage();
      await loadArchives();
      showToast({
        type: "success",
        title: "已恢复",
        description: session.label,
      });
    },
    [showToast, persistToStorage, loadArchives],
  );

  // ── Shared components ─────────────────────────────────────────────────────
  const SettingRow = ({
    icon,
    label,
    children,
  }: {
    icon: React.ReactNode;
    label: string;
    children: React.ReactNode;
  }) => (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border/40 last:border-b-0 gap-3 transition-colors duration-150">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span className="text-muted-foreground shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
            {label}
          </p>
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );

  const InputField = React.forwardRef<
    HTMLInputElement,
    {
      value: string;
      onChange: (v: string) => void;
      placeholder?: string;
      type?: string;
      className?: string;
      prefix?: React.ReactNode;
      suffix?: React.ReactNode;
    }
  >(
    (
      {
        value,
        onChange,
        placeholder,
        type = "text",
        className = "",
        prefix,
        suffix,
      },
      ref,
    ) => (
      <div
        className={`flex items-center gap-0 bg-muted/50 border border-border/50 rounded-lg focus-within:ring-2 focus-within:ring-ring ${className}`}
      >
        {prefix && <span className="pl-3 text-muted-foreground">{prefix}</span>}
        <input
          ref={ref}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 px-3 py-2 bg-transparent text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/40 font-mono"
        />
        {suffix && <span className="pr-3">{suffix}</span>}
      </div>
    ),
  );
  InputField.displayName = "InputField";

  // ── Render content ────────────────────────────────────────────────────────
  const ModelHistoryList = () => {
    if (apiHistory.length === 0) {
      return null;
    }

    // Group by baseUrl (preserve first-appearance order). Within a group the
    // entries share the same endpoint but may carry different apiKeys — the
    // addApiHistory dedup already collapses same baseUrl+apiKey, so each item
    // here is a distinct (baseUrl, apiKey) pair. Grouping keeps one endpoint's
    // many keys visually together instead of scattered across the flat list.
    type HistoryItem = { h: (typeof apiHistory)[number]; index: number };
    const groups: { baseUrl: string; items: HistoryItem[] }[] = [];
    const groupPos = new Map<string, number>();
    apiHistory.forEach((h, index) => {
      const url = h.baseUrl || "(无 baseUrl)";
      let pos = groupPos.get(url);
      if (pos === undefined) {
        pos = groups.length;
        groupPos.set(url, pos);
        groups.push({ baseUrl: url, items: [] });
      }
      groups[pos].items.push({ h, index });
    });

    // Whether the CURRENT connection (baseUrl + apiKey) exists in history at
    // all. Computed ONCE per render, not per entry (renderItem). The list
    // groups entries by baseUrl only, so one endpoint can hold entries saved
    // under different apiKeys. When the current connection IS present, highlight
    // only the exact key; when it's NOT (legacy keys only), fall back to
    // baseUrl+model so the highlight never orphans the whole group.
    const activeCfg = useHelixStore.getState().apiConfig;
    const connPresent =
      !!activeCfg?.baseUrl &&
      !!activeCfg?.apiKey &&
      apiHistory.some(
        (x) => x.baseUrl === activeCfg.baseUrl && x.apiKey === activeCfg.apiKey,
      );

    const renderItem = ({ h, index }: HistoryItem) => {
      // Use the same unified criterion as the chat input's model selector
      // (activeModel || apiConfig.model) so both pages always agree on which
      // model is "current". Without this, selecting a model in chat would leave
      // the settings list highlighting a stale entry (or nothing at all).
      const store = useHelixStore.getState();
      const displayModel = store.activeModel || apiConfig.model;
      const isActive =
        !!activeCfg?.baseUrl &&
        activeCfg.baseUrl === h.baseUrl &&
        displayModel === h.model &&
        (connPresent ? !!h.apiKey && h.apiKey === activeCfg.apiKey : true);
      return (
        <div
          key={index}
          onClick={async () => {
            // Write the history entry through setApiConfig first: it guards
            // against model/baseUrl mismatches (poisoned history) and snaps
            // the model to the endpoint it actually belongs to.
            setApiConfig({ ...h });
            // Then anchor activeModel/activeProviderId directly to this history
            // entry's endpoint. Don't use setActiveModel here: its model-name-based
            // resolution can pick the wrong provider when a model name also exists
            // in another provider's fetched list (e.g. cross-endpoint pollution),
            // causing an explicit deepseek click to snap back to a different provider.
            const state = useHelixStore.getState();
            let match = state.providers.find((p) => p.baseUrl === h.baseUrl);
            if (!match) {
              // This endpoint lives only in history (no saved Profile). Upsert a
              // runtime provider so the input-bar model list can resolve to it and
              // the active model stays pinned instead of snapping to the default
              // provider (a runtime-synthesized entry) after a refresh.
              const exists = state.providers.some(
                (p) => p.baseUrl === h.baseUrl,
              );
              useHelixStore.setState((s) => ({
                providers: exists
                  ? s.providers.map((p) =>
                      p.baseUrl === h.baseUrl
                        ? {
                            ...p,
                            models: Array.from(
                              new Set([...(p.models || []), h.model]),
                            ),
                          }
                        : p,
                    )
                  : [
                      ...s.providers,
                      {
                        id: `hist-${h.baseUrl}`,
                        name:
                          h.provider ||
                          (() => {
                            try {
                              return new URL(h.baseUrl).hostname;
                            } catch {
                              return "配置";
                            }
                          })(),
                        baseUrl: h.baseUrl,
                        apiKey: h.apiKey || "",
                        models: [h.model],
                        isDefault: false,
                      } as any,
                    ],
              }));
              match = useHelixStore
                .getState()
                .providers.find((p) => p.baseUrl === h.baseUrl) as any;
            }
            useHelixStore.setState({
              activeModel: h.model,
              activeProviderId: match?.id || null,
              apiConfig: {
                ...state.apiConfig,
                ...h,
                provider: match?.name || h.provider || "custom",
                model: h.model,
              },
            });
            const final = useHelixStore.getState().apiConfig;
            setLocalConfig({ ...final });
            await persistToStorage();
            const helix = (window as any).electron?.helix;
            if (isElectron() || helix?.setConfig) {
              try {
                const cfg = {
                  model: final.model,
                  provider:
                    final.provider && final.provider !== "__custom__"
                      ? final.provider
                      : "custom",
                  baseUrl: final.baseUrl,
                  apiKey: final.apiKey,
                };
                await helix.setConfig(cfg);
                await (window as any).electron?.profile?.cacheConfig?.(cfg);
                useGatewayStore.getState().setHelixSessionId(null);
              } catch { /* empty */}
            }
            showToast({ type: "success", title: `已切换到 ${final.model}` });
          }}
          className={`flex items-center justify-between px-3 py-1.5 rounded-xl bg-card shadow-sm cursor-pointer transition-colors group ${isActive ? "ring-1 ring-primary/30 bg-primary/5" : "hover:bg-muted/40"}`}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {isActive && (
                <span className="size-1.5 rounded-full bg-primary shrink-0" />
              )}
              <p
                className={`text-[length:var(--helix-transcript-size)] truncate ${isActive ? "font-semibold text-primary" : "font-medium text-foreground"}`}
              >
                {h.model}
              </p>
            </div>
            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60 truncate mt-0.5 font-mono">
              {h.baseUrl}
            </p>
          </div>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setLocalConfig({ ...h });
                setShowAddModelModal(true);
              }}
              className="ml-2 p-1 rounded text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/20 hover:text-foreground hover:bg-accent transition-all"
            >
              编辑
            </button>
            <button
              onClick={async (e) => {
                e.stopPropagation();
                removeApiHistory(index);
                await persistToStorage();
              }}
              className="ml-1 p-1 rounded text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/20 hover:text-red-500 transition-all"
            >
              删除
            </button>
          </div>
        </div>
      );
    };

    return (
      <div className="space-y-1.5">
        {groups.flatMap((g) => g.items).map(renderItem)}
      </div>
    );
  };

  const renderContent = () => {
    switch (page) {
      case "general":
        return <GeneralSettingsPanel />;

      case "appearance":
        return (
          <AppearanceSettingsPanel
            themeStyle={themeStyle}
            onSelectThemeStyle={onSelectThemeStyle}
          />
        );

      case "api":
        return (
          <div className="space-y-6">
            <PageHeader>模型设置</PageHeader>
            {/* ── Left-right split layout ── */}
            <div className="flex gap-5 items-stretch">
              {/* Left sidebar — tabs + provider list */}
              <div className="w-60 shrink-0 flex flex-col rounded-xl border border-border/40 bg-card/60 overflow-hidden">
                <div className="px-3 pt-3 pb-2">
                    <div className="flex items-center gap-1 bg-muted/60 rounded-full p-1">
                    <button
                      onClick={() => setModelTab("main")}
                      className={`flex-1 px-2 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium rounded-full transition-colors ${
                        modelTab === "main"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      对话
                    </button>
                    <button
                      onClick={() => setModelTab("vision")}
                      className={`flex-1 px-2 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium rounded-full transition-colors ${
                        modelTab === "vision"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      视觉
                    </button>
                    <button
                      onClick={() => setModelTab("image")}
                      className={`flex-1 px-2 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium rounded-full transition-colors ${
                        modelTab === "image"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      生图
                    </button>
                  </div>
                </div>
                {modelTab === "main" && (
                  <>
                    <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
                    {apiProfiles.map((p) => {
                      const isActive = selectedProviderId === p.id;
                      return (
                        <button
                          key={p.id}
                          onClick={() => {
                            setSelectedProviderId(p.id);
                            setEditingProfileId(p.id);
                            setLocalConfig({ ...p.config });
                            setAddedModels(
                              (p.models || []).map((id) => ({ id })),
                            );
                            setAvailableModels([]);
                            setShowModelDropdown(false);
                          }}
                          className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
                            isActive
                              ? "bg-primary/10 text-primary"
                              : "text-foreground hover:bg-muted/50"
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate text-[length:var(--helix-transcript-size)] font-medium">
                            {p.config.provider || p.name}
                          </span>
                          {p.config.apiKey && (
                            <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <div className="p-2 border-t border-border/30">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => {
                        setSelectedProviderId(null);
                        setEditingProfileId(null);
                        setLocalConfig({
                          provider: "",
                          apiKey: "",
                          baseUrl: "",
                          model: "",
                          apiFormat: DEFAULT_API_FORMAT,
                        });
                        setAddedModels([]);
                        setAvailableModels([]);
                        setShowModelDropdown(false);
                      }}
                    >
                      添加供应商
                    </Button>
                  </div>
                  </>
                )}
              </div>

                {/* Right content */}
                <div className="flex-1 min-w-0 flex flex-col">
                  {modelTab === "main" ? (
                    <>
                      <SettingGroup className="flex-1 flex flex-col">
                    <div className="p-5 space-y-4 flex-1 flex flex-col">
                      <div className="flex items-center gap-3">
                        <input
                          type="text"
                          value={localConfig.provider}
                          onChange={(e) =>
                            handleCustomProviderChange(e.target.value)
                          }
                          placeholder="供应商名称"
                          className="flex-1 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text font-semibold text-foreground placeholder:text-muted-foreground/40"
                        />
                        <Toggle
                          enabled={!!localConfig.apiKey}
                          onToggle={() =>
                            setLocalConfig((prev) => ({
                              ...prev,
                              apiKey: prev.apiKey ? "" : "enabled",
                            }))
                          }
                        />
                        {editingProfileId && (
                          <button
                            onClick={async (e) => {
                              await handleRemoveProfile(e, editingProfileId);
                              setSelectedProviderId(null);
                              setEditingProfileId(null);
                              setLocalConfig({
                                provider: "",
                                apiKey: "",
                                baseUrl: "",
                                model: "",
                              });
                              setAddedModels([]);
                            }}
                          >
                            <svg
                              className="size-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M3 6h18" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        )}
                      </div>

                      <div>
                        <label className="block ui-text font-medium text-foreground mb-1.5">
                          Base URL
                        </label>
                        <input
                          type="text"
                          value={localConfig.baseUrl}
                          onChange={(e) =>
                            setLocalConfig((prev) => ({
                              ...prev,
                              baseUrl: e.target.value,
                            }))
                          }
                          placeholder="https://api.openai.com/v1"
                          className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 font-mono"
                        />
                      </div>

                      <div>
                        <label className="block ui-text font-medium text-foreground mb-1.5">
                          API 格式
                        </label>
                        <PopupSelect
                          value={localConfig.apiFormat || DEFAULT_API_FORMAT}
                          onChange={(v) =>
                            setLocalConfig((prev) => ({
                              ...prev,
                              apiFormat: v,
                            }))
                          }
                          placeholder="请选择 API 格式"
                          className="w-full ui-text text-foreground border border-border/50 bg-muted/50 rounded-lg px-3 py-2"
                          options={API_FORMATS}
                        />
                      </div>

                      <div>
                        <label className="block ui-text font-medium text-foreground mb-1.5">
                          API Key
                        </label>
                        <div className="relative">
                          <input
                            type={showApiKey ? "text" : "password"}
                            value={localConfig.apiKey}
                            onChange={(e) =>
                              setLocalConfig((prev) => ({
                                ...prev,
                                apiKey: e.target.value,
                              }))
                            }
                            placeholder="sk-..."
                            className="w-full px-3 py-2 pr-10 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 font-mono"
                          />
                          <button
                            type="button"
                            onClick={() => setShowApiKey(!showApiKey)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/50 hover:text-foreground transition-colors"
                          >
                            {showApiKey ? "隐藏" : "显示"}
                          </button>
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="block ui-text font-medium text-foreground">
                            已添加的模型
                          </label>
                          <Button
                            variant="outline"
                            size="sm"
                            type="button"
                            onClick={() => {
                              setPickedModel("");
                              setManualModel("");
                              setPickedContext("");
                              setModelSearch("");
                              setShowAddModelDialog(true);
                            }}
                          >
                            添加模型
                          </Button>
                        </div>
                        {addedModels.length === 0 ? (
                          <p className="px-1 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/50">
                            还没有模型，点击「添加模型」添加
                          </p>
                        ) : (
                          <div className="space-y-1.5">
                            {addedModels.map((m, idx) => (
                              <div
                                key={m.id}
                                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-border/40 bg-muted/30 group/model-row"
                              >
                                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--helix-transcript-size)] text-foreground">
                                  {m.id}
                                </span>
                                {m.contextWindow !== undefined && (
                                  <span className="shrink-0 font-mono text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/70">
                                    {m.contextWindow.toLocaleString()} ctx
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={async () => {
                                    showToast({ type: "info", title: `正在测试「${m.id}」连接…` });
                                    try {
                                      const models = await new Promise<string[]>((resolve, reject) => {
                                        if (isElectron() && window.electron?.helix?.fetchModels) {
                                          window.electron.helix.fetchModels({
                                            baseUrl: localConfig.baseUrl,
                                            apiKey: localConfig.apiKey,
                                          }).then((r: any) => {
                                            if (r?.error) reject(new Error(r.error));
                                            else resolve(r?.models || []);
                                          }).catch(reject);
                                        } else {
                                          reject(new Error("模型测试仅在桌面端可用"));
                                        }
                                      });
                                      if (models.includes(m.id)) {
                                        showToast({ type: "success", title: `「${m.id}」连接正常` });
                                      } else {
                                        showToast({ type: "warning", title: `未找到「${m.id}」，请检查模型名称` });
                                      }
                                    } catch (e: any) {
                                      showToast({
                                        type: "error",
                                        title: `「${m.id}」连接失败`,
                                        description: String(e?.message || e),
                                      });
                                    }
                                  }}
                                  className="shrink-0 p-1 text-muted-foreground/40 hover:text-primary opacity-0 group-hover/model-row:opacity-100 transition-colors"
                                  data-tip="测试连接"
                                >
                                  <svg
                                    className="size-3.5"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPickedModel(m.id);
                                    setManualModel("");
                                    setPickedContext(
                                      m.contextWindow ? String(m.contextWindow) : "",
                                    );
                                    setModelSearch("");
                                    setShowAddModelDialog(true);
                                  }}
                                  className="shrink-0 p-1 text-muted-foreground/30 hover:text-foreground opacity-0 group-hover/model-row:opacity-100 transition-colors"
                                  data-tip="编辑"
                                >
                                  <svg
                                    className="size-3.5"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                    <path d="m15 5 4 4" />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setAddedModels((prev) =>
                                      prev.filter((x) => x.id !== m.id),
                                    )
                                  }
                                  className="shrink-0 p-1 text-muted-foreground/30 hover:text-destructive opacity-0 group-hover/model-row:opacity-100 transition-colors"
                                  data-tip="删除模型"
                                >
                                  <svg
                                    className="size-3.5"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M3 6h18" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                  </svg>
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Add model dialog */}
                      {showAddModelDialog && (
                        <div
                          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
                          onClick={() => setShowAddModelDialog(false)}
                        >
                          <div
                            className="w-full max-w-md space-y-4 rounded-xl border border-border/50 bg-card p-4 shadow-xl"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-between">
                              <h3 className="ui-title font-semibold text-foreground">
                                添加模型
                              </h3>
                              <button
                                type="button"
                                onClick={() => setShowAddModelDialog(false)}
                                className="p-1 text-muted-foreground/60 hover:text-foreground transition-colors"
                                data-tip="关闭"
                              >
                                <svg
                                  className="size-4"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <path d="M18 6 6 18" />
                                  <path d="m6 6 12 12" />
                                </svg>
                              </button>
                            </div>

                            <div>
                              <div className="mb-1.5 flex items-center justify-between">
                                <label className="block ui-text font-medium text-foreground">
                                  获取模型列表
                                </label>
                                <button
                                  type="button"
                                  onClick={handleFetchModels}
                                  disabled={isLoadingModels}
                                  className="flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.8571)] text-primary hover:text-primary/80 disabled:text-muted-foreground transition-colors"
                                >
                                  <RefreshCw
                                    size={13}
                                    className={isLoadingModels ? "animate-spin" : ""}
                                  />
                                  {isLoadingModels ? "获取中..." : "获取"}
                                </button>
                              </div>
                              {availableModels.length > 0 ? (
                                <div className="space-y-1.5">
                                  <input
                                    type="text"
                                    value={modelSearch}
                                    onChange={(e) => setModelSearch(e.target.value)}
                                    placeholder="筛选模型…"
                                    className="w-full rounded-lg border border-border/50 bg-muted/50 px-2.5 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground outline-none placeholder:text-muted-foreground/40"
                                  />
                                  <div className="max-h-44 overflow-y-auto rounded-lg border border-border/40">
                                    {sortedModelOptions.length === 0 ? (
                                      <p className="px-2.5 py-3 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/50">
                                        无匹配模型
                                      </p>
                                    ) : (
                                      sortedModelOptions.map((model) => {
                                        const picked = pickedModel === model;
                                        return (
                                          <button
                                            key={model}
                                            type="button"
                                            onClick={() => setPickedModel(model)}
                                            className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left font-mono text-[length:var(--helix-transcript-size)] transition-colors ${
                                              picked
                                                ? "bg-primary/10 text-primary"
                                                : "text-foreground/70 hover:bg-muted/70 hover:text-foreground"
                                            }`}
                                          >
                                            <span className="truncate">{model}</span>
                                            {picked && (
                                              <svg
                                                className="size-3.5 shrink-0"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="2.5"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                              >
                                                <path d="M20 6 9 17l-5-5" />
                                              </svg>
                                            )}
                                          </button>
                                        );
                                      })
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <div className="space-y-1.5">
                                  <input
                                    type="text"
                                    value={manualModel}
                                    onChange={(e) => {
                                      setManualModel(e.target.value);
                                      setPickedModel("");
                                    }}
                                    placeholder="获取不到列表时手动输入模型名称"
                                    className="w-full rounded-lg border border-border/50 bg-muted/50 px-2.5 py-2 font-mono ui-text text-foreground placeholder:text-muted-foreground/40"
                                  />
                                  <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/60">
                                    点「获取」会从该供应商的 Base URL 拉取可用模型，也可以直接输入名称。
                                  </p>
                                </div>
                              )}
                            </div>

                            <div>
                              <label className="mb-1.5 block ui-text font-medium text-foreground">
                                模型上下文限制
                              </label>
                              <input
                                type="number"
                                min={1}
                                step={1000}
                                value={pickedContext}
                                onChange={(e) => setPickedContext(e.target.value)}
                                placeholder="默认 256000"
                                className="w-full rounded-lg border border-border/50 bg-muted/50 px-3 py-2 font-mono ui-text text-foreground placeholder:text-muted-foreground/40"
                              />
                            </div>

                            <div className="flex justify-end gap-2 pt-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setShowAddModelDialog(false)}
                              >
                                取消
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={confirmAddModel}
                                disabled={!pickedModel.trim() && !manualModel.trim()}
                              >
                                添加
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="mt-auto">
                        <SaveBar
                          saving={apiSaving}
                          status={apiSaveState}
                          errorText={apiSaveErr}
                          onSave={() => void handleSaveApi()}
                          saveLabel="保存"
                        />
                      </div>
                    </div>
                  </SettingGroup>
                  </>
                ) : modelTab === "vision" ? (
                  <VisionModelSettings />
                ) : (
                  <ImageModelSettings />
                )}
              </div>
            </div>
          </div>
        );

      case "shortcuts":
        return (
          <div className="max-w-3xl">
            <ShortcutsPage />
          </div>
        );

      case "mcp":
        return (
          <div className="space-y-6">
            <PageHeader
              action={<>
                {!isAddingMcp && !editingMcpName && !gatewayEditing ? (
                  <button
                    onClick={() => {
                      setIsAddingMcp(true);
                      resetMcpForm();
                    }}
                    className="flex items-center gap-1.5 text-[length:var(--helix-transcript-size)] font-medium text-primary hover:text-primary/80 transition-colors"
                  >
                    添加服务器
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setIsAddingMcp(false);
                      setEditingMcpName(null);
                      setGatewayEditing(null);
                      resetMcpForm();
                    }}
                    className="text-[length:var(--helix-transcript-size)] text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg px-2 py-1 transition-colors"
                    data-tip="关闭"
                  >
                    关闭
                  </button>
                )}
              </>}>
              MCP
            </PageHeader>

            {/* Gateway-loaded MCP servers (config.yaml mcp_servers) — editable */}
            {gatewayMcpLoaded &&
              !isAddingMcp &&
              !editingMcpName &&
              !gatewayEditing && (
                <section className="space-y-2">
                  {Object.keys(gatewayMcp).length === 0 ? null : (
                    <div className="max-w-3xl space-y-2">
                      {Object.entries(gatewayMcp).map(([name, cfg]) => {
                        const st = mcpStatus[name];
                        const cmd = [cfg?.command, ...(cfg?.args || [])]
                          .filter(Boolean)
                          .join(" ");
                        return (
                          <div
                            key={name}
                            className="flex items-center gap-3 px-4 py-3 border border-border/20 bg-muted/20 rounded-lg group"
                          >
                            <div className="relative shrink-0">
                              <div
                                className={`w-2.5 h-2.5 rounded-full ${cfg?.enabled === false ? "bg-gray-300" : st === "connected" ? "bg-green-500" : st === "failed" ? "bg-red-400" : "bg-amber-400"}`}
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
                                  {name}
                                </span>
                                <span
                                  className={`text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded-full font-medium ${cfg?.url ? "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300" : "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"}`}
                                >
                                  {cfg?.url ? "远程" : "本地"}
                                </span>
                              </div>
                              <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 font-mono truncate mt-0.5">
                                {cfg?.url || cmd || "(环境变量式配置)"}
                              </p>
                            </div>
                            <button
                              onClick={() => handleEditGatewayMcp(name)}
                              className="px-1.5 py-1 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/40 hover:text-foreground hover:bg-accent opacity-0 group-hover:opacity-100 transition-all shrink-0"
                            >
                              编辑
                            </button>
                            <button
                              onClick={() => handleDeleteGatewayMcp(name)}
                              className="px-1.5 py-1 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/40 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                            >
                              删除
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}

            {!isAddingMcp && !editingMcpName && !gatewayEditing ? (
              <>
                {/* Server list */}
                <div className="max-w-3xl space-y-2">
                  {mcpServerNames.map((name) => {
                    const config = mcpServers[name];
                    const st = mcpStatus[name];
                    return (
                      <div
                        key={name}
                        className="flex items-center gap-3 px-4 py-3 border-b border-border/30 last:border-b-0 hover:bg-muted/40 transition-colors group"
                      >
                        <div className="relative shrink-0">
                          <div
                            className={`w-2.5 h-2.5 rounded-full ${config.enabled === false ? "bg-gray-300" : st === "connected" ? "bg-green-500" : st === "failed" ? "bg-red-400" : "bg-amber-400"}`}
                          />
                          {config.enabled !== false && st === "connected" && (
                            <span className="absolute inset-0 w-2.5 h-2.5 rounded-full bg-green-500 animate-ping opacity-30" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
                              {name}
                            </span>
                            <span
                              className={`text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded-full font-medium ${config.type === "local" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"}`}
                            >
                              {config.type === "local" ? "本地" : "远程"}
                            </span>
                          </div>
                          <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 font-mono truncate mt-0.5">
                            {config.type === "local"
                              ? config.command?.join(" ")
                              : config.url}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Toggle
                            enabled={config.enabled !== false}
                            onToggle={() => handleToggleMcp(name)}
                          />
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                            <button
                              onClick={() => handleEditMcp(name)}
                              className="px-1 py-1 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-colors"
                            >
                              编辑
                            </button>
                            <button
                              onClick={() => handleDeleteMcp(name)}
                              className="px-1 py-1 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/40 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {mcpServerNames.length === 0 && (
                  <div className="max-w-3xl flex flex-col items-center justify-center py-12 text-center">
                    <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground/60">
                      暂无 MCP 服务器
                    </p>
                  </div>
                )}
              </>
            ) : (
              /* Editor — centered card, similar to model add */
              <div className="flex justify-center py-4">
                <div className="w-full max-w-2xl">
                  <McpEditorForm
                    form={mcpForm}
                    onChange={handleMcpFormChange}
                    saving={mcpSaving}
                    saveState={mcpSaveState}
                    saveError={mcpSaveErr}
                    onSave={
                      gatewayEditing ? handleSaveGatewayMcp : handleSaveMcp
                    }
                    onCancel={() => {
                      setIsAddingMcp(false);
                      setEditingMcpName(null);
                      setGatewayEditing(null);
                      resetMcpForm();
                      setMcpSaveState(null);
                      setMcpSaveErr(null);
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        );

      case "archive":
        return (
          <div className="max-w-3xl space-y-6">
            <PageHeader>历史归档</PageHeader>

            {/* Archived sessions */}
            <section className="space-y-3">
              {archives.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground/60">
                    暂无归档记录
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {archives.map((a) => (
                    <div
                      key={a.id}
                      onClick={() => handleLoadArchive(a.id)}
                      className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-card shadow-sm cursor-pointer transition-colors group hover:bg-muted/40"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground truncate">
                          {a.label}
                        </p>
                        <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 mt-0.5">
                          {a.messageCount} 条消息
                        </p>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteArchive(a.id);
                        }}
                        className="p-1 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/20 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        );

      case "usage":
        return (
          <div className="max-w-3xl space-y-6">
            <PageHeader>用量</PageHeader>
            <TokenUsagePanel />
          </div>
        );

      case "hook":
        return <HookSettings />;

      case "help":
        return (
          <div className="max-w-3xl space-y-6">
            <PageHeader>帮助</PageHeader>

            {/* About */}
            <section className="space-y-3">
              <div className="overflow-hidden">
                <button
                  className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors"
                  onClick={() =>
                    setCollapsedSections((s) => {
                      const next = new Set(s);
                      next.has("about")
                        ? next.delete("about")
                        : next.add("about");
                      return next;
                    })
                  }
                ></button>
                <div></div>
              </div>
            </section>
          </div>
        );

      case "agents":
        return <AgentsSettings />;
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-row">
      {/* Left nav — width synced with the main sidebar */}
      {showSidebar && (
        <div
          className={`helix-sidebar relative flex flex-col shrink-0 h-full overflow-hidden ${isResizing ? "" : "transition-[width] duration-200 ease-out"}`}
          style={{ width: sidebarCollapsed ? 48 : navVisualWidth }}
        >
          {sidebarCollapsed ? (
            <div className="flex-1 flex flex-col items-center pt-2 gap-1 overflow-y-auto">
              <button
                onClick={() => useHelixStore.getState().toggleSettings()}
                data-tip="返回"
                className="p-2.5 rounded-lg text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/40 transition-colors"
              >
                <ChevronLeft className="size-[18px]" />
              </button>
              {NAV_GROUPS.flatMap((group) => group.items).map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setPage(item.id);
                    pushNavigation({ type: "settings", page: item.id });
                  }}
                  data-tip={item.label}
                  className={`p-2.5 rounded-lg transition-colors ${
                    page === item.id
                      ? "bg-sidebar-accent/70 text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/40"
                  }`}
                >
                  <item.icon className="size-[18px]" />
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="px-4 pt-2 pb-1 space-y-2">
                <button
                  onClick={() => useHelixStore.getState().toggleSettings()}
                  className="flex items-center gap-2 w-full px-3 py-2 text-[calc(var(--helix-transcript-size)*0.9286)] text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 rounded-xl transition-colors"
                >
                  <ChevronLeft className="size-4" />
                  返回
                </button>
                <div className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg border border-sidebar-border/60 bg-sidebar/40 transition-all duration-150  hover:border-sidebar-border">
                  <Search className="size-3.5 text-muted-foreground/25 shrink-0" />
                  <input
                    ref={navSearchRef}
                    value={navSearch}
                    onChange={(e) => setNavSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setNavSearch("");
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    placeholder="搜索设置..."
                    className="flex-1 bg-transparent text-[calc(var(--helix-transcript-size)*0.9286)] text-sidebar-foreground placeholder:text-sidebar-foreground/30 min-w-0"
                  />
                  {navSearch && (
                    <button
                      onClick={() => setNavSearch("")}
                      className="text-sidebar-foreground/25 hover:text-sidebar-foreground/60 shrink-0"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>
              </div>
              {(() => {
                const q = navSearch.trim().toLowerCase();
                const filtered = q
                  ? NAV_GROUPS.map((g) => ({
                      ...g,
                      items: g.items.filter((i) =>
                        i.label.toLowerCase().includes(q),
                      ),
                    })).filter((g) => g.items.length)
                  : NAV_GROUPS;
                if (!filtered.length)
                  return (
                    <div className="px-5 py-8 text-center text-[calc(var(--helix-transcript-size)*0.9286)] text-sidebar-foreground/40">
                      未找到匹配项
                    </div>
                  );
                return (
                  <nav className="flex-1 overflow-y-auto pt-1 pb-2">
                    {filtered.map((group) => (
                      <div key={group.title} className="mb-2">
                        <p className="px-5 py-1.5 text-[calc(var(--helix-transcript-size)*0.9286)] font-semibold text-sidebar-foreground/40 uppercase tracking-[0.12em] select-none">
                          {group.title}
                        </p>
                        <div className="space-y-0.5 px-2">
                          {group.items.map((item) => (
                            <button
                              key={item.id}
                              onClick={() => {
                                setPage(item.id);
                                pushNavigation({
                                  type: "settings",
                                  page: item.id,
                                });
                                setNavSearch("");
                              }}
                              className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 text-[calc(var(--helix-transcript-size)*0.9286)] rounded-lg transition-colors duration-100 ${
                                page === item.id
                                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                              }`}
                            >
                              <item.icon className="size-4" />
                              {item.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </nav>
                );
              })()}
            </>
          )}

          {/* Resize handle — drag to resize the settings nav (also resizes the
            main sidebar, since they share one width). */}
          {!sidebarCollapsed && (
            <div
              className={`absolute top-0 -right-1 w-2 h-full cursor-col-resize z-30 group ${
                isResizing ? "bg-primary/20" : ""
              }`}
              onMouseDown={startNavResize}
            >
              <div
                className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 transition-colors ${
                  isResizing
                    ? "bg-primary/40"
                    : "bg-transparent group-hover:bg-border/40"
                }`}
              />
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                <GripVertical className="size-3 text-primary/60" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Right content — flat card, border-separated from the nav sidebar */}
      <div className="helix-surface settings-scroll flex-1 overflow-y-auto relative">
        <div className="flex justify-center">
          <div className="px-8 pt-10 pb-10 w-full max-w-3xl">
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
