"use client";

import { Cable, RefreshCw, X } from "lucide-react";
import React, { useEffect, useState, useSyncExternalStore } from "react";
import {
  STALE_MS,
  checkinToday,
  getSnapshot,
  query,
  subscribe,
} from "./channels-center-state";

/**
 * 渠道中心面板 —— pi-connect 扩展（WorkBuddy · Trae · Qoder）的状态与签到。
 *
 * 入口在侧边栏「设置」按钮上方，以叠加面板呈现（不是设置页的一个子页）。
 * 数据来自一次性 pi RPC 进程执行的 `/connect status|checkin`
 * （见 src-tauri/src/pi_connect.rs）；扩展把结果作为 notify 文本回传，
 * 这里按「渠道块」切成卡片渲染。
 *
 * 结果、在途查询与今日签到判定都在 ./channels-center-state：应用启动时
 * helix-layout 已预热过一次，所以打开面板通常直接有数据；结果过期时才
 * 后台静默刷新（此间旧数据照常显示）。
 */

/** 一块 = 首行标题 + 其余明细。 */
function splitBlock(block: string): { title: string; detail: string } {
  const nl = block.indexOf("\n");
  if (nl < 0) return { title: block, detail: "" };
  return { title: block.slice(0, nl).trim(), detail: block.slice(nl + 1).trimEnd() };
}

const TONE: Record<string, string> = {
  info: "text-foreground",
  warning: "text-amber-500",
  error: "text-red-500",
};

export function ChannelsCenterPanel({ onClose }: { onClose: () => void }) {
  const st = useSyncExternalStore(subscribe, getSnapshot);
  const [confirming, setConfirming] = useState(false);
  const today = checkinToday(st);

  // 挂载策略：无数据（或上次失败）→ 常规查询；有数据但已过期 → 后台静默刷新
  // （旧数据照常展示）；新鲜或已有在途查询 → 什么都不做，直接接上共享状态。
  useEffect(() => {
    const s = getSnapshot();
    if (s.busy) return;
    if (s.blocks === null || s.error) void query("status");
    else if (s.updatedAt && Date.now() - s.updatedAt.getTime() > STALE_MS)
      void query("status", { silent: true });
  }, []);

  const textSm =
    "text-[calc(var(--helix-transcript-size)*0.8571)]";
  const btn =
    "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 " +
    textSm +
    " transition-colors hover:bg-accent disabled:opacity-50 disabled:pointer-events-none";
  const box = "rounded-xl border border-border/50 bg-card/50";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-2xl mx-4 bg-card border border-border/60 rounded-2xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60 shrink-0">
          <div className="flex items-center gap-2">
            <Cable className="size-4 text-primary" />
            <h2 className="text-[calc(var(--helix-transcript-size)*1.2857)] font-semibold text-foreground">
              渠道中心
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <div className={`${box} flex items-start gap-2 px-4 py-3`}>
            <Cable className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
            <div className={`${textSm} leading-relaxed text-muted-foreground/80`}>
              pi-connect 扩展的渠道状态与签到（WorkBuddy · Trae · Qoder）。
              命令在一次性 pi 进程中执行，不占用当前会话；应用启动时已在
              后台查询，打开面板优先显示上次结果，过期后自动在后台刷新，
              也可随时手动「刷新」。
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              className={btn}
              disabled={!!st.busy || confirming}
              onClick={() => void query("status")}
            >
              <RefreshCw
                className={`size-3.5 ${st.busy === "status" ? "animate-spin" : ""}`}
              />
              刷新
            </button>
            {confirming ? (
              <div className="flex items-center gap-2">
                <span className={textSm}>为全部渠道领取今日签到？</span>
                <button
                  className={`${btn} border-primary/60 text-primary`}
                  disabled={!!st.busy}
                  onClick={() => {
                    setConfirming(false);
                    void query("checkin");
                  }}
                >
                  确认领取
                </button>
                <button className={btn} onClick={() => setConfirming(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button
                className={btn}
                disabled={
                  !!st.busy ||
                  st.blocks === null ||
                  !!st.error ||
                  today !== "ready"
                }
                onClick={() => setConfirming(true)}
                title={
                  today === "done"
                    ? "今日已领取，无需重复领取"
                    : today === "none"
                      ? "各渠道今日都没有可领取的签到"
                      : undefined
                }
              >
                {st.busy === "checkin"
                  ? "签到中…"
                  : today === "done"
                    ? "今日已领取"
                    : today === "none"
                      ? "今日无可签"
                      : "领取今日签到"}
              </button>
            )}
            <span className={`ml-auto ${textSm} text-muted-foreground/60`}>
              {st.updatedAt
                ? `更新于 ${st.updatedAt.toLocaleTimeString()} · ${
                    st.blocks?.length ?? 0
                  } 个渠道`
                : ""}
            </span>
          </div>

          {st.checkinResults && (
            <div className={`${box} overflow-hidden`}>
              <div
                className={`px-4 py-2 ${textSm} font-medium border-b border-border/30`}
              >
                签到结果
              </div>
              <div className="divide-y divide-border/20">
                {st.checkinResults.map((m, i) => (
                  <div
                    key={i}
                    className={`px-4 py-1.5 ${textSm} ${
                      TONE[m.type] ?? "text-foreground"
                    }`}
                  >
                    {m.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {st.error && (
            <div
              className={`rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 ${textSm} whitespace-pre-line text-red-500`}
            >
              {st.error}
            </div>
          )}

          {st.busy === "status" && st.blocks === null && !st.error ? (
            <div className={`px-1 py-8 text-center ${textSm} text-muted-foreground/70`}>
              读取中…
            </div>
          ) : (
            st.blocks && (
              <div
                className={`space-y-2.5 ${st.busy === "status" ? "opacity-60" : ""}`}
              >
                {st.blocks.map((b, i) => {
                  const { title, detail } = splitBlock(b);
                  return (
                    <div key={i} className={`${box} px-4 py-3`}>
                      <div className="text-[length:var(--helix-transcript-size)] font-medium">
                        {title}
                      </div>
                      {detail && (
                        <div
                          className={`mt-1 whitespace-pre-line ${textSm} leading-relaxed text-muted-foreground/80`}
                        >
                          {detail}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
