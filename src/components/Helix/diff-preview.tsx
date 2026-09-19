"use client";

import {
  X,
  Check,
  RotateCcw,
  FileCode,
  Split,
  Rows3,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import React, { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface DiffChange {
  fileId: string;
  fileName: string;
  filePath: string;
  oldContent: string;
  newContent: string;
  language: string;
  /** Backend-rendered unified diff (Helix inline_diff). When present the
   *  viewers render these lines directly instead of recomputing from
   *  old/new content. */
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
  let oldLineNum = m;
  let newLineNum = n;

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
      oldLineNum--;
      newLineNum--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({
        type: "add",
        content: newLines[j - 1],
        newLineNum: j,
      });
      j--;
      newLineNum--;
    } else {
      stack.push({
        type: "remove",
        content: oldLines[i - 1],
        oldLineNum: i,
      });
      i--;
      oldLineNum--;
    }
  }

  while (stack.length > 0) {
    result.push(stack.pop()!);
  }

  return result;
}

// Find word-level changes within a line
function findWordDiff(
  oldLine: string,
  newLine: string,
): { old: string; new: string }[] {
  const oldWords = oldLine.split(/(\s+)/);
  const newWords = newLine.split(/(\s+)/);
  const result: { old: string; new: string }[] = [];

  // Simple word diff - mark changed words
  const maxLen = Math.max(oldWords.length, newWords.length);
  for (let i = 0; i < maxLen; i++) {
    const oldWord = i < oldWords.length ? oldWords[i] : "";
    const newWord = i < newWords.length ? newWords[i] : "";
    if (oldWord !== newWord) {
      result.push({ old: oldWord, new: newWord });
    }
  }

  return result;
}

