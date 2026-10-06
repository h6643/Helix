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
 *
 * `runSnapshotId`：本轮开跑前那次整轮快照的 id（见 agent-flow-panel 的
 * takeRunSnapshot）。有它才能兜底撤销 `undoUnsafe` 的改动。
 */
export function FileChangeSummaryCard({
  changes,
  runSnapshotId,
}: {
  changes: PendingChange[];
  runSnapshotId?: string;
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

  /**
   * 逐文件撤销：把这一条改动还原成改动前的内容（本轮新建的文件直接删掉）。
   * 调用方必须已经排除 `undoUnsafe` 的条目——反推原理与拒绝理由见 handleUndoRun。
   */
  const undoChange = async (change: PendingChange) => {
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

  /**
   * 「撤销本轮」= 两段式还原，缺一不可：
   *
   * 1. **逐文件反推 diff**：覆盖本轮真正改过的文件，**包括本轮新建的**（diff 里
   *    的 `--- /dev/null` → 直接删）。
   * 2. **本轮快照兜底**：`undoUnsafe` 的条目在第 1 步被跳过——那是网关标的"这份
   *    diff 不能拿去反推撤销"（pi 的 write 结果不带 diff，覆盖前读不到旧内容时
   *    只能按"原文件为空"假想一个 patch；diff 过长被截断时也置位）。
   *    `reverseUnifiedDiff` 按行号 splice，拿这类 diff 撤销会**静默切坏文件**，
   *    只能绕开它，用快照里存着的原文还原。
   *
   * 顺序不能反：快照只覆盖"本轮开始前 git 已认为脏"的文件，本轮新建的文件压根
   * 不在它的清单里，只有第 1 步会删。
   *
   * 没有快照（远程对话、未初始化 git 的项目）时只剩第 1 步：能撤的都撤掉，
   * undoUnsafe 的那些如实报错，不给出虚假的安全感。
   */
  const handleUndoRun = async () => {
    if (undoing) return;
    setUndoing(true);
    const api = getElectronAPI();
    const failed: string[] = [];
    const undoneIds = new Set<string>();

    for (const change of visibleChanges) {
      if (change.undoUnsafe) continue;
      try {
        await undoChange(change);
        undoneIds.add(change.fileId);
      } catch (e) {
        failed.push(`${change.fileName}（${String(e)}）`);
      }
    }

    let snapshotRestored = false;
    if (runSnapshotId) {
      try {
        const res = await api?.fs?.snapshotRestore(runSnapshotId);
        if (res?.ok) snapshotRestored = true;
        else if (res?.error && /不存在|已清理|损坏|格式错误/.test(res.error)) {
          // 消息是从磁盘恢复的旧对话，快照早没了（或当时根本没建成）：
          // 逐文件那一段该撤的已经撤了，不该再报"撤销失败"。
        } else if (res) {
          failed.push(...(res.failed ?? []));
          if (res.error) failed.push(res.error);
        } else failed.push("快照功能不可用");
      } catch (e) {
        failed.push(String(e));
      }
    } else {
      for (const c of visibleChanges) {
        if (c.undoUnsafe)
          failed.push(`${c.fileName}（改动内容不可靠且本轮无快照，请用 Git 恢复）`);
      }
    }

    if (snapshotRestored && runSnapshotId) {
      // 快照整体还原成功 → 卡片剩余条目（含被跳过的 undoUnsafe）也已回到本轮
      // 开始前，一并销账，别让卡片继续显示"还能撤销"的假状态。
      for (const c of visibleChanges) undoneIds.add(c.fileId);
      useHelixStore.setState((s) => ({
        pendingChanges: s.pendingChanges.filter((c) => !undoneIds.has(c.fileId)),
      }));
      // 快照已消费，留着只会一直涨盘。只在还原成功时删——失败时它还是这些文件
      // 唯一的"改动前"副本。
      void api?.fs?.snapshotDiscard(runSnapshotId);
    }

    setUndoing(false);
    setUndone((prev) => new Set([...prev, ...undoneIds]));

    const st = useHelixStore.getState();
    // 文件真的写回磁盘了 → 「更改」列表立刻重算，不等 5s 轮询。
    if (undoneIds.size > 0) st.bumpGitChangeRevision();
    if (failed.length === 0) {
      st.showToast({
        type: "success",
        title: "已撤销本轮",
        description: `已恢复 ${undoneIds.size} 个文件到本轮开始前的状态`,
      });
    } else {
      st.showToast({
        type: "error",
        title: undoneIds.size > 0 ? "部分撤销失败" : "撤销失败",
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
          onClick={handleUndoRun}
          disabled={undoing}
          className="ml-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded text-[length:var(--helix-transcript-size)] text-foreground/50 hover:text-foreground hover:bg-red-500/10 disabled:opacity-50 transition-colors"
          title={
            runSnapshotId
              ? "把这些文件还原到本轮开始前（本轮新建的一并删除），并用本轮快照兜底 diff 反推不了的改动"
              : "把这些文件还原到本轮开始前（本轮新建的一并删除）；本轮没有快照，diff 反推不了的改动不会被还原"
          }
        >
          <Undo2 className={`size-3.5 ${undoing ? "animate-pulse" : ""}`} />
          {undoing ? "撤销中" : "撤销本轮"}
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
