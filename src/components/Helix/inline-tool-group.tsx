"use client";

import { Copy, CheckCheck, ChevronRight } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { computeDiff, looksLikeUnifiedDiff } from "@/components/Helix/diff-preview";
import { CodeCard } from "@/components/Helix/helix-markdown";
import {
  detectResultKind,
  extractDiffStats,
  groupSteps,
} from "@/components/Helix/inline-tool-group-utils";
import { normalizeAcpContent, stripEmoji } from "@/lib/text-utils";
import {
  getToolDisplayLabel,
  extractCommandSnippet,
  extractToolPath,
  parseWorkflowMeta,
  WORKFLOW_TOOL_NAME,
} from "@/lib/tool-display-utils";
import { useHelixStore } from "@/stores/helix-store";
import type { ExecutionStep } from "@/stores/helix-store";

const TOOL_RESULT_CLAMP = 20_000;

// 运行中实时输出预览保留的尾部长度。容器 max-h-40 约能显示 8 行，这里按略宽于
// 一屏的余量取尾巴；更早的内容交给展开后的完整结果卡。
// 之前是 slice(-200) + max-h-16 overflow-hidden：0.85em×leading-relaxed 一行
// ≈19.3px，64px 刚好卡 3.3 行，四行以上的输出被静默砍掉、连滚动条都没有。
const PREVIEW_TAIL_CHARS = 1200;

// ── Sub-step grouping ───────────────────────────────────────────────────

const TOOL_CATEGORY: Record<string, string> = {
  open_browser: "浏览器",
  browser_navigate: "浏览器导航",
  browser_read: "浏览器读取",
  browser_click: "浏览器点击",
  browser_type: "浏览器输入",
  browser_scroll: "浏览器滚动",
  browser_hover: "浏览器",
  browser_drag: "浏览器",
  browser_wait: "浏览器",
  browser_eval: "浏览器",
  browser_upload: "浏览器",
  browser_dialog: "浏览器",
  read: "读取",
  read_file: "读取",
  write: "写入",
  write_file: "写入",
  edit: "编辑",
  patch: "编辑",
  bash: "终端",
  execute_command: "终端",
  run_command: "终端",
  terminal: "终端",
  grep: "搜索",
  search: "搜索",
  glob: "搜索",
  list_directory: "列表",
  list_files: "列表",
  web_search: "网页搜索",
  web_fetch: "获取网页",
  fetch: "获取网页",
};

function getToolCategory(toolName: string): string {
  const name = (toolName || "").toLowerCase().replace(/[^a-z0-9]/g, "_");
  for (const [key, cat] of Object.entries(TOOL_CATEGORY)) {
    if (name.includes(key)) return cat;
  }
  return toolName || "工具";
}

interface SubStepGroup {
  category: string;
  count: number;
  items: ExecutionStep[];
  status: "completed" | "failed" | "running";
}

function groupSubSteps(steps: ExecutionStep[]): SubStepGroup[] {
  const groups: SubStepGroup[] = [];
  for (const step of steps) {
    const cat = getToolCategory(step.toolName || "");
    const last = groups[groups.length - 1];
    if (last && last.category === cat && last.status !== "failed") {
      last.count++;
      last.items.push(step);
    } else {
      groups.push({
        category: cat,
        count: 1,
        items: [step],
        status: step.status === "failed" ? "failed" : step.status === "running" ? "running" : "completed",
      });
    }
  }
  return groups;
}

