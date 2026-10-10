"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  SettingRow,
  SettingGroup,
  PageHeader,
  PopupSelect,
  Toggle,
} from "./settings-ui";
import { WebSearchSettings } from "./web-search-settings";
import { Button } from "@/components/ui/button";
import { runAutoArchiveScan } from "@/lib/auto-archive";
import { electronApp, electronDialog } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

/** 审批卡超时预设（秒）：1/2/5/10/30 分钟。范围 [30,3600] 由扩展与后端收敛。 */
const APPROVAL_TIMEOUT_PRESETS = [60, 120, 300, 600, 1800];

/** 自动归档保留期预设（天）。 */
const ARCHIVE_RETENTION_PRESETS = [7, 14, 30];

/** 轮次完成通知的三档，字面量与 Rust 侧 TurnEndMode::as_str() 对齐。 */
const TURN_END_MODES = [
  { label: "从不", value: "never" },
  { label: "仅在未聚焦时", value: "unfocused" },
  { label: "总是", value: "always" },
];

/** 通知偏好。真相在 config.yaml 的 notifications: 块（后端每次弹之前现读），
 *  这里只是这份真相的显示副本 —— 不进 store、不参与导出/导入。 */
interface NotifyPrefs {
  turnEndMode: string;
  approvalEnabled: boolean;
  clarifyEnabled: boolean;
}

const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  turnEndMode: "unfocused",
  approvalEnabled: true,
  clarifyEnabled: true,
};

