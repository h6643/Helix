"use client";

/**
 * 对话流单条消息行（与主对话的渲染逐字同源）。
 *
 * agent-flow-panel 与右侧「旁路问答」面板（BylinePanel）共用：主对话里
 * TranscriptMessage 渲染的 user/assistant 行、折叠卡（已完成/思考/N 个操作）、
 * 复制/分叉按钮，都在这里。拆成独立模块是为了让旁路面板和主对话**同一种
 * 视觉语言**（此前 BylinePanel 自己画了一版气泡式消息，两边样式不一致）。
 *
 * 主对话专属的交互（搜索高亮）通过 props 传 boolean；旁路面板传全 false 即可。
 */
import { useState, useMemo } from "react";
import React from "react";
import {
  Check,
  Copy,
  GitFork,
  Undo2,
  FileText,
} from "lucide-react";
import {
  normalizeAcpContent,
  normalizeAcpContentRaw,
  extractKaomojiStatus,
} from "@/lib/text-utils";
import {
  type ChatMessage,
  type ExecutionStep,
  type StreamingResponseBlock,
  type PendingChange,
} from "@/stores/helix-types";
import { HelixMarkdown } from "./helix-markdown";
import { FileChangeSummary } from "./file-change-summary";
import { InlineToolGroup, summarizeGroupDiff } from "./inline-tool-group";
import { formatMergedSummary, isSubAgentTool } from "@/lib/tool-merge";

// ── 过程块工具（与 agent-flow-panel 原有实现完全一致，两边共用一份）─────────

// mergeAdjacentThinking merges runs of consecutive thinking blocks: a
// cumulative superset replaces the earlier one, disjoint segments are
// concatenated. Runs only become adjacent when there was no tool/text between
// them, so interleaved thinking/tool turns stay chronologically separated —
// each thinking segment keeps its own fold.
export function mergeAdjacentThinking(
  blocks: StreamingResponseBlock[],
): StreamingResponseBlock[] {
  const out: StreamingResponseBlock[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    if (block.type === "thinking" && prev && prev.type === "thinking") {
      const prevC = String(prev.content || "");
      const curC = String(block.content || "");
      let content = curC;
      if (prevC && curC) {
        if (curC.includes(prevC)) {
          // 累积重发：当前块已含前块全文 → 只保留当前
          content = curC;
        } else if (prevC.includes(curC)) {
          // 前块是超集（当前块只是其子集/重发）→ 保留前块
          continue;
        } else {
          // 无重叠：真正的独立思考段
          content = `${prevC}\n\n${curC}`;
        }
      }
      out[out.length - 1] = { ...prev, content };
    } else {
      out.push(block);
    }
  }
  return out;
}

// 交替段切分：按时间序把过程区切成「思考段 / 工具段 / 文本段」的交替序列，
// 保住模型"思考→执行→总结→再思考→再执行→再总结"的叙事节奏。
export function segmentizeProcessBlocks<T extends { type: string }>(
  blocks: T[],
): ProcessSegment<T>[] {
  const segs: ProcessSegment<T>[] = [];
  for (const block of blocks) {
    const kind: "thinking" | "tasks" | "text" =
      block.type === "thinking"
        ? "thinking"
        : block.type === "text"
          ? "text"
          : "tasks";
    const prev = segs[segs.length - 1];
    if (prev && prev.kind === kind) {
      prev.blocks.push(block);
    } else {
      segs.push({ kind, blocks: [block] });
    }
  }
  return segs;
}

export type ProcessSegment<T extends { type: string }> = {
  kind: "text" | "thinking" | "tasks";
  blocks: T[];
};

// 不再分段，所有 blocks 放在一个段落里
export function buildProcessSegments<T extends { type: string }>(
  blocks: T[],
): ProcessSegment<T>[] {
  if (blocks.length === 0) return [];
  return [{ kind: "tasks", blocks }];
}

// 归一化用于判重比较：去空白 + 去标点 + 小写。
export function normalizeForCompare(s: string): string {
  return s.replace(/[\s\p{P}]/gu, "").toLowerCase();
}

