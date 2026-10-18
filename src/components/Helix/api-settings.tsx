"use client";

import {
  Settings,
  Sun,
  Plug,
  Archive,
  ArchiveRestore,
  ChevronLeft,
  Search,
  X,
  GripVertical,
  Globe,
  Keyboard,
  Bot,
  Activity,
  Workflow,
  RefreshCw,
  Trash2,
  Folder,
  Brain,
  Compass,
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
import { BrowserSettingsPanel } from "./browser-settings";
import { ChannelModelSettings } from "./channel-model-settings";
import { GeneralSettingsPanel } from "./general-settings-panel";
import { HookSettings } from "./hook-settings";
import { ImageModelSettings } from "./image-model-settings";
import { McpEditorForm, type McpFormData } from "./mcp-editor-form";
import { MemorySettingsPanel } from "./memory-settings";
import { PageHeader, PopupSelect, SettingGroup } from "./settings-ui";
import { ShortcutsPage } from "./shortcuts-page";
import { TokenUsagePanel } from "./usage-stats";
import { VisionModelSettings } from "./vision-model-settings";
import { Button } from "@/components/ui/button";
import { isElectron, helixApi, electronApp } from "@/lib/electron-bridge";
import { persistence } from "@/lib/persist";
import { getAllProviders, getBaseUrl } from "@/lib/providers";
import { useGatewayStore } from "@/stores/gateway-store";
import { useHelixStore, type ApiConfig } from "@/stores/helix-store";

const ALL_PROVIDERS = getAllProviders();

// 供应商的 API 格式 —— 写入 pi models.json 的 provider `api` 字段。
// 取值与 pi-ai 的协议枚举一致，拼错会导致该 provider 的所有请求走错协议。
const API_FORMATS = [
  { label: "Anthropic Messages (/v1/messages)", value: "anthropic-messages" },
  { label: "Responses (/responses)", value: "openai-responses" },
  { label: "Chat Completions (/chat/completions)", value: "openai-completions" },
];
const DEFAULT_API_FORMAT = "openai-completions";

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
  sidebarCollapsed: boolean;
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
  | "agents"
  | "memory"
  | "browser"

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
      { id: "memory", label: "记忆", icon: Brain },
      { id: "browser", label: "浏览器", icon: Compass },
    ],
  },
  {
    title: "集成",
    items: [
      { id: "hook", label: "Hook", icon: Workflow },
      { id: "archive", label: "归档", icon: Archive },
    ],
  },
];

// 归档列表按 workDir 分组显示项目名：取路径最后一段，末位分隔符先剥掉。
const archiveProjectName = (workDir: string | null): string => {
  if (!workDir) return "未关联项目";
  const parts = workDir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || workDir;
};

// 网关 config.yaml `mcp_servers:` 块的 wire 形状：app 侧 McpServerConfig
// （command: string[] / environment）与网关条目（command: string / args /
// env / env_passthrough，外加合井保存时原样带回的未知标量键）的并集。
// 只用于 mcpConfig.list/save 的读写边界。
interface GatewayMcpServerWire {
  type?: "local" | "remote";
  command?: string | string[];
  url?: string;
  args?: unknown[];
  environment?: Record<string, string>;
  env?: Record<string, string>;
  enabled?: boolean;
  cwd?: string;
  timeout?: number;
  headers?: Record<string, string>;
  envPassthrough?: boolean;
  env_passthrough?: boolean;
  description?: string;
  exposure?: "codemode" | "deferred" | "direct" | "hidden";
  toolExposure?: Record<string, string>;
  [key: string]: unknown;
}

// mcpConfig.list 的返回值 / mcpConfig.save 的参数在 d.ts 里标的是 app 侧
// McpServerConfig 记录，但运行时字段是网关 wire 形状（command 可能是字符串、
// 带 args/env），Rust 端也接受任意 YAML 映射。这两个 wrapper 只做类型边界
// 收窄，值原样透传。
// pi 的 exposure / toolExposure：表单（多行文本）与 wire（对象）互转。
// 每行「工具名或 glob=exposure」；空行与没有 = 的行丢弃。
const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;
type McpExposure = (typeof MCP_EXPOSURES)[number];

function advancedFromWire(entry: object): {
  description: string;
  exposure: McpExposure;
  toolExposureText: string;
  timeoutText: string;
} {
  const e = entry as Record<string, unknown>;
  const exposure = (MCP_EXPOSURES as readonly string[]).includes(
    String(e.exposure ?? ""),
  )
    ? (e.exposure as McpExposure)
    : "codemode";
  const toolExposureText =
    e.toolExposure && typeof e.toolExposure === "object"
      ? Object.entries(e.toolExposure as Record<string, unknown>)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "";
  return {
    description: typeof e.description === "string" ? e.description : "",
    exposure,
    toolExposureText,
    timeoutText: typeof e.timeout === "number" ? String(e.timeout) : "",
  };
}

/** 表单 → wire：只写非空项，空值不覆盖旧值（调用方按 merge 处理）。 */
function advancedToWire(form: McpFormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.description.trim()) out.description = form.description.trim();
  out.exposure = form.exposure;
  const toolExposure: Record<string, string> = {};
  for (const line of form.toolExposureText.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && line.slice(i + 1).trim())
      toolExposure[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (Object.keys(toolExposure).length > 0) out.toolExposure = toolExposure;
  const timeout = Number(form.timeoutText.trim());
  if (form.timeoutText.trim() && Number.isFinite(timeout) && timeout > 0)
    out.timeout = Math.round(timeout);
  return out;
}

// 服务器工具数的小标签（只给连上的服务器显示；工具数 = pi 实际拿到的）
const mcpToolCountLabel = (count: number | undefined) =>
  typeof count === "number" ? ` · ${count} 工具` : "";

type McpConfigApi = {
  list: (includeEnv?: boolean) => Promise<{
    ok: boolean;
    servers?: Record<string, import("@/stores/helix-types").McpServerConfig>;
    error?: string;
  }>;
  save: (
    servers: Record<string, import("@/stores/helix-types").McpServerConfig>,
  ) => Promise<{ ok: boolean; error?: string }>;
};

const listGatewayMcp = async (
  api: McpConfigApi,
): Promise<{ ok: boolean; servers?: Record<string, GatewayMcpServerWire>; error?: string }> => {
  const r: { ok: boolean; servers?: unknown; error?: string } = await api.list();
  return {
    ok: r.ok,
    servers: r.servers as Record<string, GatewayMcpServerWire> | undefined,
    error: r.error,
  };
};

