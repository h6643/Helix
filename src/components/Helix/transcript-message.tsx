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
import { Check, Copy, GitFork, FileText, Pencil } from "lucide-react";
import React from "react";
import { useState, useMemo, useEffect, useRef } from "react";
import { FileChangeSummary } from "./file-change-summary";
import { HelixMarkdown } from "./helix-markdown";
import { InlineToolGroup } from "./inline-tool-group";
import { summarizeGroupDiff } from "./inline-tool-group-utils";
import {
  buildProcessSegments,
  formatBytes,
  formatDuration,
  mergeAdjacentThinking,
  mergeThinkingContents,
  mergeToolRuns,
  normalizeTextBlocks,
  segmentizeProcessBlocks,
  thinkingSegmentDurationS,
} from "./transcript-utils";
import { formatDurationSeconds } from "@/lib/format";
import { copyTextAndImages } from "@/lib/image-utils";
import {
  normalizeAcpContent,
  normalizeAcpContentRaw,
  extractKaomojiStatus,
} from "@/lib/text-utils";
import { formatMergedSummary, isSubAgentTool } from "@/lib/tool-merge";
import { useHelixStore } from "@/stores/helix-store";
import { type ChatMessage, type ExecutionStep } from "@/stores/helix-types";

/** 思考体展开后最多显示的行数。超出部分在这个高度里滚动——完整推理仍在数据里
 *  （上翻可读、复制可拿全文），但一段几千字的 reasoning 不能把对话流整个顶下去。
 *  按行数而不是写死 rem：思考体字号跟随「界面字号」设置，写死 18rem 时小字号能显示
 *  二十来行、大字号只剩七八行，同一个限制在不同设置下含义不同。 */
const THINKING_BODY_MAX_LINES = 8;
/** 思考体的 row-height（em）。必须与下面 div 的 lineHeight 用同一个值，行数才准。 */
const THINKING_BODY_LINE_HEIGHT = 1.5;

/** 贴底判定容差：滚动位置距底 ≤ 该像素即视为「跟着最新内容」。取 24 是按
 *  行高留的余量——差不到一行还往回拽，用户感觉不出被抢滚动条。 */