export function textSimilarityRatio(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na.length === 0 || nb.length === 0) return 0;
  const short = na.length <= nb.length ? na : nb;
  const long = na.length <= nb.length ? nb : na;
  if (short.length < 8) return 0;
  let pref = 0;
  while (pref < short.length && short[pref] === long[pref]) pref++;
  let suf = 0;
  while (
    suf < short.length - pref &&
    short[short.length - 1 - suf] === long[long.length - 1 - suf]
  )
    suf++;
  const prefixSuffix = pref + suf;
  if (prefixSuffix >= short.length * 0.6) return prefixSuffix / short.length;
  if (long.length > 8000 || long.length > short.length * 2)
    return prefixSuffix / short.length;
  let best = prefixSuffix;
  for (let i = 0; i < short.length && best < short.length; i++) {
    let idx = long.indexOf(short[i], 0);
    while (idx !== -1 && best < short.length) {
      let k = 0;
      const maxK = Math.min(short.length - i, long.length - idx);
      while (k < maxK && short[i + k] === long[idx + k]) k++;
      if (k > best) {
        best = k;
        if (best >= short.length * 0.6) return best / short.length;
      }
      idx = long.indexOf(short[i], idx + 1);
    }
  }
  return best / short.length;
}

function isNearDuplicate(aN: string, bN: string): boolean {
  return (
    aN === bN ||
    aN.startsWith(bN) ||
    bN.startsWith(aN) ||
    aN.includes(bN) ||
    textSimilarityRatio(aN, bN) >= 0.6
  );
}

// Older streamed messages may store cumulative text per block. Convert those
// to incremental text blocks so completed messages never render duplicates.
export function normalizeTextBlocks(
  blocks: NonNullable<ChatMessage["blocks"]>,
): NonNullable<ChatMessage["blocks"]> {
  let prevConcat = "";
  let lastKept = "";
  const rendered: NonNullable<ChatMessage["blocks"]> = [];
  for (const block of blocks) {
    if (block.type !== "text") {
      rendered.push(block);
      continue;
    }
    const cur =
      typeof block.content === "string"
        ? block.content
        : String(block.content || "");
    const curN = normalizeForCompare(cur);
    let out: string | null = null;
    let matched = false;
    if (prevConcat && prevConcat.length > 0) {
      if (cur.startsWith(prevConcat)) {
        out = cur.slice(prevConcat.length);
        matched = true;
      } else if (prevConcat.startsWith(cur) && cur.length >= 4) {
        out = "";
        matched = true;
      } else if (lastKept && lastKept.length > 0) {
        const lastN = normalizeForCompare(lastKept);
        if (cur.length >= 8 && lastKept.length >= 8) {
          let _hit = 0;
          const _maxK = Math.min(Math.min(cur.length, lastKept.length), 20);
          for (let _k = _maxK; _k >= 4; _k--) {
            if (lastKept.slice(-_k) === cur.slice(0, _k)) {
              _hit = _k;
              break;
            }
          }
          if (_hit >= 4 && cur.slice(_hit).trim()) {
            out = cur.slice(_hit);
            matched = true;
          }
        }
        if (!matched && curN.length >= 8 && lastN.length >= 8 && isNearDuplicate(lastN, curN)) {
          if (curN.length >= lastN.length) {
            for (let i = rendered.length - 1; i >= 0; i--) {
              const b = rendered[i];
              if (b.type === "text" && b.content !== "") {
                rendered[i] = { ...b, content: "" };
                break;
              }
            }
          } else {
            out = "";
          }
          matched = true;
        }
      }
      if (!matched && curN.length >= 12) {
        const concatN = normalizeForCompare(prevConcat);
        if (
          concatN.length >= 12 &&
          (curN === concatN ||
            concatN.includes(curN) ||
            curN.includes(concatN) ||
            textSimilarityRatio(concatN, curN) >= 0.6)
        ) {
          out = "";
          matched = true;
        }
      }
    }
    const final = out ?? cur;
    if (final) {
      rendered.push({ ...block, content: final });
      lastKept = final;
      prevConcat = prevConcat + final;
    }
  }
  return rendered.filter((b) => b.type !== "text" || b.content.length > 0);
}

