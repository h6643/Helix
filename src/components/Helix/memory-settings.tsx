"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  PageHeader,
  SettingGroup,
  SettingRow,
  Toggle,
  NumberField,
  PopupSelect,
} from "./settings-ui";
import { getElectronAPI } from "@/lib/electron-bridge";

interface MemoryStats {
  file_count: number;
  last_updated: number;
  enabled: boolean;
}

interface MemoryOverview {
  ok: boolean;
  global: MemoryStats;
  current_project: string;
  projects: (MemoryStats & { name: string })[];
  config_path?: string;
}

type MemoryConfig = Record<string, any>;

/** 记忆设置：全局/项目记忆开关 + 记忆文件统计 + pi-hermes-memory 全量配置。 */
export function MemorySettingsPanel() {
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [cfg, setCfg] = useState<MemoryConfig | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshOverview = useCallback(() => {
    getElectronAPI()
      ?.helix.memoryOverview()
      .then((r) => setOverview(r as MemoryOverview))
      .catch(() => setOverview(null));
  }, []);

  const refreshConfig = useCallback(() => {
    getElectronAPI()
      ?.helix.memoryConfig()
      .then((r) => {
        const c = (r as { ok: boolean; config?: MemoryConfig }).config;
        if (c) setCfg(c);
      })
      .catch(() => setCfg(null));
  }, []);

  useEffect(() => {
    refreshOverview();
    refreshConfig();
  }, [refreshOverview, refreshConfig]);

  const fmt = (secs: number) =>
    secs
      ? new Date(secs * 1000).toLocaleString("zh-CN", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";

  /** 写入一项/几项配置并刷新。 */
  const apply = useCallback(
    async (updates: Record<string, unknown>) => {
      setBusy(true);
      try {
        await getElectronAPI()?.helix.setMemoryConfig(updates);
        refreshConfig();
      } finally {
        setBusy(false);
      }
    },
    [refreshConfig],
  );

  const toggleEnabled = useCallback(
    async (scope: "global" | "project", enabled: boolean) => {
      setBusy(true);
      try {
        await getElectronAPI()?.helix.setMemoryEnabled(scope, enabled);
        refreshOverview();
      } finally {
        setBusy(false);
      }
    },
    [refreshOverview],
  );

  const currentProject =
    overview?.projects.find((p) => p.name === overview.current_project) ??
    overview?.projects[0];

  const num = (key: string, fallback: number) =>
    typeof cfg?.[key] === "number" ? cfg[key] : fallback;

  const bool = (key: string, fallback = true) =>
    typeof cfg?.[key] === "boolean" ? cfg[key] : fallback;

  const sessionVariant =
    typeof cfg?.sessionSearch === "object" && cfg.sessionSearch?.variant
      ? cfg.sessionSearch.variant
      : "legacy";

  return (
    <div className="flex-1 flex flex-col space-y-6">
      <PageHeader>记忆</PageHeader>

      {/* 记忆行为 */}
      <SettingGroup>
        <SettingRow
          label="全局记忆"
          hint="开启后，Pi 会在所有项目中读取和更新你的个人偏好、习惯和长期上下文；关闭后不会使用或更新全局记忆。"
        >
          <Toggle
            enabled={overview?.global.enabled ?? true}
            onToggle={() =>
              toggleEnabled("global", !(overview?.global.enabled ?? true))
            }
          />
        </SettingRow>
        <SettingRow
          label="项目记忆"
          hint="开启后，Pi 会按项目读取和更新代码库规则、经验和长期上下文；关闭后不会使用或更新任何项目记忆。"
        >
          <Toggle
            enabled={currentProject?.enabled ?? true}
            onToggle={() =>
              toggleEnabled("project", !(currentProject?.enabled ?? true))
            }
          />
        </SettingRow>
      </SettingGroup>

      {/* 记忆文件统计 */}
      <SettingGroup>
        <div className="flex items-center justify-between px-4 py-2.5 text-[calc(var(--helix-transcript-size)*0.8571)]">
          <div>
            <div className="font-medium text-foreground">全局记忆</div>
            <div className="text-muted-foreground/70">
              {overview
                ? `${overview.global.file_count} 个记忆文件 · 更新于 ${fmt(
                    overview.global.last_updated,
                  )}`
                : "加载中…"}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5 text-[calc(var(--helix-transcript-size)*0.8571)]">
          <div>
            <div className="font-medium text-foreground">
              项目记忆{currentProject ? `（${currentProject.name}）` : ""}
            </div>
            <div className="text-muted-foreground/70">
              {currentProject
                ? `${currentProject.file_count} 个记忆文件 · 更新于 ${fmt(
                    currentProject.last_updated,
                  )}`
                : overview
                  ? "暂无项目记忆"
                  : "加载中…"}
            </div>
          </div>
        </div>
      </SettingGroup>

      {/* 容量上限 */}
      <SettingGroup>
        <SettingRow
          label="记忆容量上限"
          hint="各类记忆达到该字符数后触发溢出策略（0 = 无上限）"
        >
          <div className="flex items-center gap-3 justify-end">
            <span className="text-muted-foreground/70 text-[calc(var(--helix-transcript-size)*0.8571)]">
              全局
            </span>
            <NumberField
              value={num("memoryCharLimit", 5000)}
              min={0}
              max={100000}
              suffix="字符"
              small
              onCommit={(v) => apply({ memoryCharLimit: v })}
            />
          </div>
        </SettingRow>
        <SettingRow label="用户记忆上限" hint="USER.md 的容量上限">
          <div className="flex items-center gap-3 justify-end">
            <NumberField
              value={num("userCharLimit", 5000)}
              min={0}
              max={100000}
              suffix="字符"
              small
              onCommit={(v) => apply({ userCharLimit: v })}
            />
          </div>
        </SettingRow>
        <SettingRow label="项目记忆上限" hint="各项目记忆文件的容量上限">
          <div className="flex items-center gap-3 justify-end">
            <NumberField
              value={num("projectCharLimit", 5000)}
              min={0}
              max={100000}
              suffix="字符"
              small
              onCommit={(v) => apply({ projectCharLimit: v })}
            />
          </div>
        </SettingRow>
        <SettingRow
          label="溢出策略"
          hint="记忆超限时的处理：自动整理 / 拒绝写入 / 先进先出淘汰"
        >
          <PopupSelect
            value={cfg?.memoryOverflowStrategy ?? "auto-consolidate"}
            options={[
              { label: "自动整理", value: "auto-consolidate" },
              { label: "拒绝写入", value: "reject" },
              { label: "先进先出淘汰", value: "fifo-evict" },
            ]}
            onChange={(v) => apply({ memoryOverflowStrategy: v })}
          />
        </SettingRow>
      </SettingGroup>

      {/* 提醒与冲刷 */}
      <SettingGroup>
        <SettingRow
          label="提醒间隔"
          hint="每多少轮会话提醒沉淀一次记忆"
        >
          <div className="flex items-center gap-3 justify-end">
            <NumberField
              value={num("nudgeInterval", 10)}
              min={0}
              max={200}
              suffix="轮"
              small
              onCommit={(v) => apply({ nudgeInterval: v })}
            />
          </div>
        </SettingRow>
        <SettingRow
          label="提醒工具调用数"
          hint="每多少次工具调用提醒沉淀一次记忆"
        >
          <div className="flex items-center gap-3 justify-end">
            <NumberField
              value={num("nudgeToolCalls", 15)}
              min={0}
              max={500}
              suffix="次"
              small
              onCommit={(v) => apply({ nudgeToolCalls: v })}
            />
          </div>
        </SettingRow>
        <SettingRow
          label="压缩时冲刷"
          hint="上下文压缩时先把待沉淀记忆写盘"
        >
          <Toggle
            enabled={bool("flushOnCompact")}
            onToggle={() => apply({ flushOnCompact: !bool("flushOnCompact") })}
          />
        </SettingRow>
        <SettingRow
          label="退出时冲刷"
          hint="会话结束时把待沉淀记忆写盘"
        >
          <Toggle
            enabled={bool("flushOnShutdown")}
            onToggle={() =>
              apply({ flushOnShutdown: !bool("flushOnShutdown") })
            }
          />
        </SettingRow>
      </SettingGroup>

      {/* 回顾与自动识别 */}
      <SettingGroup>
        <SettingRow
          label="会话回顾"
          hint="会话结束后用最近 N 条消息回顾并沉淀记忆（0 = 关闭）"
        >
          <div className="flex items-center gap-3 justify-end">
            <NumberField
              value={num("reviewRecentMessages", 0)}
              min={0}
              max={200}
              suffix="条"
              small
              onCommit={(v) => apply({ reviewRecentMessages: v })}
            />
          </div>
        </SettingRow>
        <SettingRow
          label="纠正识别"
          hint="自动识别对话中的纠正与偏好并写入记忆"
        >
          <Toggle
            enabled={bool("correctionDetection")}
            onToggle={() =>
              apply({ correctionDetection: !bool("correctionDetection") })
            }
          />
        </SettingRow>
        <SettingRow
          label="常驻指令"
          hint="在系统提示中注入记忆相关常驻指令"
        >
          <Toggle
            enabled={bool("standingInstructionsEnabled")}
            onToggle={() =>
              apply({
                standingInstructionsEnabled: !bool(
                  "standingInstructionsEnabled",
                ),
              })
            }
          />
        </SettingRow>
      </SettingGroup>

      {/* 失败教训 */}
      <SettingGroup>
        <SettingRow
          label="失败教训沉淀"
          hint="开启后自动记录失败/纠正类教训（failures）"
        >
          <Toggle
            enabled={bool("failureInjectionEnabled")}
            onToggle={() =>
              apply({ failureInjectionEnabled: !bool("failureInjectionEnabled") })
            }
          />
        </SettingRow>
        <SettingRow label="失败保留天数" hint="超过该天数的失败教训不再注入">
          <div className="flex items-center gap-3 justify-end">
            <NumberField
              value={num("failureInjectionMaxAgeDays", 7)}
              min={0}
              max={365}
              suffix="天"
              small
              onCommit={(v) => apply({ failureInjectionMaxAgeDays: v })}
            />
          </div>
        </SettingRow>
        <SettingRow label="失败最多条数" hint="失败教训注入的上限">
          <div className="flex items-center gap-3 justify-end">
            <NumberField
              value={num("failureInjectionMaxEntries", 5)}
              min={0}
              max={50}
              suffix="条"
              small
              onCommit={(v) => apply({ failureInjectionMaxEntries: v })}
            />
          </div>
        </SettingRow>
      </SettingGroup>

      {/* 会话与其它 */}
      <SettingGroup>
        <SettingRow
          label="会话保留天数"
          hint="会话搜索保留最近多少天的会话（0 = 全部保留）"
        >
          <div className="flex items-center gap-3 justify-end">
            <NumberField
              value={num("sessionRetentionDays", 0)}
              min={0}
              max={3650}
              suffix="天"
              small
              onCommit={(v) => apply({ sessionRetentionDays: v })}
            />
          </div>
        </SettingRow>
        <SettingRow
          label="策略注入风格"
          hint="记忆策略注入方式（full / compact / none）"
        >
          <PopupSelect
            value={cfg?.memoryPolicyStyle ?? "full"}
            options={[
              { label: "完整", value: "full" },
              { label: "精简", value: "compact" },
              { label: "不注入", value: "none" },
            ]}
            onChange={(v) => apply({ memoryPolicyStyle: v })}
          />
        </SettingRow>
        <SettingRow
          label="会话搜索实现"
          hint="会话搜索的后端实现（默认 legacy）"
        >
          <PopupSelect
            value={sessionVariant}
            options={[
              { label: "Legacy", value: "legacy" },
              { label: "Anchors", value: "anchors" },
            ]}
            onChange={(v) => apply({ sessionSearch: { variant: v } })}
          />
        </SettingRow>
        <SettingRow
          label="打开会话即查记忆"
          hint="会话打开时快速检索相关记忆"
        >
          <Toggle
            enabled={bool("quickCheckOnOpen")}
            onToggle={() =>
              apply({ quickCheckOnOpen: !bool("quickCheckOnOpen") })
            }
          />
        </SettingRow>
      </SettingGroup>

      {busy && (
        <div className="px-4 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
          正在保存…
        </div>
      )}
    </div>
  );
}