/** 秒 → 展示文案（60 的倍数按分钟显示，其余按秒）。 */
function formatApprovalTimeout(sec: number): string {
  return sec >= 60 && sec % 60 === 0 ? `${sec / 60} 分钟` : `${sec} 秒`;
}

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
    startupGreeting,
    terminalShell,
    agentMaxIterations,
    autoCompactContext,
    autoSaveSession,
    autoArchiveOldTasks,
    autoArchiveRetentionDays,
    setAutoArchiveOldTasks,
    setAutoArchiveRetentionDays,
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
    // 审批卡超时：真相在 pi-permission 的 settings.json，store 里是供本页
    // 下拉显示的只读缓存（回读/写回见 sync/setApprovalTimeoutSec）。
    approvalTimeoutSec,
    syncApprovalTimeoutSec,
    setApprovalTimeoutSec,
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
    // 审批档位/审批超时不导出：它们的真相是 pi-permission 的配置文件
    // （<pi 数据根>/settings.json 的 permission 键），store 里的值只是缓存，
    // 导出一份副本等于制造第二条真相。要迁移请复制那个文件。
    "startupGreeting",
    "terminalShell",
    "agentMaxIterations",
    "autoCompactContext",
    "autoSaveSession",
    "autoArchiveOldTasks",
    "autoArchiveRetentionDays",
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
    startupGreeting,
    terminalShell,
    agentMaxIterations,
    autoCompactContext,
    autoSaveSession,
    autoArchiveOldTasks,
    autoArchiveRetentionDays,
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

  // 审批卡超时（settings.json permission.approvalTimeoutSec；下拉显示回读值）。
  const [approvalTimeoutBusy, setApprovalTimeoutBusy] = useState(false);

  // 通知开关（config.yaml notifications: 块）；改完即生效，本页无保存按钮。
  const [notifyPrefs, setNotifyPrefs] =
    useState<NotifyPrefs>(DEFAULT_NOTIFY_PREFS);
  const [notifyBusy, setNotifyBusy] = useState(false);

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

  // 回读审批卡超时的真相（settings.json permission.approvalTimeoutSec）。
  useEffect(() => {
    void syncApprovalTimeoutSec();
  }, [syncApprovalTimeoutSec]);

  // 回读通知偏好。读不到（纯浏览器 dev / 旧 preload）就停在默认值 —— 那正是
  // 本功能改造前的固定行为，下拉不会假装出一个后端没有的档位。
  useEffect(() => {
    let cancelled = false;
    electronApp
      .notificationConfig()
      .then((r) => {
        if (!cancelled && r?.ok) applyNotifyPrefs(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 后端回包 → 显示副本（三个字段一次换掉，避免半新半旧）。
  function applyNotifyPrefs(r: {
    turnEndMode?: string;
    approvalEnabled?: boolean;
    clarifyEnabled?: boolean;
  }) {
    setNotifyPrefs({
      turnEndMode: r.turnEndMode ?? DEFAULT_NOTIFY_PREFS.turnEndMode,
      approvalEnabled:
        r.approvalEnabled ?? DEFAULT_NOTIFY_PREFS.approvalEnabled,
      clarifyEnabled: r.clarifyEnabled ?? DEFAULT_NOTIFY_PREFS.clarifyEnabled,
    });
  }

  // 写通知偏好：只认后端回读的生效值；失败时后端一个字节都没写，所以留在原值
  // 上就是真话，只需把失败说出来。
  const patchNotify = async (updates: Partial<NotifyPrefs>) => {
    setNotifyBusy(true);
    try {
      const res = await electronApp.setNotificationConfig(updates);
      if (res?.ok) {
        applyNotifyPrefs(res);
        return;
      }
      showToast({
        type: "error",
        title: "通知设置未保存",
        description: res?.error ?? "后端不可用",
      });
    } catch (e) {
      showToast({
        type: "error",
        title: "通知设置未保存",
        description: String(e),
      });
    } finally {
      setNotifyBusy(false);
    }
  };

  const openNotifySettings = async () => {
    try {
      const r = await electronApp.openNotificationSettings();
      if (!r.ok) {
        showToast({
          type: "error",
          title: "打不开系统通知设置",
          description: r.error,
        });
      }
    } catch (e) {
      showToast({
        type: "error",
        title: "打不开系统通知设置",
        description: String(e),
      });
    }
  };

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

  // 审批卡超时下拉选项：预设 + （手工改过文件时）当前值本身，选项不撒谎。
  const approvalTimeoutPresets = APPROVAL_TIMEOUT_PRESETS.includes(
    approvalTimeoutSec,
  )
    ? APPROVAL_TIMEOUT_PRESETS
    : [...APPROVAL_TIMEOUT_PRESETS, approvalTimeoutSec].sort((a, b) => a - b);
  const approvalTimeoutOptions = approvalTimeoutPresets.map((s) => ({
    label: formatApprovalTimeout(s),
    value: s,
  }));

  // 审批卡超时改动即写（无保存按钮）：写 settings.json 后回读生效值刷新下拉。
  const handleApprovalTimeoutChange = async (v: string) => {
    const sec = Number(v);
    if (!Number.isFinite(sec) || sec === approvalTimeoutSec) return;
    setApprovalTimeoutBusy(true);
    try {
      const applied = await setApprovalTimeoutSec(sec);
      if (applied === sec) {
        showToast({
          type: "success",
          title: `审批卡超时已设为 ${formatApprovalTimeout(applied)}`,
        });
      } else {
        // 写失败会回读旧值；越界收敛也走这里（预设均在范围内，实际只有失败）。
        showToast({
          type: "error",
          title: `审批卡超时未能写入，当前为 ${formatApprovalTimeout(applied)}`,
        });
      }
    } finally {
      setApprovalTimeoutBusy(false);
    }
  };

  // 保留期下拉选项：预设 + （导入配置带来的非常规值）当前值本身，选项不撒谎。
  const archiveRetentionPresets = ARCHIVE_RETENTION_PRESETS.includes(
    autoArchiveRetentionDays,
  )
    ? ARCHIVE_RETENTION_PRESETS
    : [...ARCHIVE_RETENTION_PRESETS, autoArchiveRetentionDays].sort(
        (a, b) => a - b,
      );
  const archiveRetentionOptions = archiveRetentionPresets.map((d) => ({
    label: `${d} 天后归档`,
    value: d,
  }));

  // 归档设置改完即存（本页无保存按钮）。打开开关时立刻扫一轮，让用户当场见到
  // 效果，而不是等运行器的下一次心跳。
  const handleAutoArchiveToggle = (v: boolean) => {
    setAutoArchiveOldTasks(v);
    void persistToStorage();
    if (v) void runAutoArchiveScan();
  };

  const handleRetentionChange = (v: string) => {
    const days = Number(v);
    if (!Number.isFinite(days) || days === autoArchiveRetentionDays) return;
    setAutoArchiveRetentionDays(days);
    void persistToStorage();
  };

  return (
    <div className="space-y-6">
      <PageHeader>常规</PageHeader>

      {/* 小标题一律放在卡片外面（与「外观」页的「编辑器」「界面」同一套版式）：
          标题是分类名，卡片里的行标签只说具体项，两者不重复。
          这一组不带 pt-1 / pt-3：它是页面首个分组，别的首个分组都是无标题的卡片
          （页标题到卡片 = space-y 的 24px），带上那两层内边距会多出 16px。 */}
      <div>
        <div className="px-4 pb-2">
          <h4 className="ui-subtitle font-semibold text-foreground">网络</h4>
        </div>
        <SettingGroup>
          <SettingRow
            label="HTTP 代理"
            hint="模型 / MCP / 浏览器抓取 / npm 检查均经此代理"
          >
            <div className="flex flex-wrap items-center gap-2 justify-end">
              <input
                type="text"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="例如 http://127.0.0.1:10809"
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
      </div>

      {/* 联网搜索：真相在 config.yaml 的 web_search: 块（第三方扩展读它），
          所以这一行自带保存按钮，不走本页「改完即存」的那套。 */}
      <div className="pt-1">
        <div className="px-4 pt-3 pb-2">
          <h4 className="ui-subtitle font-semibold text-foreground">
            联网搜索
          </h4>
        </div>
        <WebSearchSettings />
      </div>

      <div className="pt-1">
        <div className="px-4 pt-3 pb-2">
          <h4 className="ui-subtitle font-semibold text-foreground">审批</h4>
        </div>
        <SettingGroup>
          <SettingRow
            label="审批卡超时"
            hint="弹窗出现即倒计时；到期未操作自动拒绝（拒绝执行，不放行）"
          >
            <PopupSelect
              value={String(approvalTimeoutSec)}
              onChange={(v) => void handleApprovalTimeoutChange(v)}
              options={approvalTimeoutOptions}
              className="w-36"
              disabled={approvalTimeoutBusy}
            />
          </SettingRow>
        </SettingGroup>
      </div>

      {/* 通知：只管「要不要用系统 toast 把人叫回来」。应用内的审批卡 / 澄清浮条
          永远照常弹，关掉这里只会少一条系统提醒。真相在 config.yaml，后端每次
          弹之前现读，所以改完即生效。 */}
      <div className="pt-1">
        <div className="px-4 pt-3 pb-2">
          <h4 className="ui-subtitle font-semibold text-foreground">通知</h4>
        </div>
        <SettingGroup>
          <SettingRow
            label="轮次完成通知"
            hint="一轮跑完（含出错、定时任务与渠道签到结果）何时提醒；未聚焦=没有 Helix 窗口在前台时才弹"
          >
            <PopupSelect
              value={notifyPrefs.turnEndMode}
              onChange={(v) => void patchNotify({ turnEndMode: v })}
              options={TURN_END_MODES}
              className="w-36"
              disabled={notifyBusy}
            />
          </SettingRow>
          <SettingRow
            label="权限请求通知"
            hint="Agent 需要授权才能继续时显示系统通知"
          >
            <Toggle
              enabled={notifyPrefs.approvalEnabled}
              onToggle={() =>
                void patchNotify({
                  approvalEnabled: !notifyPrefs.approvalEnabled,
                })
              }
            />
          </SettingRow>
          <SettingRow
            label="等待回答通知"
            hint="Agent 等待你回答问题时显示系统通知"
          >
            <Toggle
              enabled={notifyPrefs.clarifyEnabled}
              onToggle={() =>
                void patchNotify({
                  clarifyEnabled: !notifyPrefs.clarifyEnabled,
                })
              }
            />
          </SettingRow>
          <SettingRow
            label="系统通知设置"
            hint="收不到提醒时，到系统设置里确认 Helix 的通知权限（含专注助手）"
          >
            <Button
              size="sm"
              variant="outline"
              onClick={() => void openNotifySettings()}
            >
              打开系统设置
            </Button>
          </SettingRow>
        </SettingGroup>
      </div>

      <div className="pt-1">
        <div className="px-4 pt-3 pb-2">
          <h4 className="ui-subtitle font-semibold text-foreground">
            任务归档
          </h4>
        </div>
        <SettingGroup>
          <SettingRow
            label="自动归档旧任务"
            hint="定时扫描本地任务，将已完成、无未读、未置顶且超过保留期的移入归档"
          >
            <Toggle
              enabled={autoArchiveOldTasks}
              onToggle={() => handleAutoArchiveToggle(!autoArchiveOldTasks)}
            />
          </SettingRow>
          <SettingRow
            label="归档保留时长"
            hint="任务最后更新时间早于该时长后，才会进入自动归档候选"
          >
            <PopupSelect
              value={String(autoArchiveRetentionDays)}
              onChange={handleRetentionChange}
              options={archiveRetentionOptions}
              className="w-36"
              disabled={!autoArchiveOldTasks}
            />
          </SettingRow>
        </SettingGroup>
      </div>

      <div className="pt-1">
        <div className="px-4 pt-3 pb-2">
          <h4 className="ui-subtitle font-semibold text-foreground">
            数据与配置
          </h4>
        </div>
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
                      if (
                        !data ||
                        typeof data !== "object" ||
                        Array.isArray(data)
                      )
                        throw new Error("bad config file");
                      // 新格式带信封；旧裸对象也放行（向后兼容）。
                      if (
                        data.type !== undefined &&
                        data.type !== "helix-config"
                      )
                        throw new Error("unknown config type");
                      if (typeof data.version === "number" && data.version > 1)
                        throw new Error("unsupported version");
                      const patch: Record<string, unknown> = {};
                      let skippedApiKey = false;
                      for (const k of CONFIG_EXPORT_KEYS) {
                        if (data[k] === undefined) continue;
                        // 防御：即便旧文件里塞了 apiKey 也不直接吃进 state
                        // （apiConfig.apiKey 字段级剥离在下面做）。
                        if (
                          k === "apiConfig" &&
                          data[k] &&
                          typeof data[k] === "object"
                        ) {
                          const cfg = {
                            ...(data[k] as Record<string, unknown>),
                          };
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
    </div>
  );
}