const STICK_EPSILON_PX = 24;

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
  durationS,
}: {
  content: string;
  fontSize: number;
  active?: boolean;
  streaming?: boolean;
  status?: string;
  durationS?: number;
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
  // 展开与否完全由用户点击决定：默认折叠，active（思考中）只驱动标题脉冲与
  // 摘要行更新，不再强制展开——否则思考中无法手动折叠，思考→正文/工具时还会
  // 出现"自动展开/收起"的闪动。
  const open = userOpen;
  const bodyRef = React.useRef<HTMLDivElement | null>(null);

  // 思考不足 3 秒就不报具体秒数，标题直接说「思考了一会」：一两秒的思考显示成
  // 「1.2s」像在比拼耗时，读者只会盯住那个数字，而它想表达的其实是"没过脑子"。
  const briefThink =
    !active && durationS != null && durationS > 0 && durationS < 3;

  // 流式思考（active）时 body 受 max-h 限高 + 滚轮，增量内容要把视图钉到底部，
  // 否则用户只能看到最开头的旧文本、看不到模型正在写的最新思考。
  // 但**只在视图本来就在底部时**跟：这个 body 自己有滚动条，用户上翻去读前面
  // 的推理时，每来一个分片都无条件拽回 scrollTop=scrollHeight，等于把滚动条
  // 抢走——"我往上滚想看思考内容，它还是跳回最下面"。所以按终端式贴底判定
  // （距底 ≤24px 才算跟着），用户回到底部后自动恢复跟随。
  const stickRef = React.useRef(true);
  const handleBodyScroll = React.useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distanceFromBottom <= STICK_EPSILON_PX;
  }, []);
  React.useEffect(() => {
    if (!active) return;
    const el = bodyRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [active, body, open]);

  // 重新展开就重新决定「看哪儿」：默认回到跟随最新内容（展开瞬间视图确实在
  // 底部）。不重置的话，上一次展开时上翻过就会带着 stickRef=false 再打开，
  // 展开后停在顶部、新内容再也不跟进来。
  const toggleOpen = React.useCallback(() => {
    setUserOpen((v) => {
      if (!v) stickRef.current = true;
      return !v;
    });
  }, []);

  return (
    <div className="group/think my-1 rounded-md">
      {/* 用受控 div 替代原生 <details>：WebKit/Chromium 里 <details> 包裹
          overflow:auto 子元素时存在高度计算循环依赖，内部滚动条不出现、内容被
          直接裁断（"截断无滚轮"）。这里用普通 div + inline maxHeight 限高，
          让滚动条稳定出现。点击标题随时切换展开/收起（默认折叠）。 */}
      <div
        onClick={toggleOpen}
        className="cursor-pointer hover:bg-muted/10 -mx-1.5 px-1.5 rounded-md flex items-center gap-1.5 list-none transition-colors"
      >
        <ThinkGlyph active={active} />
        {/* 状态标题只在 active（这段思考还在跑）时才有意义：结束的思考必须回到
            「思考 / 思考了一会」，否则转录中间会挂着一排假的「思考中」。 */}
        <span
          className={`select-none ${
            active
              ? "text-foreground/60 font-medium"
              : "text-foreground/40 font-normal"
          }`}
          style={{ fontSize: fontSize + 2 }}
        >
          {active && kaomojiStatus
            ? `思考中 ${kaomojiStatus}`
            : active
              ? "思考中"
              : briefThink
                ? "思考了一会"
                : "思考"}
        </span>
        {active && summary && (
          <span
            className="text-foreground/30 truncate max-w-[60%]"
            style={{ fontSize }}
          >
            {summary}
          </span>
        )}
        {/* 与工具组标签同一条规则（见 ToolStreamFold 的 durationIsLive）：还在长
            的计时常驻 —— 「正在思考多久」是实时进度，藏起来就等于没有；定格后
            归入历史数字，默认不显示、指针移到这一行才出现（opacity 而非移除，
            位置留着免得悬停时抖动）。 */}
        {durationS != null && durationS > 0 && !briefThink && (
          <span
            className={`ml-auto tabular-nums shrink-0 transition-opacity ${
              active
                ? "text-foreground/45"
                : "text-foreground/25 opacity-0 group-hover/think:opacity-100"
            }`}
            style={{ fontSize: fontSize - 1 }}
          >
            {formatDurationSeconds(durationS)}
          </span>
        )}
        {status && !active && (
          <span className="text-foreground/30 text-[calc(var(--helix-transcript-size)*0.7143)] ml-auto shrink-0">
            · {status}
          </span>
        )}
      </div>
      {open && (
        /* 左侧竖线：与工具结果面板（.tool-result-panel）同一条 var(--border)
           2px 折线，让「思考」在视觉上也归入"被引出的正文"，不至于和最终答复
           混成同一层。ml-1 + pl-3 与旧 pl-5 的文字起点基本重合，行长不变。 */
        <div
          ref={bodyRef}
          onScroll={handleBodyScroll}
          className="mt-1 ml-1 pl-3 border-l-2 border-border text-foreground/70 whitespace-pre-wrap"
          style={{
            fontSize,
            lineHeight: THINKING_BODY_LINE_HEIGHT,
            maxHeight: fontSize * THINKING_BODY_LINE_HEIGHT * THINKING_BODY_MAX_LINES,
            overflowY: "auto",
          }}
        >
          {active && !body ? "…" : body}
        </div>
      )}
    </div>
  );
});

// 行名截断：openAgentView 的 name 会成为右侧栏页签的显示名，取任务描述第一行够读即可。
const shortAgentName = (s: string): string =>
  s.replace(/\s+/g, " ").trim().slice(0, 60) || "子代理";

/** 点击对话里的子代理执行行 → 跳右侧栏「子 Agent」页。目标定位三级解析：
 *  ① toolCallId 直接命中 store 子代理（磁盘重建卡的 id 就是 tool_call_id，
 *    agent-work-panel 里 subagentMap 的 tool_call_id→agent_id 映射同键）；
 *  ② 按 Agent 调用参数里的 goal/prompt 文本匹配 live 卡 description/name——
 *    subagent.start 的 goal 与工具参数本就同源；同段描述重复派发取时间最近的；
 *  ③ 未命中（重启后 / 旧会话无 live 卡）：把 toolCallId 当 id 交给面板——
 *    磁盘 delegation 按 id 命中时间线，subagentMap 兜底，都是既有路径。 */
