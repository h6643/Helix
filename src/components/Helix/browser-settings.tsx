"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Folder,
  HardDrive,
  KeyRound,
  Trash2,
} from "lucide-react";
import {
  PageHeader,
  SettingGroup,
  SettingRow,
} from "./settings-ui";
import { invoke } from "@tauri-apps/api/core";
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

/** 本机检测到的 Chromium 系浏览器（browser_import_detect）。 */
interface DetectedBrowser {
  id: string;
  name: string;
  dir: string;
  profiles: string[];
}

interface PasswordImportResult {
  ok: boolean;
  imported?: number;
  unsupported?: number;
  failed?: number;
  total?: number;
  closed_windows?: number;
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

/** 浏览器选择胶囊（导入密码 / 数据检索两个区块共用）。 */
function BrowserPills({
  browsers,
  value,
  onChange,
}: {
  browsers: DetectedBrowser[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {browsers.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => onChange(b.id)}
          className={
            "rounded-full border px-2.5 py-0.5 text-[calc(var(--helix-transcript-size)*0.8)] transition-colors " +
            (value === b.id
              ? "border-ring bg-accent text-accent-foreground"
              : "border-border/50 text-muted-foreground hover:bg-accent/60")
          }
        >
          {b.name}
        </button>
      ))}
    </div>
  );
}

/** 浏览器设置：内置浏览器的存储占用、密码导入与清理。 */
export function BrowserSettingsPanel() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [pending, setPending] = useState<ClearMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // 本机浏览器探测（密码导入用）。
  const [browsers, setBrowsers] = useState<DetectedBrowser[]>([]);

  // 导入密码。
  const [pwBrowser, setPwBrowser] = useState("");
  const [pwConfirm, setPwConfirm] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwResult, setPwResult] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<StorageUsage>("browser_storage_usage")
      .then(setUsage)
      // 拿不到（非 Windows 平台后端直接返回 Err）时也要落地成一条
      // ok:false，否则界面会永远停在「加载中…」。
      .catch((e: any) =>
        setUsage({ ok: false, error: e?.message ?? String(e) }),
      );
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    invoke<{ ok: boolean; browsers?: DetectedBrowser[] }>(
      "browser_import_detect",
    )
      .then((res) => {
        const list = res.browsers ?? [];
        setBrowsers(list);
        if (list[0]) {
          setPwBrowser((cur) => cur || list[0].id);
        }
      })
      .catch(() => setBrowsers([]));
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
      } catch (e: any) {
        setResult(`清理失败：${e?.message ?? String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const runPasswordImport = useCallback(async () => {
    setPwConfirm(false);
    setPwBusy(true);
    setPwResult(null);
    try {
      const res = await invoke<PasswordImportResult>(
        "browser_import_passwords",
        { browser: pwBrowser },
      );
      const parts = [`已导入 ${res.imported ?? 0} 条密码到内置浏览器`];
      if (res.unsupported) {
        parts.push(
          `${res.unsupported} 条使用新版应用绑定加密、无法解密而跳过`,
        );
      }
      if (res.failed) parts.push(`${res.failed} 条解密失败`);
      setPwResult(`${parts.join("；")}。`);
    } catch (e: any) {
      setPwResult(`导入失败：${e?.message ?? String(e)}`);
    } finally {
      setPwBusy(false);
    }
  }, [pwBrowser]);

  const option = CLEAR_OPTIONS.find((o) => o.mode === pending);

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

      {/* 导入密码：小标题放卡片外（与「常规」「外观」页同一套版式） */}
      <div className="pt-1">
        <div className="px-4 pt-3 pb-2">
          <h4 className="ui-subtitle font-semibold text-foreground">导入密码</h4>
        </div>
        <SettingGroup>
        {browsers.length === 0 ? (
          <div className="px-4 py-3 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
            未检测到本机 Chrome / Edge。
          </div>
        ) : (
          <>
            <SettingRow
              label="从本地浏览器导入"
              hint="读取本机 Chrome / Edge 保存的网页密码，解密后直接写进内置浏览器的登录数据（WebView2）。导入时会先关闭已打开的浏览器页；密码只留在浏览器配置里，Helix 不做任何加密留存。新版 Chrome 的应用绑定加密条目无法读取，会自动跳过。"
            >
              <div className="flex items-center gap-2">
                <BrowserPills
                  browsers={browsers}
                  value={pwBrowser}
                  onChange={setPwBrowser}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pwBusy}
                  onClick={() => setPwConfirm(true)}
                >
                  导入
                </Button>
              </div>
            </SettingRow>
            {pwBusy && (
              <div className="px-4 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
                正在导入…（会先关闭所有浏览器页）
              </div>
            )}
            {pwResult && (
              <div className="px-4 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
                {pwResult}
              </div>
            )}
          </>
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

      {pwConfirm && (
        <div
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
          onClick={() => setPwConfirm(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <KeyRound className="size-4" />
              </span>
              <div className="min-w-0">
                <div className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
                  导入浏览器密码？
                </div>
                <p className="mt-1 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
                  将读取本机
                  {browsers.find((b) => b.id === pwBrowser)?.name ?? "浏览器"}
                  {" "}保存的网页密码并写入内置浏览器。写入前会关闭所有已打开的浏览器页；读取源不会被修改。
                </p>
                <p className="mt-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
                  密码只存在于内置浏览器的配置文件中，Helix 不留副本，也不上传。
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPwConfirm(false)}
              >
                取消
              </Button>
              <Button size="sm" onClick={runPasswordImport}>
                确认导入
              </Button>
            </div>
          </div>
        </div>
      )}

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