// ── ANSI escape code stripper ───────────────────────────────────────────

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_RE = new RegExp(
  `${ANSI_ESCAPE}\\[[0-9;]*[a-zA-Z]|${ANSI_ESCAPE}\\].*?${String.fromCharCode(7)}`,
  "g",
);
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// Helix 的 mktemp 包装（cache/terminal/helix-snap-*.sh.tmp.XXXX）若
// cache/terminal 目录缺失就会刷一行 mktemp: failed to create...。这是环境噪音
// 不是工具执行失败，从渲染内容里整行剥掉。
function stripMktempNoise(s: string): string {
  return s
    .split("\n")
    .filter(
      (line) => !/^\s*mktemp:\s+failed to create file via template/i.test(line),
    )
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

// ── Result count extraction ──────────────────────────────────────────────

function extractResultCount(
  content: string,
  _toolName: string,
  params?: Record<string, unknown>,
): string {
  // Check params for explicit count fields
  if (params) {
    for (const key of [
      "count",
      "result_count",
      "match_count",
      "file_count",
      "total",
    ]) {
      const v = params[key];
      if (typeof v === "number" && v > 0) return `${v}`;
    }
  }
  // Scan content for "Found X results", "X matches", "X files", etc.
  const countMatch = content.match(
    /(?:Found|found|Total|total)\s+(\d+)\s+(results?|matches?|files?|entries?|items?|occurrences?)/i,
  );
  if (countMatch) return countMatch[1];
  // Match array-like patterns
  const lines = content
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length > 3 && /^\d+\s*[│|]/.test(lines[1] || ""))
    return `${lines.length}`;
  return "";
}



// ── Copy button ─────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };
  return (
    <button
      onClick={handleCopy}
      className="p-0.5 rounded text-foreground/30 hover:text-foreground/60 hover:bg-muted/50 transition-colors"
      data-tip="复制"
    >
      {copied ? (
        <CheckCheck className="size-3 text-emerald-500" />
      ) : (
        <Copy className="size-3" />
      )}
    </button>
  );
}

// ── Result renderers ────────────────────────────────────────────────────

