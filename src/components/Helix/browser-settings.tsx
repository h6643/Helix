"use client";

import { invoke } from "@tauri-apps/api/core";
import {
  Folder,
  HardDrive,
  Trash2,
} from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import {
  PageHeader,
  NumberField,
  SettingGroup,
  SettingRow,
} from "./settings-ui";
import { Button } from "@/components/ui/button";
import { electronShell } from "@/lib/electron-bridge";

interface ClearResult {
  ok: boolean;
  freed_bytes: number;
  errors?: string[];
  closed_windows?: number;
}

interface StorageUsage {
  ok: boolean;
  dir?: string;
  cache_bytes?: number;
  total_bytes?: number;
  error?: string;
}

/** 人工接管超时（browser_handoff_config / browser_set_handoff_config）。
 *  返回里的 `timeoutMin` 是回读到的生效值，所以界面不必自己记一份。 */
interface HandoffConfig {
  ok: boolean;
  timeoutMin?: number;
  maxMin?: number;
  error?: string;
}

/** 清理范围，与后端 browser_clear_data 的 mode 一一对应。 */
type ClearMode = "cache" | "cache_site" | "all";

const CLEAR_OPTIONS: {
  mode: ClearMode;
  label: string;
  desc: string;
  danger: boolean;
}[] = [
  {
    mode: "cache",
    label: "只清缓存",
    desc: "删掉网页的 HTTP 缓存、V8 编译缓存与 GPU 缓存，并顺带回收 Helix 界面自身（主窗口）的同款缓存。登录态、站点数据全部保留，最常用。",
    danger: false,
  },
  {
    mode: "cache_site",
    label: "缓存 + 站点数据",
    desc: "额外删掉 cookie、IndexedDB、localStorage。所有网站的登录态会掉，需要重新登录。",
    danger: true,
  },
  {
    mode: "all",
    label: "全部浏览器数据",
    desc: "删掉整个浏览器用户数据目录，含历史记录、下载记录与自动填充表单。",
    danger: true,
  },
];