function SideBySideDiffViewer({
  change,
  onNavigateToLine,
}: {
  change: DiffChange;
  onNavigateToLine?: (filePath: string, lineNumber: number) => void;
}) {
  const diff = useMemo(
    () => computeDiff(change.oldContent, change.newContent),
    [change.oldContent, change.newContent],
  );

  // Group diff lines into pairs for side-by-side view
  const pairs: { left: DiffLine | null; right: DiffLine | null }[] = [];
  let i = 0;

  while (i < diff.length) {
    const line = diff[i];

    if (line.type === "equal") {
      pairs.push({ left: line, right: line });
      i++;
    } else if (line.type === "remove") {
      // Look ahead for corresponding add
      let addLine: DiffLine | null = null;
      if (i + 1 < diff.length && diff[i + 1].type === "add") {
        addLine = diff[i + 1];
        i += 2;
      } else {
        i++;
      }
      pairs.push({ left: line, right: addLine });
    } else if (line.type === "add") {
      pairs.push({ left: null, right: line });
      i++;
    }
  }

  return (
    <div className="flex font-mono text-[calc(var(--helix-font-size,13px)*0.9231)]">
      {/* Left side (old) */}
      <div className="flex-1 border-r border-border">
        <div className="px-3 py-1.5 bg-red-500/10 border-b border-border text-red-400 text-[calc(var(--helix-transcript-size)*0.7143)] font-medium">
          原始版本
        </div>
        <div className="max-h-[500px] overflow-y-auto">
          {pairs.map((pair, idx) => {
            if (!pair.left) {
              return (
                <div key={idx} className="flex h-6 bg-emerald-500/5">
                  <span className="w-12 shrink-0 text-right pr-2 text-muted-foreground/30 select-none" />
                  <span className="px-2 flex-1" />
                </div>
              );
            }

            const isRemoved = pair.left.type === "remove";
            return (
              <div
                key={idx}
                onClick={() =>
                  onNavigateToLine?.(
                    change.filePath,
                    pair.left!.oldLineNum || 1,
                  )
                }
                className={`flex h-6 cursor-pointer ${isRemoved ? "bg-red-500/10 border-l-2 border-red-500" : "hover:bg-accent/20"}`}
              >
                <span
                  className={`w-12 shrink-0 text-right pr-2 select-none ${isRemoved ? "text-red-400" : "text-muted-foreground/40"}`}
                >
                  {pair.left.oldLineNum || ""}
                </span>
                <span
                  className={`px-2 flex-1 whitespace-pre ${isRemoved ? "text-red-300" : ""}`}
                >
                  {isRemoved && <span className="text-red-400 mr-1">-</span>}
                  {pair.left.content}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right side (new) */}
      <div className="flex-1">
        <div className="px-3 py-1.5 bg-emerald-500/10 border-b border-border text-emerald-400 text-[calc(var(--helix-transcript-size)*0.7143)] font-medium">
          新版本
        </div>
        <div className="max-h-[500px] overflow-y-auto">
          {pairs.map((pair, idx) => {
            if (!pair.right) {
              return (
                <div key={idx} className="flex h-6 bg-red-500/5">
                  <span className="w-12 shrink-0 text-right pr-2 text-muted-foreground/30 select-none" />
                  <span className="px-2 flex-1" />
                </div>
              );
            }

            const isAdded = pair.right.type === "add";
            return (
              <div
                key={idx}
                onClick={() =>
                  onNavigateToLine?.(
                    change.filePath,
                    pair.right!.newLineNum || 1,
                  )
                }
                className={`flex h-6 cursor-pointer ${isAdded ? "bg-emerald-500/10 border-l-2 border-emerald-500" : "hover:bg-accent/20"}`}
              >
                <span
                  className={`w-12 shrink-0 text-right pr-2 select-none ${isAdded ? "text-emerald-400" : "text-muted-foreground/40"}`}
                >
                  {pair.right.newLineNum || ""}
                </span>
                <span
                  className={`px-2 flex-1 whitespace-pre ${isAdded ? "text-emerald-300" : ""}`}
                >
                  {isAdded && <span className="text-emerald-400 mr-1">+</span>}
                  {pair.right.content}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function UnifiedDiffViewer({
  change,
  onNavigateToLine,
}: {
  change: DiffChange;
  onNavigateToLine?: (filePath: string, lineNumber: number) => void;
}) {
  const diff = useMemo(
    () => computeDiff(change.oldContent, change.newContent),
    [change.oldContent, change.newContent],
  );

  return (
    <div className="font-mono text-[calc(var(--helix-font-size,13px)*0.9231)]">
      <div className="max-h-[500px] overflow-y-auto">
        {diff.map((line, idx) => {
          if (line.type === "equal") {
            return (
              <div
                key={idx}
                onClick={() =>
                  onNavigateToLine?.(change.filePath, line.oldLineNum || 1)
                }
                className="flex hover:bg-accent/20 cursor-pointer"
              >
                <span className="w-12 shrink-0 text-right pr-2 text-muted-foreground/40 select-none">
                  {line.oldLineNum}
                </span>
                <span className="w-12 shrink-0 text-right pr-2 text-muted-foreground/40 select-none">
                  {line.newLineNum}
                </span>
                <span className="px-2 flex-1 whitespace-pre">
                  {line.content}
                </span>
              </div>
            );
          }

          if (line.type === "add") {
            return (
              <div
                key={idx}
                onClick={() =>
                  onNavigateToLine?.(change.filePath, line.newLineNum || 1)
                }
                className="flex bg-emerald-500/10 border-l-2 border-emerald-500 cursor-pointer"
              >
                <span className="w-12 shrink-0 text-right pr-2 text-muted-foreground/40 select-none" />
                <span className="w-12 shrink-0 text-right pr-2 text-emerald-400 select-none">
                  {line.newLineNum}
                </span>
                <span className="px-2 flex-1 whitespace-pre text-emerald-300">
                  + {line.content}
                </span>
              </div>
            );
          }

          return (
            <div
              key={idx}
              onClick={() =>
                onNavigateToLine?.(change.filePath, line.oldLineNum || 1)
              }
              className="flex bg-red-500/10 border-l-2 border-red-500 cursor-pointer"
            >
              <span className="w-12 shrink-0 text-right pr-2 text-red-400 select-none">
                {line.oldLineNum}
              </span>
              <span className="w-12 shrink-0 text-right pr-2 text-muted-foreground/40 select-none" />
              <span className="px-2 flex-1 whitespace-pre text-red-300 line-through opacity-70">
                - {line.content}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}


/** 是否为真正的 unified diff：diff 头行（---/+++/@@）出现在文本前部，
 *  且后文存在 + / - 改动行。普通命令/ls 输出不满足（无 diff 头行）。 */
export function looksLikeUnifiedDiff(text: string): boolean {
  const lines = text.split("\n");
  const firstNonEmpty = lines.findIndex((l) => l.trim());
  if (firstNonEmpty === -1 || firstNonEmpty > 3) return false;
  const head = lines.slice(firstNonEmpty, firstNonEmpty + 4);
  const headerNearStart =
    head.some((l) => /^--- /.test(l)) ||
    head.some((l) => /^\+\+\+ /.test(l)) ||
    head.some((l) => /^@@ /.test(l));
  if (!headerNearStart) return false;
  return lines.some((l) => l.startsWith("+") || l.startsWith("-"));
}

// Renders a backend-provided unified diff string directly (Helix inline_diff).
// Lines carry their own +/-/context markers, so we colorize them instead of
// recomputing a diff from old/new content.
function UnifiedDiffTextViewer({ diff }: { diff: string }) {
  // Normalize \r\n to \n for consistent splitting across platforms
  const normalizedDiff = useMemo(
    () => diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    [diff],
  );
  // 非 diff 形态（diff 头行缺失）时不逐行着色：整段按普通文本渲染，
  // 防止后端误发的非 diff 内容（如命令输出）被染成满屏 + 行。
  const isRealDiff = useMemo(() => looksLikeUnifiedDiff(normalizedDiff), [
    normalizedDiff,
  ]);
  const lines = useMemo(() => normalizedDiff.split("\n"), [normalizedDiff]);
  return (
    <div className="font-mono text-[calc(var(--helix-font-size,13px)*0.9231)]">
      <div className="max-h-[500px] overflow-y-auto">
        {lines.map((line, idx) => {
          // 非 diff 形态时整段按普通文本渲染，不做逐行着色。
          if (!isRealDiff) {
            return (
              <div key={idx} className="flex hover:bg-accent/20">
                <span className="px-2 flex-1 whitespace-pre-wrap text-muted-foreground/80">
                  {line}
                </span>
              </div>
            );
          }
          if (line.startsWith("+++") || line.startsWith("---")) {
            return (
              <div
                key={idx}
                className="flex bg-purple-500/10 px-2 py-0.5 text-purple-300"
              >
                <span className="px-2 flex-1 whitespace-pre-wrap">{line}</span>
              </div>
            );
          }
          if (line.startsWith("@@")) {
            return (
              <div
                key={idx}
                className="flex bg-sky-500/10 px-2 py-0.5 text-sky-300"
              >
                <span className="px-2 flex-1 whitespace-pre-wrap">{line}</span>
              </div>
            );
          }
          if (line.startsWith("+")) {
            return (
              <div
                key={idx}
                className="flex bg-emerald-500/10 border-l-2 border-emerald-500"
              >
                <span className="px-2 flex-1 whitespace-pre-wrap text-emerald-300">
                  {line}
                </span>
              </div>
            );
          }
          if (line.startsWith("-")) {
            return (
              <div
                key={idx}
                className="flex bg-red-500/10 border-l-2 border-red-500"
              >
                <span className="px-2 flex-1 whitespace-pre-wrap text-red-300">
                  {line}
                </span>
              </div>
            );
          }
          return (
            <div key={idx} className="flex hover:bg-accent/20">
              <span className="px-2 flex-1 whitespace-pre-wrap text-muted-foreground/80">
                {line}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
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
