"use client";

import { Copy, CheckCheck } from "lucide-react";
import React, { useState } from "react";
import { looksLikeUnifiedDiff } from "@/components/Helix/diff-preview";
import { CodeCard } from "@/components/Helix/helix-markdown";
import { formatDurationSeconds } from "@/lib/format";
import { normalizeAcpContent, stripEmoji } from "@/lib/text-utils";
import {
  getToolDisplayLabel,
  extractCommandSnippet,
  extractToolPath,
} from "@/lib/tool-display-utils";
import type { ExecutionStep } from "@/stores/helix-store";

const TOOL_RESULT_CLAMP = 20_000;

// ── Sub-step grouping ───────────────────────────────────────────────────

const TOOL_CATEGORY: Record<string, string> = {
  open_browser: "浏览器",
  browser_navigate: "浏览器导航",
  browser_read: "浏览器读取",
  browser_click: "浏览器点击",
  browser_type: "浏览器输入",
  browser_scroll: "浏览器滚动",
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


// 统计统一 diff 里的 +N/−N：先验「这是 diff」，再逐行计数；
// 非 diff 文本（ls 结果、JSON、命令输出）返回 0/0 不出徽标。
function extractDiffStats(content: string): {
  added: number;
  removed: number;
} {
  if (!looksLikeUnifiedDiff(content)) return { added: 0, removed: 0 };
  let added = 0,
    removed = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

// ── Content type detection ───────────────────────────────────────────────

type ResultKind = "diff" | "image" | "search" | "plain";

function detectResultKind(toolName: string, content: string): ResultKind {
  const name = (toolName || "").toLowerCase();

  // Diff detection
  if (
    name.includes("diff") ||
    name.includes("patch") ||
    name.includes("git_diff")
  )
    return "diff";
  // pi 的 edit 工具：真 diff 在 details.diff/patch（网关白名单外不带），
  // 拼在结果文本后段。必须按「真 diff 形态」验证再按 diff 着色——
  // 结果文本首行是 "Successfully replaced N block(s)"，若 edit 失败
  // 或输出被截断时按 diff 渲染会把普通文本行误染成 + 行。
  if (name === "edit" && looksLikeUnifiedDiff(content)) return "diff";
  // diff 头可能不在第一行（前面有 "Successfully replaced …" 一句），
  // 但必须满足「头行靠近开头 + 有 +/− 改动行」才算真 diff —— 普通命令输出
  // （ls、dir、JSON）里散落的 + 开头行不触发 diff 着色。
  if (looksLikeUnifiedDiff(content)) return "diff";
  if (
    content.startsWith(`${ANSI_ESCAPE}[`) &&
    /added|removed|modified/i.test(content)
  )
    return "diff";

  // Image detection
  if (/^data:image\//.test(content.trim())) return "image";
  if (/!\[.*?\]\(data:image\//.test(content)) return "image";

  // Search results (grep/glob/read_directory output with file:line patterns)
  if (
    name.includes("grep") ||
    name.includes("search") ||
    name.includes("list_directory")
  )
    return "search";
  if (/^\s*\d+\s*[│|]/.test(content) || /^[\w/.]+\.\w+:\d+/.test(content))
    return "search";

  // 工具输出一律按纯文本处理 —— 不解析 markdown（标题/表格/代码块原样显示）
  return "plain";
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
      // 非命令工具（GUI/浏览器/MCP 等）的参数可能把错误文案放在 text/input 里，
      // 直接拿它当标题会变成 "指令完成 (gui.lock) prevented..."。明显是错误/拦截
      // 说明时不当作命令标题，回退到工具名。
      const looksLikeError =
        /^\(|prevented|failed|error|cannot|unable|permission|denied|timeout/i.test(
          cmd,
        );
      if (looksLikeError) return "";
      // bash/terminal：标题返回命令完整首行（不手动截断 50）——命令卡已不可
      // 展开、标题是唯一查看入口，截断太短会看不到命令本体；视觉过长由外层
      // CSS truncate 省略，完整命令放 title 悬停可见。
      return cmd.split("\n")[0];
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
  if (name.includes("memory")) return "读取记忆";
  if (name.includes("git")) return "查看";
  // bash / terminal / run / execute / default
  return "执行";
}

// Pair tool_result / error steps with their preceding tool_call so the result
// renders inside that tool's card. An orphan result (no preceding call) becomes
// a standalone card.
function groupSteps(
  steps: ExecutionStep[],
): Array<{ call: ExecutionStep; results: ExecutionStep[] }> {
  const rows: Array<{ call: ExecutionStep; results: ExecutionStep[] }> = [];
  for (const s of steps) {
    if (s.type === "tool_call") {
      rows.push({ call: s, results: [] });
      continue;
    }
    // 结果/错误步骤优先按 toolCallId 挂回发起调用的那张卡；两侧都有 id
    // 但对不上时仍退回"最后一个 call"（组内通常只有一个 call，此兜底
    // 只服务无 id 的旧事件）。
    const rid =
      s.type === "tool_result" || s.type === "error" ? s.toolCallId : undefined;
    const byId =
      rid && rows.length > 0
        ? rows.find((r) => r.call.toolCallId === rid)
        : undefined;
    if (byId) {
      byId.results.push(s);
    } else if (rows.length > 0) {
      rows[rows.length - 1].results.push(s);
    } else {
      rows.push({ call: s, results: [] });
    }
  }
  return rows;
}

// 折叠摘要用：把一组 tool_group blocks 里所有 diff 结果的 +/- 行数汇总成
// 「+N −n」，供 ToolStreamFold 摘要行右侧展示（与工具卡标题同一套判据）。
export function summarizeGroupDiff(
  blocks: Array<{ type: string; steps?: ExecutionStep[] }>,
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const b of blocks) {
    if (b.type !== "tool_group" || !b.steps) continue;
    for (const { results } of groupSteps(b.steps)) {
      for (const r of results) {
        const raw = normalizeAcpContent(r.content || "");
        if (detectResultKind(r.toolName || "", raw) !== "diff") continue;
        const s = extractDiffStats(raw);
        added += s.added;
        removed += s.removed;
      }
    }
  }
  return { added, removed };
}

function ToolCard({
  step,
  results,
  isRunning,
}: {
  step: ExecutionStep;
  results: ExecutionStep[];
  isRunning: boolean;
}) {
  const [open, setOpen] = useState(false);
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
  const visibleParamEntries = isCompactTool
    ? []
    : step.toolParams
      ? Object.entries(step.toolParams).filter(
          ([, v]) => v !== null && v !== undefined && v !== "",
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
  const expandable = hasExpandableContent && (!isReadTool || hasImageResult);
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

  return (
    <div className="group">
      {/* Tool title row — click to expand/collapse.
          固定宽动词列 + 动作列:动词承担动作分类,动作列显示命令/路径/工具名。 */}
      <button
        type="button"
        onClick={() => {
          if (expandable) setOpen((prev) => !prev);
        }}
        className={`w-full flex items-center gap-1.5 text-left text-[0.9em] text-foreground/80 ${expandable ? "" : "cursor-default"}`}
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
          className={`flex-1 min-w-0 truncate text-foreground/60 ${running ? "text-foreground/85" : ""}`}
        >
          {verbText} {titleLabel}
        </span>
        {step.duration_s != null && step.duration_s > 0 && (
          <span className="text-[0.72em] text-muted-foreground shrink-0">
            {formatDurationSeconds(step.duration_s)}
          </span>
        )}
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
      </button>

      {/* 命令类不可展开：运行中的实时输出与失败错误直接外露在标题下，不依赖展开。 */}
      {!canExpand && running && step.content && (
        <div className="ml-1 mt-1 text-[0.85em] text-foreground/40 font-mono max-h-16 overflow-hidden leading-relaxed whitespace-pre-wrap break-all">
          {stripAnsi(step.content.slice(-200))}
        </div>
      )}
      {!canExpand && results.some((r) => r.type === "error") && (
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

      {expandable && open && (
        <div className="tool-result-panel space-y-1.5">
          {/* Streaming output preview — shown while tool is running.
              tool.progress → tool_call_update(in_progress) → tool_output_delta 把
              实时输出追加到 step.content（agent-flow-panel），这里显示它的末尾。 */}
          {running && step.content && (
            <div className="text-[0.85em] text-foreground/40 font-mono max-h-16 overflow-hidden leading-relaxed whitespace-pre-wrap break-all">
              {stripAnsi(step.content.slice(-200))}
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
          {/* 参数与结果合并成同一张卡片：参数作为首部"输入"行，结果紧随其后。
              外层 ⎿ 面板已带 bg-inset 底与折角线，内部只渲染一张代码卡。 */}
          {(headerText || results.length > 0) && (
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
                // 工具结果一律不折叠（collapsible=false）、且不渲染头部栏
                // （showHeader=false）——去掉顶部那条「语言标签 + 复制」灰底大边框，
                // 内容直接铺开；工具输出不是正文，无需收起。
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
                        showRunButton={false}
                        collapsible={false}
                        showHeader={false}
                        className="!leading-snug !my-0"
                      />
                    </div>
                  </div>
                );
              })}
              {/* 仅有"输入"、暂无结果（运行中）：把输入单独渲染成一张卡，
                  保持"始终一张卡"的视觉，避免空面板。命令类由上方实时输出预览覆盖。 */}
              {results.length === 0 && headerText && !isCommandTool && (
                <div className="pt-1.5">
                  <div className="helix-md">
                    <CodeCard
                      language="text"
                      code={headerText}
                      showRunButton={false}
                      showHeader={false}
                      collapsible={false}
                      className="!leading-snug !my-0"
                    />
                  </div>
                </div>
              )}
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
}: {
  steps: ExecutionStep[];
  isRunning: boolean;
  fontSize?: number;
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
        />
      ))}
    </div>
  );
}
