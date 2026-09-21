"use client";

import {
  Trash2,
  ChevronDown,
  ChevronUp,
  User,
  Users,
} from "lucide-react";
import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  SettingRow,
  SettingGroup,
  PageHeader,
  PopupSelect,
  Toggle,
  NumberField,
  SaveBar,
} from "./settings-ui";
import { Button } from "@/components/ui/button";
import { useHelixStore } from "@/stores/helix-store";

interface DelegationConfig {
  provider: string;
  model: string;
  base_url: string;
  max_iterations: number;
  reasoning_effort: string;
  subagent_auto_approve: boolean;
}

const DEFAULTS: DelegationConfig = {
  provider: "",
  model: "",
  base_url: "",
  max_iterations: 50,
  reasoning_effort: "",
  subagent_auto_approve: false,
};

interface SubagentDraft {
  id: string;
  name: string;
  system_prompt: string;
}

const truncate = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + "…" : s;

// 来源徽标的取值来自后端 SubagentPreset.source（skills.rs::helix_list_subagents）：
// 内置预设与 pi-subagents 扩展自带文件都是 "default"，`.pi/agents` → "project"，
// `.agents/agents` → "workspace"，`~/.pi/agent/agents` → "global"。
const SOURCE_LABEL: Record<string, string> = {
  default: "内置",
  project: "项目",
  workspace: "工作区",
  global: "全局",
};



