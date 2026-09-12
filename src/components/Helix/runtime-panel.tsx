"use client";

import {
  X,
  ShieldCheck,
  Server,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
  Download,
} from "lucide-react";
import React, { useState, useEffect, useCallback } from "react";
import { isElectron } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

interface DiagStatus {
  gatewayRunning: boolean;
  gatewayStartedAt: number;
  runtimeVersion: string;
  signatureStatus: string;
  signatureDetail: string;
  platform: string;
  electronVersion: string;
  nodeVersion: string;
  uptime: number;
}

export function RuntimePanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<DiagStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!isElectron() || !(window as any).electron?.diagnostics) return;
    try {
      const s = await (window as any).electron.diagnostics.getStatus();
      setStatus(s);
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const [updating, setUpdating] = useState(false);

  const doUpdate = async () => {
    if (!isElectron()) return;
    setUpdating(true);
    try {
      // 检查 pi agent + npm 插件的更新（npm registry）——与帮助菜单的
      // “检查更新”同一后端命令；Helix 应用自身没有自动更新通道。
      const res = await (window as any).electron?.helix?.piCheckUpdates?.();
      if (!res) {
        useHelixStore.getState().showToast({
          type: "error",
          title: "检查更新失败",
          description: "更新检查不可用",
        });
        return;
      }
      const pi = res.pi || {};
      const outdated = (res.packages || []).filter((p: any) => p.hasUpdate);
      if (pi.hasUpdate && pi.latest) {
        useHelixStore.getState().showToast({
          type: "info",
          title: "pi 有新版本可用",
          description: `v${pi.installed} → v${pi.latest}${
            outdated.length > 0 ? `，另有 ${outdated.length} 个插件可更新` : ""
          }`,
          duration: 8000,
          onClick: () =>
            window.open(
              "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
              "_blank",
            ),
        });
      } else if (outdated.length > 0) {
        const names = outdated
          .slice(0, 3)
          .map((p: any) => `${p.name} v${p.installed} → v${p.latest}`)
          .join("\n");
        useHelixStore.getState().showToast({
          type: "info",
          title: `有 ${outdated.length} 个插件可更新`,
          description:
            names + (outdated.length > 3 ? `\n…等 ${outdated.length} 个` : ""),
          duration: 10000,
        });
      } else if (pi.installed) {
        useHelixStore.getState().showToast({
          type: "success",
          title: "已是最新版本",
          description: `pi v${pi.installed}（含全部插件）`,
        });
      } else {
        useHelixStore.getState().showToast({
          type: "error",
          title: "检查更新失败",
          description: "未找到 pi 安装",
        });
      }
    } catch (e: any) {
      useHelixStore.getState().showToast({
        type: "error",
        title: "检查更新失败",
        description: String(e?.message || e),
      });
    } finally {
      setUpdating(false);
    }
  };

  const fmtUptime = (ms: number) => {
    if (!ms || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  };

  return (
    <div className="h-full w-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pr-36 py-4 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" />
          <h1 className="text-[calc(var(--helix-transcript-size)*1.4286)] font-semibold text-foreground">
            运行时与安全
          </h1>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
          data-tip="关闭"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
          {loading && !status ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            <>
              {/* Status cards */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border/50 bg-card/50 p-4">
                  <div className="flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground mb-1">
                    <Server className="size-3.5" /> Gateway 状态
                  </div>
                  <div className="flex items-center gap-2">
                    {status?.gatewayRunning ? (
                      <CheckCircle2 className="size-4 text-emerald-500" />
                    ) : (
                      <XCircle className="size-4 text-muted-foreground" />
                    )}
                    <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
                      {status?.gatewayRunning ? "运行中" : "未连接"}
                    </span>
                  </div>
                  <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/70 mt-1">
                    运行时长 {fmtUptime(status?.uptime || 0)}
                  </p>
                </div>

                <div className="rounded-xl border border-border/50 bg-card/50 p-4">
                  <div className="flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground mb-1">
                    <ShieldCheck className="size-3.5" /> 内核签名校验
                  </div>
                  <div className="flex items-center gap-2">
                    {status?.signatureStatus === "verified" ? (
                      <CheckCircle2 className="size-4 text-emerald-500" />
                    ) : (
                      <XCircle className="size-4 text-amber-500" />
                    )}
                    <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
                      {status?.signatureStatus === "verified"
                        ? "已校验"
                        : "未校验"}
                    </span>
                  </div>
                  <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/70 mt-1 truncate">
                    {status?.signatureDetail}
                  </p>
                </div>

                <div className="rounded-xl border border-border/50 bg-card/50 p-4">
                  <div className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground mb-1">
                    运行时版本
                  </div>
                  <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
                    {status?.runtimeVersion || "—"}
                  </p>
                  <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/70 mt-1">
                    Electron {status?.electronVersion} · Node{" "}
                    {status?.nodeVersion}
                  </p>
                </div>

                <div className="rounded-xl border border-border/50 bg-card/50 p-4">
                  <div className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground mb-1">
                    平台
                  </div>
                  <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground capitalize">
                    {status?.platform || "—"}
                  </p>
                  <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/70 mt-1">
                    托管运行时通道
                  </p>
                </div>
              </div>

              {/* Refresh button */}
              <div className="flex items-center gap-2">
                <button
                  onClick={refresh}
                  className="px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] rounded-lg border border-border/50 hover:bg-muted/50 transition-colors flex items-center gap-1.5"
                >
                  <RefreshCw className="size-3.5" /> 刷新状态
                </button>
                <button
                  onClick={doUpdate}
                  disabled={updating}
                  className="px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] rounded-lg border border-border/50 hover:bg-muted/50 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {updating ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  检查并更新
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