const fmtBytes = (n?: number) => {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

/** 浏览器设置：内置浏览器的存储占用、人工接管超时与数据清理。 */
export function BrowserSettingsPanel() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [pending, setPending] = useState<ClearMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // 人工接管超时。
  const [handoff, setHandoff] = useState<HandoffConfig | null>(null);
  const [handoffMsg, setHandoffMsg] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<StorageUsage>("browser_storage_usage")
      .then(setUsage)
      // 拿不到（非 Windows 平台后端直接返回 Err）时也要落地成一条
      // ok:false，否则界面会永远停在「加载中…」。
      .catch((e: unknown) =>
        setUsage({ ok: false, error: (e as { message?: string })?.message ?? String(e) }),
      );
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    invoke<HandoffConfig>("browser_handoff_config")
      .then(setHandoff)
      .catch((e: unknown) =>
        setHandoff({ ok: false, error: (e as { message?: string })?.message ?? String(e) }),
      );
  }, []);

  /** 保存接管超时：以后端回读的生效值刷新界面 —— 写失败时数字不会自己骗人。 */
  const saveHandoffMin = useCallback(async (min: number) => {
    setHandoffMsg(null);
    try {
      const res = await invoke<HandoffConfig>("browser_set_handoff_config", {
        updates: { timeoutMin: min },
      });
      if (res.ok) {
        setHandoff(res);
      } else {
        setHandoffMsg(`没保存：${res.error ?? "后端拒绝了该值"}`);
      }
    } catch (e) {
      setHandoffMsg(`没保存：${(e as { message?: string })?.message ?? String(e)}`);
    }
  }, []);

  const openDir = useCallback(async () => {
    if (!usage?.dir) return;
    try {
      // 目录可能还没建出来（从没开过浏览器），打不开就忽略。
      await electronShell.openPath(usage.dir);
    } catch (e) {
      console.error("打开浏览器数据目录失败", e);
    }
  }, [usage?.dir]);

  const runClear = useCallback(
    async (mode: ClearMode) => {
      setPending(null);
      setBusy(true);
      setResult(null);
      try {
        const res = await invoke<ClearResult>("browser_clear_data", { mode });
        if (!res.ok) {
          setResult(
            `已释放 ${fmtBytes(res.freed_bytes)}，但有 ${
              res.errors?.length ?? 0
            } 项失败：${(res.errors ?? []).slice(0, 3).join("; ")}`,
          );
        } else {
          const extra = res.closed_windows
            ? `，已关闭 ${res.closed_windows} 个浏览器页`
            : "";
          setResult(
            `已释放 ${fmtBytes(res.freed_bytes)}${extra}。`,
          );
        }
        refresh();
      } catch (e) {
        setResult(`清理失败：${(e as { message?: string })?.message ?? String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const option = CLEAR_OPTIONS.find((o) => o.mode === pending);

  // 只有后端回了生效值才渲染输入框：取值区间由 Rust 侧定义，界面不自己记一份。
  const handoffCfg =
    handoff?.ok &&
    typeof handoff.timeoutMin === "number" &&
    typeof handoff.maxMin === "number"
      ? { value: handoff.timeoutMin, max: handoff.maxMin }
      : null;

  return (
    <div className="flex-1 flex flex-col space-y-6">
      <PageHeader>浏览器</PageHeader>

      {/* 存储占用 */}
      <SettingGroup>
        <div className="flex items-center gap-3 py-3 px-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <HardDrive className="size-[1.15em]" />
          </span>
          <span className="min-w-0 flex-1 text-[length:var(--helix-transcript-size)]">
            <span className="block truncate font-medium text-foreground">
              浏览器数据
            </span>
            <span className="block truncate text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
              {!usage
                ? "加载中…"
                : usage.ok
                  ? `共 ${fmtBytes(usage.total_bytes)} · 其中缓存 ${fmtBytes(
                      usage.cache_bytes,
                    )}`
                  : (usage.error ?? "当前平台不支持")}
            </span>
          </span>
          <button
            type="button"
            title="打开数据目录"
            aria-label="打开数据目录"
            disabled={!usage?.dir}
            onClick={openDir}
            className="shrink-0 rounded-md p-1.5 text-foreground transition-colors hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Folder className="size-4" />
          </button>
        </div>
      </SettingGroup>

      {/* 人工接管 */}
      <div className="pt-1">
        <div className="px-4 pt-3 pb-2">
          <h4 className="ui-subtitle font-semibold text-foreground">人工接管</h4>
        </div>
        <SettingGroup>
          {handoffCfg ? (
            <SettingRow
              label="接管超时"
              hint={`Agent 把侧栏浏览器交给你登录/过验证码之后，这条页最长被锁住多久；上限 ${handoffCfg.max} 分钟。`}
            >
              <NumberField
                value={handoffCfg.value}
                min={1}
                max={handoffCfg.max}
                suffix="分钟"
                onCommit={saveHandoffMin}
              />
            </SettingRow>
          ) : (
            <div className="px-4 py-3 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
              {handoff
                ? `读不到接管超时配置：${handoff.error ?? "后端没返回生效值"}`
                : "加载中…"}
            </div>
          )}
          {handoffMsg && (
            <div className="px-4 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
              {handoffMsg}
            </div>
          )}
        </SettingGroup>
      </div>

      {/* 清理 */}
      <div className="pt-1">
        <div className="px-4 pt-3 pb-2">
          <h4 className="ui-subtitle font-semibold text-foreground">清理</h4>
        </div>
        <SettingGroup>
        {CLEAR_OPTIONS.map((o) => (
          <SettingRow key={o.mode} label={o.label} hint={o.desc}>
            <Button
              size="sm"
              variant={o.danger ? "destructive" : "outline"}
              disabled={busy}
              onClick={() => setPending(o.mode)}
            >
              {o.danger ? "清理" : "清缓存"}
            </Button>
          </SettingRow>
        ))}
        {busy && (
          <div className="px-4 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
            正在清理…（会先关闭所有浏览器页）
          </div>
        )}
        {result && (
          <div className="px-4 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
            {result}
          </div>
        )}
        </SettingGroup>
      </div>

      {option && (
        <div
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
          onClick={() => setPending(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                <Trash2 className="size-4" />
              </span>
              <div className="min-w-0">
                <div className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
                  {option.label}？
                </div>
                <p className="mt-1 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
                  {option.desc}
                </p>
                <p className="mt-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
                  当前占用 {fmtBytes(usage?.total_bytes)}。清理会先关闭所有已打开的浏览器页，操作不可撤销。
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
                取消
              </Button>
              <Button
                size="sm"
                variant={option.danger ? "destructive" : "default"}
                onClick={() => runClear(option.mode)}
              >
                确认清理
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
