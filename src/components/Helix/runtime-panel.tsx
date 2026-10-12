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
import { useGatewayStore } from "@/stores/gateway-store";
import { useHelixStore } from "@/stores/helix-store";

/** app.rs 的 get_status 返回值 —— 字段就这四个，不再假装 Electron 那套。 */
interface RuntimeStatus {
  version: string;
  platform: string;
  arch: string;
  pid: number;
}

export function RuntimePanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // Gateway 连接态直接读 store：那是 helix-layout 的网关事件监听维持的唯一
  // 事实源（gatewayState === "open"），面板自己再去 poll 一遍只会多一个会说
  // 假话的地方。
  const gatewayConnected = useGatewayStore((s) => s.helixConnected);

  const refresh = useCallback(async () => {
    if (!isElectron() || !window.electron?.diagnostics) return;
    try {
      const s = await window.electron.diagnostics.getStatus();
      setStatus(s);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // get_status 返回的是进程级不变量（版本/平台/架构/PID），不需要轮询；
    // 会变的 Gateway 状态已经走 store 响应式拿到了。曾经这里的 2s setInterval
    // 是为了刷 uptime，那个字段已随 Electron 时代一起去掉。手动「刷新状态」
    // 按钮仍然调 refresh。
    refresh();
  }, [refresh]);

  const [updating, setUpdating] = useState(false);

  const doUpdate = async () => {
    if (!isElectron()) return;
    setUpdating(true);
    try {
      // 检查 pi agent + npm 插件的更新（npm registry）——与帮助菜单
      // “检查更新”的 pi 分支同一后端命令；Helix 应用自身的更新在帮助
      // 菜单里走 GitHub Release（tauri-plugin-updater），这里不涉及。
      const res = await window.electron?.helix?.piCheckUpdates?.();
      if (!res) {
        return;
      }
      const pi = res.pi || {};
      const outdated = (res.packages || []).filter((p) => p.hasUpdate);
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
          .map((p) => `${p.name} v${p.installed} → v${p.latest}`)
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
      }
    } catch {
      // 手动检查失败静默处理：不弹 error toast。
    } finally {
      setUpdating(false);
    }
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
              {/* Status cards —— 只列后端真给得出的东西 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border/50 bg-card/50 p-4">
                  <div className="flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground mb-1">
                    <Server className="size-3.5" /> Gateway 状态
                  </div>
                  <div className="flex items-center gap-2">
                    {gatewayConnected ? (
                      <CheckCircle2 className="size-4 text-emerald-500" />
                    ) : (
                      <XCircle className="size-4 text-muted-foreground" />
                    )}
                    <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
                      {gatewayConnected ? "运行中" : "未连接"}
                    </span>
                  </div>
                </div>

                <div className="rounded-xl border border-border/50 bg-card/50 p-4">
                  <div className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground mb-1">
                    运行时
                  </div>
                  <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
                    Helix v{status?.version || "—"}
                  </p>
                  <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/70 mt-1 capitalize">
                    {status?.platform || "—"} · {status?.arch || "—"} · pid{" "}
                    {status?.pid ?? "—"}
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
