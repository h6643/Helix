// ── 过程块工具（与 agent-flow-panel 原有实现完全一致，两边共用一份）─────────
//
// 从 transcript-message.tsx 抽出的纯函数 / 类型，供 fast-refresh 合规
// （react-refresh/only-export-components 要求模块只导出组件）。
// 函数体原样搬迁，未改任何逻辑、参数、返回类型与注释语义。

import type {
  ChatMessage,
  StreamingResponseBlock,
} from "@/stores/helix-types";

// Preserve every thinking block as its own unit. Do not merge adjacent
// thinking segments: the user-facing history should show the same number of
// thinking folds as the source blocks, instead of collapsing repeated runs.
export function mergeAdjacentThinking(
  blocks: StreamingResponseBlock[],
): StreamingResponseBlock[] {
  return blocks.map((block) => ({ ...block }));
}

// 保留每个过程块自己的分段，避免相邻同类块被合并。
// 这样模型多段思考 / 多段总结会按原始顺序各自展示，不会被折叠成一个长块。
export function segmentizeProcessBlocks<T extends { type: string }>(
  blocks: T[],
): ProcessSegment<T>[] {
  return blocks.map((block) => {
    const kind: "thinking" | "tasks" | "text" =
      block.type === "thinking"
        ? "thinking"
        : block.type === "text"
          ? "text"
          : "tasks";
    return { kind, blocks: [block] };
  });
}

export type ProcessSegment<T extends { type: string }> = {
  kind: "text" | "thinking" | "tasks";
  blocks: T[];
};

/** 纯工具段：段内全是 tool_group 块（没有文本/思考/文件改动夹在中间）。 */
function isToolRunSegment<T extends { type: string }>(
  seg: ProcessSegment<T>,
): boolean {
  return (
    seg.kind === "tasks" &&
    seg.blocks.length > 0 &&
    seg.blocks.every((b) => b.type === "tool_group")
  );
}

/**
 * 把**连续的纯工具段**并成一段（只做渲染前的整理，块本身一个不动）。
 *
 * 为什么需要：`segmentizeProcessBlocks` 是"一个 block 一段"，而工具块又是
 * "一个工具调用一块"（agent-flow-panel 有意为之 —— 这样工具卡能与思考/正文严格
 * 按事件顺序交叉显示）。两者相乘 ⇒ **一轮里连续 N 个工具调用会渲染出 N 行折叠
 * 摘要**（`编辑 · 1 编辑` ×N），而不是一行 `编辑 · 6 编辑, 终端 · 1 命令` ——
 * 因为 `ToolStreamFold` 的摘要是**在段范围内**聚合的，而每个段里只有一个工具。
 *
 * 只在渲染前合并相邻的纯工具段：思考段/正文段照旧隔断（"思考→编辑→思考→编辑"
 * 仍分成两行），工具块自身的顺序与"折叠区内按事件序渲染"的语义都不变。
 */
export function mergeToolRuns<T extends { type: string }>(
  segs: ProcessSegment<T>[],
): ProcessSegment<T>[] {
  const out: ProcessSegment<T>[] = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (isToolRunSegment(seg) && last && isToolRunSegment(last)) {
      out[out.length - 1] = {
        ...last,
        blocks: [...last.blocks, ...seg.blocks],
      };
      continue;
    }
    out.push(seg);
  }
  return out;
}

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

// 本段思考的耗时（秒）：计时挂在 thinking 块上（见 StreamingResponseBlock），
// 一个思考段通常就是一个块；旧快照/旁路草稿没有这两个字段时返回 0，徽标随之
// 不渲染 —— 宁可不显示，也不拿消息级总时长冒充「这段思考花了多久」。
export function thinkingSegmentDurationS(
  blocks: Array<{ type: string; duration_s?: number }>,
): number {
  let seconds = 0;
  for (const b of blocks) {
    if (b.type === "thinking") seconds += b.duration_s ?? 0;
  }
  return seconds;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