function openSubAgentForStep(step: ExecutionStep): void {
  const { openAgentView, subAgents, currentSessionId } =
    useHelixStore.getState();
  const pool = subAgents.filter(
    (a) => !a.sessionId || a.sessionId === currentSessionId,
  );
  const params = (step.toolParams ?? {}) as Record<string, unknown>;
  const goal =
    [params.goal, params.prompt, params.description].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    ) ?? "";
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  if (step.toolCallId) {
    const byId = pool.find(
      (a) => a.id === step.toolCallId || a.agentId === step.toolCallId,
    );
    if (byId) {
      openAgentView({
        id: byId.id,
        name: shortAgentName(byId.description || byId.name),
      });
      return;
    }
  }
  if (goal) {
    const cands = pool.filter(
      (a) =>
        norm(a.description) === norm(goal) || norm(a.name) === norm(goal),
    );
    if (cands.length > 0) {
      const anchor = step.startedAt ?? step.timestamp;
      const best = cands.reduce((p, c) =>
        Math.abs(c.createdAt - anchor) < Math.abs(p.createdAt - anchor)
          ? c
          : p,
      );
      openAgentView({
        id: best.id,
        name: shortAgentName(best.description || best.name),
      });
      return;
    }
  }
  openAgentView({
    id: step.toolCallId || norm(goal) || "subagent",
    name: goal ? shortAgentName(goal) : "子代理",
  });
}

