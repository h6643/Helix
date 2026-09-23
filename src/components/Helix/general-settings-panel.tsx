"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  SettingRow,
  SettingGroup,
  PageHeader,
  PopupSelect,
} from "./settings-ui";
import { Button } from "@/components/ui/button";
import { electronApp, electronDialog } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

export function GeneralSettingsPanel() {
  const showToast = useHelixStore((s) => s.showToast);

  const {
    apiConfig,
    apiProfiles,
    activeProfileId,
    providers,
    activeModel,
    activeProviderId,
    providerModels,
    fontFamily,
    fontSize,
    interfaceFont,
    transcriptFontSize,
    mcpServers,
    themeStyle,
    editorTheme,
    approvalMode,
    startupGreeting,
    terminalShell,
    agentMaxIterations,
    autoCompactContext,
    autoSaveSession,
    reasoningEffort,
    personality,
    fastMode,
    externalServices,
    customShortcuts,
    customizedShortcutIds,
    scheduledTasks,
    gitAutoCommit,
    gitAutoPush,
    gitPushConfirm,
    gitAutoBranch,
    gitRemoteUrl,
    gitCommitTemplate,
    gitBranchPrefix,
    persistToStorage,
  } = useHelixStore();

  // 导出/导入共用的键列表（与 persistToStorage 落盘键对齐，apiKeys 不导出）。
  const CONFIG_EXPORT_KEYS = [
    "apiConfig",
    "apiProfiles",
    "activeProfileId",
    "providers",
    "activeModel",
    "activeProviderId",
    "providerModels",
    "fontFamily",
    "fontSize",
    "interfaceFont",
    "transcriptFontSize",
    "themeStyle",
    "editorTheme",
    "mcpServers",
    "approvalMode",
    "startupGreeting",
    "terminalShell",
    "agentMaxIterations",
    "autoCompactContext",
    "autoSaveSession",
    "reasoningEffort",
    "personality",
    "fastMode",
    "externalServices",
    "customShortcuts",
    "customizedShortcutIds",
    "scheduledTasks",
    "gitAutoCommit",
    "gitAutoPush",
    "gitPushConfirm",
    "gitAutoBranch",
    "gitRemoteUrl",
    "gitCommitTemplate",
    "gitBranchPrefix",
  ] as const;
  // 从 store 取值用的映射（与 CONFIG_EXPORT_KEYS 一一对应）。
  const exportSource = {
    apiConfig,
    apiProfiles,
    activeProfileId,
    providers,
    activeModel,
    activeProviderId,
    providerModels,
    fontFamily,
    fontSize,
    interfaceFont,
    transcriptFontSize,
    themeStyle,
    editorTheme,
    mcpServers,
    approvalMode,
    startupGreeting,
    terminalShell,
    agentMaxIterations,
    autoCompactContext,
    autoSaveSession,
    reasoningEffort,
    personality,
    fastMode,
    externalServices,
    customShortcuts,
    customizedShortcutIds: Array.from(customizedShortcutIds),
    scheduledTasks,
    gitAutoCommit,
    gitAutoPush,
    gitPushConfirm,
    gitAutoBranch,
    gitRemoteUrl,
    gitCommitTemplate,
    gitBranchPrefix,
  } as Record<string, unknown>;

  const [dataRootInfo, setDataRootInfo] = useState<{
    dataRoot: string;
    dataRootDefault: string;
    dataRootCustom: boolean;
  }>({ dataRoot: "", dataRootDefault: "", dataRootCustom: false });
  const [dataRootPath, setDataRootPath] = useState("");
  const [dataRootBusy, setDataRootBusy] = useState(false);

  // HTTP 代理（持久化在 pi 全局 settings.json 的 httpProxy 键，重启应用后生效）。
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyBusy, setProxyBusy] = useState(false);

  // 常规面板的开关/选项改动即生效（无保存按钮），防抖写入 IndexedDB，
  // 避免设置项重启后丢失。
  const settingsPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(() => {
    if (settingsPersistTimer.current)
      clearTimeout(settingsPersistTimer.current);
    settingsPersistTimer.current = setTimeout(() => {
      void persistToStorage().catch(() => {});
    }, 300);
    return () => {
      if (settingsPersistTimer.current)
        clearTimeout(settingsPersistTimer.current);
    };
  }, [persistToStorage]);

  // 拉取当前生效的数据根目录（后端是权威来源）。
  useEffect(() => {
    let cancelled = false;
    electronApp
      .getDataRoot()
      .then((r) => {
        if (!cancelled && r) {
          setDataRootInfo(r);
          setDataRootPath(r.dataRoot);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 拉取当前配置的 HTTP 代理。
  useEffect(() => {
    let cancelled = false;
    electronApp
      .proxyGet()
      .then((r: { url?: string } | null) => {
        if (!cancelled && r) setProxyUrl(r.url ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const applyProxy = async () => {
    setProxyBusy(true);
    try {
      const r = await electronApp.proxySet(proxyUrl);
      if (r?.success) {
        showToast({
          type: "success",
          title: "代理已保存",
          description: "重启 Helix 后生效",
        });
      } else {
        showToast({ type: "error", title: "保存失败" });
      }
    } catch (e) {
      showToast({ type: "error", title: "保存失败", description: String(e) });
    } finally {
      setProxyBusy(false);
    }
  };

  const pickDataRoot = async () => {
    try {
      const dir = await electronDialog.openDirectory(
        dataRootInfo.dataRoot || undefined,
      );
      if (dir) setDataRootPath(dir);
    } catch {
      /* 取消选择：忽略 */
    }
  };

  const applyDataRoot = async () => {
    const target = dataRootPath.trim();
    if (!target) {
      showToast({ type: "warning", title: "请先输入或选择路径" });
      return;
    }
    setDataRootBusy(true);
    try {
      const r = await electronApp.setDataRoot(target);
      if (r?.success) {
        setDataRootInfo({
          dataRoot: r.dataRoot,
          dataRootDefault: r.dataRootDefault,
          dataRootCustom: r.dataRootCustom,
        });
        setDataRootPath(r.dataRoot);
        showToast({
          type: "success",
          title: "数据已复制到新位置",
          description: "重启 Helix 后生效",
        });
      } else {
        showToast({ type: "error", title: "设置失败" });
      }
    } catch (e) {
      showToast({ type: "error", title: "设置失败", description: String(e) });
    } finally {
      setDataRootBusy(false);
    }
  };

  const resetDataRoot = async () => {
    setDataRootBusy(true);
    try {
      const r = await electronApp.setDataRoot("");
      if (r?.success) {
        setDataRootInfo({
          dataRoot: r.dataRoot,
          dataRootDefault: r.dataRootDefault,
          dataRootCustom: r.dataRootCustom,
        });
        setDataRootPath(r.dataRoot);
        showToast({
          type: "success",
          title: "已恢复默认路径",
          description: "重启 Helix 后生效",
        });
      } else {
        showToast({ type: "error", title: "恢复失败" });
      }
    } catch (e) {
      showToast({ type: "error", title: "恢复失败", description: String(e) });
    } finally {
      setDataRootBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader>常规</PageHeader>

      <SettingGroup>
        <SettingRow
          label="HTTP 代理"
          hint="模型 / MCP / 浏览器抓取 / npm 检查均经此代理；localhost 直连；支持 socks5；保存后需重启应用"
        >
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <input
              type="text"
              value={proxyUrl}
              onChange={(e) => setProxyUrl(e.target.value)}
              placeholder="例如 http://127.0.0.1:7890"
              className="w-64 ui-text-sm2 px-2 py-1 rounded-md border border-border bg-background text-foreground"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={applyProxy}
              disabled={proxyBusy}
            >
              {proxyBusy ? "保存中…" : "保存"}
            </Button>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup>
        <SettingRow label="数据存储路径" hint={`应用数据的根目录`}>
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <input
              type="text"
              value={dataRootPath}
              onChange={(e) => setDataRootPath(e.target.value)}
              placeholder={dataRootInfo.dataRootDefault || "未设置"}
              className="w-72 ui-text-sm2 px-2 py-1 rounded-md border border-border bg-background text-foreground"
            />
            <Button size="sm" variant="outline" onClick={pickDataRoot}>
              选择文件夹
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={applyDataRoot}
              disabled={dataRootBusy}
            >
              {dataRootBusy ? "复制中…" : "应用"}
            </Button>
            {dataRootInfo.dataRootCustom && (
              <Button
                size="sm"
                variant="outline"
                onClick={resetDataRoot}
                disabled={dataRootBusy}
              >
                恢复默认
              </Button>
            )}
          </div>
        </SettingRow>
        <SettingRow
          label="配置管理"
          hint="导出/导入不含 API Key；导入会覆盖同名设置项"
        >
          <div className="flex flex-wrap gap-2 justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  const payload: Record<string, unknown> = {};
                  for (const k of CONFIG_EXPORT_KEYS)
                    if (exportSource[k] !== undefined)
                      payload[k] = exportSource[k];
                  const data = {
                    type: "helix-config",
                    version: 1,
                    exportedAt: new Date().toISOString(),
                    ...payload,
                  };
                  const blob = new Blob([JSON.stringify(data, null, 2)], {
                    type: "application/json",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `helix-config-${new Date().toISOString().slice(0, 10)}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                  showToast({ type: "success", title: "配置已导出" });
                } catch {
                  showToast({ type: "error", title: "导出失败" });
                }
              }}
            >
              导出配置
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".json";
                input.onchange = async (e) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  if (!file) return;
                  try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    if (!data || typeof data !== "object" || Array.isArray(data))
                      throw new Error("bad config file");
                    // 新格式带信封；旧裸对象也放行（向后兼容）。
                    if (
                      data.type !== undefined &&
                      data.type !== "helix-config"
                    )
                      throw new Error("unknown config type");
                    if (
                      typeof data.version === "number" &&
                      data.version > 1
                    )
                      throw new Error("unsupported version");
                    const patch: Record<string, unknown> = {};
                    let skippedApiKey = false;
                    for (const k of CONFIG_EXPORT_KEYS) {
                      if (data[k] === undefined) continue;
                      // 防御：即便旧文件里塞了 apiKey 也不直接吃进 state
                      // （apiConfig.apiKey 字段级剥离在下面做）。
                      if (k === "apiConfig" && data[k] && typeof data[k] === "object") {
                        const cfg = { ...(data[k] as Record<string, unknown>) };
                        if (cfg.apiKey !== undefined) {
                          delete cfg.apiKey;
                          skippedApiKey = true;
                        }
                        patch[k] = cfg;
                      } else {
                        patch[k] = data[k];
                      }
                    }
                    if (Object.keys(patch).length === 0)
                      throw new Error("no recognizable keys");
                    // customizedShortcutIds 运行时是 Set，JSON 里是数组。
                    if (Array.isArray(patch.customizedShortcutIds))
                      patch.customizedShortcutIds = new Set(
                        patch.customizedShortcutIds as string[],
                      );
                    useHelixStore.setState(patch);
                    await persistToStorage();
                    showToast({
                      type: "success",
                      title: skippedApiKey
                        ? "配置已导入（已跳过 API Key）"
                        : "配置已导入",
                    });
                  } catch {
                    showToast({
                      type: "error",
                      title: "导入失败：文件格式无效",
                    });
                  }
                };
                input.click();
              }}
            >
              导入配置
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (confirm("确定要重置所有设置吗？此操作不可撤销。")) {
                  localStorage.clear();
                  window.location.reload();
                }
              }}
            >
              重置所有设置
            </Button>
          </div>
        </SettingRow>
      </SettingGroup>
    </div>
  );
}
