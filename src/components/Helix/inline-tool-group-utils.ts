// 从 inline-tool-group.tsx 抽出的纯函数 / 类型，供 fast-refresh 合规
// （react-refresh/only-export-components 要求模块只导出组件）。
// 函数体原样搬迁，未改任何逻辑、参数、返回类型与注释语义。

import { looksLikeUnifiedDiff } from "@/components/Helix/diff-preview";
import { normalizeAcpContent } from "@/lib/text-utils";
import type { ExecutionStep } from "@/stores/helix-store";

const ANSI_ESCAPE = String.fromCharCode(27);

// 统计统一 diff 里的 +N/−N：先验「这是 diff」，再逐行计数；
// 非 diff 文本（ls 结果、JSON、命令输出）返回 0/0 不出徽标。
export function extractDiffStats(content: string): {
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

export type ResultKind = "diff" | "image" | "search" | "plain";

export function detectResultKind(toolName: string, content: string): ResultKind {
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

// renders inside that tool's card. An orphan result (no preceding call) becomes
// a standalone card.
export function groupSteps(
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
