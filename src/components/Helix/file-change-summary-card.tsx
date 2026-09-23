"use client";

import { FileCode, Undo2 } from "lucide-react";
import React, { useMemo, useState } from "react";
import { countDiffLines, firstChangedLineRange } from "./diff-preview";
import { electronFS, getElectronAPI } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";
import type { PendingChange } from "@/stores/helix-types";

function reverseUnifiedDiff(
  diff: string,
  currentContent: string,
): string | null {
  const hunks: Array<{ newStart: number; newCount: number; body: string[] }> =
    [];
  for (const raw of diff.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@@ ")) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) return null;
      hunks.push({
        newStart: Number(m[1]),
        newCount: m[2] ? Number(m[2]) : 1,
        body: [],
      });
    } else if (
      hunks.length > 0 &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      if (line.startsWith("\\")) continue;
      hunks[hunks.length - 1].body.push(line);
    }
  }

  const result = currentContent.split("\n");
  for (let i = hunks.length - 1; i >= 0; i--) {
    const hunk = hunks[i];
    const start = hunk.newStart - 1;
    const end = start + hunk.newCount;
    if (start < 0 || end > result.length) return null;
    const oldSegment: string[] = [];
    for (const bodyLine of hunk.body) {
      if (bodyLine.startsWith("+")) continue;
      if (bodyLine.startsWith("-")) oldSegment.push(bodyLine.slice(1));
      else if (bodyLine.startsWith(" ")) oldSegment.push(bodyLine.slice(1));
      else oldSegment.push(bodyLine);
    }
    result.splice(start, hunk.newCount, ...oldSegment);
  }
  return result.join("\n");
}

/**
 * 单条回复末尾的修改汇总卡片：外层卡片 + 每个文件一行，点击行展开该文件的 diff。
 */