// 完成态工具流折叠：整轮 N 个工具调用收成一行「N 个操作 · 动词统计」。
// 子代理执行（Agent / delegate_task…）不并入动词统计——每次子代理执行
// 提升为常显的独立行，摘要行只统计普通工具。
export const ToolStreamFold = React.memo(function ToolStreamFold({
  blocks,
  fontSize,
  children,
  isRunning = false,
}: {
  blocks: Array<{ type: string; steps?: ExecutionStep[] }>;
  fontSize: number;
  children: React.ReactNode;
  isRunning?: boolean;
}) {
  const { names, total, subagentSteps, timedSteps, failedCount } = useMemo(() => {
    const ns: string[] = [];
    const sa: ExecutionStep[] = [];
    const ts: ExecutionStep[] = [];
    let all = 0;
    let failed = 0;
    for (const b of blocks) {
      if (b.type !== "tool_group" || !b.steps) continue;
      for (const s of b.steps) {
        if (s.type !== "tool_call") continue;
        all += 1;
        // 失败数按 tool_call 自己的 status 计，与 ToolCard 判红叉的口径一致
        // （inline-tool-group.tsx 里 `step.status === "failed"`）。子代理失败也计入
        // ——它们虽然单列成行不进动词统计，但失败这一事实不该被埋掉。
        if (s.status === "failed") failed += 1;
        if (isSubAgentTool(s.toolName)) {
          sa.push(s);
          continue;
        }
        ns.push(s.toolName || "");
        ts.push(s);
      }
    }
    return { names: ns, total: all, subagentSteps: sa, timedSteps: ts, failedCount: failed };
  }, [blocks]);
  const diff = useMemo(() => summarizeGroupDiff(blocks), [blocks]);
  // 工具耗时只出现在这一行标签上，卡片上不再逐个显示：一轮里挂一排零碎数字看不出
  // 任何规律，「这一段工具花了多久」才是有用的那个数。
  const [, setTimingTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setTimingTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [isRunning]);
  // 取时间区间的长度，而不是把各步骤的 duration_s 相加：pi 对同一条消息里的多个
  // 工具调用默认**并行执行**（agent-loop.js executeToolCallsParallel，`toolExecution`
  // 缺省 "parallel"，且没有内置工具声明 executionMode:"sequential"），两条各跑 90 秒
  // 的并行命令求和会报成 3 分钟，而用户只等了 90 秒。串行时区间长度与求和等价。
  let spanStart = Infinity;
  let spanEnd = -Infinity;
  for (const s of timedSteps) {
    if (s.startedAt == null) continue;
    // 未收尾的步骤终点跟着表针走，数字随执行增长、不必等工具收尾；跑完仍未收尾
    // （停止/掉事件）的按 startedAt 收口，不让它无限拉长这一段。
    const end =
      s.duration_s == null && isRunning
        ? Date.now()
        : (s.finishedAt ?? s.startedAt);
    if (s.startedAt < spanStart) spanStart = s.startedAt;
    if (end > spanEnd) spanEnd = end;
  }
  const totalDurationS =
    spanStart === Infinity ? 0 : Math.max(0, (spanEnd - spanStart) / 1000);
  // 这一行的数字还在长（本折叠里有未收尾的工具）才常驻；一旦定格就归入「历史
  // 数字」，与 ThinkingFold 的耗时同样默认隐藏、悬停才出现。
  const durationIsLive =
    isRunning && timedSteps.some((s) => s.duration_s == null && s.startedAt);
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
              onOpenAgent={() => openSubAgentForStep(step)}
            />
          </div>
        ))}
      </>
    ) : null;
  // 没有普通工具可统计：全是子代理（或没有工具调用）。
  if (names.length === 0) {
    // 全是子代理：独立行就是全部内容，children 会与其重复，不再渲染折叠行。
    // 但如果这一轮里有失败，子代理独立行上面插一行叙述：全部子代理失败时若
    // 不插一行，失败信号就没地方落。
    if (total > 0) {
      return (
        <>
          {failedCount > 0 && (
            <div className="group/tfold -mx-1.5 px-1.5">
              <span
                className="text-foreground/40 font-normal select-none"
                style={{ fontSize }}
              >
                共 {total} 个子代理，其中 {failedCount} 个失败
              </span>
            </div>
          )}
          {hoisted}
        </>
      );
    }
    return <>{children}</>;
  }
  const summary = formatMergedSummary(names) || `${total} 个操作`;
  // 失败数缀在摘要句子尾巴上（「终端 · 1 命令，失败 1」），而不是右端一个孤立 ✕
  // 徽章：这一行已经把「跑了什么、成败如何」一次说完；右边只留变更行号与总耗时
  // ——那里是计量信息，不是叙述。
  // 标签右端这一条带子同时容纳「总耗时」与「+N −n」，都靠右对齐。
  // 失败信号已归到左边摘要句子，这里不再重复。
  const rightBand =
    totalDurationS > 0 || diff.added > 0 || diff.removed > 0 ? (
      <span
        className="ml-auto shrink-0 flex items-center gap-1.5 tabular-nums"
        style={{ fontSize }}
      >
        {totalDurationS > 0 && (
          <span
            className={`text-muted-foreground/70 ${
              durationIsLive
                ? ""
                : "opacity-0 group-hover/tfold:opacity-100 transition-opacity"
            }`}
          >
            {formatDurationSeconds(totalDurationS)}
          </span>
        )}
        {diff.added > 0 && (
          <span className="text-emerald-500/70">+{diff.added}</span>
        )}
        {diff.removed > 0 && (
          <span className="text-rose-500/70">−{diff.removed}</span>
        )}
      </span>
    ) : null;
  const labelRow = (
    <summary className="group/tfold cursor-pointer hover:bg-muted/10 -mx-1.5 px-1.5 rounded-md flex items-center gap-1.5 list-none transition-colors">
      <span
        className="text-foreground/40 font-normal select-none truncate"
        style={{ fontSize }}
      >
        {summary}
        {failedCount > 0 && (
          <span className="text-foreground/40">；失败 {failedCount}</span>
        )}
      </span>
      {rightBand}
    </summary>
  );
  // 单个工具也照样折起来：耗时、成败信号都在标签行上，展开只是为了看那张卡，
  // 而「一行命令正文占满对话流」并不是用户回看历史时的默认诉求。
  return (
    <>
      {hoisted}
      <details className="group/details">
        {labelRow}
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

/**
 * 「已完成」过程卡的外层折叠。open 跟随流式边沿：本轮开始跑就展开，跑完自动
 * 收起成「已完成」；两次边沿之间完全由用户开合。
 *
 * 不要用 `open={streaming}` 直接绑：那样每次重渲染都会把用户的开合状态冲掉。
 * 也不要在 ref 回调里写 `el.open = true`：行内 ref 每次重渲染都会重新执行，
 * 用户刚点收起，下一次面板更新（每秒耗时 tick 就够）就被撑回去，表现为
 * 「完成后默认展开且点不动」。
 */
export const ProcessFold = ({
  streaming,
  summary,
  children,
}: {
  streaming: boolean;
  summary: React.ReactNode;
  children: React.ReactNode;
}) => {
  const [open, setOpen] = useState(streaming);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current === streaming) return;
    wasStreaming.current = streaming;
    setOpen(streaming);
  }, [streaming]);
  return (
    <details
      className="my-2 group/details"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer hover:bg-muted/10 -mx-1.5 px-1.5 rounded-md flex items-center gap-1.5 list-none transition-colors mb-1">
        {summary}
      </summary>
      {children}
    </details>
  );
};

