"use client";

import React, { useCallback, useEffect, useState } from "react";
import { McpEditorForm, type McpFormData } from "./mcp-editor-form";
import { Toggle } from "./settings-ui";
import { isElectron, helixApi, electronApp } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

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

// 插件中心里的连接器（MCP）页签：config.yaml `mcp_servers`（网关级，可编辑）
// 与应用侧遗留列表共同展示，共享 mcp.servers.status 的连接状态。
// SkillPanel 通过 addRequest 递增触发「添加服务器」，通过 onCount 上报条目数。
export function McpPanel({
  onCount,
  addRequest,
  searchQuery,
}: {
  onCount?: (n: number) => void;
  addRequest?: number;
  searchQuery?: string;
}) {
  const {
    showToast,
    persistToStorage,
    mcpServers,
    removeMcpServer,
    toggleMcpServer,
  } = useHelixStore();
  const selectedWorkDir = useHelixStore((s) => s.selectedWorkDir);

  const [editingMcpName, setEditingMcpName] = useState<string | null>(null);
  const [isAddingMcp, setIsAddingMcp] = useState(false);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpSaveState, setMcpSaveState] = useState<null | "ok" | "err">(null);
  const [mcpSaveErr, setMcpSaveErr] = useState<string | null>(null);
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

  // 上报条目数（网关 + 应用侧去重），供扩展管理页签计数。
  useEffect(() => {
    const names = new Set([...Object.keys(gatewayMcp), ...mcpServerNames]);
    onCount?.(names.size);
  }, [gatewayMcp, mcpServerNames, onCount]);

  const q = (searchQuery || "").trim().toLowerCase();
  const gatewayEntries = Object.entries(gatewayMcp).filter(([name]) =>
    q ? name.toLowerCase().includes(q) : true,
  );
  const legacyNames = mcpServerNames.filter((name) =>
    q ? name.toLowerCase().includes(q) : true,
  );

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

  // 头部「添加」按钮触发：递增序号打开添加表单。
  useEffect(() => {
    if (!addRequest) return;
    setIsAddingMcp(true);
    resetMcpForm();
  }, [addRequest, resetMcpForm]);

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
    [mcpServers, mcpArgText],
  );

  const handleDeleteMcp = useCallback(
    async (name: string) => {
      removeMcpServer(name);
      await persistToStorage();
    },
    [removeMcpServer, persistToStorage],
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

  const notEditing = !isAddingMcp && !editingMcpName && !gatewayEditing;

  return (
    <div>
      {/* Gateway-loaded MCP servers (config.yaml mcp_servers) — editable */}
      {gatewayMcpLoaded && notEditing && (
        <section className="space-y-2">
          {gatewayEntries.length === 0 ? null : (
            <div className="space-y-2">
              {gatewayEntries.map(([name, cfg]) => {
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

      {notEditing ? (
        <>
          {/* Server list */}
          <div className="space-y-2">
            {legacyNames.map((name) => {
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

          {/* Empty state — both lists empty */}
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
              onSave={gatewayEditing ? handleSaveGatewayMcp : handleSaveMcp}
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
}