export function FileChangeSummaryCard({
  changes,
}: {
  changes: PendingChange[];
}) {
  const [undone, setUndone] = useState<Set<string>>(new Set());
  const [undoing, setUndoing] = useState(false);
  const visibleChanges = useMemo(
    () => changes.filter((c) => !undone.has(c.fileId)),
    [changes, undone],
  );
  const stats = useMemo(
    () => visibleChanges.map(countDiffLines),
    [visibleChanges],
  );

  if (visibleChanges.length === 0) return null;

  const totalAdded = stats.reduce((sum, s) => sum + s.added, 0);
  const totalRemoved = stats.reduce((sum, s) => sum + s.removed, 0);

  const undoChange = async (change: PendingChange) => {
    // undoUnsafe：网关标了"这份 diff 不能拿去反推撤销"—— pi 的 write 结果不带
    // diff，若工具执行前读不到旧内容，合成出来的 patch 只是"假想原文件为空"；
    // diff 过长被截断时也置位。reverseUnifiedDiff 是按行号 splice 的，拿这类
    // diff 反推会静默切坏文件，宁可拒绝并说清原因。
    if (change.undoUnsafe) {
      throw new Error(
        "缺少可靠的改动内容（write 覆盖前内容未取到或 diff 被截断），无法自动撤销（请用编辑器或 Git 恢复）",
      );
    }
    if (!change.filePath) throw new Error("缺少文件路径");
    const st = useHelixStore.getState();
    const workDir = st.selectedWorkDir ?? st.activeSessionWorkDir ?? "";
    const absolutePath =
      /^[A-Za-z]:[\\/]/.test(change.filePath) || change.filePath.startsWith("/")
        ? change.filePath
        : workDir
          ? `${workDir.replace(/[\\/]+$/, "")}/${change.filePath}`
          : change.filePath;

    const isNewFile = change.unifiedDiff?.includes("--- /dev/null") === true;
    let restored: string | null | undefined = change.oldContent;

    if (isNewFile) {
      await electronFS.deleteFile(absolutePath);
    } else if (restored) {
      await electronFS.writeFile(absolutePath, restored);
    } else if (change.unifiedDiff) {
      const current = await electronFS.readFile(absolutePath);
      restored = reverseUnifiedDiff(change.unifiedDiff, current);
      if (restored == null) throw new Error("无法解析 diff，无法撤销");
      await electronFS.writeFile(absolutePath, restored);
    } else {
      throw new Error("缺少可撤销的更改内容");
    }

    useHelixStore.setState((s) => ({
      pendingChanges: s.pendingChanges.filter(
        (c) => c.fileId !== change.fileId || (c.workDir ?? "") !== workDir,
      ),
    }));

    const existing = useHelixStore.getState().findFileByPath(absolutePath);
    if (existing) {
      if (restored != null)
        useHelixStore.getState().applyFileChange(existing.id, restored);
      else useHelixStore.getState().deleteFile(existing.id);
    }
  };

  const openChange = async (change: PendingChange) => {
    const st = useHelixStore.getState();
    const workDir = st.selectedWorkDir ?? st.activeSessionWorkDir ?? "";
    const absolutePath =
      /^[A-Za-z]:[\\/]/.test(change.filePath) || change.filePath.startsWith("/")
        ? change.filePath
        : workDir
          ? `${workDir.replace(/[\\/]+$/, "")}/${change.filePath}`
          : change.filePath;

    // 主进程 fs 沙箱只认它登记的根（模块级 workDir + allowRoot 注册的根）。
    // 本会话可能在非应用激活目录里跑 pi（如应用 workDir=D:\桌面\pi-main，而 pi
    // 会话 cwd=D:\Project\Helix），此时不 ensure 根 → readFile 判"在项目里却
    // 报工作区外"。与 file-tree-panel / setWorkDir 的 allowRoot 口径一致，读数前
    // 先把当前项目目录登记为合法根（best-effort）。
    const api = getElectronAPI();
    const rootToAllow = workDir || (/^[A-Za-z]:[\\/]/.test(absolutePath)
      ? absolutePath.split(/[\\/]/).slice(0, 3).join("/")
      : "");
    if (rootToAllow) {
      try {
        await (api as any)?.fs?.allowRoot?.(rootToAllow);
      } catch {
        /* best-effort */
      }
    }

    // 目标行：unified diff 的第一个 hunk 在新文件里的首处改动。只打开文件不滚
    // 过去 = 用户还得自己找那几行（"点了文件但没跳到改动内容"）。
    const target = change.unifiedDiff
      ? firstChangedLineRange(change.unifiedDiff)
      : null;

    // 右侧栏由 rightSidebarTab 控制显隐，先切到 code 视图再建编辑器 tab。
    st.setRightSidebarTab("code");
    const createdEmpty = st.ensureEditorTab(absolutePath, change.fileName);
    try {
      const content = await electronFS.readFile(absolutePath);
      if (content == null) throw new Error("读取为空");
      if (content.length > 1_000_000) {
        st.showToast({
          type: "error",
          title: "文件过大",
          description: `${change.fileName} 超过 1MB，暂不支持在编辑器打开`,
        });
        if (createdEmpty) st.closeEditorTab(absolutePath);
        return;
      }
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008]/.test(content.slice(0, 4096))) {
        st.showToast({
          type: "error",
          title: "无法编辑",
          description: `${change.fileName} 不是文本文件`,
        });
        if (createdEmpty) st.closeEditorTab(absolutePath);
        return;
      }
      if (createdEmpty) st.fillEditorTabContent(absolutePath, content);
      // 内容就绪后再请求定位：编辑器 effect 收到请求时 doc 已是新内容，行号
      // 才落得准（先请求后填内容会被 clamp 到旧文档的行数上）。
      if (target) {
        st.revealEditorRange(absolutePath, target.start, target.end);
      }
    } catch (e: any) {
      // 诊断：把实际尝试读取的绝对路径与 workDir 带出来，便于定位是路径拼错还是编码/权限问题
      console.warn("[Helix] openChange failed:", {
        rawFilePath: change.filePath,
        workDir: st.selectedWorkDir ?? st.activeSessionWorkDir ?? "(空)",
        absolutePath,
        error: e,
      });
      // Tauri invoke 对 Result::Err 的 reject 是字符串（没有 .message），需按字符串取
      const errText =
        (typeof e === "string" ? e : e?.message) || "读取文件出错";
      // 按错误文本分类：ENOENT（文件已被清理/未落盘）→ 友好提示；
      // 沙箱拒绝（safe_path 白名单外）→ 明确说无权读取；其余原样带出。
      const notFound =
        /os error 2|cannot find|No such file|找不到|不存在/i.test(errText);
      const outside = /outside working directory/i.test(errText);
      st.showToast({
        type: "error",
        title: "打开失败",
        description: notFound
          ? `文件已不存在（可能已被后端清理）: ${absolutePath}`
          : outside
            ? `文件在工作区外，编辑器无权读取: ${absolutePath}`
            : `${errText}｜尝试读取: ${absolutePath}`,
      });
      if (createdEmpty) st.closeEditorTab(absolutePath);
    }
  };

  const handleUndoAll = async () => {
    if (undoing || visibleChanges.length === 0) return;
    setUndoing(true);
    const failed: string[] = [];
    const restoredIds: string[] = [];
    for (const change of visibleChanges) {
      try {
        await undoChange(change);
        restoredIds.push(change.fileId);
      } catch (e) {
        failed.push(`${change.fileName}（${String(e)}）`);
      }
    }
    setUndone((prev) => new Set([...prev, ...restoredIds]));
    setUndoing(false);

    const st = useHelixStore.getState();
    if (failed.length === 0) {
      st.showToast({
        type: "success",
        title: "已撤销",
        description: `已恢复本次回复修改的 ${restoredIds.length} 个文件`,
      });
    } else {
      st.showToast({
        type: "error",
        title: "部分撤销失败",
        description: failed.join("；"),
      });
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border/40 bg-card/40">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/30 text-[length:var(--helix-transcript-size)] text-foreground/70">
        <span className="font-medium">已修改</span>
        <span className="text-[length:var(--helix-transcript-size)] text-muted-foreground">
          {visibleChanges.length} 个文件
        </span>
        <span className="ml-auto flex items-center gap-2 text-[length:var(--helix-transcript-size)] tabular-nums">
          {totalAdded > 0 && (
            <span className="text-emerald-500">+{totalAdded}</span>
          )}
          {totalRemoved > 0 && (
            <span className="text-red-500">-{totalRemoved}</span>
          )}
        </span>
        <button
          type="button"
          onClick={handleUndoAll}
          disabled={undoing}
          className="ml-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded text-[length:var(--helix-transcript-size)] text-foreground/50 hover:text-foreground hover:bg-red-500/10 disabled:opacity-50 transition-colors"
        >
          <Undo2 className={`size-3.5 ${undoing ? "animate-pulse" : ""}`} />
          {undoing ? "撤销中" : "撤销"}
        </button>
      </div>
      {visibleChanges.map((change, idx) => {
        const s = stats[idx];
        return (
          <div
            key={change.fileId}
            className="border-b border-border/20 last:border-b-0"
          >
            <div className="flex items-center hover:bg-muted/40 transition-colors">
              <button
                type="button"
                onClick={() => openChange(change)}
                className="flex flex-1 min-w-0 items-center gap-1.5 px-3 py-1.5 text-left"
              >
                <FileCode className="size-3.5 shrink-0 text-sky-500/80" />
                <span className="break-all font-mono text-[length:var(--helix-transcript-size)] text-foreground/70">
                  {change.fileName}
                </span>
                <span className="shrink-0 tabular-nums text-[length:var(--helix-transcript-size)]">
                  {s.added > 0 && (
                    <span className="text-emerald-500 mr-1.5">+{s.added}</span>
                  )}
                  {s.removed > 0 && (
                    <span className="text-red-500">-{s.removed}</span>
                  )}
                </span>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
