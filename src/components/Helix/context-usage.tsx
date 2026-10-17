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
  /** 后端"整块占用"兜底项（会话文件还没落盘时给不出按内容的拆分） */
  aggregate?: boolean;
}

/** 兜底的"整块占用"：id/label 都对得上，或后端显式标了 aggregate。 */
function isAggregateCategory(c: ContextBreakdown): boolean {
  return (
    c.aggregate === true ||
    (c.id === "conversation" &&
      (c.label === "会话上下文" || c.label === "整体上下文占用"))
  );
}

/**
 * 选哪一套分类来渲染。
 *
 * 之前这里是「RPC categories 非空就顶替本地快照」，于是三套形态互相顶：
 * 分桶快照（上次 run 存的）→ 首轮里 RPC 的整块兜底 → 会话文件落盘后的分桶，
 * 每一步看着都像"分类自己变了"。现在按信息量排序：**分桶 > 整块兜底**，
 * 同级里实时数据优先；只有当两边都拿不出分桶时才显示整块兜底。
 */
function pickCategories(
  backend: ContextBreakdown[] | undefined,
  local: ContextBreakdown[] | undefined,
): ContextBreakdown[] {
  const live = backend?.length ? backend : undefined;
  const snap = local?.length ? local : undefined;
  const liveBuckets = live?.some((c) => !isAggregateCategory(c)) ? live : undefined;
  const snapBuckets = snap?.some((c) => !isAggregateCategory(c)) ? snap : undefined;
  // Prefer live buckets, then snapshot buckets, then any live data, then any
  // snapshot data. Within each tier, bucket data beats a single aggregate lump
  // so the panel never swaps between 分桶 and 整块 fallback in the same window.
  return liveBuckets ?? snapBuckets ?? live ?? snap ?? [];
}

