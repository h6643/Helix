export interface DiffChange {
  fileId: string;
  fileName: string;
  filePath: string;
  oldContent: string;
  newContent: string;
  language: string;
  /** 后端直接给出的 unified diff（Helix inline_diff）。有它时计数就
   *  直接数这份 diff，不再从 old/new content 重算。 */
  unifiedDiff?: string;
}

interface DiffLine {
  type: "add" | "remove" | "equal";
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

// Optimized diff algorithm using patience diff approach
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLine[] = [];

  // Simple line-by-line diff using LCS
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to get diff
  const stack: DiffLine[] = [];
  let i = m,
    j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({
        type: "equal",
        content: oldLines[i - 1],
        oldLineNum: i,
        newLineNum: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({
        type: "add",
        content: newLines[j - 1],
        newLineNum: j,
      });
      j--;
    } else {
      stack.push({
        type: "remove",
        content: oldLines[i - 1],
        oldLineNum: i,
      });
      i--;
    }
  }

  while (stack.length > 0) {
    result.push(stack.pop()!);
  }

  return result;
}

/** diff 头行的搜索窗口（前 N 行）。
 *  以前固定看前 4 行，但 pi 的 edit/write 结果前面常带一两句说明
 *  （"Successfully replaced N block(s)"、"Wrote X bytes to …"），
 *  说明一多头行就被挤到第 4 行之外 → `+N −n` 徽标与 Diff 着色整段失效。
 *  放宽到 12 行仍只在前部窗口里找，长输出中段碰巧出现的 `---` 不会误判。 */
const DIFF_HEADER_WINDOW = 12;

/** 是否为真正的 unified diff：前部窗口内有 hunk 头（`@@`）或成对的
 *  `--- file` / `+++ file`，且全文存在 `+` / `-` 改动行。
 *  普通命令 / ls / JSON 输出不满足。 */
export function looksLikeUnifiedDiff(text: string): boolean {
  const lines = text.split("\n");
  const head = lines.slice(0, DIFF_HEADER_WINDOW);
  const hasHunk = head.some((l) => /^@@ /.test(l));
  const hasFilePair =
    head.some((l) => /^--- /.test(l)) &&
    head.some((l) => /^\+\+\+ /.test(l));
  if (!hasHunk && !hasFilePair) return false;
  // 必须有真改动行（排除 `---` / `+++` 文件头本身）：只有头没有 ± 行的
  // 不是可渲染的 diff。
  return lines.some(
    (l) =>
      (l.startsWith("+") || l.startsWith("-")) &&
      !l.startsWith("+++") &&
      !l.startsWith("---"),
  );
}

/**
 * 从 unified diff 里算出**第一处改动**在「新文件」中的行号区间（1-based，闭区间）。
 *
 * 「已修改」卡片点文件名时要跳过去：只打开文件不滚动/不高亮，用户仍然要自己
 * 找那几行 —— 这个函数就是给编辑器定位用的。
 *
 * 只看第一个 hunk（与 GitHub "view the first change" 同语义），返回值里 start
 * 用于滚动定位、end 用于高亮范围。纯删除的 hunk 在新文件里没有对应行：定位到
 * 它原本占据的那个位置（前后行之间的缝隙，即后一行）。返回 null = 无法判定
 * （没有 @@ 头，说明不是标准 unified diff）。
 */
export function firstChangedLineRange(
  diff: string,
): { start: number; end: number } | null {
  let newLine = 0;
  let start = 0;
  let end = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@@ ")) {
      if (inHunk) break; // 只看第一个 hunk
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) return null;
      newLine = Number(m[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // --- / +++ 头行
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("-")) {
      // 删除行不占新文件行号，但"改动就在这里"——定位到它空出的位置。
      if (!start) start = Math.max(1, newLine);
      end = start;
      continue;
    }
    if (line.startsWith("+")) {
      if (!start) start = newLine;
      end = newLine;
      newLine++;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      newLine++; // 上下文行（部分生成器不写前导空格）
      continue;
    }
    break; // hunk 体结束（截断标记等）
  }
  if (!start) return null;
  return { start, end: Math.max(start, end) };
}

/** Count +added / -removed lines from a unified diff or old/new content pair. */
export function countDiffLines(change: DiffChange): {
  added: number;
  removed: number;
} {
  // unifiedDiff 须通过严格形态校验才逐行数 +/−；异常注入的非 diff 文本
  // 回退到 old/new 内容重算（都缺时 0/0），避免把命令输出里的 + 行误计。
  if (change.unifiedDiff && looksLikeUnifiedDiff(change.unifiedDiff)) {
    let added = 0,
      removed = 0;
    for (const line of change.unifiedDiff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    return { added, removed };
  }
  if (change.oldContent || change.newContent) {
    const diff = computeDiff(change.oldContent, change.newContent);
    return {
      added: diff.filter((l) => l.type === "add").length,
      removed: diff.filter((l) => l.type === "remove").length,
    };
  }
  return { added: 0, removed: 0 };
}