// 段内思考文本合并：后端两种流式形态混发时（有的 chunk 是增量、有的是
// 累积全文重发），相邻块会出现"后块包含前块全文"的重复；steering/重试还会
// 把整段思考近似原样重发（首尾略改）。直接 join 会把同一段思考渲染 N 遍。
export function mergeThinkingContents(contents: string[]): string {
  let merged = "";
  for (const cur of contents) {
    if (!cur.trim()) continue;
    if (!merged) {
      merged = cur;
      continue;
    }
    if (cur.includes(merged) || merged.includes(cur)) {
      merged = cur.length > merged.length ? cur : merged;
      continue;
    }
    merged = `${merged}\n\n${cur}`;
  }
  return merged;
}

const ThinkGlyph = ({ active = false }: { active?: boolean }) => (
  <span
    className={`think-glyph shrink-0${active ? " think-glyph-active" : ""}`}
    aria-hidden
  >
    <span className="think-flake" />
    <span className="think-flake" />
    <span className="think-flake" />
    <span className="think-flake" />
    <span className="think-flake" />
    <span className="think-flake" />
  </span>
);

export const ThinkingFold = React.memo(function ThinkingFold({
  content,
  fontSize,
  active = false,
  streaming = false,
  status,
  searchOpen,
  searchQuery,
  isSearchActive,
}: {
  content: string;
  fontSize: number;
  active?: boolean;
  streaming?: boolean;
  status?: string;
  searchOpen: boolean;
  searchQuery: string;
  isSearchActive: boolean;
}) {
  const { status: kaomojiStatus, body: rawBody } =
    extractKaomojiStatus(content);
  const body = useMemo(
    () =>
      rawBody
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n")
        .replace(/\n{2,}/g, "\n")
        .trim(),
    [rawBody],
  );
  const summary = useMemo(() => {
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const picked = streaming ? lines[lines.length - 1] : lines[0];
    return picked ? picked.slice(0, 56) : "";
  }, [body, streaming]);

  const [userOpen, setUserOpen] = useState(false);
  const open = active || userOpen;
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const userClickedRef = React.useRef(false);

  const detailsRef = React.useRef<HTMLDetailsElement | null>(null);
  React.useEffect(() => {
    const el = detailsRef.current;
    if (!el) return;
    if (open && !el.open) {
      el.open = true;
      el.setAttribute("data-force", "1");
    } else if (!open && el.open && el.getAttribute("data-force") === "1" && !userClickedRef.current) {
      el.open = false;
      el.removeAttribute("data-force");
    }
  }, [open]);

  const shown = active ? body : userOpen ? body : summary || body.slice(0, 0) || body;

  return (
    <details
      ref={detailsRef}
      className="group/think my-1 rounded-md"
      onToggle={(e) => {
        const t = e.currentTarget as HTMLDetailsElement;
        if (t.open) userClickedRef.current = true;
      }}
    >
      <summary className="cursor-pointer hover:bg-muted/10 -mx-1.5 px-1.5 rounded-md flex items-center gap-1.5 list-none transition-colors">
        <ThinkGlyph active={active} />
        <span
          className={`select-none ${
            active
              ? "text-foreground/60 font-medium"
              : "text-foreground/40 font-normal"
          }`}
          style={{ fontSize: fontSize + 2 }}
        >
          {kaomojiStatus ? `思考中 ${kaomojiStatus}` : active ? "思考中…" : "思考"}
        </span>
        {status && !active && (
          <span className="text-foreground/30 text-[calc(var(--helix-transcript-size)*0.7143)]">
            · {status}
          </span>
        )}
        {searchOpen && searchQuery.trim() ? (
          <span className="ml-auto" />
        ) : null}
      </summary>
      {(open || active) && (
        <div
          ref={bodyRef}
          className={`mt-1 pl-5 text-foreground/70 whitespace-pre-wrap ${
            active ? "" : "max-h-72 overflow-y-auto"
          }`}
          style={{ fontSize }}
        >
          {active && !body ? "…" : body}
        </div>
      )}
    </details>
  );
});