function normalizeCategories(
  used: number,
  categories: ContextBreakdown[],
): Array<ContextBreakdown & { estimatedTokens: number }> {
  if (!used || categories.length === 0) return [];
  const visible = categories.filter((c) => c.tokens > 0);
  const estimatedTotal = visible.reduce((s, c) => s + c.tokens, 0);
  // The jsonl chars/4 estimate only counts message text blocks, not the
  // system prompt / tool schemas that dominate the real `used` figure. When
  // the estimate collapses to a tiny number (e.g. "回复 ~22" against a
  // 15.2K ring), the display looks broken. Floor each bucket's share of
  // `used` at its proportional estimate: display = max(estimate, used × share),
  // which keeps the bucket sum close to `used` while preserving the relative
  // split the estimate actually measured.
  return visible.map((category) => {
    const share = estimatedTotal > 0 ? category.tokens / estimatedTotal : 0;
    const proportional = Math.round(used * share);
    const displayTokens = Math.max(category.tokens, proportional);
    return { ...category, estimatedTokens: category.tokens, tokens: displayTokens };
  });
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

/**
 * pi 自己的 `/context`（pi-cc-extensions）报告 —— 网关 `session/context_report`
 * 就是去问 pi 要的这份，与 pi CLI 里 `/context` 弹框完全同一份数。
 * 分类固定是：系统提示 / 记忆文件 / 技能 / 工具定义 / 工具结果 / 对话上下文，
 * 再加「其他」与「剩余空间」（id = "free"，是窗口余量，不计入已用）。
 */
interface ContextReportData {
  source: "pi-context" | "unavailable";
  context_max: number;
  context_used: number;
  context_percent: number;
  free_space?: number;
  categories: ContextBreakdown[];
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
  windowBasis = false,
}: {
  used: number;
  total: number;
  categories: ContextBreakdown[];
  /**
   * true = pi `/context` 口径：段宽按「每个 part 占整个上下文窗口的比例」算，
   * 剩余空间段自然把条形铺满整窗（part 之和 + 剩余 = 窗口）。
   * false（默认）= 旧口径：段宽按 part 之间的相对占比摊到已用填充里。
   */
  windowBasis?: boolean;
}) {
  const percentage = Math.min(Math.max((used / total) * 100, 0), 100);
  // Segment widths are proportional to each category's share, normalized to the
  // used fill — so the bar always reads as used/total regardless of whether the
  // category tokens come from the backend or the local session stats.
  const catTotal = categories.reduce((s, c) => s + c.tokens, 0) || 1;
  const basis = windowBasis && total > 0 ? total : catTotal;

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
          const catPercent = windowBasis
            ? // 窗口口径：每段直接是「占整窗的比例」，剩余那段刚好补满右缘。
              (cat.tokens / basis) * 100
            : // 旧口径：段与段之间按相对占比，整体只铺满「已用」那一截。
              (cat.tokens / catTotal) * percentage;
          if (catPercent <= 0) return null;
          // 剩余空间段吃掉右缘余量：各段百分比四舍五入后右缘常留一条空白槽，
          // 看着像"窗口没用满"。按 id 认，不按位置——位置会随空分类移动。
          const width =
            cat.id === "free"
              ? `${Math.max(100 - usedShareBefore(categories, cat.id, basis), 0)}%`
              : `${Math.max(catPercent, 0.5)}%`;
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

/** `beforeId` 之前各段累计占的百分比（窗口口径），供剩余空间段补齐右缘用。 */
function usedShareBefore(
  categories: ContextBreakdown[],
  beforeId: string,
  basis: number,
): number {
  let sum = 0;
  for (const c of categories) {
    if (c.id === beforeId) break;
    sum += (c.tokens / basis) * 100;
  }
  return sum;
}

// ---- Panel (detailed breakdown popover) ----

function ContextUsagePanel({
  used,
  total,
  categories,
  toolsets,
  cache,
  report,
  style,
  contentRef,
}: {
  used: number;
  total: number;
  categories: ContextBreakdown[];
  toolsets?: Array<{
    toolset: string;
    tool_count: number;
    schema_tokens: number;
  }>;
  cache?: { input: number; cacheRead: number; cacheWrite: number };
  /** pi `/context` 的报告（`session.context_report`）。有它就走 pi 的口径。 */
  report?: ContextReportData | null;
  style?: React.CSSProperties;
  contentRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [showToolsets, setShowToolsets] = useState(false);
  const cacheHit = promptCacheHit(cache);
  // Raw per-toolset schema estimates; they describe schema size, not the exact
  // provider token cost, so they remain unnormalized.
  const toolsetList = toolsets ?? [];
  // pi `/context` 口径：part 之和 + 剩余空间 = 窗口，段宽按整窗比例算，
  // 每行再标「占窗口百分比」——和 pi CLI 里 `/context` 弹框同一式样。
  const reportMax =
    report?.source === "pi-context" ? report.context_max || 0 : 0;
  const piParts =
    report?.source === "pi-context"
      ? (report.categories ?? []).filter((c) => c.tokens > 0)
      : [];
  const piStyle = piParts.length > 0 && reportMax > 0;
  const normalizedCategories = piStyle
    ? piParts
    : normalizeCategories(used, categories);
  // pi 口径下整块浮层都用报告自己的 used/total：part 之和 + 剩余 = 窗口是 pi
  // 那边算好的，换成环的读数（本地快照，可能是压缩前高位）会让条形顶出 100%。
  const shownTotal = piStyle ? reportMax : total;
  const shownUsed = piStyle ? report?.context_used || 0 : used;
  // 后端在会话文件落盘前只能给出"整块占用"这一项 —— 明确说明，别让它看起来
  // 像某个内容分类（"对话中分类变成会话上下文"的观感来源）。
  const aggregateOnly =
    !piStyle &&
    normalizedCategories.length > 0 &&
    normalizedCategories.every(isAggregateCategory);

  const windowPercent = (tokens: number) =>
    shownTotal > 0 ? ((tokens / shownTotal) * 100).toFixed(1) : "0.0";

  // Portal 到 body：卡片的 overflow-x: clip（globals.css .helix-chat-input-card）
  // 会把这个 288px 宽的浮层按卡片左缘切掉——左侧「~16.3K」整段被削平。fixed
  // 定位由触发按钮的 rect 计算（与 reasoning 选择器同款），完全脱离卡片裁剪链。
  return createPortal(
    <div
      ref={contentRef}
      style={style}
      className="w-72 bg-card border border-border/40 rounded-xl shadow-lg p-3 z-50"
    >
      <ContextUsageBar
        used={shownUsed}
        total={shownTotal}
        categories={normalizedCategories}
        windowBasis={piStyle}
      />
      {/* Legend list */}
      <div className="mt-3 space-y-1.5">
        {normalizedCategories.length === 0 ? (
          <div className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
            暂无上下文分类数据
          </div>
        ) : (
          normalizedCategories.map((item) => {
            const isFree = item.id === "free";
            return (
              <div key={item.id} className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-sm"
                    style={{ backgroundColor: item.color }}
                  />
                  <span
                    className={
                      isFree
                        ? "text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground"
                        : "text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground"
                    }
                  >
                    {item.label}
                  </span>
                </div>
                <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground tabular-nums">
                  ~{formatTokens(item.tokens)}
                  {piStyle && (
                    <span className="ml-1.5 text-muted-foreground/70">
                      {windowPercent(item.tokens)}%
                    </span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
      {aggregateOnly && (
        <div className="mt-2 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/80 leading-snug">
          整体占用：本轮会话记录尚未落盘，暂时拿不到按内容拆分的分类
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
    </div>,
    document.body,
  );
}

// ---- Main indicator (button + popover combo) ----

export function ContextUsageIndicator({ sessionId }: { sessionId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [backendData, setBackendData] = useState<ContextUsageData | null>(null);
  const [reportData, setReportData] = useState<ContextReportData | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const t = e.target as Node;
      // 浮层已 portal 到 body，不在 panelRef 的 DOM 子树里，必须单独判一次，
      // 否则点浮层内部（展开工具集明细等）会被当成"点外面"直接关掉。
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

  // ── Context breakdown fetch ─────────────────────────────────────────
  // Fetch context breakdown from backend via RPC
  const fetchContextData = useCallback(async () => {
    try {
      const currentSessionId = sessionId ?? useHelixStore.getState().currentSessionId;
      // Only the backend sid mapped to THIS conversation — never fall back to
      // the global helixSessionId: that is whichever conversation ran LAST,
      // and querying it would write the GLOBAL session's usage/categories into
      // this conversation's snapshot (contextUsage), making the ring track
      // another conversation. Unmapped → render the persisted local snapshot.
      const resolvedSid = await resolveBackendSid(currentSessionId);
      if (!resolvedSid) {
        setBackendData(null);
        return;
      }
      const result = await helixApi()?.send("session.context_breakdown", {
        session_id: resolvedSid,
      });
      if (result && typeof result === "object") {
        const data = result as ContextUsageData;
        setBackendData(data);
        // 本地快照写回统一收敛到 captureContextBreakdown（context-capture.ts）：
        // - 仅当后端回报非零用量或分类非空才写，避免空会话把本地真实值覆盖成 0；
        // - size/used 用本地已有值兜底（used 取 max），避免估算偏低时把环缩水；
        // - 分类数据只要有就持久化（唯一来源，不写重启后必显示"暂无上下文分类数据"）。
        await captureContextBreakdown(currentSessionId, sessionId);

        // 自动压缩决策已交给 pi：pi 在回合内做阈值压缩（压缩完
        // agent.continue() 自动续跑任务，与 CLI 语义一致）。开关走
        // set_auto_compaction（前端 autoCompactContext，helix-layout.tsx 里
        // 有同步 effect）。旧的 80% 前端闸门在这里主动 session.compress，
        // 而 pi 的手动 compact 首行就 abort 当前回合且永不续跑
        //（“压缩后任务暂停”的根因），已停用。手动压缩用 /compact。
      }
    } catch {
      // Backend may not support this — degrade gracefully
    }
  }, [sessionId]);

  // ── pi `/context` 报告 ────────────────────────────────────────────────
  // 分类口径与 pi CLI 的 `/context` 完全对齐：网关去问 pi 要那份分布
  // （系统提示 / 记忆 / 技能 / 工具定义 / 工具结果 / 对话上下文 + 其他 + 剩余）。
  // 后端没有该扩展时返回 source="unavailable"，这里清空、面板回落旧的分类。
  const fetchContextReport = useCallback(async () => {
    try {
      const currentSessionId = sessionId ?? useHelixStore.getState().currentSessionId;
      const resolvedSid = await resolveBackendSid(currentSessionId);
      if (!resolvedSid) {
        setReportData(null);
        return;
      }
      const result = await helixApi()?.send("session.context_report", {
        session_id: resolvedSid,
      });
      if (result && typeof result === "object") {
        const data = result as ContextReportData;
        setReportData(
          data.source === "pi-context" && (data.categories?.length ?? 0) > 0
            ? data
            : null,
        );
      }
    } catch {
      // 旧后端不认识这个方法（或不支持）—— 静默回落到本地分类。
      setReportData(null);
    }
  }, [sessionId]);

  // 打开弹层时查询，并在打开期间每 5s 刷新一次：后端 agent 可能刚构建完成，
  // 分类数据不会在会话创建瞬间就绪，只查一次容易永久停留在"暂无上下文分类数据"。
  // （自动压缩的决策已交给 pi 的回合内阈值压缩，这里不再为检测 80% 门槛
  //  保持后台轮询；压缩发生时的可见反馈走 compaction 事件与压缩通知卡。）
  const currentSessionId = useHelixStore((s) => s.currentSessionId);
  useEffect(() => {
    if (!open) {
      // 关了就撤：报告只在这个浮层里用，留着会让下次打开先闪一份旧分布。
      setReportData(null);
      return;
    }
    fetchContextData();
    fetchContextReport();
    const timer = setInterval(() => {
      fetchContextData();
      fetchContextReport();
    }, 5000);
    return () => clearInterval(timer);
  }, [open, fetchContextData, fetchContextReport]);

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

  // 分桶优先于"整块占用"兜底（见 pickCategories）：RPC 非空不再无条件顶替本地
  // 快照，否则首轮里后端只给得出「会话上下文」一块时，原本的分桶会被它顶掉，
  // 看起来就像分类自己变了。
  const categories: ContextBreakdown[] = pickCategories(
    backendData?.categories,
    localCtx?.categories,
  ).map((c) => ({ ...c }));

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
        ref={triggerRef}
        onClick={toggle}
        className="size-8 rounded-xl flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors duration-150"
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
