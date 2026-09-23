/**
 * run-file-changes.ts —— 「已修改」汇总卡片的**唯一数据登记入口**。
 *
 * 抽成独立模块的原因：这段逻辑原先写在 agent-flow-panel.tsx 里（那个文件常被
 * 并行编辑整块覆盖），而它一旦消失，表面症状是"改动卡片死活不出现"——
 * 2026-09-22 就是这么坏的：函数整块丢了，前端只剩两条**在 pi 后端下永远不成立**
 * 的旧登记路径（ACP 的 `update.inlineDiff`、`parsed.toolKind === "edit"`），
 * 于是卡片静默消失。放到独立文件后，面板里只留一行调用。
 *
 * 数据源（pi 网关 tool_execution_end → session/update.update）：
 *   - `details.path`   ← **文件身份的权威来源**：网关转发的工具参数里的目标
 *                        路径（`arg_path(args)`）。卡片"改了哪个文件"必须用它，
 *                        不许从 diff 文本里猜（见 inferDiffPath 的注释）。
 *   - `details.patch`  ← 标准 unified diff（`---`/`+++`/`@@`）。**首选**：
 *                        能反推原文（撤销）。
 *   - `details.diff`   ← pi 自己的行号标注形态（`+12 文本`），无文件头无 `@@`，
 *                        推不出路径 —— 只能当"没有 patch"时的兜底，通常会被
 *                        下面的形态校验直接淘汰（这正是它不该被喂给卡片的原因）。
 *   - `details.undoUnsafe` ← 网关标了"这份 diff 不能反推撤销"（write 覆盖前
 *                        内容没读到 / diff 被截断）。
 *   - `update.inlineDiff` ← 旧 ACP 后端的字段，pi 不发；保留以兼容旧数据。
 *
 * 没有 `details.path`（旧网关 / 旧数据）时才退化成从 diff 文本推断路径。
 */

import { looksLikeUnifiedDiff } from "@/components/Helix/diff-preview";
import type { PendingChange } from "@/stores/helix-types";

/**
 * 从 unified diff 里推断文件路径（相对或绝对，取决于后端给的形态）。
 *
 * ⚠️ 这只是**兜底**：权威来源是工具参数里的 `path`（网关放在 `details.path`）。
 * 推断的本质是"从一段文本里猜文件名"，任何形态像头行的正文都能命中——
 * 真实事故：pi-main 的 tui.ts 补丁里有一行注释 `// 布局：chat → panel → …`，
 * 被当标签行解析成"文件" `布局：chat`，于是卡片里多出一个**模型从没生成过**的
 * 文件（详见本文件顶部的历史注释与 skill `helix-pi-backend`）。
 *
 * `+++` 必须优先：新建文件的 `---` 行是 `/dev/null`，若按"第一条 ---/+++ 行"
 * 取值就会命中 `/dev/null` 并返回空串 ⇒ **新建的文件永远进不了「已修改」卡片**。
 */