function CopyButton({
  text,
  images,
  className = "",
}: {
  text: string;
  /** 消息里附带的图片（data URL）。传了就会跟文字一起写进剪贴板，
   *  粘到微信/Word/邮件这类吃富文本的目标时图文同现。 */
  images?: string[];
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
        const done = () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        };
        // 有图片时走富文本通道（text/plain + text/html 内联 <img>）；
        // 编码/写入失败再退回原来的纯文字路径，至少不把复制整个弄坏。
        if (images && images.length > 0) {
          copyTextAndImages(cleanText, images)
            .then(done)
            .catch(() => {
              navigator.clipboard
                .writeText(cleanText)
                .then(done)
                .catch(() => {});
            });
          return;
        }
        navigator.clipboard
          .writeText(cleanText)
          .then(done)
          .catch(() => {});
      }}
      className={`p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors ${className}`}
      data-tip="复制"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** 流式过程区容器。历史上的 300px 限高内滚已移除：内容自然撑开，
 *  贴底跟随交给外层转录视口（运行中每 200ms scrollToBottom，用户上翻即停）。
 *  组件壳保留，调用点不用动。 */
export function ProcessWindow({
  children,
}: {
  active?: boolean;
  dependency?: unknown[];
  children: React.ReactNode;
}) {
  return <>{children}</>;
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

/**
 * 单条消息行（与主对话逐字同源）：
 *  - user：右对齐、圆角描边框（无背景填充）、图片/文件附件、复制/编辑按钮
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
  onEdit,
}: {
  msg: ChatMessage;
  fontSize: number;
  searchOpen?: boolean;
  searchQuery?: string;
  isSearchMatch?: boolean;
  isSearchActive?: boolean;
  onFork?: (_id: string) => void;
  /** 编辑这条用户消息（撤回该轮并把原文回填输入框），仅模型尚未回复时提供。 */
  onEdit?: () => void;
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
                const allSegments = mergeToolRuns(
                  segmentizeProcessBlocks(processBlocks),
                );
                let lastTextIdx = -1;
                for (let i = allSegments.length - 1; i >= 0; i--) {
                  if (allSegments[i].kind === "text") {
                    lastTextIdx = i;
                    break;
                  }
                }
                // 「最后一段文本」只有在它**真的位于末尾**时才算收尾总结，这时才
                // 提到过程卡下方（最常见形态：思考/工具 → 最终答复）。
                //
                // 若它后面还有段，那它不是总结、只是过程里的一句话——典型场景是模型
                // 先讲一段话、再调用 ask_user_question 然后本轮停住等回答。旧逻辑
                // 无条件把最后一段文本提到卡下，真实的 [文字, 工具] 就被渲染成
                // [工具, 文字]（"明明下面的话先输出，ask 工具后使用，结果上 ask 工具
                // 还在上面"）。此时按时间序渲染：过程卡（文字之前的段）→ 文字 → 尾段。
                // 与主对话流式管线（agent-flow-panel 的同一处）保持一致。
                const isFinalText =
                  lastTextIdx >= 0 && lastTextIdx === allSegments.length - 1;
                const processSegments =
                  lastTextIdx < 0
                    ? // 全程没有文本段（纯工具轮）：整段都留在过程卡里（原行为）
                      allSegments
                    : isFinalText
                      ? allSegments
                          .slice(0, lastTextIdx)
                          .concat(allSegments.slice(lastTextIdx + 1))
                      : // 非收尾文本：卡只装它**之前**的段，之后的段走 trailingSegments
                        allSegments.slice(0, lastTextIdx);
                const summarySegment =
                  lastTextIdx >= 0 ? allSegments[lastTextIdx] : null;
                // 尾段：仅当最后文本不位于末尾时非空（见上）。
                const trailingSegments =
                  lastTextIdx >= 0 && !isFinalText
                    ? allSegments.slice(lastTextIdx + 1)
                    : [];
                const hasProcess =
                  processSegments.length > 0 || showInlineReasoning;
                // 「思考中」脉冲只在**最后到达的那个块确实是思考**时才亮。与流式
                // 视图（agent-flow-panel 的 thinkingActiveNow）同一套判定，两条渲染
                // 路径不各算一套。
                // 【别跳过 text 块】：「思考 → 正文」是最常见的收尾形态，正文流式期间
                // 最后那个非文本块仍是 thinking，旧实现（从尾部往前扫并跳过 text）
                // 会让思考卡一直冒充「思考中」。
                const lastProcessBlock =
                  processBlocks[processBlocks.length - 1];
                const thinkingActiveNow = lastProcessBlock?.type === "thinking";
                // 本轮总耗时：运行中由流式区顶部的「工作中 Ns」实时显示，完成后
                // 这张卡不再常驻数字（一排历史轮次各挂一个耗时只是噪声），鼠标
                // 移到卡上时才浮现。
                const processDuration =
                  !isStreaming && (messageDuration ?? 0) > 0
                    ? formatDuration(messageDuration ?? 0)
                    : "";
                return (
                  <>
                    {hasProcess && (
                      // 流式时展开、跑完自动收起成「已完成」，中途用户可自由开合
                      // （与主对话流式管线共用 ProcessFold）。
                      <ProcessFold
                        streaming={isStreaming}
                        summary={
                          !isStreaming && (
                            <>
                              <FoldTitle
                                label="已完成"
                                active={false}
                                fontSize={fontSize}
                              />
                              {processDuration ? (
                                <span className="tabular-nums text-foreground/25 opacity-0 transition-opacity group-hover/details:opacity-100">
                                  {processDuration}
                                </span>
                              ) : null}
                            </>
                          )
                        }
                      >
                        <div className="mt-1">
                          {showInlineReasoning && (
                            <ThinkingFold
                              content={reasoning}
                              fontSize={fontSize}
                              active={isStreaming}
                              durationS={msg.thinkingTime}
                            />
                          )}
                          <div className="my-2 space-y-2">
                            {processSegments.map((seg, si) => {
                              // 交替段渲染：思考段一张 ThinkingFold，工具段平铺
                              // 工具卡，文本段渲染 markdown——与流式视图
                              // （agent-flow-panel 的 processSegments.map）同一套
                              // segmentizeProcessBlocks 语义，落盘后不重排，
                              // 保住"思考→执行→总结"的行为链。
                              if (seg.kind === "thinking") {
                                const segContent = mergeThinkingContents(
                                  seg.blocks.map((b) =>
                                    b.type === "thinking"
                                      ? String(b.content || "")
                                      : "",
                                  ),
                                );
                                if (!segContent.trim()) return null;
                                const isLastSeg =
                                  si === processSegments.length - 1;
                                // 与流式区同一套：只有"整条消息的最后一块就在这一段里、
                                // 且它是思考"才脉冲（尾段非空时，最新内容在卡片下方，
                                // 卡内最后那段旧思考不得冒充「思考中」）。
                                const isNewestSegment =
                                  isLastSeg && trailingSegments.length === 0;
                                return (
                                  <ThinkingFold
                                    key={si}
                                    content={segContent}
                                    fontSize={fontSize}
                                    active={
                                      isStreaming &&
                                      thinkingActiveNow &&
                                      isNewestSegment
                                    }
                                    streaming={isStreaming && isNewestSegment}
                                    durationS={thinkingSegmentDurationS(
                                      seg.blocks,
                                    )}
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
                                            !(tb.steps ?? []).every(
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
                      </ProcessFold>
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
                              <FileChangeSummary key={i} changes={b.changes} />
                            );
                          }
                          return null;
                        })}
                      </div>
                    )}
                    {/* 尾段：按时间序画在「总结」之后，不塞回过程卡。
                        只有「最后一段文本并不位于末尾」时非空——例如模型先说话、
                        再调用 ask_user_question 然后本轮停住等回答。塞回卡里会渲染成
                        "工具在上、文字在下"，与真实顺序相反。 */}
                    {trailingSegments.map((seg, si) => (
                      <div key={`trail-${si}`} className="my-2 space-y-1">
                        {seg.kind === "thinking"
                          ? (() => {
                              const c = mergeThinkingContents(
                                seg.blocks.map((b) =>
                                  b.type === "thinking"
                                    ? String(b.content || "")
                                    : "",
                                ),
                              );
                              if (!c.trim()) return null;
                              // 与流式区同一套：尾段区里只有"最新的那一段 + 此刻
                              // 真在思考"才脉冲——它才是「思考中」的归属者。
                              const isLastTrail =
                                si === trailingSegments.length - 1;
                              return (
                                <ThinkingFold
                                  content={c}
                                  fontSize={fontSize}
                                  active={
                                    isStreaming &&
                                    thinkingActiveNow &&
                                    isLastTrail
                                  }
                                  streaming={isStreaming && isLastTrail}
                                  durationS={thinkingSegmentDurationS(
                                    seg.blocks,
                                  )}
                                />
                              );
                            })()
                          : (() => {
                              const toolBlocks = seg.blocks.filter(
                                (b) => b.type === "tool_group",
                              );
                              const otherBlocks = seg.blocks.filter(
                                (b) =>
                                  b.type !== "tool_group" &&
                                  b.type !== "thinking",
                              );
                              return (
                                <>
                                  {otherBlocks.map((b, i) => {
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
                                            !(tb.steps ?? []).every(
                                              (s) =>
                                                s.type !== "tool_call" ||
                                                isSubAgentTool(s.toolName),
                                            ),
                                        )
                                        .map((tb, tbi) => (
                                          <InlineToolGroup
                                            key={`trail-tb-${tbi}`}
                                            steps={tb.steps}
                                            isRunning={false}
                                            fontSize={fontSize}
                                          />
                                        ))}
                                    </ToolStreamFold>
                                  )}
                                </>
                              );
                            })()}
                      </div>
                    ))}
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
                                      durationS={b.duration_s}
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

            {/* 操作行（复制 + 分叉）：blocks / plain 两个分支共用，放外层
                避免两处重复。复制任何状态都可用（复制的是当前已渲染的
                正文，流式中也无妨）；分叉要求消息已落定（forkConversation
                从消息列表切片复制，流式草稿尚未提交进 chatMessages，分叉
                点会缺内容），所以只在 !isStreaming 时显示。 */}
            <div className="flex opacity-0 group-hover:opacity-100 transition-opacity pt-1 px-1 gap-0.5">
              <CopyButton text={mdContent || content} />
              {!isStreaming && onFork && (
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
                  <div className="whitespace-pre-wrap break-words">
                    {content}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Action buttons below user message */}
          <div className="flex justify-end items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
            {onEdit && (
              <button
                onClick={() => onEdit()}
                className="p-1 rounded-lg text-muted-foreground/40 hover:text-blue-500 hover:bg-blue-500/10 transition-colors"
                data-tip="编辑消息"
              >
                <Pencil className="size-3" />
              </button>
            )}
            <CopyButton
              text={content}
              images={[
                ...(msg.images?.map((i) => i.dataUrl) ?? []),
                ...(msg.files
                  ?.filter((f) => f.kind === "image" && f.dataUrl)
                  .map((f) => f.dataUrl as string) ?? []),
              ]}
            />
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