function ImageRenderer({ content }: { content: string }) {
  const [error, setError] = useState(false);
  if (error)
    return (
      <span className="text-[0.85em] text-muted-foreground">
        [图片加载失败]
      </span>
    );
  return (
    <div className="relative group/img">
      <img
        src={
          content.startsWith("data:")
            ? content
            : `data:image/png;base64,${content}`
        }
        alt="工具输出图片"
        className="max-w-xs max-h-48 rounded-md border border-border/30"
        onError={() => setError(true)}
      />
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────
//
// ZCode-style flat layout: each tool call is its own card (icon + status +
// duration + action), expanded on click to reveal params / sub-steps / result.
// No whole-group collapse wrapper — a multi-tool turn reads as a flat stack.

// The tool's concrete action: the command/script for bash, the path for
// file tools, etc. — shown WITHOUT the Chinese action prefix.
//
// extractCommandSnippet 里属于「命令本体」的键：命中这些键的值是模型自己要跑的
// 命令，标题必须照原样显示，不做错误文案过滤。
const COMMAND_BODY_KEYS = ["command", "cmd", "script", "code"];

function toolActionText(step: ExecutionStep): string {
  // 非命令工具（GUI/浏览器/MCP 等）的参数经常把正文/代码/错误说明塞在 text/input
  // 里，直接拿它当标题会显示 "Clear the draft's responseBlocks" 这类内容。非命令
  // 工具只显示工具名，不拿参数当标题。
  const isCommandTool = /bash|terminal|shell|run|execute|command/i.test(
    step.toolName || "",
  );

  // 命令类工具优先取命令本体：extractToolPath 的 content 兜底正则会从
  // tool_output_delta 追加进来的输出文本里误抓"路径样"片段，把标题变成输出中
  // 的某个路径而非命令本身。
  if (isCommandTool) {
    const cmd = extractCommandSnippet(step.toolParams);
    if (cmd) {
      // 参数里真的有命令本体时，字面内容就是模型要跑的命令，一律照原样显示。
      // 只有当命令类工具其实没给命令（工具名撞上 /run|execute/，参数是 GUI/MCP
      // 塞在 text/input 里的说明）才需要下面的错误文案防呆 —— 否则 `grep
      // permission`、`--timeout 30`、任何含 error/failed 字样的正常命令都会被判
      // 成错误，标题掉回「执行 bash」，而展开区的 `$ 命令` 依旧完整（它不经这里）。
      const hasCommandBody = COMMAND_BODY_KEYS.some((k) => {
        const v = step.toolParams?.[k];
        return typeof v === "string" && v.trim() !== "";
      });
      // 非命令工具（GUI/浏览器/MCP 等）的参数可能把错误文案放在 text/input 里，
      // 直接拿它当标题会变成 "指令完成 (gui.lock) prevented..."。明显是错误/拦截
      // 说明时不当作命令标题，回退到工具名。
      const looksLikeError =
        !hasCommandBody &&
        /^\(|prevented|failed|error|cannot|unable|permission|denied|timeout/i.test(
          cmd,
        );
      if (looksLikeError) return "";
      // bash/terminal：标题返回**完整命令**——不手动截断 50、也不只取首行。
      // 标题是命令本体的唯一查看入口，只取首行 / 横向 CSS truncate 会让后端
      // 实际跑满、前端却少显示好几行的情况被误读成「命令没执行完」。
      // 折叠态由外层 CSS 裁到 1 行（line-clamp，末尾自带省略号），点开这一行即
      // 恢复全文并可滚动；悬停 title 始终给全文。
      return cmd;
    }
    return "";
  }

  const path = extractToolPath(step);
  if (path) return path;
  return "";
}

// Action verb shown before the concrete action, derived from the tool type:
// a command shows "执行", a search shows "搜索", a read shows "读取" — NOT a
// generic "执行中" that doesn't describe what the tool does.
function toolVerb(toolName: string): string {
  const name = (toolName || "").toLowerCase();
  if (
    name.includes("grep") ||
    name.includes("search") ||
    name.includes("glob") ||
    name.includes("find")
  )
    return "搜索";
  if (
    name.includes("read") ||
    name.includes("view") ||
    name.includes("list") ||
    name.includes("directory")
  )
    return "读取";
  if (
    name.includes("write") ||
    name.includes("create") ||
    name.includes("edit") ||
    name.includes("patch")
  )
    return "写入";
  if (name.includes("fetch") || name.includes("web")) return "获取网页";
  if (name.includes("workflow")) return "派发";
  if (name.includes("memory")) return "读取记忆";
  if (name.includes("git")) return "查看";
  // bash / terminal / run / execute / default
  return "执行";
}

// Pair tool_result / error steps with their preceding tool_call so the result

function ToolCard({
  step,
  results,
  isRunning,
  onOpenAgent,
}: {
  step: ExecutionStep;
  results: ExecutionStep[];
  isRunning: boolean;
  /** 传入即「子代理导航卡」：整卡变成跳转入口，点击进右侧栏「子 Agent」页，
   *  不再展开参数/结果面板（完整执行流在侧栏里看，比卡片内展开信息全）。 */
  onOpenAgent?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // 命令标题裁行只影响折叠态；展开后必须回到全文，所以测量只在折叠时跑，
  // 展开期间保留最后一次结果（否则 titleClipped 会在展开瞬间自己翻成 false，
  // 连带 expandable 变 false、刚点开的面板又被自己关掉）。
  const titleRef = useRef<HTMLSpanElement>(null);
  const [titleClipped, setTitleClipped] = useState(false);
  const path = extractToolPath(step);
  const hasSubSteps = step.subSteps && step.subSteps.length > 0;
  const isCommandTool = /bash|terminal|shell|run|execute|command/i.test(
    step.toolName || "",
  );
  // 读文件类（read/read_file/list_directory…）**不支持展开**：标题/状态/错误外露即可，
  // 点击标题不再切换结果区、结果区也不渲染。
  const isReadTool = /read|view|list|directory/i.test(step.toolName || "");
  // 命令类 + 读文件类点击不展开（标题/状态/错误外露即可）；文件修改等其余工具保留展开。
  const canExpand = !isCommandTool && !isReadTool;
  // 紧凑工具：命令/搜索/罗列类工具，具体动作（命令/查询/路径）已经在标题里展示，
  // 参数区和结果区再平铺一遍纯属冗余。约定是"只显示标题/动作就够了"。
  const isCompactTool =
    isCommandTool || /grep|search|glob|list/i.test(step.toolName || "");
  // 工作流卡：参数里的 `script` 是模型写的整段编排程序（上限 512KiB），既不是
  // 「输入」也不是结果，平铺进卡片就是一堵代码墙；它落盘后路径会在工具结果文本
  // 里报出来（Script: …），要看脚本的人开那个文件即可。所以这里只留结构化字段。
  const isWorkflowTool = step.toolName === WORKFLOW_TOOL_NAME;
  const workflowMeta = isWorkflowTool ? parseWorkflowMeta(step.toolParams) : null;
  // 运行编号（wf_…）只出现在工具返回的那条文本里一次，卡片想复用就得从结果里捞。
  const workflowRunId = isWorkflowTool
    ? results
        .map(
          (r) =>
            /Task ID:\s*([A-Za-z0-9_-]+)/.exec(
              normalizeAcpContent(r.content || ""),
            )?.[1],
        )
        .find((v): v is string => Boolean(v)) ?? ""
    : "";
  const visibleParamEntries = isCompactTool
    ? []
    : step.toolParams
      ? Object.entries(step.toolParams).filter(
          ([key, v]) =>
            v !== null &&
            v !== undefined &&
            v !== "" &&
            !(isWorkflowTool && key === "script"),
        )
      : [];
  const hasParams = !hasSubSteps && visibleParamEntries.length > 0;
  // 是否有可展开内容：参数 / 子步骤 / 结果 / 运行中实时输出。
  const hasExpandableContent =
    hasParams || hasSubSteps || results.length > 0 || !!step.content;
  // 点击标题是否切换结果区：读取类恒不切换（图片结果例外 —— 不展开就看不到图）。
  const hasImageResult = results.some(
    (r) => detectResultKind(r.toolName || "", r.content || "") === "image",
  );
  // 折叠态标题一律只占 1 行：长 grep/管道命令原本能吃到 5 行以上，读取类的长路径
  // 也会按 break-all 自然折行成两三行，两种都会把时间线撑开。展开后回到全文。
  // 行尾不放文字入口（一行标题 + 省略号已经说明可点），所以被裁过的行必须自己
  // 可点，哪怕它还没有结果 —— 读取类没有结果面板，点开就是标题换成全文容器。
  // 命令类例外：展开后标题仍然只有 1 行。heredoc / 多行脚本能吃到整屏，铺在标题位
  // 就把真正要看的结果顶出视野，而它并没有消失——⎿ 卡片首部本来就重复一遍 `$ 命令`
  // 全文，标题再展开纯属同一件事做两遍。
  const clampTitle = !open || isCommandTool;
  const expandable =
    (hasExpandableContent && (!isReadTool || hasImageResult)) ||
    (clampTitle && titleClipped);
  // 展开态下裁行让标题自己变成全文容器（没有结果面板可开），此时行仍然可点，
  // 所以光标不能退回 default 骗人「点不动」。
  const clickable = expandable || (open && titleClipped);
  const stepStatus =
    results.length > 0
      ? step.status === "failed"
        ? "failed"
        : "completed"
      : step.status ||
        (step.finishedAt
          ? "completed"
          : step.startedAt
            ? "running"
            : undefined);
  const running = stepStatus === "running" && isRunning;
  const failed = stepStatus === "failed";
  // 运行中一律折叠：面板开关完全由用户点击决定（open），不再因为「运行中」自动
  // 展开。刻意不提供 forcePanel / 运行中外露实时输出的分支——那样一条跑几分钟的
  // 命令会把这些面板一路钉在对话流里，用户看到的不是「正在执行」而是刷屏。
  // 标题行的 ⏺ 脉冲 + 计时已经表达了执行中；实时输出与报错都在面板里，点标题看。
  const panelVisible = expandable && open;
  const action = toolActionText(step);
  // 动词固定不随状态变化("搜索/读取/执行"),完成态不再加"已"前缀——
  // 组折叠摘要已经表达完成语义,行内前缀"已/正在"切换只会让列宽抖动。
  const verb = toolVerb(step.toolName || "");
  const verbText = verb;
  // 完整标题（verb + action/label）：action 为空时回退到工具显示名。title 属性
  // 用于悬停查看全文——命令类标题可能被 CSS truncate 视觉截断。
  // 注意：action 为空时回退标签自带动词（bash 无参 → "执行命令"），再前置 verb
  // 会得到「执行 执行命令」——API 报错中断时 toolCall 参数为空，正是这个形态。
  // 此时改显英文工具名（"执行 bash"），既去掉重复动词，又保留"调的是哪个工具"。
  const fallbackLabel = getToolDisplayLabel(
    step.toolName || "",
    step.toolKind,
    path,
    step.toolParams,
  );
  const titleLabel =
    action ||
    (fallbackLabel.startsWith(verb) && step.toolName
      ? step.toolName
      : fallbackLabel);
  // 「有没有被裁」只能实测：按字符数猜会在窄面板下漏判、宽面板下误报，
  // 而这两种情况都会让行尾那个入口变成谎话。
  useEffect(() => {
    if (!clampTitle) return;
    const el = titleRef.current;
    if (!el) return;
    const measure = () => setTitleClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [clampTitle, titleLabel]);
  // 卡片首部文本（"输入"）：命令类 → `$ 命令`；其余工具 → 参数。与结果合并为同一张
  // 卡片，避免"参数卡 + 结果卡"分裂成两张。单参数且其值已作为标题展示（如 read/list
  // 的 path、grep 的 query）时不再重复，仅在输入尚未见于标题时才并入卡片首部。
  const headerText = (() => {
    if (isCommandTool) {
      const cmd = (extractCommandSnippet(step.toolParams) || "").trim();
      return cmd ? `$ ${cmd}` : "";
    }
    const entries = visibleParamEntries.filter(
      ([, v]) => !(typeof v === "string" && action && v === action),
    );
    if (entries.length === 0) return "";
    if (entries.length === 1) {
      const [, v] = entries[0];
      return typeof v === "string" ? v : JSON.stringify(v, null, 2);
    }
    return entries
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
  })();
  // 运行中的实时输出尾巴（tool_output_delta 往 step.content 里追加）。它和"输入"必须
  // 合成同一张卡：分成两块就是"一张白卡 + 下面一堆没有容器的散字"，同一件事两种排版。
  // 只在用户把面板点开后才渲染——运行中不再自动展开（见 panelVisible）。
  const liveTail =
    running && step.content
      ? stripAnsi(step.content.slice(-PREVIEW_TAIL_CHARS))
      : "";

  return (
    <div className="group">
      {/* Tool title row — click to expand/collapse.
          固定宽动词列 + 动作列:动词承担动作分类,动作列显示命令/路径/工具名。 */}
      <button
        type="button"
        onClick={() => {
          if (onOpenAgent) {
            onOpenAgent();
            return;
          }
          if (clickable) setOpen((prev) => !prev);
        }}
        className={`w-full flex items-center gap-1.5 text-left text-[0.9em] text-foreground/80 ${
          onOpenAgent ? "cursor-pointer" : clickable ? "" : "cursor-default"
        }`}
      >
        {failed ? (
          <span className="tool-glyph tool-glyph-failed" aria-hidden>
            ✕
          </span>
        ) : (
          <span className={`tool-glyph${running ? " tool-glyph-running" : ""}`} aria-hidden>
            ⏺
          </span>
        )}
        <span
          ref={titleRef}
          title={titleLabel}
          className={`flex-1 min-w-0 break-all whitespace-pre-wrap text-foreground/60 ${
            clampTitle ? "line-clamp-1" : "max-h-40 overflow-y-auto"
          } ${running ? "text-foreground/85" : ""}`}
        >
          {verbText} {titleLabel}
        </span>
        {(() => {
          const count = step.content
            ? extractResultCount(
                step.content,
                step.toolName || "",
                step.toolParams,
              )
            : "";
          return count ? (
            <span className="text-[0.72em] text-muted-foreground/50 shrink-0">
              {count}
            </span>
          ) : null;
        })()}
        {(() => {
          // 真正的统一 diff 在 tool_result 步骤（results[r].content），不在 tool_call
          // 的流式预览 step.content（那是进度叙述文本，无 +- 行）。从所有 diff 类结果里
          // 汇总 +N −n；结果里没有 diff 时再回退到 step.content（兼容个别把 diff 直接
          // 流进预览的工具）。
          let added = 0,
            removed = 0;
          for (const r of results) {
            const raw = normalizeAcpContent(r.content || "");
            if (detectResultKind(r.toolName || "", raw) !== "diff") continue;
            const s = extractDiffStats(raw);
            added += s.added;
            removed += s.removed;
          }
          // 回退：write_file/edit 结果不含 unified diff（只是新内容），
          // 从 pendingChanges 里按路径匹配，用 backend 带的 diff 或 old/new 算统计。
          if (added === 0 && removed === 0) {
            const tn = (step.toolName || "").toLowerCase();
            if (tn.includes("write") || tn.includes("edit") || tn.includes("patch")) {
              const p = extractToolPath(step);
              if (p) {
                const pc = useHelixStore.getState().pendingChanges.find(
                  (c) => c.filePath === p || c.fileName === p,
                );
                if (pc) {
                  if (pc.unifiedDiff && looksLikeUnifiedDiff(pc.unifiedDiff)) {
                    const s = extractDiffStats(pc.unifiedDiff);
                    added = s.added;
                    removed = s.removed;
                  } else if (pc.oldContent && pc.newContent) {
                    const diffLines = computeDiff(pc.oldContent, pc.newContent);
                    added = diffLines.filter((l) => l.type === "add").length;
                    removed = diffLines.filter((l) => l.type === "remove").length;
                  }
                }
              }
            }
          }
          if (added === 0 && removed === 0) {
            const fb = step.content ? extractDiffStats(step.content) : null;
            if (!fb || (fb.added === 0 && fb.removed === 0)) return null;
            return (
              <span className="text-[0.72em] shrink-0 flex items-center gap-1">
                {fb.added > 0 && (
                  <span className="text-emerald-500/70">+{fb.added}</span>
                )}
                {fb.removed > 0 && (
                  <span className="text-rose-500/70">−{fb.removed}</span>
                )}
              </span>
            );
          }
          return (
            <span className="text-[0.72em] shrink-0 flex items-center gap-1">
              {added > 0 && (
                <span className="text-emerald-500/70">+{added}</span>
              )}
              {removed > 0 && (
                <span className="text-rose-500/70">−{removed}</span>
              )}
            </span>
          );
        })()}
        {onOpenAgent && (
          <span
            data-tip="在右侧栏查看工作内容"
            className="shrink-0 flex items-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <ChevronRight
              className="size-3.5 text-foreground/30"
              aria-hidden
            />
          </span>
        )}
      </button>

      {/* 读取类不展开（canExpand=false），只有失败错误外露在标题下、不依赖展开——
          运行中的实时输出不外露（时间线会被刷屏），它仍在面板里，点标题看。
          命令类走下面那张面板，两处都渲染就是同一段输出两份。 */}
      {!canExpand &&
        !isCommandTool &&
        results.some((r) => r.type === "error") && (
          <div className="ml-1 mt-1 flex items-start gap-1">
            <div className="flex-1 min-w-0 text-[0.8em] text-red-500/80 font-mono whitespace-pre-wrap break-all leading-relaxed">
              {results
                .filter((r) => r.type === "error")
                .map((r) =>
                  stripMktempNoise(
                    stripEmoji(normalizeAcpContent(r.content || "")),
                  ),
                )
                .filter(Boolean)
                .join("\n")}
            </div>
          </div>
        )}

      {panelVisible && (
        <div className="tool-result-panel space-y-1.5">
          {/* 还没有结果（运行中 / 调用被中断 / 只剩 error 结果）：这一张卡就是"输入 +
              实时输出"。命令类尤其靠它——标题永远只占一行，不展开就没有任何地方
              能看到整条命令。结果到达后改由下面的结果卡带 `$ 命令` 前缀，不再走这里。 */}
          {(results.length === 0 ||
            results.every((r) => r.type === "error")) &&
            !!(headerText || liveTail) && (
              <div className="helix-md">
                <CodeCard
                  language="text"
                  code={[headerText, liveTail].filter(Boolean).join("\n\n")}
                  showHeader={false}
                  className="!leading-snug !my-0"
                />
              </div>
            )}
          {/* 工作流：meta 里的真实结构（说明 + 阶段链）。这段程序是模型写的文本，
              这里只做静态解析、绝不执行；阶段名取自 meta.phases[].title。 */}
          {isWorkflowTool && workflowMeta && (
            <div className="space-y-1">
              {workflowMeta.description && (
                <div className="text-[0.85em] text-foreground/60 leading-relaxed whitespace-pre-wrap break-all">
                  {workflowMeta.description}
                </div>
              )}
              {workflowMeta.phases.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 text-[0.8em]">
                  {workflowMeta.phases.map((title, pi) => (
                    <React.Fragment key={pi}>
                      {pi > 0 && (
                        <span className="text-foreground/25" aria-hidden>
                          →
                        </span>
                      )}
                      <span className="rounded bg-muted/60 px-1.5 py-0.5 text-foreground/60">
                        {pi + 1} {title}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
              )}
              {/* 工具是立刻返回的，活还在后台跑，所以不写「已完成」。当前这份扩展
                  实现不落盘工作流进度（journalPath 恒为 undefined），界面拿不到
                  实时条数；完成时它会给模型发一条通知并触发新一轮对话，结果从那
                  一轮起才可见。 */}
              <div className="text-[0.78em] text-foreground/40">
                后台执行中，本卡片不显示实时进度；完成时会触发新一轮对话带回结果
                {workflowRunId ? ` · ${workflowRunId}` : ""}
              </div>
            </div>
          )}
          {/* Sub-agent sub-steps */}
          {hasSubSteps && (
            <div className="space-y-1">
              {(() => {
                const filtered = step.subSteps!.filter((sub) => sub.toolName !== "progress");
                const groups = groupSubSteps(filtered);
                return groups.map((g, gi) => {
                  const isRunning = g.status === "running";
                  const isFailed = g.status === "failed";
                  const label = g.count > 1 ? `${g.category} · ${g.count} 次` : g.category;
                  return (
                    <div key={gi} className="flex items-center gap-1.5 text-[0.85em]">
                      {isFailed ? (
                        <span className="tool-glyph tool-glyph-failed !text-[0.8em]" aria-hidden>✕</span>
                      ) : (
                        <span className={`tool-glyph !text-[0.8em]${isRunning ? " tool-glyph-running" : ""}`} aria-hidden>⏺</span>
                      )}
                      <span className={`${isRunning ? "text-foreground/70" : "text-foreground/50"}`}>
                        {label}
                      </span>
                      {isRunning ? (
                        <span className="text-[0.85em] text-primary/70 shrink-0 flowing-text">执行中</span>
                      ) : isFailed ? (
                        <span className="text-[0.85em] text-red-500/80 shrink-0">失败</span>
                      ) : (
                        <span className="text-[0.85em] text-emerald-500/70 shrink-0">✓</span>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          )}
          {/* 结果区：参数已经由上面那张「输入卡」或本卡首部的 headerText 行给出，
              这里只列结果。外层 ⎿ 面板自带折角线与内嵌底色，内部只渲染代码卡。 */}
          {results.length > 0 && (
            <div className="space-y-1.5 divide-y divide-border/20">
              {results.map((r, ri) => {
                if (r.type === "error") {
                  const errFiltered = stripMktempNoise(
                    stripEmoji(normalizeAcpContent(r.content || "")),
                  );
                  if (!errFiltered) return null;
                  return (
                    <div key={r.id} className="flex items-start gap-1 pt-1.5">
                      <div className="flex-1 min-w-0 text-[0.85em] text-red-500/80 font-mono whitespace-pre-wrap break-all leading-relaxed">
                        {errFiltered}
                      </div>
                      <CopyButton text={errFiltered} />
                    </div>
                  );
                }
                // 紧凑工具（搜索/罗列）只显示标题，正常结果不展开；
                // 命令类工具例外——展开后要能看到非 error 的运行结果。
                // Note: r.type is typed as ExecutionStep['type'] which doesn't include 'error',
                // but the runtime value might be 'error' from legacy code. Use type assertion.
                if (
                  (r.type as string) !== "error" &&
                  isCompactTool &&
                  !isCommandTool
                )
                  return null;
                const raw = stripMktempNoise(
                  stripEmoji(normalizeAcpContent(r.content || "")),
                );
                if (!raw) return null;
                const fullText = raw;
                const isImage =
                  detectResultKind(r.toolName || "", raw) === "image";

                // 图片结果不是代码块，保持原样渲染。
                if (isImage) {
                  return (
                    <div key={r.id} className="relative pt-1.5">
                      <div className="absolute top-2 right-2 z-10">
                        <CopyButton text={fullText} />
                      </div>
                      <ImageRenderer content={raw} />
                    </div>
                  );
                }

                // 其余结果（diff / plain 文本）统一走代码卡片：语法高亮 + 卡片外框。
                // 工具结果不渲染头部栏（showHeader=false）——去掉顶部那条「语言标签 +
                // 复制」灰底大边框，内容直接铺开；工具输出不是正文，无需头部。
                const resultLang =
                  detectResultKind(r.toolName || "", raw) === "diff"
                    ? "diff"
                    : "text";
                // 卡片首部（"输入"）：命令 → `$ 命令`，其余工具 → 参数行。与结果合并
                // 成同一张卡 —— 即"上面输入、下面输出"。只加在首个非 error 结果上；
                // diff 结果不加（首行前缀会破坏 DiffView 的逐行解析）。
                const firstResultIdx = results.findIndex(
                  (x) => (x.type as string) !== "error",
                );
                const withHeader =
                  headerText && resultLang === "text" && ri === firstResultIdx
                    ? `${headerText}\n\n`
                    : "";
                const codeText = withHeader + raw;
                const clamped =
                  codeText.length > TOOL_RESULT_CLAMP
                    ? codeText.slice(0, TOOL_RESULT_CLAMP) +
                      `\n\n… (${codeText.length - TOOL_RESULT_CLAMP} 字符已截断)`
                    : codeText;

                return (
                  <div key={r.id} className="pt-1.5">
                    <div className="helix-md">
                      <CodeCard
                        language={resultLang}
                        code={clamped}
                        showHeader={false}
                        className="!leading-snug !my-0"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function InlineToolGroup({
  steps,
  isRunning,
  fontSize = 14,
  onOpenAgent,
}: {
  steps: ExecutionStep[];
  isRunning: boolean;
  fontSize?: number;
  /** 透传给组内每张 ToolCard（仅单张子代理卡的场景使用）。 */
  onOpenAgent?: () => void;
}) {
  const visible = steps ?? [];
  if (visible.length === 0) {
    // 防御：steps 为空的 tool_group 绝不能塌成零高度隐形间隙（否则两段文字之间
    // 看起来像被截断）。始终渲染一行可见占位，标明此处有工具执行，而不是留空白。
    return (
      <div className="my-2 flex items-center gap-1.5 text-[0.85em] text-muted-foreground/70 select-none">
        <span className="tool-glyph" aria-hidden>
          ⏺
        </span>
        <span>工具执行</span>
      </div>
    );
  }

  const rows = groupSteps(visible);

  return (
    <div className="my-2 space-y-1.5" style={{ fontSize }}>
      {rows.map(({ call, results }) => (
        <ToolCard
          key={call.id}
          step={call}
          results={results}
          isRunning={isRunning}
          onOpenAgent={onOpenAgent}
        />
      ))}
    </div>
  );
}