export function inferDiffPath(diff: string): string {
  if (!diff) return "";
  const lines = diff.split("\n");
  const clean = (raw: string) =>
    raw
      .trim()
      .slice(4)
      .replace(/^(a|b)\//, "")
      .replace(/\s+\(timestamp.*\)$/, "")
      .trim();
  // ① `+++` / `---` 头行**优先**：这是 unified diff 的权威字段，pi 的
  //    `details.patch` 一定带（`+++` 先于 `---`：新建文件的 `---` 是
  //    `/dev/null`）。
  for (const prefix of ["+++ ", "--- "]) {
    const line = lines.find((l) => l.trim().startsWith(prefix));
    if (!line) continue;
    const p = clean(line);
    if (p && p !== "/dev/null") return p;
  }
  // ② 旧 ACP 的 `inlineDiff` 没有标准头行，只有自渲染的标签行 `a/x → b/x`。
  //    **必须放在头行之后、且必须两边都像路径**——否则 diff 正文里任何带箭头的
  //    行都会把路径劫走：真实事故是 pi-main 的 tui.ts 补丁里有一行注释
  //    `// 布局：chat → panel → 输入区 → footer`，被解析成"文件" `布局：chat`，
  //    于是「已修改」卡片凭空多出一行用户从没改过的"文件"。
  const looksLikePath = (s: string) =>
    /[\\/]/.test(s) || /^[\w.@-]+\.[A-Za-z0-9]{1,8}$/.test(s);
  const label = lines.find((l) => l.includes("→"));
  if (label) {
    const m = label.match(/(?:^|\s)([^\s→]+)\s*→\s*([^\s→]+)/);
    if (m && looksLikePath(m[1]) && looksLikePath(m[2])) {
      return m[1].replace(/^a\//, "") || m[2].replace(/^b\//, "");
    }
  }
  return "";
}

export function diffLanguageForPath(filePath: string): string {
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const ext = fileName.includes(".")
    ? fileName.split(".").pop()!.toLowerCase()
    : "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    md: "markdown",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    css: "css",
    html: "html",
    sh: "bash",
  };
  return map[ext] || "plaintext";
}

/** 归一化：CRLF→LF、去 ANSI 色码。后端两种 diff 都可能带色码。 */
function normalizeDiff(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 规范化权威路径：去引号/空白，拒绝明显不是路径的值（多行、`/dev/null`）。
 * 返回空串表示"不可用"。
 */
function normalizeAuthoritativePath(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (!s || s === "/dev/null" || /[\r\n]/.test(s)) return "";
  return s;
}

/**
 * 从候选文本里挑**第一份**"形态可判"的 diff（顺序即优先级），并给出文件路径。
 *
 * `authoritativePath`（工具的 `path` 参数）存在时**无条件**用它——它是"模型
 * 想改哪个文件"的唯一事实来源；diff 文本推断只在它缺失时兜底。
 */
export function pickUsableDiff(
  candidates: Array<string | undefined>,
  authoritativePath?: unknown,
): { diff: string; filePath: string } | null {
  const forced = normalizeAuthoritativePath(authoritativePath);
  for (const c of candidates) {
    if (typeof c !== "string" || !c.trim()) continue;
    const diff = normalizeDiff(c);
    if (!looksLikeUnifiedDiff(diff)) continue;
    if (forced) {
      // 已知路径 → diff 只作为"有没有改动内容"的证据，不再从文本里猜文件。
      const inferred = inferDiffPath(diff);
      if (inferred && inferred !== forced) {
        console.debug(
          "[Helix] diff 文本推断出的路径与工具参数不一致，已采用工具参数:",
          { inferred, path: forced },
        );
      }
      return { diff, filePath: forced };
    }
    const filePath = inferDiffPath(diff);
    if (!filePath) {
      // 形态像 diff 但推不出路径（典型：pi 的 `details.diff` 标注形态）。
      // 静默丢弃 + 留一条诊断，避免"卡片不出现"再次无从查起。
      console.debug(
        "[Helix] 丢弃无法推断路径的 diff（前 80 字）:",
        diff.slice(0, 80),
      );
      continue;
    }
    return { diff, filePath };
  }
  return null;
}

export type FileChangeSink = {
  /** 本次 run 累积的改动（最后挂到最终消息的 fileChanges 上）。 */
  runChanges: PendingChange[];
  /** store 的 addPendingChange（返回新建条目的 id）。 */
  addPendingChange: (
    change: Omit<PendingChange, "id" | "workDir"> & { workDir?: string },
  ) => string;
  /** 登记成功后的收尾（刷新流式草稿）。 */
  afterRegister?: () => void;
};

/**
 * 工具完成事件 → 登记文件改动。返回是否登记成功（0/1），便于调用方/诊断使用。
 *
 * `update` 就是 pi 网关 `session/update` 里的 `update` 对象（含 toolCallId /
 * status / content / details）。
 *
 * 文件身份**优先取 `details.path`**（工具自己的 path 参数，网关转发），
 * 只有它缺失时才从 diff 文本推断——见本文件顶部关于"幻影文件"的说明。
 */
export function registerFileChangesFromToolUpdate(
  update: unknown,
  sink: FileChangeSink,
): number {
  const u = (update ?? {}) as {
    status?: string;
    details?: {
      path?: unknown;
      patch?: unknown;
      diff?: unknown;
      undoUnsafe?: unknown;
    };
    inlineDiff?: unknown;
  };
  if (u.status && u.status !== "completed" && u.status !== "complete") return 0;
  const d = u.details;
  const picked = pickUsableDiff(
    [
      typeof d?.patch === "string" ? d.patch : undefined,
      typeof d?.diff === "string" ? d.diff : undefined,
      typeof u.inlineDiff === "string" ? u.inlineDiff : undefined,
    ],
    d?.path,
  );
  if (!picked) return 0;
  const { diff, filePath } = picked;
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  // undoUnsafe：网关明确标了（write 覆盖前内容没取到 / diff 截断）才算；
  // 旧 ACP 的 inlineDiff 是按渲染结果给的，没有这个标记 → 保持可撤销。
  const undoUnsafe = d?.undoUnsafe === true;
  const changeId = sink.addPendingChange({
    fileId: filePath,
    fileName,
    filePath,
    oldContent: "",
    newContent: "",
    language: diffLanguageForPath(filePath),
    unifiedDiff: diff,
    undoUnsafe,
  });
  sink.runChanges.push({
    id: changeId,
    fileId: filePath,
    fileName,
    filePath,
    oldContent: "",
    newContent: "",
    language: diffLanguageForPath(filePath),
    unifiedDiff: diff,
    undoUnsafe,
  });
  sink.afterRegister?.();
  return 1;
}