const SubagentModelPicker = ({
  id,
  current,
  onModelChange,
}: {
  id: string;
  current: string;
  onModelChange: (id: string, model: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const providers = useHelixStore((s) => s.providers);
  const activeProviderId = useHelixStore((s) => s.activeProviderId);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // 只列用户在「模型配置」里主动添加的模型（p.models）——不合并
  // providerModels[p.id]（那是端点 /models 目录，会自动拉进来几百个没配置的
  // 模型）。与主对话模型选择器行为一致（agent-flow-panel providerModelGroups
  // 的同款注释）。
  const allModels = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ providerLabel: string; modelId: string; key: string }> = [];
    // current 形如 "<providerId>/<modelId>"；模型 id 本身可能含 "/"
    // （org/model 格式），只按第一个斜杠切，与显示逻辑一致。
    const slash = current.indexOf("/");
    const curPid = slash > 0 ? current.slice(0, slash) : null;
    const curModel = slash > 0 ? current.slice(slash + 1) : null;
    for (const p of providers) {
      const models = new Set<string>(p.models.filter(Boolean));
      // 当前保存的模型可能来自历史配置、不在当前清单里：至少让它可选中/高亮。
      if (curPid === p.id && curModel && !models.has(curModel)) {
        models.add(curModel);
      }
      for (const m of models) {
        const key = `${p.id}/${m}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ providerLabel: p.name || p.id, modelId: m, key });
      }
    }
    return out;
  }, [providers, current]);

  const display = current
    ? (() => {
        // current is stored as "<providerId>/<modelId>"; show model part only
        const slash = current.indexOf("/");
        return slash > 0 ? current.slice(slash + 1) : current;
      })()
    : "继承主模型";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/70 hover:text-foreground transition-colors"
      >
        <span className="max-w-[120px] truncate">{display}</span>
        {open ? (
          <ChevronUp className="size-3 shrink-0" />
        ) : (
          <ChevronDown className="size-3 shrink-0" />
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px] max-h-56 overflow-y-auto rounded-xl border border-border bg-popover shadow-xl">
          <button
            type="button"
            onClick={() => {
              onModelChange(id, "");
              setOpen(false);
            }}
          >
          </button>
          {allModels.length === 0 && (
            <p className="px-3 py-2 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/50">
              请先在「模型配置」中添加提供方
            </p>
          )}
          {allModels.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => {
                onModelChange(id, m.key);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] hover:bg-muted/30 transition-colors ${
                current === m.key
                  ? "text-primary font-medium"
                  : "text-foreground/80"
              }`}
            >
              <span>{m.modelId}</span>
              <span className="ml-1.5 text-muted-foreground/50 text-[calc(var(--helix-transcript-size)*0.7143)]">
                {m.providerLabel}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const SubagentItem = ({
  i,
  remove,
}: {
  i: SubagentDraft;
  remove: (id: string) => void;
}) => (
  <div className="group flex items-center justify-between gap-3 rounded-xl border border-border/40 bg-card/60 px-4 py-3 transition-colors hover:border-border/70">
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <User className="size-5" />
      </div>
      <div className="min-w-0 space-y-0.5">
        <p className="ui-text font-semibold text-foreground truncate">
          {i.name.trim() || "未命名"}
        </p>
        <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 truncate">
          {i.system_prompt.trim()
            ? truncate(i.system_prompt.trim(), 28)
            : "（未填写系统提示词）"}
        </p>
      </div>
    </div>
    <Button
      size="icon"
      variant="ghost"
      className="size-8 shrink-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10"
      onClick={() => remove(i.id)}
      aria-label="删除子智能体"
      data-tip="删除"
    >
      <Trash2 className="size-4" />
    </Button>
  </div>
);

/// Card for a pi-subagents agent type.
/// - Disable/enable writes/removes `enabled: false` in the agent .md's
///   frontmatter (or a stub for compiled defaults) — the same mechanism the
///   extension's own /agents command uses, handled by
///   `helix_set_subagent_enabled`.
/// - Delete unlinks a custom agent's .md — handled by `helix_delete_subagent`.
///   A two-step confirm prevents accidents.
const PresetSubagentItem = ({
  p,
  onToggle,
  onDelete,
  onModelChange,
}: {
  p: any;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onModelChange: (id: string, model: string) => void;
}) => {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const disabled = p.disabled === true;
  return (
    <div
      className={
        "relative rounded-xl border border-border/40 bg-card/60 px-4 py-3 space-y-3 transition-colors " +
        (disabled ? "opacity-55" : "hover:border-border/70")
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <p
                className={`ui-text font-semibold truncate ${
                  disabled ? "text-muted-foreground/60" : "text-foreground"
                }`}
              >
                {p.name?.trim() || p.id}
              </p>
              <span className="shrink-0 rounded border border-border/20 bg-muted/40 px-1.5 py-0.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/70">
                {SOURCE_LABEL[p.source] ?? p.source ?? "未知"}
              </span>
            </div>
            {p.description?.trim() && (
              <p className="text-[calc(var(--helix-transcript-size)*0.8571)] leading-snug text-muted-foreground/70">
                {p.description}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SubagentModelPicker
            id={p.id}
            current={p.model}
            onModelChange={onModelChange}
          />
          <div className="flex items-center gap-1.5">
            {disabled && (
              <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-amber-500/80">
                已禁用
              </span>
            )}
            <Toggle
              enabled={!disabled}
              onToggle={async () => {
                setToggling(true);
                try {
                  await onToggle(p.id, !disabled);
                } finally {
                  setToggling(false);
                }
              }}
            />
          </div>
          {confirming ? (
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await onDelete(p.id);
                  } finally {
                    setDeleting(false);
                    setConfirming(false);
                  }
                }}
                className="text-[calc(var(--helix-transcript-size)*0.7857)] text-destructive hover:underline disabled:opacity-50"
              >
                {deleting ? "删除中…" : "确认删除"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground hover:underline"
              >
                取消
              </button>
            </span>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              className="size-8 text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10"
              onClick={() => setConfirming(true)}
              aria-label="删除预设"
              data-tip="删除"
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {Array.isArray(p.tools) &&
          p.tools.map((t: string) => (
            <span
              key={t}
              className="text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/60 bg-muted/20 border border-border/15 rounded px-1.5 py-0.5 font-mono"
            >
              {t}
            </span>
          ))}
      </div>
      {p.thinking && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/60">
          <span>思考强度：{p.thinking}</span>
        </div>
      )}
      {p.systemPrompt?.trim() && (
        <details className="group">
          <summary className="cursor-pointer list-none text-[calc(var(--helix-transcript-size)*0.8571)] text-primary/80 hover:text-primary select-none">
            <span className="inline-flex items-center gap-1">
              <span className="group-open:hidden">▸</span>
              <span className="hidden group-open:inline">▾</span>
              查看系统提示词
            </span>
          </summary>
          <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-card/60 border border-border/40 px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/70 font-mono leading-relaxed">
            {p.systemPrompt}
          </pre>
        </details>
      )}
    </div>
  );
};

export function AgentsSettings() {
  const [cfg, setCfg] = useState<DelegationConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [identities, setIdentities] = useState<
    { id: string; name: string; system_prompt: string }[]
  >([]);
  const [adding, setAdding] = useState(false);

  // ── Subagent global settings (config.yaml `subagents:` block) ───────
  type SubagentSettings = {
    workflowsEnabled?: boolean;
    schedulingEnabled?: boolean;
    toolDescriptionMode?: "full" | "compact" | "custom";
    worktreeIsolation?: boolean;
    maxConcurrent?: number;
    maxSubagentDepth?: number;
    disableDefaultAgents?: boolean;
  };
  const [saSettings, setSaSettings] = useState<SubagentSettings>({});
  const [, setSaLoading] = useState(false);
  const [saSaving, setSaSaving] = useState(false);
  const [saSaved, setSaSaved] = useState(false);
  const [saErr, setSaErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const api = (window as any).electron?.subagentsConfig;
    if (!api?.list) {
      // Tauri bridge not available — fall back silently.
      return;
    }
    api
      .list()
      .then((r: any) => {
        if (!alive) return;
        if (r?.ok && r.settings) {
          setSaSettings(r.settings);
        }
      })
      .catch((e) => alive && setSaErr(String(e)))
      .finally(() => alive && setSaLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const saveSubagentSettings = async () => {
    const api = (window as any).electron?.subagentsConfig;
    if (!api?.save) {
      setSaErr("网关未连接，无法保存子智能体设置");
      return;
    }
    setSaSaving(true);
    setSaErr(null);
    try {
      const r = await api.save(saSettings);
      if (!r?.ok) throw new Error(r?.error ?? "保存失败");
      setSaSaved(true);
      setTimeout(() => setSaSaved(false), 2000);
    } catch (e: any) {
      setSaErr(String(e?.message || e));
    } finally {
      setSaSaving(false);
    }
  };

  // pi-subagents agent types (extension defaults + project/workspace/global
  // .md files), with reversible enable/disable + delete.
  const [presets, setPresets] = useState<
    {
      id: string;
      name: string;
      description: string;
      tools: string[];
      model: string;
      thinking: string;
      systemPromptMode: string;
      systemPrompt: string;
      path: string;
      disabled: boolean;
      source: "default" | "project" | "workspace" | "global";
    }[]
  >([]);

  const apiHistory = useHelixStore((s) => s.apiHistory);

  useEffect(() => {
    let alive = true;
    const api = (window as any).electron?.helix;
    if (!api?.getConfig) {
      setErr("网关未连接，无法读取配置");
      setLoading(false);
      return;
    }
    api
      .getConfig()
      .then((r: any) => {
        if (!alive) return;
        const d = r?.delegation ?? {};
        setCfg({
          provider: d.provider ?? "",
          model: d.model ?? "",
          base_url: d.base_url ?? "",
          max_iterations:
            d.max_iterations != null ? Number(d.max_iterations) : 50,
          reasoning_effort: d.reasoning_effort ?? "",
          subagent_auto_approve:
            d.subagent_auto_approve === true ||
            d.subagent_auto_approve === "true",
        });
        // identities is persisted as a JSON-on-one-line YAML flow value, so
        // getConfig returns it as a string we JSON.parse here.
        const rawIds = d?.identities;
        let parsedIds: any[] = [];
        if (rawIds) {
          try {
            parsedIds = JSON.parse(rawIds);
          } catch { /* empty */ }
        }
        if (Array.isArray(parsedIds)) {
          setIdentities(
            parsedIds.map((x, i) => ({
              id: `id-${i}`,
              name: String(x?.name ?? ""),
              system_prompt: String(x?.system_prompt ?? ""),
            })),
          );
        }
      })
      .catch((e: any) => alive && setErr(String(e?.message || e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // Fetch the extension's registered agent types independently of
  // `getConfig` — the two are unrelated calls and one failing should not
  // block the other from populating `presets` (the pi-subagents registry
  // section).
  useEffect(() => {
    let alive = true;
    const listSubagents = (window as any).electron?.helix?.listSubagents;
    if (typeof listSubagents !== "function") return;
    listSubagents()
      .then((ps: any[]) => {
        if (alive && Array.isArray(ps)) setPresets(ps);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const setKey = (key: string, value: any) =>
    (window as any).electron?.helix?.setYamlKey(`delegation.${key}`, value);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setErr(null);
    try {
      await Promise.all([
        setKey("provider", cfg.provider),
        setKey("model", cfg.model),
        setKey("base_url", cfg.base_url),
        setKey("max_iterations", cfg.max_iterations),
        setKey("reasoning_effort", cfg.reasoning_effort),
        setKey("subagent_auto_approve", cfg.subagent_auto_approve),
      ]);
      const payload = identities
        .filter((i) => i.name.trim())
        .map(({ name, system_prompt }) => ({
          name: name.trim(),
          system_prompt,
        }));
      await (window as any).electron?.helix?.setDelegationIdentities?.(payload);
      // 与「保存 Hooks 配置」一致：保存后停留在本页并显示行内「已保存」状态，
      // 不再自动跳回列表（避免状态一闪而过）。
      setSaved(true);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const applyHistory = (idx: string) => {
    const h = apiHistory[Number(idx)];
    if (!h) return;
    setCfg((c) => ({
      ...c,
      provider: h.provider,
      model: h.model,
      base_url: h.baseUrl,
    }));
  };

  const matchedHistory = apiHistory.findIndex(
    (h) => h.model === cfg.model && h.baseUrl === cfg.base_url,
  );

  const addIdentity = () =>
    setIdentities((prev) => [
      ...prev,
      { id: `id-${Date.now()}`, name: "", system_prompt: "" },
    ]);

  const startAdd = () => {
    addIdentity();
    setAdding(true);
    setSaved(false);
    setErr(null);
  };

  // 取消/关闭添加页：未保存时丢弃 startAdd 插入的空白草稿；已保存后只是
  // 退出编辑页（身份已写入，不应再删除），与「保存 Hooks 配置」停留显示一致。
  const cancelAdd = () => {
    setIdentities((prev) => prev.slice(0, -1));
    setAdding(false);
  };

  const exitAdd = () => {
    if (saved) setAdding(false);
    else cancelAdd();
  };

  const updateIdentity = (
    id: string,
    patch: Partial<{ name: string; system_prompt: string }>,
  ) =>
    setIdentities((prev) =>
      prev.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    );

  const removeIdentity = (id: string) =>
    setIdentities((prev) => prev.filter((i) => i.id !== id));

  // Delete a pi-subagents custom agent: unlinks its .md (built-in defaults
  // have no file and are refused), then drop it from view.
  const deletePreset = async (id: string) => {
    const fn = (window as any).electron?.helix?.deleteSubagent;
    if (typeof fn !== "function") {
      setErr("网关未连接，无法删除预设");
      return;
    }
    try {
      await fn(id);
      setPresets((prev) => prev.filter((p) => p.id !== id));
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  };

  // Enable/disable an agent: writes/removes `enabled: false` in its
  // frontmatter — the same edit the extension's own /agents command makes,
  // so both surfaces stay in sync. Disabling a compiled default writes a
  // stub to ~/.pi/agent/agents/<type>.md.
  const togglePreset = async (id: string, enabled: boolean) => {
    const fn = (window as any).electron?.helix?.setSubagentEnabled;
    if (typeof fn !== "function") {
      setErr("网关未连接，无法切换预设状态");
      return;
    }
    try {
      await fn(id, enabled);
      setPresets((prev) =>
        prev.map((p) => (p.id === id ? { ...p, disabled: !enabled } : p)),
      );
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  };

  // Set the model on a preset: writes `model: "<provider/modelId>"` into the
  // agent's .md frontmatter. Empty string clears the field (inherit parent).
  const handleModelChange = async (id: string, model: string) => {
    const fn = (window as any).electron?.helix?.setSubagentModel;
    if (typeof fn !== "function") {
      setErr("网关未连接，无法设置模型");
      return;
    }
    try {
      await fn(id, model);
      setPresets((prev) =>
        prev.map((p) => (p.id === id ? { ...p, model } : p)),
      );
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  };

  const field = (
    label: string,
    key: keyof DelegationConfig,
    placeholder: string,
    type: "text" | "number" = "text",
    hint?: string,
  ) => (
    <SettingRow label={label} hint={hint}>
      <input
        type={type}
        value={cfg[key] as any}
        placeholder={placeholder}
        onChange={(e) =>
          setCfg((c) => ({
            ...c,
            [key]: type === "number" ? Number(e.target.value) : e.target.value,
          }))
        }
        className="w-56 px-3 py-1.5 bg-transparent border border-border/30 rounded-lg ui-text text-foreground/80 text-center placeholder:text-muted-foreground/30 transition-colors focus:border-primary/40"
      />
    </SettingRow>
  );

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <PageHeader
        action={
          adding ? (
            <button
              onClick={exitAdd}
              className="text-[length:var(--helix-transcript-size)] text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg px-2 py-1 transition-colors shrink-0"
              data-tip="关闭"
            >
              关闭
            </button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={startAdd}
              className="shrink-0"
            >
              添加子智能体
            </Button>
          )
        }
      >
        子智能体
      </PageHeader>

      <div className="max-w-3xl space-y-4">
        {loading ? (
          <div className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60 mt-2">
            读取配置中…
          </div>
        ) : adding ? (
          /* ── 添加 Subagent 独立页：整页替换列表视图，与「添加模型」一致 ── */
          <>
            <SettingGroup
              plain
              title="添加子智能体"
              description="配置委派模型的默认参数，并登记一个具名的子智能体身份。"
            >
                  {apiHistory.length > 0 ? (
                    <SettingRow label="模型配置（从历史选择）">
                      <PopupSelect
                        value={
                          matchedHistory >= 0 ? String(matchedHistory) : ""
                        }
                        onChange={applyHistory}
                        placeholder={
                          matchedHistory >= 0 ? "手动配置" : "选择历史模型配置…"
                        }
                        className="w-56 ui-text text-foreground"
                        options={apiHistory.map((h, i) => ({
                          value: String(i),
                          label: h.model,
                        }))}
                      />
                    </SettingRow>
                  ) : (
                    <SettingRow label="模型配置">
                      <span className="ui-text text-muted-foreground/60">
                        暂无历史配置，请先在「API 配置」中添加模型
                      </span>
                    </SettingRow>
                  )}
                  <SettingRow
                    label="最大迭代次数"
                    hint="子智能体单次任务最多执行的步骤数，超过即停止。"
                  >
                    <NumberField
                      value={cfg.max_iterations}
                      min={1}
                      max={1000}
                      onCommit={(v) =>
                        setCfg((c) => ({ ...c, max_iterations: v }))
                      }
                    />
                  </SettingRow>
                  {field(
                    "推理强度",
                    "reasoning_effort",
                    "ultra / max / high（可选）",
                    "text",
                    "控制子智能体的思考深度与耗时",
                  )}
                  {identities.length > 0 &&
                    (() => {
                      const draft = identities[identities.length - 1];
                      return (
                        <>
                          <SettingRow label="名称">
                            <div className="flex items-center gap-2">
                              <input
                                value={draft.name}
                                onChange={(e) =>
                                  updateIdentity(draft.id, {
                                    name: e.target.value,
                                  })
                                }
                                placeholder="如 researcher"
                                className="w-56 px-3 py-1.5 bg-transparent border border-border/30 rounded-lg ui-text font-semibold text-foreground text-center placeholder:text-muted-foreground/30 placeholder:font-normal transition-colors focus:border-primary/40"
                              />
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-8 shrink-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10"
                                onClick={exitAdd}
                                aria-label="删除子智能体"
                                data-tip="删除"
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          </SettingRow>
                          <SettingRow
                            label="系统提示词"
                            hint="子智能体的人格描述 / 角色设定"
                          >
                            <textarea
                              value={draft.system_prompt}
                              onChange={(e) =>
                                updateIdentity(draft.id, {
                                  system_prompt: e.target.value,
                                })
                              }
                              placeholder="系统提示词 / 人格描述…"
                              className="w-72 min-h-[80px] px-3 py-1.5 bg-transparent border border-border/30 rounded-lg ui-text text-foreground text-left placeholder:text-muted-foreground/30 resize-y transition-colors focus:border-primary/40"
                            />
                          </SettingRow>
                        </>
                      );
                    })()}
                  <SettingRow
                    label="危险命令自动通过"
                    hint="开启后，子智能体执行危险命令前不再逐条请求确认。"
                  >
                    <Toggle
                      enabled={cfg.subagent_auto_approve}
                      onToggle={() =>
                        setCfg((c) => ({
                          ...c,
                          subagent_auto_approve: !c.subagent_auto_approve,
                        }))
                      }
                    />
                  </SettingRow>
            </SettingGroup>

            <SaveBar
              saving={saving}
              status={saved ? "ok" : err ? "err" : null}
              errorText={err}
              onSave={save}
              onReset={() => setCfg(DEFAULTS)}
              disabled={loading || saving}
              saveLabel="保存"
            />
          </>
        ) : (
          /* ── 列表页 ── */
          <>
            {/* ── Subagent global settings (config.yaml subagents block) ── */}
            <SettingGroup>
              <SettingRow
                label="工具描述模式"
                hint="compact 缩短工具描述以节省上下文。"
              >
                <PopupSelect
                  value={saSettings.toolDescriptionMode ?? "full"}
                  onChange={(v) =>
                    setSaSettings((s) => ({
                      ...s,
                      toolDescriptionMode: v as "full" | "compact" | "custom",
                    }))
                  }
                  className="w-36"
                  options={[
                    { value: "full", label: "full" },
                    { value: "compact", label: "compact" },
                    { value: "custom", label: "custom" },
                  ]}
                />
              </SettingRow>

              <SettingRow
                label="并发上限"
                hint="同时运行的子智能体数量上限。0 = 不限。"
              >
                <NumberField
                  value={saSettings.maxConcurrent ?? 0}
                  min={0}
                  max={64}
                  onCommit={(v) =>
                    setSaSettings((s) => ({ ...s, maxConcurrent: v }))
                  }
                />
              </SettingRow>

              <SettingRow
                label="最大嵌套深度"
                hint="子智能体再派生子智能体的层数上限。"
              >
                <NumberField
                  value={saSettings.maxSubagentDepth ?? 1}
                  min={1}
                  max={16}
                  onCommit={(v) =>
                    setSaSettings((s) => ({ ...s, maxSubagentDepth: v }))
                  }
                />
              </SettingRow>

              <SettingRow
                label="启用调度"
                hint="允许子智能体使用 schedule 工具。"
              >
                <Toggle
                  enabled={saSettings.schedulingEnabled ?? false}
                  onToggle={() =>
                    setSaSettings((s) => ({
                      ...s,
                      schedulingEnabled: !(s.schedulingEnabled ?? false),
                    }))
                  }
                />
              </SettingRow>

              <SettingRow
                label="启用工作流"
                hint="开启工作流编排（多步骤协作）。"
              >
                <Toggle
                  enabled={saSettings.workflowsEnabled ?? false}
                  onToggle={() =>
                    setSaSettings((s) => ({
                      ...s,
                      workflowsEnabled: !(s.workflowsEnabled ?? false),
                    }))
                  }
                />
              </SettingRow>

              <SettingRow
                label="工作树隔离"
                hint="为每个子智能体创建独立 git worktree。"
              >
                <Toggle
                  enabled={saSettings.worktreeIsolation ?? false}
                  onToggle={() =>
                    setSaSettings((s) => ({
                      ...s,
                      worktreeIsolation: !(s.worktreeIsolation ?? false),
                    }))
                  }
                />
              </SettingRow>

              <div className="flex items-center justify-end gap-3 px-4 py-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={saveSubagentSettings}
                  disabled={saSaving}
                >
                  {saSaving ? "保存中…" : saSaved ? "已保存" : "保存行为设置"}
                </Button>
              </div>
              {saErr && (
                <p className="px-4 pb-3 text-[calc(var(--helix-transcript-size)*0.8571)] text-red-400">
                  {saErr}
                </p>
              )}
            </SettingGroup>

            {identities.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Users className="size-4 text-muted-foreground/60" />
                  <h4 className="ui-subtitle font-semibold text-foreground">
                    已登记的身份
                  </h4>
                  <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/50">
                    {identities.length}
                  </span>
                </div>
                {identities.map((i) => (
                  <SubagentItem key={i.id} i={i} remove={removeIdentity} />
                ))}
              </div>
            )}

            {err && (
              <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-red-400 pt-2">
                {err}
              </p>
            )}

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <h4 className="ui-subtitle font-semibold text-foreground">
                  已注册的 Agent
                </h4>
                <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/50">
                  {presets.length}
                </span>
              </div>
              {presets.length === 0 ? (
                <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">
                  当前未检测到 pi-subagents 扩展注册的 agent 类型。
                </p>
              ) : (
                <div className="space-y-2.5">
                  {presets.map((p) => (
                    <PresetSubagentItem
                      key={p.id}
                      p={p}
                      onToggle={togglePreset}
                      onDelete={deletePreset}
                      onModelChange={handleModelChange}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