// 完成态工具流折叠：整轮 N 个工具调用收成一行「N 个操作 · 动词统计」。
// 子代理执行（Agent / delegate_task…）不并入动词统计——每次子代理执行
// 提升为常显的独立行，摘要行只统计普通工具。
export const ToolStreamFold = React.memo(function ToolStreamFold({
  blocks,
  fontSize,
  children,
  forceFold = false,
  isRunning = false,
}: {
  blocks: Array<{ type: string; steps?: ExecutionStep[] }>;
  fontSize: number;
  children: React.ReactNode;
  forceFold?: boolean;
  isRunning?: boolean;
}) {
  const { names, total, subagentSteps } = useMemo(() => {
    const ns: string[] = [];
    const sa: ExecutionStep[] = [];
    let all = 0;
    for (const b of blocks) {
      if (b.type !== "tool_group" || !b.steps) continue;
      for (const s of b.steps) {
        if (s.type !== "tool_call") continue;
        all += 1;
        if (isSubAgentTool(s.toolName)) {
          sa.push(s);
          continue;
        }
        ns.push(s.toolName || "");
      }
    }
    return { names: ns, total: all, subagentSteps: sa };
  }, [blocks]);
  const diff = useMemo(() => summarizeGroupDiff(blocks), [blocks]);
  // 子代理执行独立行：始终可见，不进折叠摘要。子代理是高层动作（派发了
  // 什么、跑完没有），合并进「子代理 · 2 子代理」会把用户最关心的信息埋掉。
  const hoisted =
    subagentSteps.length > 0 ? (
      <>
        {subagentSteps.map((step) => (
          <div key={step.id} className="my-2" style={{ fontSize }}>
            <InlineToolGroup
              steps={[step]}
              isRunning={isRunning}
              fontSize={fontSize}
            />
          </div>
        ))}
      </>
    ) : null;
  // 没有普通工具可统计：全是子代理（或没有工具调用）。
  if (names.length === 0) {
    // 全是子代理：独立行就是全部内容，children 会与其重复，不再渲染折叠行。
    if (total > 0) return <>{hoisted}</>;
    return <>{children}</>;
  }
  if (total <= 1 && !forceFold) return <>{children}</>;
  const summary = formatMergedSummary(names);
  return (
    <>
      {hoisted}
      <details className="group/details">
        <summary className="cursor-pointer hover:bg-muted/10 -mx-1.5 px-1.5 rounded-md flex items-center gap-1.5 list-none transition-colors">
          <span
            className="text-foreground/40 font-normal select-none truncate"
            style={{ fontSize }}
          >
            {summary || `${total} 个操作`}
          </span>
          {(diff.added > 0 || diff.removed > 0) && (
            <span
              className="ml-auto shrink-0 tabular-nums flex items-center gap-1"
              style={{ fontSize }}
            >
              {diff.added > 0 && (
                <span className="text-emerald-500/70">+{diff.added}</span>
              )}
              {diff.removed > 0 && (
                <span className="text-rose-500/70">−{diff.removed}</span>
              )}
            </span>
          )}
        </summary>
        <div className="mt-1">{children}</div>
      </details>
    </>
  );
});

export const FoldTitle = ({
  label,
  active,
  fontSize,
}: {
  label: string;
  active?: boolean;
  fontSize: number;
}) => (
  <span
    className={`select-none ${
      active
        ? "text-foreground/60 font-medium"
        : "text-foreground/40 font-normal"
    }`}
    style={{ fontSize: fontSize + 2 }}
  >
    {label}
  </span>
);

