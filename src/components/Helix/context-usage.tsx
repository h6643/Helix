"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { captureContextBreakdown } from "@/lib/context-capture";
import { helixApi } from "@/lib/electron-bridge";
import { formatTokens, promptCacheHit } from "@/lib/format";
import { resolveBackendSid } from "@/lib/session-map";
import { useHelixStore } from "@/stores/helix-store";

// ---- Types ----

interface ContextBreakdown {
  id: string;
  label: string;
  tokens: number;
  color: string;
}

/** pi `/context` 口径的面板 —— 后端没有该扩展时浮层显示「正在获取」占位。 */

/**
 * pi 自己的 `/context`（pi-cc-extensions）报告 —— 网关 `session/context_report`
 * 就是去问 pi 要的这份，与 pi CLI 里 `/context` 弹框完全同一份数。
 * 后端返回 7 类：系统提示 / 记忆文件 / 技能 / 工具定义 / 工具结果 / 对话上下文 / 剩余空间。
 * 前端展示 6 类本体（过滤掉 id = "free" 的剩余空间）：余量不是占用，
 * 用窗口右侧自然余下那部分表达就够，单列一行（占窗口 85% 那类）容易误读。
 * 0 项保留："本轮完全没用到某类"与"后端没报该类"需要区分，不能合并成看不见。
 */
interface ContextReportData {
  source: "pi-context" | "unavailable";
  context_max: number;
  context_used: number;
  context_percent: number;
  categories: ContextBreakdown[];
}

// Backend categories use a chars/4 heuristic, while the top-level `used` is the
// provider-exact prompt+completion figure. For a coherent UI, categories are
// normalized to the real usage total; tooltips retain the original heuristic
// estimate. Compression decisions use the real usage figure, not this display
// normalization.

/**
 * pi `/context` 报告的按会话缓存（cid → 最近一次成功拿到的报告）。
 *
 * 为什么缓存：`session.context_report` 要经网关往返问 pi 拿 `/context` 分布，
 * 慢一截（1~3s）。若打开浮层时每次都从零等，浮层会先停在「正在获取」占位
 * 几秒才显示内容。用缓存先按 pi 口径渲染，数值再由新一轮 RPC 刷新；同一
 * 口径内只有数字变化，不再换结构。
 */
const contextReportCache = new Map<string, ContextReportData>();

// ---- ContextUsageBar (segmented horizontal bar — Helix Desktop style) ----

/** pi `/context` 口径的分段条：每段是「该类占整个上下文窗口的比例」，
 *  已用各段铺到哪儿，右边没铺满的部分就是窗口余量（不单列剩余空间段）。 */