const saveGatewayMcp = (
  api: McpConfigApi,
  servers: Record<string, GatewayMcpServerWire>,
): Promise<{ ok: boolean; error?: string }> =>
  api.save(
    servers as Record<string, import("@/stores/helix-types").McpServerConfig>,
  );

const formatArchiveDate = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
};

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
  sidebarCollapsed,
}: SettingsProps) {
  const {
    apiConfig,
    apiProfiles,
    activeProfileId,
    addApiHistory,
    upsertProvider,
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
    mcpServers,
    removeMcpServer,
    toggleMcpServer,
  } = useHelixStore();

  const settingsPage = useHelixStore((s) => s.settingsPage);
  const setSettingsPage = useHelixStore((s) => s.setSettingsPage);
  const pushNavigation = useHelixStore((s) => s.pushNavigation);
  const [page, setPage] = useState<SettingsPage>(
    (settingsPage as SettingsPage) || "general",
  );
  // Reset the shared scroll container when switching settings pages.
  const scrollRef = useRef<HTMLDivElement>(null);
  const handlePageChange = useCallback((p: SettingsPage) => {
    setPage(p);
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    });
  }, []);
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

  // ── Settings nav resize (synced with the main sidebar width) ──────────────
  // The main sidebar width lives in helix-layout and is the single source of
  // truth. We mirror it here so the settings nav matches, and let the user drag
  // this handle to resize — which also resizes the main sidebar live.
  const SETTINGS_NAV_MIN = 220;
  const SETTINGS_NAV_MAX = 500;
  const navWidth = Math.max(
    SETTINGS_NAV_MIN,
    Math.min(SETTINGS_NAV_MAX, sidebarWidth),
  );
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

  // Profile 只存模型 id 字符串，contextWindow / reasoning 不在 profile 里。
  // 重新灌入 addedModels 时必须保留内存里已有的 per-model 元数据，否则
  // 保存触发 apiProfiles 变化 → 下方 effect 一跑就把它们洗成 { id }。
  // 冷启动（prev 为空）时回退到 profile 落盘的 modelContextWindows /
  // modelReasonings：若不单独存一份映射，重开编辑时 per-model 元数据全丢，
  // 再保存就送 undefined，后端 256_000 回退把用户填过的值重置掉
  // （"我之前填的上下文窗口被改掉了" / "思考模式重启后没了"根因）。
  const seedAddedModels = useCallback(
    (
      ids: string[],
      persistedWindows?: Record<string, number>,
      persistedReasonings?: Record<string, boolean>,
      persistedInputs?: Record<string, string[]>,
    ) => {
      setAddedModels((prev) =>
        ids.map((id) => {
          const old = prev.find((x) => x.id === id);
          if (old) {
            return {
              id,
              contextWindow: old.contextWindow,
              reasoning: old.reasoning,
              input: old.input,
            };
          }
          const cw = persistedWindows?.[id];
          const rs = persistedReasonings?.[id];
          const inp = persistedInputs?.[id];
          return {
            id,
            ...(cw !== undefined ? { contextWindow: cw } : {}),
            ...(rs !== undefined ? { reasoning: rs } : {}),
            ...(inp !== undefined ? { input: inp } : {}),
          };
        }),
      );
    },
    [],
  );

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
    seedAddedModels(
      p.models || [],
      p.modelContextWindows,
      p.modelReasonings,
      p.modelInputs,
    );
  }, [activeProfileId, apiProfiles, seedAddedModels]);

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
    const h = window.electron?.helix;
    if (!h?.getConfig) return;
    h.getConfig()
      .then((r: { model?: string; provider?: string; baseUrl?: string }) => {
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
  // 已添加的模型（第一个是默认模型）。每项的 contextWindow 单独落到
  // models.json 里对应模型条目上，所以不能复用 localConfig.contextWindow。
  const [addedModels, setAddedModels] = useState<
    {
      id: string;
      contextWindow?: number;
      reasoning?: boolean;
      /** models.json 的 `input` 数组。pi 只读 "image" 决定图片原生透传。 */
      input?: string[];
    }[]
  >([]);
  const [showAddModelDialog, setShowAddModelDialog] = useState(false);
  const [pickedModel, setPickedModel] = useState("");
  const [pickedContext, setPickedContext] = useState("");
  const [manualModel, setManualModel] = useState("");
  const [pickedReasoning, setPickedReasoning] = useState(false);
  // 输入类型：文字始终开；图片/视频是可选项。
  // 后端白名单里收了 video/audio（pi 现在只认 image），留位不丢数据。
  const [pickedInputImage, setPickedInputImage] = useState(false);
  const [pickedInputVideo, setPickedInputVideo] = useState(false);
  type ModelTab = "main" | "vision" | "image" | `channel:${string}`;
  const [modelTab, setModelTab] = useState<ModelTab>("main");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  // Vision / Image model config (loaded from config.yaml via Tauri or localStorage)
  const [visionModelName, setVisionModelName] = useState("");
  const [visionHasApiKey, setVisionHasApiKey] = useState(false);
  const [imageModelName, setImageModelName] = useState("");
  const [imageHasApiKey, setImageHasApiKey] = useState(false);

  useEffect(() => {
    const loadVisionImage = async () => {
      if (isElectron()) {
        try {
          const visionApi = window.electron?.vision;
          if (visionApi?.getConfig) {
            const r = await visionApi.getConfig();
            if (r?.ok && r.config) {
              setVisionModelName(r.config.model || "");
              setVisionHasApiKey(!!r.config.apiKey);
            }
          }
        } catch { /* empty */ }
        try {
          const imageApi = window.electron?.image;
          if (imageApi?.getConfig) {
            const r = await imageApi.getConfig();
            if (r?.ok && r.config) {
              setImageModelName(r.config.model || "");
              setImageHasApiKey(!!r.config.apiKey);
            }
          }
        } catch { /* empty */ }
      } else {
        try {
          const vs = localStorage.getItem("helix-vision-model");
          if (vs) { const d = JSON.parse(vs); setVisionModelName(d.model || ""); setVisionHasApiKey(!!d.apiKey); }
          const is = localStorage.getItem("helix-image-model");
          if (is) { const d = JSON.parse(is); setImageModelName(d.model || ""); setImageHasApiKey(!!d.apiKey); }
        } catch { /* empty */ }
      }
    };
    loadVisionImage();
  }, [modelTab]);

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
    input?: string[];
    contextWindow?: number;
  };
  const [piModels, setPiModels] = useState<PiModel[]>([]);
  // pi-connect 渠道 provider（WorkBuddy / Trae / Qoder）——由 helix-layout 在
  // 网关就绪时刷新，这里只读用于左栏渠道行。
  const piChannelProviders = useHelixStore((s) => s.piChannelProviders);
  const loadPiModels = useCallback(async () => {
    if (!isElectron()) return;
    try {
      const r = await window.electron.helix.piGetAvailableModels();
      const list = Array.isArray(r?.models) ? (r.models as PiModel[]) : [];
      setPiModels(list.filter((m) => m?.id && m?.provider));
    } catch {
      // Pi may still be spawning (gateway not INITIALIZED yet) — degrade to the
      // manual probe path silently instead of firing a scary toast on open.
      setPiModels([]);
    }
  }, []);

  // 挂载即拉一次 pi 的模型列表：per-model 的 contextWindow / reasoning 只
  // 持久化在 ~/.pi/agent/models.json，profile 重启后只剩 id，冷启动后编辑
  // 弹窗要靠这份数据回填。渠道 provider 列表一并刷新（扩展注册结果可能
  // 在本会话里变过——比如刚在渠道中心重新登录）。
  useEffect(() => {
    void loadPiModels();
    void useHelixStore.getState().refreshPiChannelProviders();
  }, [loadPiModels]);

  // 把 pi models.json 里该模型的 contextWindow / reasoning 回填进
  // addedModels（只补空缺，不覆盖已有值——刚添加还没被 pi 刷新的值优先）。
  useEffect(() => {
    if (piModels.length === 0 || addedModels.length === 0) return;
    const prov = localConfig.provider.trim().replace(/^custom:/, "");
    setAddedModels((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        if (
          m.contextWindow !== undefined &&
          m.reasoning !== undefined &&
          m.input !== undefined
        )
          return m;
        const pm =
          piModels.find(
            (x) => x.id === m.id && (!prov || x.provider === prov),
          ) ?? piModels.find((x) => x.id === m.id);
        if (!pm) return m;
        const contextWindow = m.contextWindow ?? pm.contextWindow;
        const reasoning = m.reasoning ?? pm.reasoning;
        const input = m.input ?? pm.input;
        if (
          contextWindow === m.contextWindow &&
          reasoning === m.reasoning &&
          input === m.input
        ) {
          return m;
        }
        changed = true;
        return { ...m, contextWindow, reasoning, input };
      });
      return changed ? next : prev;
    });
  }, [piModels, addedModels, localConfig.provider]);

  /** Pi's registered wire format for the current provider. When a provider was
   *  registered in Pi with a format other than the OpenAI default (a pi-messages
   *  endpoint, anthropic-messages, …), adding/saving a model on this card must
   *  inherit that format — otherwise Pi falls back to its built-in provider's
   *  protocol (built-in `anthropic` = anthropic-messages), and an OpenAI-style
   *  chat endpoint suddenly routes its requests to /v1/messages. */
  const piFormatForProvider = useMemo(() => {
    const prov = localConfig.provider.trim().replace(/^custom:/, "");
    if (!prov) return undefined;
    const match = piModels.find((m) => m.provider === prov);
    return match?.api || undefined;
  }, [piModels, localConfig.provider]);

  /** When Pi reports a format for the selected provider, fill it in ONLY for
   *  legacy profiles that never stored an apiFormat. Any stored value —
   *  including the default chat (openai-completions) — is an explicit choice
   *  and must win: treating chat as "unset" made the card flip back to Pi's
   *  (possibly stale) registration every time it opened. */
  useEffect(() => {
    const fmt = piFormatForProvider;
    if (!fmt) return;
    setLocalConfig((prev) =>
      prev.apiFormat ? prev : { ...prev, apiFormat: fmt },
    );
  }, [piFormatForProvider]);

  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const [modelSearch, setModelSearch] = useState("");

  // Search-filtered view of the model list (the dropdown renders this, not the
  // raw availableModels, so the search box composes with it).
  const sortedModelOptions = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    const filtered = q
      ? availableModels.filter((m) => m.toLowerCase().includes(q))
      : availableModels;
    return [...filtered].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
  }, [availableModels, modelSearch]);

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
    description: "",
    exposure: "codemode",
    toolExposureText: "",
    timeoutText: "",
  });
  const mcpServerNames = Object.keys(mcpServers);
  const [mcpStatus, setMcpStatus] = useState<Record<string, string>>({});
  // 同一份状态响应里的附加信息：工具数与连接错误原因。
  // 单独一份 state，是为了不改 mcpStatus 的两个渲染点（它们只认字符串）。
  const [mcpStatusDetail, setMcpStatusDetail] = useState<
    Record<string, { toolCount?: number; error?: string }>
  >({});
  // Gateway MCP servers — read-only view of config.yaml `mcp_servers` (loaded
  // by the gateway at startup; separate from the app-managed list above, which
  // is persisted locally and sent per-session via session/new).
  const [gatewayMcp, setGatewayMcp] = useState<
    Record<string, GatewayMcpServerWire>
  >({});
  const [gatewayMcpLoaded, setGatewayMcpLoaded] = useState(false);
  // Name of a gateway (config.yaml mcp_servers) server being edited — opens
  // the shared McpEditorForm with its config; null = not editing.
  const [gatewayEditing, setGatewayEditing] = useState<string | null>(null);

  // MCP status - read the REAL runtime connection state from the backend via
  // `mcp.servers.status` (session-independent; covers both config.yaml servers
  // and session-injected servers). Replaces the old tools/list tool-name probe.
  // （此前这里还订阅 helixSessionId 放在 fetchMcpStatus 依赖里——回调体从未
  //  读过它，exhaustive-deps 判定为多余依赖后一并移除。）
  const [mcpStatusAttempt, setMcpStatusAttempt] = useState(0);
  const fetchMcpStatus = useCallback(async () => {
    try {
      const result = (await helixApi()!.send("mcp.servers.status", {})) as
        | {
            servers?: Array<{
              name?: string;
              state?: string;
              status?: string;
              connected?: boolean;
              toolCount?: number;
              tools?: unknown;
              error?: string;
            }>;
            timeout?: boolean;
          }
        | null;
      const servers = result?.servers || [];
      const status: Record<string, string> = {};
      const detail: Record<string, { toolCount?: number; error?: string }> = {};
      for (const s of servers) {
        if (!s?.name) continue;
        status[s.name] =
          s.state || s.status || (s.connected ? "connected" : "configured");
        const count =
          typeof s.toolCount === "number"
            ? s.toolCount
            : Array.isArray(s.tools)
              ? s.tools.length
              : undefined;
        if (typeof count === "number" || (s.error && typeof s.error === "string")) {
          detail[s.name] = {
            toolCount: count,
            error: typeof s.error === "string" && s.error ? s.error : undefined,
          };
        }
      }
      setMcpStatus(status);
      setMcpStatusDetail(detail);
      setMcpStatusAttempt(0); // success resets the retry counter
    } catch {
      // Transient failure (WS not ready, RPC timeout): keep last status and
      // schedule a retry instead of wiping to {} (which shows "检测中" forever).
      setMcpStatusAttempt((a) => a + 1);
    }
  }, []);

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
      const api = window.electron?.mcpConfig;
      if (!api?.list) {
        setGatewayMcpLoaded(true);
        return;
      }
      const r = await listGatewayMcp(api);
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
    Array<{ id: string; label: string; savedAt: number; workDir: string | null }>
  >([]);
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveProjectFilter, setArchiveProjectFilter] = useState("all");
  const [archiveConfirmDeleteAll, setArchiveConfirmDeleteAll] = useState(false);
  const [archiveDeletingAll, setArchiveDeletingAll] = useState(false);

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
            workDir: s.workDir ?? null,
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

  // API 格式下拉：即时持久化（profile + apiConfig + pi models.json）。
  // 旧行为只改内存 localConfig，保存按钮又已移除 → 重开设置从 profile
  // 灌回旧值；聊天选模型 / 添加模型还会把 profile 的旧 apiFormat 写回
  // models.json，表现为「改成 openai-completions 又变回 anthropic」。
  const handleApiFormatChange = useCallback(
    async (fmt: string) => {
      setLocalConfig((prev) => ({ ...prev, apiFormat: fmt }));
      const pid = editingProfileId;
      if (pid) {
        const p = apiProfiles.find((x) => x.id === pid);
        if (p) {
          updateApiProfileConfig(pid, { ...p.config, apiFormat: fmt });
          const st = useHelixStore.getState();
          if (st.apiConfig.baseUrl === p.config.baseUrl) {
            setApiConfig({ apiFormat: fmt });
          }
        }
      }
      try {
        await persistToStorage();
      } catch {
        /* empty */
      }
      const prov = localConfig.provider.trim().replace(/^custom:/, "");
      if (prov && localConfig.baseUrl.trim()) {
        void window.electron?.helix
          ?.registerProviderModels({
            provider: prov,
            baseUrl: localConfig.baseUrl.trim(),
            apiKey: localConfig.apiKey || undefined,
            api: fmt,
            models: addedModels
              .filter((m) => m.id.trim())
              .map((m) => ({
                id: m.id.trim(),
                contextWindow: m.contextWindow,
                ...(m.reasoning ? { reasoning: true } : {}),
                ...(m.input && m.input.length > 0
                  ? { input: m.input }
                  : {}),
              })),
          })
          ?.catch((e) =>
            console.warn("[Helix] registerProviderModels failed:", e),
          );
      }
    },
    [
      editingProfileId,
      apiProfiles,
      updateApiProfileConfig,
      setApiConfig,
      persistToStorage,
      localConfig.provider,
      localConfig.baseUrl,
      localConfig.apiKey,
      addedModels,
    ],
  );

  // 一次性对账：旧版 API_FORMATS label/value 错位把「Chat Completions」存成了
  // anthropic-messages；pi models.json 才是实际跑的协议（用户可能已手改）。
  // 首次拉到 pi 列表时，若 profile 存的 apiFormat 与 pi 注册值不一致，以 pi 为准
  // 回写 profile，避免后续保存 / 聊天选模型再把脏值冲回 models.json。
  const piFormatHealedRef = useRef(false);
  useEffect(() => {
    if (
      piFormatHealedRef.current ||
      piModels.length === 0 ||
      apiProfiles.length === 0
    )
      return;
    piFormatHealedRef.current = true;
    const piApiByProvider = new Map<string, string>();
    for (const m of piModels) {
      if (m.provider && m.api && !piApiByProvider.has(m.provider)) {
        piApiByProvider.set(m.provider, m.api);
      }
    }
    if (piApiByProvider.size === 0) return;
    let changed = false;
    for (const p of apiProfiles) {
      const prov = (p.config.provider || "").trim().replace(/^custom:/, "");
      if (!prov || !p.config.apiFormat) continue;
      const piFmt = piApiByProvider.get(prov);
      if (piFmt && piFmt !== p.config.apiFormat) {
        updateApiProfileConfig(p.id, { ...p.config, apiFormat: piFmt });
        changed = true;
      }
    }
    if (changed) void persistToStorage().catch(() => {});
  }, [piModels, apiProfiles, updateApiProfileConfig, persistToStorage]);

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
        })) as { models?: string[]; error?: string };
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
  }, [localConfig.apiKey, localConfig.baseUrl, showToast, setAvailableModels, loadPiModels, piModels.length]);

  const handleRemoveProfile = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      removeApiProfile(id);
      await persistToStorage();
    },
    [removeApiProfile, persistToStorage],
  );

  // Ref to the auto-save function so `confirmAddModel` (defined earlier in the
  // component body) can trigger persistence after adding a model. Assigned
  // below once `handleSaveApi` exists.
  const saveApiRef = useRef<
    ((modelsList?: typeof addedModels) => Promise<void>) | null
  >(null);

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
    // 输入类型：文字始终在，图片/视频按勾选附加。
    const inputList = ["text"];
    if (pickedInputImage) inputList.push("image");
    if (pickedInputVideo) inputList.push("video");
    const newModels = [
      ...addedModels.filter((m) => m.id !== id),
      {
        id,
        contextWindow,
        reasoning: pickedReasoning || undefined,
        input: inputList,
      },
    ];
    setAddedModels(newModels);
    setPickedModel("");
    setManualModel("");
    setPickedContext("");
    setPickedReasoning(false);
    setPickedInputImage(false);
    setPickedInputVideo(false);
    setModelSearch("");
    setShowAddModelDialog(false);
    // 保存按钮已移除：添加模型后立即自动持久化（传入刚更新好的列表，
    // 避免 state 尚未刷新的闭包陈旧）。
    void saveApiRef.current?.(newModels);
  }, [
    pickedModel,
    manualModel,
    pickedContext,
    pickedReasoning,
    pickedInputImage,
    pickedInputVideo,
    addedModels,
    showToast,
  ]);

  const handleSaveApi = useCallback(
    async (modelsList?: typeof addedModels) => {
      // 无参调用用 state 里的 addedModels（供未来保存入口）；传参则用调用方给的
      // 刚更新过的列表（添加模型即自动保存的场景，避免 state 尚未刷新的闭包陈旧）。
      const models = modelsList ?? addedModels;

      if (!localConfig.baseUrl.trim()) return;

      const savedModels = models.map((m) => m.id.trim()).filter(Boolean);
      if (savedModels.length === 0) return;

      // 模型上下文限制必须是正整数
      if (
        models.some(
          (m) =>
            m.contextWindow !== undefined &&
            (!Number.isFinite(m.contextWindow) ||
              !Number.isInteger(m.contextWindow) ||
              m.contextWindow <= 0),
        )
      ) {
        return;
      }
      // 第一个模型是默认模型（写入 settings.json 的 defaultModel），其余只进
      // models.json 的模型列表；每个模型的上下文限制落在各自条目上。
      const firstModel = models.find((m) => m.id.trim())!;
      // 每个模型各自的 contextWindow 必须随 profile 落盘：models 数组只存 id，
      // 若不单独存一份映射，重开编辑时 `p.models.map(id => ({id}))` 会把所有
      // per-model 窗口剥掉，再保存就送 undefined → 后端 256_000 回退把用户
      // 填过的值重置（"我之前填的上下文窗口被改掉了"根因）。
      const modelContextWindows: Record<string, number> = {};
      // 同理：reasoning（开启思考模式）也必须随 profile 落盘，否则冷启动
      // seedAddedModels 剥成 undefined，重开编辑弹窗开关显示为关
      // （"我开了思考模式，重启后没了"根因）。
      const modelReasonings: Record<string, boolean> = {};
      // 同 contextWindow / reasoning：input 也必须随 profile 落盘，否则冷启动
      // seedAddedModels 剥成 undefined，多模态模型又变回「图片走转述管道」。
      const modelInputs: Record<string, string[]> = {};
      for (const m of models) {
        const id = m.id.trim();
        if (id && m.contextWindow !== undefined && Number.isFinite(m.contextWindow)) {
          modelContextWindows[id] = m.contextWindow;
        }
        if (id && m.reasoning !== undefined) {
          modelReasonings[id] = m.reasoning;
        }
        if (id && Array.isArray(m.input)) {
          modelInputs[id] = m.input;
        }
      }
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
        updateApiProfileConfig(
          editingProfileId,
          finalConfig,
          profileModels,
          modelContextWindows,
          modelReasonings,
          modelInputs,
        );
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
          updateApiProfileConfig(
            dup.id,
            finalConfig,
            profileModels,
            modelContextWindows,
            modelReasonings,
            modelInputs,
          );
          renameApiProfile(dup.id, profileName);
          setActiveProfile(dup.id);
        } else {
          const id = addApiProfile(
            profileName,
            finalConfig,
            profileModels,
            modelContextWindows,
            modelReasonings,
            modelInputs,
          );
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
      const helix = window.electron?.helix;
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
          // 先把整个模型列表下发（每个模型自己的 contextWindow + API 格式），
          // 再由下面的 setConfig 把 pi 的默认指向当前选中项。register 不动全局
          // 默认、也不 respawn，所以顺序必须是 register → setConfig（后者写默认 +
          // respawn）—— 反过来的话 respawn 会把刚注册的列表冲掉。
          //
          // 这里曾经写的是 helix.setProviderModels —— bridge 从没定义过那个方法
          // （只有 registerProviderModels），于是这个守卫永远为假，模型列表事实上
          // 从未下发到 pi 的 models.json。类型收紧成 ElectronAPI 后 tsc 才报出来。
          if (typeof helix?.registerProviderModels === "function") {
            await helix.registerProviderModels({
              provider: cfg.provider,
              baseUrl: cfg.baseUrl,
              apiKey: cfg.apiKey,
              api: cfg.api,
              models: models
                .filter((m) => m.id.trim())
                .map((m) => ({
                  id: m.id.trim(),
                  contextWindow: m.contextWindow,
                  ...(m.reasoning ? { reasoning: true } : {}),
                  ...(m.input && m.input.length > 0
                    ? { input: m.input }
                    : {}),
                })),
            });
          }
          await helix.setConfig(cfg);
          // Persist the active profile so the next cold start re-asserts it
          // into Helix config.yaml (no hardcoded pin, free switching preserved).
          await window.electron?.profile?.cacheConfig?.(cfg);
          // Invalidate the cached session so the next prompt creates a fresh one
          // with the updated config. Without this, a stale session ID could be
          // reused against a restarted gateway, producing 401 errors.
          useGatewayStore.getState().setHelixSessionId(null);
        } catch {
          // 配置已落本地，只是同步回 Helix 失败 —— 不阻断保存
        }
      }
  }, [
    localConfig,
    addedModels,
    editingProfileId,
    apiProfiles,
    setApiConfig,
    addApiProfile,
    updateApiProfileConfig,
    renameApiProfile,
    setActiveProfile,
    addApiHistory,
    upsertProvider,
    persistToStorage,
  ]);

  // Keep the ref current so `confirmAddModel`'s auto-save always calls the
  // latest `handleSaveApi` (avoids stale-closure issues across re-renders).
  saveApiRef.current = handleSaveApi;

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
    setMcpForm({
      name: "",
      type: "local",
      command: "",
      url: "",
      args: "",
      description: "",
      exposure: "codemode",
      toolExposureText: "",
      timeoutText: "",
    });
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
    const api = window.electron?.mcpConfig;
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
    const gatewayEntry: GatewayMcpServerWire = {
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
      ...advancedToWire(mcpForm),
    };
    const servers: Record<string, GatewayMcpServerWire> = { ...gatewayMcp };
    if (editingMcpName && editingMcpName !== name)
      delete servers[editingMcpName];
    servers[name] = gatewayEntry;

    try {
      const r = await saveGatewayMcp(api, servers);
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
        ...advancedFromWire(config),
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
        ...advancedFromWire(cfg),
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
    const api = window.electron?.mcpConfig;
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
    const merged: GatewayMcpServerWire = { ...oldCfg };
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

    // 描述 / 暴露方式 / 按工具覆盖 / 超时：表格里空值要 delete 旧值，
    // 否则清空描述后旧描述还会被写回去（merged 的基底是上一份配置）。
    for (const [k, v] of Object.entries(advancedToWire(mcpForm))) {
      merged[k] = v;
    }
    if (!mcpForm.description.trim()) delete merged.description;
    if (!mcpForm.toolExposureText.trim()) delete merged.toolExposure;
    if (!mcpForm.timeoutText.trim()) delete merged.timeout;

    const servers: Record<string, GatewayMcpServerWire> = { ...gatewayMcp };
    if (oldName && oldName !== name) delete servers[oldName];
    servers[name] = merged;

    try {
      const r = await saveGatewayMcp(api, servers);
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
      const api = window.electron?.mcpConfig;
      if (!api?.save) {
        showToast({ type: "error", title: "当前环境不支持保存" });
        return;
      }
      const servers: Record<string, GatewayMcpServerWire> = { ...gatewayMcp };
      delete servers[name];
      try {
        const r = await saveGatewayMcp(api, servers);
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
      useHelixStore.getState().clearSessionSidebarState(id);
      showToast({ type: "success", title: "已删除" });
      await loadArchives();
    },
    [showToast, loadArchives],
  );

  const handleDeleteAllArchives = useCallback(async () => {
    setArchiveDeletingAll(true);
    try {
      const store = useHelixStore.getState();
      for (const a of archives) {
        await persistence.deleteSession(a.id);
        store.clearSessionSidebarState(a.id);
      }
      showToast({
        type: "success",
        title: "已删除全部归档",
        description: `${archives.length} 个任务`,
      });
      await loadArchives();
    } finally {
      setArchiveDeletingAll(false);
      setArchiveConfirmDeleteAll(false);
    }
  }, [archives, showToast, loadArchives]);

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
      // 取消归档：isArchived 置回 false，让会话回到侧边栏主列表。
      // savedAt 保持最后一条消息的时间——恢复不是新对话。
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
        title: "已取消归档",
        description: session.label,
      });
    },
    [showToast, persistToStorage, loadArchives],
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
          <div className="flex-1 flex flex-col space-y-6">
            <PageHeader>模型设置</PageHeader>
            {/* ── Left-right split layout：容器固定高度（不随模型数量变动），左栏绝对定位贴合等高 ── */}
            <div className="relative h-[460px]">
              {/* 左栏脱离文档流：inset-y-0 与容器固定高度对齐；列表 flex-1 超出时内部滚动。 */}
              {/* Left sidebar — all models list */}
              <div className="absolute inset-y-0 left-0 w-60 min-h-0 flex flex-col rounded-xl border border-border/40 bg-card/60 overflow-hidden">
                <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
                  <button
                    onClick={() => setModelTab("vision")}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
                      modelTab === "vision"
                        ? "bg-primary/10 text-primary"
                        : "text-foreground hover:bg-muted/50"
                    }`}
                  >
                    <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] px-1.5 py-0.5 rounded-full font-medium bg-muted/80 text-muted-foreground">
                      视觉
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[length:var(--helix-transcript-size)] font-medium">
                      {visionModelName || "未配置"}
                    </span>
                    {visionHasApiKey && (
                      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                    )}
                  </button>
                  <button
                    onClick={() => setModelTab("image")}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
                      modelTab === "image"
                        ? "bg-primary/10 text-primary"
                        : "text-foreground hover:bg-muted/50"
                    }`}
                  >
                    <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] px-1.5 py-0.5 rounded-full font-medium bg-muted/80 text-muted-foreground">
                      生图
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[length:var(--helix-transcript-size)] font-medium">
                      {imageModelName || "未配置"}
                    </span>
                    {imageHasApiKey && (
                      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                    )}
                  </button>
                  {apiProfiles.map((p) => {
                    const isActive = modelTab === "main" && selectedProviderId === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => {
                          setModelTab("main");
                          setSelectedProviderId(p.id);
                          setEditingProfileId(p.id);
                          setLocalConfig({ ...p.config });
                          seedAddedModels(
                            p.models || [],
                            p.modelContextWindows,
                            p.modelReasonings,
                            p.modelInputs,
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
                        <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] px-1.5 py-0.5 rounded-full font-medium bg-muted/80 text-muted-foreground">
                          对话
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[length:var(--helix-transcript-size)] font-medium">
                          {p.config.provider || p.name}
                        </span>
                        {p.config.apiKey && (
                          <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                        )}
                      </button>
                    );
                  })}
                  {/* 渠道行（pi-connect 的 WorkBuddy / Trae / Qoder）：由 pi 的
                      扩展在运行期注册，不在 profiles 里；点击后右侧是只读的
                      模型清单，实际使用走输入框模型下拉的按会话选择。 */}
                  {piChannelProviders.map((cp) => {
                    const tab: ModelTab = `channel:${cp.id}`;
                    const isActive = modelTab === tab;
                    return (
                      <button
                        key={cp.id}
                        onClick={() => setModelTab(tab)}
                        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
                          isActive
                            ? "bg-primary/10 text-primary"
                            : "text-foreground hover:bg-muted/50"
                        }`}
                      >
                        <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] px-1.5 py-0.5 rounded-full font-medium bg-muted/80 text-muted-foreground">
                          渠道
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[length:var(--helix-transcript-size)] font-medium">
                          {cp.name}
                        </span>
                        <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                      </button>
                    );
                  })}
                </div>
                <div className="px-2 pt-1 mb-4 mt-auto">
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
                      setModelTab("main");
                    }}
                  >
                    添加供应商
                  </Button>
                </div>
              </div>

                {/* Right content：h-full 占满容器固定高度，内容超高时内部滚动 */}
                <div className="ml-[16.25rem] w-[calc(100%-16.25rem)] h-full min-w-0 min-h-0 flex flex-col overflow-hidden">
                  {modelTab === "main" ? (
                    <>
                      <SettingGroup
                        className="flex flex-col flex-1 min-h-0"
                        bodyClassName="flex flex-col flex-1 min-h-0"
                      >
                    <div className="p-5 space-y-4 flex flex-col h-full overflow-y-auto">
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
                          onChange={(v) => void handleApiFormatChange(v)}
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

                      <div className="flex flex-col flex-1 min-h-0">
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
                              setPickedReasoning(false);
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
                          <div className="max-h-[80px] overflow-y-auto space-y-1.5 pr-1">
                            {addedModels.map((m) => (
                              <div
                                key={m.id}
                                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-border/40 bg-muted/30 group/model-row"
                              >
                                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--helix-transcript-size)] text-foreground">
                                  {m.id}
                                </span>
                                {m.contextWindow !== undefined && (
                                  <span className="shrink-0 font-mono text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/70">
                                    {m.contextWindow.toLocaleString()}
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
                                          }).then((r: { models?: string[]; error?: string }) => {
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
                                    } catch (e) {
                                      showToast({
                                        type: "error",
                                        title: `「${m.id}」连接失败`,
                                        description: String((e as { message?: string })?.message || e),
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
                                    // 回填旧值：pickedModel 只在“已拉取到模型
                                    // 列表”时才可见（列表高亮），而列表通常为空
                                    // → 走手动输入分支。manualModel 同步回填，
                                    // 编辑弹窗才能显示之前的模型名。
                                    setPickedModel(m.id);
                                    setManualModel(m.id);
                                    // 上次“获取”的列表若不含该模型，列表分支里
                                    // 也看不到旧值（无高亮）——清掉让它回落到
                                    // 已回填的手动输入分支。
                                    if (!availableModels.includes(m.id)) {
                                      setAvailableModels([]);
                                    }
                                    // 上下文/思考回填：优先 addedModels 自身，
                                    // 缺失则回落到 pi models.json 的同名模型。
                                    const prov = localConfig.provider
                                      .trim()
                                      .replace(/^custom:/, "");
                                    const pm =
                                      piModels.find(
                                        (x) =>
                                          x.id === m.id &&
                                          (!prov || x.provider === prov),
                                      ) ?? piModels.find((x) => x.id === m.id);
                                    setPickedContext(
                                      String(
                                        m.contextWindow ??
                                          pm?.contextWindow ??
                                          "",
                                      ),
                                    );
                                    setPickedReasoning(
                                      !!(m.reasoning ?? pm?.reasoning),
                                    );
                                    const inputList =
                                      m.input ?? pm?.input ?? [];
                                    setPickedInputImage(
                                      inputList.includes("image"),
                                    );
                                    setPickedInputVideo(
                                      inputList.includes("video"),
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
                                  onClick={() => {
                                    // 与「添加模型」对称：只改本地 addedModels 不会
                                    // 持久化，而且这个 state 会在 activeProfileId /
                                    // apiProfiles 变化时从 profile 重新灌入（上方
                                    // mount effect），所以「删除模型没效果」。这里同样
                                    // 立即走 saveApiRef 落盘（profile + providers +
                                    // 后端 settings.json / models.json）。
                                    if (addedModels.length <= 1) {
                                      showToast({
                                        type: "warning",
                                        title: "至少保留一个模型",
                                        description:
                                          "如需清空该配置，请删除整个供应商。",
                                      });
                                      return;
                                    }
                                    const next = addedModels.filter(
                                      (x) => x.id !== m.id,
                                    );
                                    setAddedModels(next);
                                    void saveApiRef.current?.(next);
                                  }}
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
                              {piFormatForProvider && (
                                <span
                                  className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground"
                                  data-tip="该供应商在 Pi 后端注册的 API 格式（保存模型时自动沿用）"
                                >
                                  {piFormatForProvider}
                                </span>
                              )}
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

                            <div className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
                              <div className="flex flex-col">
                                <span className="ui-text font-medium text-foreground">
                                  开启思考模式
                                </span>
                              </div>
                              <Toggle
                                enabled={pickedReasoning}
                                onToggle={() => setPickedReasoning((v) => !v)}
                              />
                            </div>

                            <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
                              <div className="mb-1.5 ui-text font-medium text-foreground">
                                输入类型
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                <span
                                  className="px-2.5 py-1.5 rounded-lg text-[length:var(--helix-transcript-size)*0.9] font-mono border border-primary/50 bg-primary/10 text-primary"
                                  data-tip="始终开启"
                                >
                                  文字
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPickedInputImage((v) => !v)
                                  }
                                  className={`px-2.5 py-1.5 rounded-lg text-[length:var(--helix-transcript-size)*0.9] font-mono border transition-colors ${
                                    pickedInputImage
                                      ? "border-primary/50 bg-primary/10 text-primary"
                                      : "border-border/40 text-muted-foreground/60 hover:bg-accent/40"
                                  }`}
                                  data-tip="开启后粘贴的图片直接发给模型，不再先走视觉转述"
                                >
                                  图片
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPickedInputVideo((v) => !v)
                                  }
                                  className={`px-2.5 py-1.5 rounded-lg text-[length:var(--helix-transcript-size)*0.9] font-mono border transition-colors ${
                                    pickedInputVideo
                                      ? "border-primary/50 bg-primary/10 text-primary"
                                      : "border-border/40 text-muted-foreground/60 hover:bg-accent/40"
                                  }`}
                                  data-tip="会写入 models.json，但 pi 目前只识别 image，视频不会生效"
                                >
                                  视频
                                </button>
                              </div>
                              <p className="mt-1.5 text-[length:var(--helix-transcript-size)*0.85] text-muted-foreground/60">
                                pi 只认「图片」：勾了才把图片原生透传给模型，
                                不勾则先转成文字描述。
                              </p>
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

                    </div>
                  </SettingGroup>
                  </>
                ) : modelTab === "vision" ? (
                  <VisionModelSettings />
                ) : modelTab === "image" ? (
                  <ImageModelSettings />
                ) : (
                  <ChannelModelSettings
                    channelId={modelTab.slice("channel:".length)}
                    models={piModels}
                  />
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
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsAddingMcp(true);
                      resetMcpForm();
                    }}
                  >
                    添加服务器
                  </Button>
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
                            className="group flex items-center gap-3 rounded-xl border border-border/40 bg-card/60 px-4 py-3 transition-colors hover:border-border/70"
                          >
                            <div className="relative shrink-0">
                              <div
                                title={mcpStatusDetail[name]?.error || undefined}
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
                                {mcpToolCountLabel(mcpStatusDetail[name]?.toolCount)}{cfg?.url || cmd || "(环境变量式配置)"}
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
                        className="group flex items-center gap-3 rounded-xl border border-border/40 bg-card/60 px-4 py-3 transition-colors hover:border-border/70"
                      >
                        <div className="relative shrink-0">
                          <div
                            title={mcpStatusDetail[name]?.error || undefined}
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
                            {mcpToolCountLabel(mcpStatusDetail[name]?.toolCount)}{config.type === "local"
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

      case "archive": {
        const projectOptions = [
          { label: "所有项目", value: "all" },
          ...[...new Set(archives.map((a) => a.workDir ?? ""))].map((v) => ({
            label: v === "" ? "未关联项目" : archiveProjectName(v),
            value: v,
          })),
        ];
        // 删空一个项目后它的筛选项不复存在 → 回退到「所有项目」，避免出现空列表。
        const projectFilter = projectOptions.some(
          (o) => o.value === archiveProjectFilter,
        )
          ? archiveProjectFilter
          : "all";
        const q = archiveQuery.trim().toLowerCase();
        const filtered = archives.filter(
          (a) =>
            (projectFilter === "all" || (a.workDir ?? "") === projectFilter) &&
            (q === "" || a.label.toLowerCase().includes(q)),
        );
        // archives 已按 savedAt 降序 → 分组按「最近有任务的项目」排序，组内同序。
        const groups: Array<{
          key: string;
          workDir: string | null;
          items: typeof archives;
        }> = [];
        for (const a of filtered) {
          const key = a.workDir ?? "";
          let g = groups.find((x) => x.key === key);
          if (!g) {
            g = { key, workDir: a.workDir, items: [] };
            groups.push(g);
          }
          g.items.push(a);
        }

        return (
          <div className="max-w-3xl space-y-6">
            <PageHeader
              action={
                <button
                  onClick={() => setArchiveConfirmDeleteAll(true)}
                  disabled={archives.length === 0}
                  className="h-9 flex items-center gap-1.5 px-4 rounded-[10px] bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors text-[calc(var(--helix-transcript-size)*0.8571)] font-medium disabled:opacity-40 disabled:pointer-events-none"
                >
                  <Trash2 className="size-4" />
                  全部删除
                </button>
              }
            >
              归档
            </PageHeader>

            {archives.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="ui-text font-medium text-foreground/60">
                  暂无归档记录
                </p>
              </div>
            ) : (
              <>
                {/* 搜索（只匹配任务名）+ 按项目筛选 */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 flex items-center gap-2.5 h-9 px-3.5 rounded-lg border border-border/50 bg-muted/50 focus-within:border-foreground/25 transition-colors">
                    <Search className="size-3.5 text-muted-foreground/40 shrink-0" />
                    <input
                      value={archiveQuery}
                      onChange={(e) => setArchiveQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setArchiveQuery("");
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      placeholder="搜索已归档任务"
                      className="flex-1 bg-transparent ui-text text-foreground placeholder:text-muted-foreground/40 min-w-0 outline-none"
                    />
                    {archiveQuery && (
                      <button
                        onClick={() => setArchiveQuery("")}
                        className="text-muted-foreground/30 hover:text-muted-foreground/60 shrink-0"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                  <PopupSelect
                    value={projectFilter}
                    onChange={setArchiveProjectFilter}
                    options={projectOptions}
                    className="w-44 h-9 shrink-0"
                  />
                </div>

                {groups.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <p className="ui-text font-medium text-foreground/60">
                      没有匹配的归档任务
                    </p>
                  </div>
                ) : (
                  <div className="space-y-8">
                    {groups.map((g) => (
                      <section key={g.key}>
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <Folder className="size-4 text-muted-foreground/60 shrink-0" />
                            <span
                              className="ui-text font-semibold text-foreground truncate"
                              data-tip={g.workDir ?? undefined}
                            >
                              {archiveProjectName(g.workDir)}
                            </span>
                          </div>
                          <span className="ui-text-sm2 text-muted-foreground/60 shrink-0">
                            {g.items.length} 个任务
                          </span>
                        </div>
                        <div className="space-y-2.5">
                          {g.items.map((a) => (
                            <div
                              key={a.id}
                              className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-border/40 bg-card/60"
                            >
                              <div className="flex-1 min-w-0">
                                <p className="ui-text font-semibold text-foreground truncate">
                                  {a.label}
                                </p>
                                <p className="ui-text-sm2 text-muted-foreground/60 mt-0.5">
                                  {formatArchiveDate(a.savedAt)}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  onClick={() => handleDeleteArchive(a.id)}
                                  aria-label="删除"
                                  data-tip="删除"
                                  className="size-9 flex items-center justify-center rounded-[10px] bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"
                                >
                                  <Trash2 className="size-4" />
                                </button>
                                <button
                                  onClick={() => handleLoadArchive(a.id)}
                                  className="h-9 flex items-center gap-1.5 px-3.5 rounded-[10px] bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors text-[calc(var(--helix-transcript-size)*0.8571)] font-medium"
                                >
                                  <ArchiveRestore className="size-4" />
                                  取消归档
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* 全部删除确认 */}
            {archiveConfirmDeleteAll && (
              <div
                className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
                onClick={() => {
                  if (!archiveDeletingAll) setArchiveConfirmDeleteAll(false);
                }}
              >
                <div
                  className="w-full max-w-sm rounded-xl border border-border/50 bg-card p-5 shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className="ui-title font-semibold text-foreground">
                    删除全部归档任务
                  </h3>
                  <p className="mt-2 ui-text text-muted-foreground/70">
                    将删除 {archives.length} 个已归档任务，此操作无法撤销。
                  </p>
                  <div className="mt-5 flex items-center justify-end gap-2.5">
                    <button
                      onClick={() => setArchiveConfirmDeleteAll(false)}
                      disabled={archiveDeletingAll}
                      className="px-4 py-2 rounded-lg ui-text-sm2 font-medium text-foreground/70 bg-muted/50 hover:bg-muted/80 transition-colors disabled:opacity-40"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleDeleteAllArchives}
                      disabled={archiveDeletingAll}
                      className="px-4 py-2 rounded-lg ui-text-sm2 font-medium text-white bg-red-500 hover:bg-red-500/90 transition-colors disabled:opacity-50"
                    >
                      {archiveDeletingAll ? "删除中…" : "全部删除"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      }

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
          </div>
        );

      case "agents":
        return <AgentsSettings />;

      case "memory":
        return <MemorySettingsPanel />;

      case "browser":
        return <BrowserSettingsPanel />;

      default:
        // 导航历史持久化里可能残留已删除页面的 id（如曾短暂存在的
        // 「channels」），回退到常规页而不是渲染空白。
        return <GeneralSettingsPanel />;
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-row">
      {/* Left nav — width synced with the main sidebar */}
      {showSidebar && (
        <div
          className={`helix-sidebar relative flex flex-col shrink-0 h-full overflow-hidden ${isResizing ? "" : "transition-[width] duration-200 ease-out"}`}
          style={{ width: sidebarCollapsed ? 48 : navWidth }}
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
                    handlePageChange(item.id);
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
                                handlePageChange(item.id);
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
      <div ref={scrollRef} className="helix-surface settings-scroll flex-1 overflow-y-auto relative">
        <div className="flex min-h-full flex-col items-center">
          <div className="px-8 pt-10 pb-10 w-full max-w-3xl flex-1 flex flex-col">
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
