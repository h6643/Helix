"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { helixApi } from "@/lib/electron-bridge";
import { captureContextBreakdown } from "@/lib/context-capture";
import { formatTokens } from "@/lib/format";
import { debug } from "@/lib/logger";
import { resolveBackendSid } from "@/lib/session-map";
import { mapBackendMessages } from "@/lib/session-resync";
import {
  resyncCurrentSessionFromBackend,
  isCurrentSessionRenderBroken,
} from "@/lib/session-resync";
import { useHelixStore } from "@/stores/helix-store";

// ---- Types ----

interface ContextBreakdown {
  id: string;
  label: string;
  tokens: number;
  color: string;
}

function normalizeCategories(
  used: number,
  categories: ContextBreakdown[],
): Array<ContextBreakdown & { estimatedTokens: number }> {
  const estimatedTotal = categories.reduce(
    (sum, category) => sum + category.tokens,
    0,
  );
  if (!used || estimatedTotal <= 0) return [];
  return categories
    .filter((category) => category.tokens > 0)
    .map((category) => ({
      ...category,
      estimatedTokens: category.tokens,
      tokens: Math.max(
        1,
        Math.round((category.tokens / estimatedTotal) * used),
      ),
    }));
}

interface ContextUsageData {
  context_max: number;
  context_used: number;
  context_percent: number;
  estimated_total?: number;
  categories: ContextBreakdown[];
  toolsets?: Array<{
    toolset: string;
    tool_count: number;
    schema_tokens: number;
  }>;
}

// Backend categories use a chars/4 heuristic, while the top-level `used` is the
// provider-exact prompt+completion figure. For a coherent UI, categories are
// normalized to the real usage total; tooltips retain the original heuristic
// estimate. Compression decisions use the real usage figure, not this display
// normalization.

// ---- ContextUsageBar (segmented horizontal bar — Helix Desktop style) ----