function ContextUsageBar({
  used,
  total,
  categories,
}: {
  used: number;
  total: number;
  categories: ContextBreakdown[];
}) {
  const percentage = total > 0 ? Math.min(Math.max((used / total) * 100, 0), 100) : 0;

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
      {/* Segmented bar — 「剩余空间」不是一类占用：条形只画已用的各段。 */}
      <div className="h-2 w-full bg-muted rounded-full overflow-hidden flex">
        {categories.map((cat) => {
          const catPercent = total > 0 ? (cat.tokens / total) * 100 : 0;
          if (catPercent <= 0) return null;
          const width = `${Math.max(catPercent, 0.5)}%`;
          return (
            <div
              key={cat.id}
              className="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full"
              style={{
                width,
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

/**
 * 详表浮层 —— 只有 pi `/context` 一个口径。`report` 未到达（刚打开且无缓存、
 * 或后端扩展不可用）时显示占位，不再回落旧分桶快照（"回复/思考/工具结果"
 * 那套口径与 pi 报告互相换脸的问题已连根删除）。
 */
function ContextUsagePanel({
  cache,
  report,
  style,
  contentRef,
}: {
  cache?: { input: number; cacheRead: number; cacheWrite: number };
  report?: ContextReportData | null;
  style?: React.CSSProperties;
  contentRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const cacheHit = promptCacheHit(cache);
  // 报告已是校验后的 pi 数据（fetch 侧只缓存 source="pi-context" 且分类非空的）。
  // 「剩余空间」（id = "free"）不展示：它不是占用项，而是右端自然余下的窗口。
  // pi 的 6 类本体（系统/记忆/技能/工具定义/工具结果/对话）即使是 0 也保留——
  // "本轮完全没用到某类"与"后端没报该类"需要区分，而不是合并成看不见。
  const piParts = (report?.categories ?? []).filter((c) => c.id !== "free");
  const reportMax = report?.context_max || 0;
  const ready = !!report && piParts.length > 0 && reportMax > 0;

  const windowPercent = (tokens: number) =>
    reportMax > 0 ? ((tokens / reportMax) * 100).toFixed(1) : "0.0";

  // Portal 到 body：卡片的 overflow-x: clip（globals.css .helix-chat-input-card）
  // 会把这个 288px 宽的浮层按卡片左缘切掉——左侧「~16.3K」整段被削平。fixed
  // 定位由触发按钮的 rect 计算（与 reasoning 选择器同款），完全脱离卡片裁剪链。
  return createPortal(
    <div
      ref={contentRef}
      style={style}
      className="w-72 bg-card border border-border/40 rounded-xl shadow-lg p-3 z-50"
    >
      {ready ? (
        <>
          <ContextUsageBar
            used={report!.context_used || 0}
            total={reportMax}
            categories={piParts}
          />
          {/* Legend list */}
          <div className="mt-3 space-y-1.5">
            {piParts.map((item) => (
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
                  <span className="ml-1.5 text-muted-foreground/70">
                    {windowPercent(item.tokens)}%
                  </span>
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="py-6 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
          正在获取上下文报告…
        </div>
      )}
      {cache && (
        <div className="mt-3 pt-2 border-t border-border/40">
          <div className="flex items-center justify-between">
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/70">
              缓存命中
            </span>
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground tabular-nums">
              {cacheHit.reported && cacheHit.percent !== null
                ? `${cacheHit.percent.toFixed(1)}%`
                : "未上报"}
            </span>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ---- Main indicator (button + popover combo) ----

export function ContextUsageIndicator({ sessionId }: { sessionId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [reportData, setReportData] = useState<ContextReportData | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const t = e.target as Node;
      // 浮层已 portal 到 body，不在 panelRef 的 DOM 子树里，必须单独判一次，
      // 否则点浮层内部会被当成"点外面"直接关掉。
      if (panelRef.current?.contains(t) || contentRef.current?.contains(t)) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggle = () => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const panelWidth = 288; // w-72
      // 右缘对齐按钮右缘（等价旧的 right-0），再夹回视口内防左侧削边。
      let left = r.right - panelWidth;
      left = Math.max(8, Math.min(left, window.innerWidth - panelWidth - 8));
      setPanelStyle({
        position: "fixed",
        left,
        bottom: window.innerHeight - r.top + 8, // mb-2
        zIndex: 50,
      });
    }
    setOpen((v) => !v);
  };

  // ── pi `/context` 报告 ────────────────────────────────────────────────
  // 分类口径与 pi CLI 的 `/context` 完全对齐：网关去问 pi 要那份分布
  // （系统提示 / 记忆 / 技能 / 工具定义 / 工具结果 / 对话上下文 + 其他 + 剩余）。
  // 后端没有该扩展 / 拿不到时清空，浮层显示「正在获取」占位（不再回落旧分桶）。
  // 只认本对话映射到的 sid，绝不兜底全局 helixSessionId（跨会话污染）。
  const fetchContextReport = useCallback(async () => {
    try {
      const cid = sessionId ?? useHelixStore.getState().currentSessionId;
      const resolvedSid = await resolveBackendSid(cid);
      if (!resolvedSid) {
        setReportData(null);
        return;
      }
      const result = await helixApi()?.send("session.context_report", {
        session_id: resolvedSid,
      });
      if (result && typeof result === "object") {
        const data = result as ContextReportData;
        if (data.source === "pi-context" && (data.categories?.length ?? 0) > 0) {
          setReportData(data);
          contextReportCache.set(cid ?? "", data);
        } else {
          setReportData(null);
        }
      }
    } catch {
      // 旧后端不认识这个方法（或不支持）—— 保持占位。
      setReportData(null);
    }
  }, [sessionId]);

  // 打开浮层时查询 pi `/context` 报告，并在打开期间每 5s 刷新一次：
  // 后端 agent 可能刚构建完成，报告不会在会话创建瞬间就绪，只查一次容易
  // 永久停留在「正在获取」占位。
  // （自动压缩的决策已交给 pi 的回合内阈值压缩，这里不再做检测/轮询压缩。）
  const currentSessionId = useHelixStore((s) => s.currentSessionId);
  useEffect(() => {
    if (!open) {
      // 关了就撤 state（缓存不撤）：报告下次打开先从缓存水合（见
      // contextReportCache），报告口径几秒内结构不变，数值由新一轮 RPC 刷新。
      setReportData(null);
      return;
    }
    // 先用缓存的上次报告渲染（pi 口径），再触发新一轮 RPC 刷新数值。
    const cidKey = sessionId ?? useHelixStore.getState().currentSessionId ?? "";
    setReportData(contextReportCache.get(cidKey) ?? null);
    fetchContextReport();
    const timer = setInterval(fetchContextReport, 5000);
    return () => clearInterval(timer);
  }, [open, sessionId, fetchContextReport]);

  // Quietly capture the category breakdown once per new live Helix session and
  // persist it into the local snapshot — WITHOUT overriding the displayed ring
  // data (which reflects THIS conversation's persisted usage). Previously the
  // breakdown was only saved when the popover was opened mid-session, so a cold
  // restart always fell back to the "需要正在运行的 Helix 会话" empty state
  // even though the total percentage had been persisted.
  // 防重位只在成功写入后才置：会话创建瞬间 agent 尚未构建，后端返回空分类，
  // 若此时标记"已捕获"，该 sid 永不重试——run 结束后的权威分类就丢了
  // （"重启后有的会话分类消失"根因之一）。留空可在下次 dep 变化（新 run 换
  // sid / 切换会话）时重试；run 结束的兜底捕获在 agent-flow-panel finally 里。
  const quietFetchedSidRef = useRef<string | null>(null);
  // 本对话映射到的后端 sid。用途是**统一本地快照的键**：历史上
  // captureContextBreakdown 在还没有 cid（draft）时会用 sid 作键，而读侧只按
  // cid 查 → 会话换绑/重启后环读到空值就显示 0（"有时候自动清零"）。这里记下
  // sid，读侧两键都查，并把落在 sid 键上的旧快照一次性搬到 cid 键。
  const [backendSid, setBackendSid] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const capture = async () => {
      // 与 fetchContextData 同口径：只认本对话映射到的 sid，绝不兜底全局
      // helixSessionId（跨会话污染）。
      const sid = await resolveBackendSid(currentSessionId);
      if (cancelled) return;
      setBackendSid(sid ?? null);
      if (!sid) return;
      // 键统一：sid 键上的旧快照搬到 cid 键（只在 cid 键还空着时，不覆盖更新的值）
      if (currentSessionId) {
        const st = useHelixStore.getState();
        const legacy = st.contextUsage[sid];
        if (legacy && !st.contextUsage[currentSessionId]) {
          st.setContextUsage(
            currentSessionId,
            legacy.size,
            legacy.used,
            legacy.categories,
            legacy.toolsets,
            false,
            legacy.usageStats,
          );
        }
      }
      const key = `${currentSessionId ?? ""}:${sid}`;
      if (quietFetchedSidRef.current === key) return;
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
  // restart. The snapshot is written by usage_prompt_complete (实测) AND
  // captureContextBreakdown（下一条 prompt 的真实估算，authoritative 覆盖）；
  // 压缩完成回报（/compact 与自动压缩）也直接写回这条快照。
  // (No client-side estimation - real saved values.)
  // 快照键可能是 cid（常规）或 sid（历史遗留 / draft 期写入）——两键都查。
  const localCtx = useHelixStore((s) => {
    const cid = sessionId ?? s.currentSessionId;
    if (!cid) return backendSid ? s.contextUsage[backendSid] : undefined;
    return s.contextUsage[cid] ?? (backendSid ? s.contextUsage[backendSid] : undefined);
  });
  const estimatedTokens = useHelixStore((s) => {
    const cid = sessionId ?? s.currentSessionId;
    return cid ? s.estimatedTokens[cid] : undefined;
  });
  const isChatLoading = useHelixStore((s) => s.isChatLoading);
  // 统一口径：环读数以本地每对话快照为唯一渲染来源（usage_prompt_complete
  // 实测值与 captureContextBreakdown 权威写回——两者同语义，都是
  // 「下一条 prompt 的真实上下文」；压缩完成回报也会直接写回）。弹窗 RPC
  // 不直接喂环：它通过 captureContextBreakdown 落盘后再反映到环，避免
  // 开/关弹窗读数乱跳。
  //
  // 如果请求正在进行中（isChatLoading），且有估算值，显示估算值（带 ~ 前缀）。
  // 请求完成后，显示真实的 context_used 值。
  const total = localCtx?.size || 0;
  const estimated =
    isChatLoading && estimatedTokens !== undefined && estimatedTokens > 0
      ? estimatedTokens
      : undefined;
  const used = estimated ?? (localCtx?.used || 0);

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={toggle}
        className="size-8 rounded-xl flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors duration-150"
        data-tip={`上下文使用情况${estimated ? `（${formatTokens(estimated)} 估算）` : ""}`}
      >
        <ContextUsageRing used={used} total={total} />
      </button>
      {open && (
        <ContextUsagePanel
          // 缓存命中只读本地快照，与环同一个口径（见上面「统一口径」注释）：
          // 弹窗的 RPC 不直接喂显示，否则开/关弹窗会让这个数字自己跳。
          cache={localCtx?.usageStats}
          report={reportData}
          style={panelStyle}
          contentRef={contentRef}
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
    <div className="relative size-7 flex items-center justify-center shrink-0">
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