function CopyButton({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        const cleanText = text
          .replace(/\*\*(.+?)\*\*/g, "$1")
          .replace(/\*(.+?)\*/g, "$1")
          .replace(/`{3}[\s\S]*?\n/g, "")
          .replace(/`(.+?)`/g, "$1")
          .replace(/^#{1,6}\s+/gm, "")
          .replace(/^>\s+/gm, "")
          .replace(/^[-*+]\s+/gm, "\u2022 ")
          .replace(/^\d+\.\s+/gm, "")
          .replace(/\[(.+?)\]\(.+?\)/g, "$1")
          .replace(/^---+$/gm, "")
          .trim();
        navigator.clipboard
          .writeText(cleanText)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
      className={`p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors ${className}`}
      data-tip="复制"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 流式过程区的滚动容器：内容超出限高时内部滚动（与主对话同款行为）。 */
export function ProcessWindow({
  active,
  dependency,
  children,
}: {
  active: boolean;
  /** 依赖此数组的引用来重新测量滚动位置（引用变化 → effect 重跑）。 */
  dependency: unknown[];
  children: React.ReactNode;
}) {
  const [innerH, setInnerH] = useState<number | null>(null);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => setInnerH(el.scrollHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  React.useEffect(() => {
    if (!active) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active, dependency]);
  const cap = active ? 300 : undefined;
  return (
    <div
      ref={scrollerRef}
      style={{ maxHeight: cap, overflowY: cap ? "auto" : "visible" }}
      className={active ? "" : "max-h-[300px] overflow-y-auto"}
    >
      {children}
    </div>
  );
}

export function HighlightText({
  text,
  query,
  active,
}: {
  text: string;
  query: string;
  active: boolean;
}) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (true) {
    const idx = lower.indexOf(q, cursor);
    if (idx === -1) {
      if (cursor < text.length) parts.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    parts.push(
      <mark
        key={key++}
        className={`rounded-[3px] px-0.5 ${active ? "bg-yellow-300/80 text-black" : "bg-yellow-300/35 text-inherit"}`}
      >
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    cursor = idx + q.length;
  }
  return <>{parts}</>;
}

export function countOccurrences(text: string, query: string): number {
  if (!query) return 0;
  let count = 0;
  let idx = text.indexOf(query);
  while (idx !== -1) {
    count++;
    idx = text.indexOf(query, idx + query.length);
  }
  return count;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * 单条消息行（与主对话逐字同源）：
 *  - user：右对齐、圆角描边框（无背景填充）、图片/文件附件、复制/撤回按钮
 *  - assistant：左对齐全宽，过程折叠卡（已完成 → 思考 / N 个操作）+ 总结正文
 *    （HelixMarkdown）；有 blocks 走折叠卡路径，无 blocks 直接渲染整段 md
 *  - 搜索高亮（searchOpen）由调用方传 boolean，旁路面板传全 false
 */
export const TranscriptMessage = React.memo(function TranscriptMessage({
  msg,
  fontSize,
  searchOpen = false,
  searchQuery = "",
  isSearchMatch = false,
  isSearchActive = false,
  onFork,
  onUndo,
}: {
  msg: ChatMessage;
  fontSize: number;
  searchOpen?: boolean;
  searchQuery?: string;
  isSearchMatch?: boolean;
  isSearchActive?: boolean;
  onFork?: (_id: string) => void;
  onUndo?: () => void;
}) {
  const content = useMemo(
    () => normalizeAcpContent(msg.content),
    [msg.content],
  );
  const mdContent = useMemo(
    () => normalizeAcpContentRaw(msg.content),
    [msg.content],
  );
  const reasoning = useMemo(
    () => normalizeAcpContentRaw(msg.reasoning || ""),
    [msg.reasoning],
  );
  const messageDuration = msg.duration ?? msg.thinkingTime;
  const isStreaming = msg.isStreaming === true;

  return (
    <div
      data-message-id={msg.id}
      className={`flex w-full step-enter ${msg.role === "user" ? "justify-end" : "justify-start"}`}
    >
      {msg.role === "assistant" ? (
        <div
          className={`group w-full transition-all duration-200 ${
            isSearchMatch
              ? isSearchActive
                ? "ring-2 ring-yellow-400/40"
                : "ring-1 ring-yellow-400/20"
              : ""
          }`}
        >
          <div className="flex-1 min-w-0">
            {msg.blocks && msg.blocks.length > 0 ? (
              (() => {
                const normalizedBlocks = mergeAdjacentThinking(
                  normalizeTextBlocks(msg.blocks),
                );
                const consolidatedBlocks = normalizedBlocks;
                const showInlineReasoning = !!(
                  msg.reasoning &&
                  msg.reasoning.trim().length > 0 &&
                  !(msg.blocks && msg.blocks.some((b) => b.type === "thinking"))
                );
                const processBlocks = consolidatedBlocks;
                const answerBlocks = consolidatedBlocks.slice(0, 0);
                const allSegments = segmentizeProcessBlocks(processBlocks);
                let lastTextIdx = -1;
                for (let i = allSegments.length - 1; i >= 0; i--) {
                  if (allSegments[i].kind === "text") {
                    lastTextIdx = i;
                    break;
                  }
                }
                const processSegments =
                  lastTextIdx >= 0
                    ? allSegments.slice(0, lastTextIdx).concat(
                        allSegments.slice(lastTextIdx + 1),
                      )
                    : allSegments;
                const summarySegment =
                  lastTextIdx >= 0 ? allSegments[lastTextIdx] : null;
                const hasProcess =
                  processSegments.length > 0 || showInlineReasoning;
                // 思考中脉冲：仅流式且最后一段是思考段（与主对话
                // thinkingActiveNow 规则一致——工具执行/收尾时不冒充思考中）。
                const lastSegIsThinking =
                  isStreaming &&
                  processSegments.length > 0 &&
                  processSegments[processSegments.length - 1].kind ===
                    "thinking";
                const processDuration =
                  !isStreaming && (messageDuration ?? 0) > 0
                    ? formatDuration(messageDuration ?? 0)
                    : "";
                return (
                  <>
                    {hasProcess && (
                      // 流式时折叠卡默认展开（与主对话流式管线 open={streamingActive}
                      // 一致），完成后收起成「已完成」。
                      <details
                        className="my-2 group/details"
                        open={isStreaming}
                      >
                        <summary className="cursor-pointer hover:bg-muted/10 -mx-1.5 px-1.5 rounded-md flex items-center gap-1.5 list-none transition-colors mb-1">
                          {!isStreaming && (
                            <>
                              <FoldTitle
                                label="已完成"
                                active={false}
                                fontSize={fontSize}
                              />
                              {processDuration ? (
                                <span className="tabular-nums text-foreground/25">
                                  {processDuration}
                                </span>
                              ) : null}
                            </>
                          )}
                        </summary>
                        <div className="mt-1">
                          {showInlineReasoning && (
                            <ThinkingFold
                              content={reasoning}
                              fontSize={fontSize}
                              active={isStreaming}
                              searchOpen={searchOpen}
                              searchQuery={searchQuery}
                              isSearchActive={isSearchActive}
                            />
                          )}
                          <div className="my-2 space-y-2">
                            {processSegments.map((seg, si) => {
                              if (seg.kind === "thinking") {
                                const segContent = mergeThinkingContents(
                                  seg.blocks.map((b) =>
                                    b.type === "thinking"
                                      ? String(b.content || "")
                                      : "",
                                  ),
                                );
                                if (!segContent.trim()) return null;
                                return (
                                  <ThinkingFold
                                    key={si}
                                    content={segContent}
                                    fontSize={fontSize}
                                    active={lastSegIsThinking && si === processSegments.length - 1}
                                    searchOpen={searchOpen}
                                    searchQuery={searchQuery}
                                    isSearchActive={isSearchActive}
                                  />
                                );
                              }
                              const toolBlocks = seg.blocks.filter(
                                (b) => b.type === "tool_group",
                              );
                              const otherBlocks = seg.blocks.filter(
                                (b) =>
                                  b.type !== "tool_group" &&
                                  b.type !== "thinking",
                              );
                              return (
                                <div key={si} className="space-y-1">
                                  {otherBlocks.map((b, i) => {
                                    if (b.type === "text") {
                                      return (
                                        <div key={i} style={{ fontSize }}>
                                          {searchOpen && searchQuery.trim() ? (
                                            <div
                                              className="whitespace-pre-wrap break-words"
                                              style={{ fontSize }}
                                            >
                                              <Highlighted
                                                text={normalizeAcpContentRaw(
                                                  b.content,
                                                )}
                                                query={searchQuery}
                                                active={isSearchActive}
                                              />
                                            </div>
                                          ) : (
                                            <HelixMarkdown
                                              text={normalizeAcpContentRaw(
                                                b.content,
                                              )}
                                            />
                                          )}
                                        </div>
                                      );
                                    }
                                    if (b.type === "file_change") {
                                      return (
                                        <FileChangeSummary
                                          key={i}
                                          changes={b.changes}
                                        />
                                      );
                                    }
                                    return null;
                                  })}
                                  {toolBlocks.length > 0 && (
                                    <ToolStreamFold
                                      blocks={toolBlocks}
                                      fontSize={fontSize}
                                    >
                                      {toolBlocks
                                        .filter(
                                          (tb) =>
                                            !(
                                              tb.steps ??
                                              []
                                            ).every(
                                              (s) =>
                                                s.type !== "tool_call" ||
                                                isSubAgentTool(s.toolName),
                                            ),
                                        )
                                        .map((tb, tbi) => (
                                          <InlineToolGroup
                                            key={tbi}
                                            steps={tb.steps}
                                            isRunning={false}
                                            fontSize={fontSize}
                                          />
                                        ))}
                                    </ToolStreamFold>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </details>
                    )}
                    {summarySegment && (
                      <div className="my-2" style={{ fontSize }}>
                        {summarySegment.blocks.map((b, i) => {
                          if (b.type === "text") {
                            return (
                              <div key={i}>
                                {searchOpen && searchQuery.trim() ? (
                                  <div className="whitespace-pre-wrap break-words">
                                    <Highlighted
                                      text={normalizeAcpContentRaw(b.content)}
                                      query={searchQuery}
                                      active={isSearchActive}
                                    />
                                  </div>
                                ) : (
                                  <HelixMarkdown
                                    text={normalizeAcpContentRaw(b.content)}
                                  />
                                )}
                              </div>
                            );
                          }
                          if (b.type === "file_change") {
                            return (
                              <FileChangeSummary
                                key={i}
                                changes={b.changes}
                              />
                            );
                          }
                          return null;
                        })}
                      </div>
                    )}
                    {answerBlocks.length > 0 && (
                      <div
                        className="helix-md helix-answer mt-3"
                        style={{ fontSize }}
                      >
                        {buildProcessSegments(answerBlocks).map((seg, si) => {
                          return (
                            <div key={si} className="space-y-1">
                              {seg.blocks.map((b, i) => {
                                if (b.type === "text") {
                                  return (
                                    <div key={i} style={{ fontSize }}>
                                      {searchOpen && searchQuery.trim() ? (
                                        <div className="whitespace-pre-wrap break-words">
                                          <Highlighted
                                            text={normalizeAcpContentRaw(
                                              b.content,
                                            )}
                                            query={searchQuery}
                                            active={isSearchActive}
                                          />
                                        </div>
                                      ) : (
                                        <HelixMarkdown
                                          text={normalizeAcpContentRaw(
                                            b.content,
                                          )}
                                        />
                                      )}
                                    </div>
                                  );
                                }
                                if (b.type === "thinking") {
                                  const c =
                                    "content" in b ? String(b.content) : "";
                                  if (!c.trim()) return null;
                                  return (
                                    <ThinkingFold
                                      key={i}
                                      content={c}
                                      fontSize={fontSize}
                                      searchOpen={searchOpen}
                                      searchQuery={searchQuery}
                                      isSearchActive={isSearchActive}
                                    />
                                  );
                                }
                                if (b.type === "tool_group") {
                                  return (
                                    <InlineToolGroup
                                      key={i}
                                      steps={b.steps}
                                      isRunning={false}
                                      fontSize={fontSize}
                                    />
                                  );
                                }
                                if (b.type === "file_change") {
                                  return (
                                    <FileChangeSummary
                                      key={b.changes?.[0]?.fileId || `fc-${i}`}
                                      changes={b.changes}
                                    />
                                  );
                                }
                                return null;
                              })}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                );
              })()
            ) : (
              <div className="helix-md" style={{ fontSize }}>
                {searchOpen && searchQuery.trim() ? (
                  <pre
                    className="whitespace-pre-wrap break-words"
                    style={{ fontSize }}
                  >
                    <Highlighted
                      text={mdContent}
                      query={searchQuery}
                      active={isSearchActive}
                    />
                  </pre>
                ) : (
                  <HelixMarkdown text={mdContent} />
                )}
              </div>
            )}

            {/* Copy button */}
            <div className="flex opacity-0 group-hover:opacity-100 transition-opacity pt-1 px-1 gap-0.5">
              <CopyButton text={mdContent} />
              {onFork && (
                <button
                  onClick={() => onFork(msg.id)}
                  className="p-1 rounded-lg text-muted-foreground/40 hover:text-blue-500 hover:bg-blue-500/10 transition-colors"
                  data-tip="分叉对话"
                >
                  <GitFork className="size-3" />
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="group w-fit max-w-[80%]">
          <div className="px-4 py-2.5 rounded-xl border border-border bg-transparent text-foreground">
            {msg.images && msg.images.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {msg.images.map((img) => (
                  <img
                    key={img.id}
                    src={img.dataUrl}
                    alt={img.name || "pasted image"}
                    className="rounded-lg max-h-[300px] max-w-full object-contain"
                  />
                ))}
              </div>
            )}
            {msg.files && msg.files.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {msg.files.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center gap-2 max-w-[240px] px-2.5 py-1.5 rounded-lg border border-border bg-transparent hover:bg-muted/60 transition-colors duration-200"
                  >
                    {f.kind === "image" && f.dataUrl ? (
                      <img
                        src={f.dataUrl}
                        alt={f.name}
                        className="size-8 rounded object-cover shrink-0"
                      />
                    ) : (
                      <FileText className="size-4 text-foreground/50 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="ui-text-sm2 font-medium text-foreground max-w-[8ch] truncate">
                        {f.name.length > 8 ? f.name.slice(0, 8) + "…" : f.name}
                      </p>
                      <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/70">
                        {formatBytes(f.size)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {content && (
              <div className="leading-normal text-justify" style={{ fontSize }}>
                {searchOpen && searchQuery.trim() ? (
                  <div className="whitespace-pre-wrap break-words">
                    <Highlighted
                      text={content}
                      query={searchQuery}
                      active={isSearchActive}
                    />
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap break-words">{content}</div>
                )}
              </div>
            )}
          </div>
          {/* Action buttons below user message */}
          <div className="flex justify-end items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
            {onUndo && (
              <button
                onClick={() => onUndo()}
                className="p-1 rounded-lg text-muted-foreground/40 hover:text-amber-500 hover:bg-amber-500/10 transition-colors"
                data-tip="撤回本轮对话"
              >
                <Undo2 className="size-3" />
              </button>
            )}
            <CopyButton text={content} />
          </div>
        </div>
      )}
    </div>
  );
});

// 搜索高亮（与 agent-flow-panel 内原实现一致，供搜索态的主对话使用；
// 非搜索态下 TranscriptMessage 走上面的 plain 分支，此组件不渲染）。
function Highlighted({
  text,
  query,
  active,
}: {
  text: string;
  query: string;
  active: boolean;
}) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (true) {
    const idx = lower.indexOf(q, cursor);
    if (idx === -1) {
      if (cursor < text.length) parts.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    parts.push(
      <mark
        key={key++}
        className={`rounded-[3px] px-0.5 ${active ? "bg-yellow-300/80 text-black" : "bg-yellow-300/35 text-inherit"}`}
      >
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    cursor = idx + q.length;
  }
  return <>{parts}</>;
}