function ContextUsageBar({
  used,
  total,
  categories,
}: {
  used: number;
  total: number;
  categories: ContextBreakdown[];
}) {
  const percentage = Math.min(Math.max((used / total) * 100, 0), 100);
  // Segment widths are proportional to each category's share, normalized to the
  // used fill — so the bar always reads as used/total regardless of whether the
  // category tokens come from the backend or the local session stats.
  const catTotal = categories.reduce((s, c) => s + c.tokens, 0) || 1;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
          ~{formatTokens(used)}
        </span>
        <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
          / {formatTokens(total)} &middot; {percentage.toFixed(1)}%
        </span>
      </div>
      {/* Segmented bar */}
      <div className="h-2 w-full bg-muted rounded-full overflow-hidden flex">
        {categories.map((cat) => {
          const catPercent =
            used > 0 ? (cat.tokens / catTotal) * percentage : 0;
          if (catPercent <= 0) return null;
          return (
            <div
              key={cat.id}
              className="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full"
              style={{
                width: `${Math.max(catPercent, 0.5)}%`,
                backgroundColor: cat.color,
              }}
              data-tip={`${cat.label}: ~${formatTokens(cat.tokens)}`}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---- Panel (detailed breakdown popover) ----

function ContextUsagePanel({
  used,
  total,
  categories,
  toolsets,
  onClose,
}: {
  used: number;
  total: number;
  categories: ContextBreakdown[];
  toolsets?: Array<{
    toolset: string;
    tool_count: number;
    schema_tokens: number;
  }>;
  onClose: () => void;
}) {
  const [showToolsets, setShowToolsets] = useState(false);
  // Raw per-toolset schema estimates; they describe schema size, not the exact
  // provider token cost, so they remain unnormalized.
  const toolsetList = toolsets ?? [];
  const normalizedCategories = normalizeCategories(used, categories);

  return (
    <div className="absolute bottom-full right-0 mb-2 w-72 bg-card border border-border/60 rounded-xl shadow-lg p-3 z-50">
      <ContextUsageBar
        used={used}
        total={total}
        categories={normalizedCategories}
      />
      {/* Legend list */}
      <div className="mt-3 space-y-1.5">
        {normalizedCategories.length === 0 ? (
          <div className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
            暂无上下文分类数据
          </div>
        ) : (
          normalizedCategories.map((item) => {
            return (
              <div key={item.id} className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-sm"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground">
                    {item.label}
                  </span>
                </div>
                <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground tabular-nums">
                  ~{formatTokens(item.tokens)}
                </span>
              </div>
            );
          })
        )}
      </div>
      {toolsetList.length > 0 && (
        <div className="mt-3 pt-2 border-t border-border/40">
          <button
            type="button"
            onClick={() => setShowToolsets((v) => !v)}
            className="w-full flex items-center justify-between text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/70 hover:text-foreground transition-colors cursor-pointer"
          >
            <span>工具集明细 ({toolsetList.length})</span>
            <span className="text-foreground/50">
              {showToolsets ? "收起" : "展开"}
            </span>
          </button>
          {showToolsets && (
            <div className="mt-2 space-y-1">
              {toolsetList.map((t) => (
                <div
                  key={t.toolset}
                  className="flex items-center justify-between gap-2 pl-2"
                >
                  <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground truncate">
                    {t.toolset}
                  </span>
                  <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground tabular-nums shrink-0">
                    {t.tool_count} 工具 · ~{formatTokens(t.schema_tokens)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Main indicator (button + popover combo) ----

export function ContextUsageIndicator() {
  const [open, setOpen] = useState(false);
  const [backendData, setBackendData] = useState<ContextUsageData | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Auto-compaction: trigger when context usage exceeds 80% and setting is enabled
  const autoCompactCooldownRef = useRef(false);

  // Fetch context breakdown from backend via RPC
  const fetchContextData = useCallback(async () => {
    try {
      const currentSessionId = useHelixStore.getState().currentSessionId;
      // Only the backend sid mapped to THIS conversation — never fall back to
      // the global helixSessionId: that is whichever conversation ran LAST,
      // and querying it would write the GLOBAL session's usage/categories into
      // this conversation's snapshot (contextUsage), making the ring track
      // another conversation. Unmapped → render the persisted local snapshot.
      const sessionId = await resolveBackendSid(currentSessionId);
      if (!sessionId) {
        setBackendData(null);
        return;
      }
      const result = await helixApi()?.send("session.context_breakdown", {
        session_id: sessionId,
      });
      if (result && typeof result === "object") {
        const data = result as ContextUsageData;
        setBackendData(data);
        // 本地快照写回统一收敛到 captureContextBreakdown（context-capture.ts）：
        // - 仅当后端回报非零用量或分类非空才写，避免空会话把本地真实值覆盖成 0；
        // - size/used 用本地已有值兜底（used 取 max），避免估算偏低时把环缩水；
        // - 分类数据只要有就持久化（唯一来源，不写重启后必显示"暂无上下文分类数据"）。
        await captureContextBreakdown(currentSessionId, sessionId);

        // Auto-compaction check (Helix Desktop style)
        if (data.context_percent >= 80 && !autoCompactCooldownRef.current) {
          const {
            autoCompactContext,
            compressionBusy,
            showToast,
            streamingDrafts,
            isChatLoading,
          } = useHelixStore.getState();
          // Agent run-in-flight guard: the backend rejects session.compress with
          // "session busy" while a turn is running (methods_session.py). Firing
          // anyway burned the 60s cooldown on a doomed RPC and the empty catch
          // made the failure invisible — "自动压缩没动画/没效果"根因。静默跳过
          // （不消耗冷却）让 run 结束后的下一轮轮询真正触发压缩。
          const runInFlight =
            isChatLoading ||
            Object.values(streamingDrafts || {}).some((d) => d?.isAgentRunning);
          if (autoCompactContext && !compressionBusy && !runInFlight) {
            autoCompactCooldownRef.current = true;
            // Cooldown: don't trigger again for 60 seconds
            setTimeout(() => {
              autoCompactCooldownRef.current = false;
            }, 60_000);
            // 与手动 /compact 共用 busy 标记：避免后端压缩锁冲突
            useHelixStore.getState().setCompressionBusy(true);
            try {
              const result = await helixApi()?.send("session.compress", {
                session_id: sessionId,
              });
              if (result && typeof result === "object") {
                const r = result as any;
                if (r.status === "compressed" && Array.isArray(r.messages)) {
                  let anchorMessageId: string | undefined;
                  // Update frontend messages with compressed messages
                  const currentSessionId =
                    useHelixStore.getState().currentSessionId;
                  if (currentSessionId) {
                    const msgs = mapBackendMessages(
                      r.messages,
                      currentSessionId,
                    );
                    // 仅替换「当前会话」：chatMessages 是跨会话全局数组，整体覆盖会清掉
                    // 其他会话历史（"压缩后消息全空"）。与手动 /compact 的修复一致。
                    useHelixStore.setState((state) => ({
                      chatMessages: [
                        ...state.chatMessages.filter(
                          (m) =>
                            m.sessionId && m.sessionId !== currentSessionId,
                        ),
                        ...msgs,
                      ],
                    }));
                    anchorMessageId =
                      msgs.length > 0 ? msgs[msgs.length - 1].id : undefined;
                  }
                  // 自动压缩提示卡片：transcript 顶部可关闭，8s 自动消失
                  useHelixStore.getState().setCompressionNotice({
                    ts: Date.now(),
                    sessionId: currentSessionId || "__draft__",
                    source: "auto",
                    anchorMessageId,
                    removed: Number(r.removed) || undefined,
                    beforeTokens: Number(r.before_tokens) || undefined,
                    afterTokens: Number(r.after_tokens) || undefined,
                    messageCount: Number(r.after_messages) || undefined,
                  });
                  // 自动自愈：若压缩回包异常导致当前会话仍为空，直接异步从后端拉
                  // 权威历史覆盖，无需用户手动 /resync（"压缩后消息全空"兜底）。
                  if (isCurrentSessionRenderBroken(currentSessionId)) {
                    await resyncCurrentSessionFromBackend({
                      sessionId: currentSessionId || "",
                      showToast: true,
                      toastMessage: "压缩后消息异常，已自动从后端恢复",
                    });
                  }
                } else if (r.status === "aborted" || r.lock_held) {
                  // 后端没执行压缩（中止/锁被占）：不显示"已压缩"提示，说明原因
                  showToast({
                    type: "warning",
                    title: r.lock_held ? "压缩进行中" : "自动压缩已中止",
                    description:
                      r.message ||
                      (r.status === "aborted"
                        ? "后端中止了本次压缩"
                        : "另一个压缩任务正在运行"),
                  });
                }
              }
              debug(
                "[ContextUsage] auto-compaction triggered at",
                data.context_percent.toFixed(1),
                "%",
              );
            } catch (e) {
              // 自动压缩失败（超时/后端拒绝）：必须有可见反馈，否则表现为
              // "有动画但压缩没成功"——busy 一闪即逝，用户无从得知原因。
              showToast({
                type: "error",
                title: "自动压缩失败",
                description: String((e as Error)?.message ?? e),
              });
            } finally {
              useHelixStore.getState().setCompressionBusy(false);
            }
          }
        }
      }
    } catch {
      // Backend may not support this — degrade gracefully
    }
  }, []);

  // 打开弹层时查询，并在打开期间每 5s 刷新一次：后端 agent 可能刚构建完成，
  // 分类数据不会在会话创建瞬间就绪，只查一次容易永久停留在"暂无上下文分类数据"。
  useEffect(() => {
    if (!open) return;
    fetchContextData();
    const timer = setInterval(fetchContextData, 5000);
    return () => clearInterval(timer);
  }, [open, fetchContextData]);

  // Quietly capture the category breakdown once per new live Helix session and
  // persist it into the local snapshot — WITHOUT overriding the displayed ring
  // data (which reflects THIS conversation's persisted usage). Previously the
  // breakdown was only saved when the popover was opened mid-session, so a cold
  // restart always fell back to the "需要正在运行的 Helix 会话" empty state
  // even though the total percentage had been persisted.
  const currentSessionId = useHelixStore((s) => s.currentSessionId);
  // 防重位只在成功写入后才置：会话创建瞬间 agent 尚未构建，后端返回空分类，
  // 若此时标记"已捕获"，该 sid 永不重试——run 结束后的权威分类就丢了
  // （"重启后有的会话分类消失"根因之一）。留空可在下次 dep 变化（新 run 换
  // sid / 切换会话）时重试；run 结束的兜底捕获在 agent-flow-panel finally 里。
  const quietFetchedSidRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const capture = async () => {
      // 与 fetchContextData 同口径：只认本对话映射到的 sid，绝不兜底全局
      // helixSessionId（跨会话污染）。
      const sid = await resolveBackendSid(currentSessionId);
      const key = `${currentSessionId ?? ""}:${sid ?? ""}`;
      if (!sid || quietFetchedSidRef.current === key || cancelled) return;
      const written = await captureContextBreakdown(currentSessionId, sid);
      if (written) quietFetchedSidRef.current = key;
    };
    capture();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId]);

  // Prefer live backend RPC data. When there is no live Helix session
  // (app/gateway restarted, or the conversation was never run this session) fall
  // fallback to the locally persisted per-conversation store
  // (contextUsage[currentSessionId]) so the ring does NOT reset to 0 after a
  // restart. The snapshot is written in agent-flow-panel.tsx on
  // `usage_prompt_complete`. (No client-side estimation - real saved values.)
  const localCtx = useHelixStore((s) =>
    s.currentSessionId ? s.contextUsage[s.currentSessionId] : undefined,
  );
  const estimatedTokens = useHelixStore((s) =>
    s.currentSessionId ? s.estimatedTokens[s.currentSessionId] : undefined,
  );
  const isChatLoading = useHelixStore((s) => s.isChatLoading);
  // 统一口径：环读数以本地每对话快照（usage_prompt_complete 落盘）为唯一来源，
  // 不再与弹窗 RPC 的 anchored 读数做 max() 合并——两者语义不同
  // （last_prompt_tokens vs prompt+completion+增量），合并导致「开弹窗跳升、
  // 关弹窗回落」的乱跳。后端 RPC 只用来取分类明细与触发自动压缩。
  //
  // 如果请求正在进行中（isChatLoading），且有估算值，显示估算值（带 ~ 前缀）。
  // 请求完成后，显示真实的 context_used 值。
  const total = localCtx?.size || 0;
  const estimated =
    isChatLoading && estimatedTokens !== undefined && estimatedTokens > 0
      ? estimatedTokens
      : undefined;
  const used = estimated ?? (localCtx?.used || 0);

  const categories: ContextBreakdown[] = backendData?.categories?.length
    ? backendData.categories.map((c) => ({ ...c }))
    : localCtx?.categories?.length
      ? localCtx.categories.map((c) => ({ ...c }))
      : [];

  const toolsets: Array<{
    toolset: string;
    tool_count: number;
    schema_tokens: number;
  }> = backendData?.toolsets?.length
    ? backendData.toolsets.map((t) => ({ ...t }))
    : localCtx?.toolsets?.length
      ? localCtx.toolsets.map((t) => ({ ...t }))
      : [];

  // When there's no backend data, the ring renders empty (progress arc at 0).

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="size-10 rounded-lg flex items-center justify-center text-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
        data-tip={`上下文使用情况${estimated ? `（${formatTokens(estimated)} 估算）` : ""}`}
      >
        <ContextUsageRing used={used} total={total} />
      </button>
      {open && (
        <ContextUsagePanel
          used={used}
          total={total}
          categories={categories}
          toolsets={toolsets}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// ---- Ring component (small circular progress indicator) ----

function ContextUsageRing({ used, total }: { used: number; total: number }) {
  const safeTotal = total > 0 ? total : 1;
  const percentage = Math.min(Math.max((used / safeTotal) * 100, 0), 100);
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;
  const colorClass =
    percentage > 90
      ? "text-red-500"
      : percentage > 70
        ? "text-amber-500"
        : "text-primary";

  return (
    <div className="relative size-7 flex items-center justify-center">
      <svg className="size-6 -rotate-90" viewBox="0 0 20 20">
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.15"
          strokeWidth="3"
        />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          className={`${colorClass} transition-all duration-300`}
        />
      </svg>
    </div>
  );
}
