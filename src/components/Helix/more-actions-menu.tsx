"use client";

import {
  FileDiff,
  FileSearch,
  GitPullRequest,
  Globe,
  MessagesSquare,
} from "lucide-react";

interface MoreActionsMenuProps {
  onToggleTab: (kind: "browser" | "diff") => void;
  /** 点「浏览器」时总是新开一个浏览器页（多开）。缺省时退化为 onToggleTab（切换）。 */
  onAddBrowser?: () => void;
  /** 打开右侧「旁路问答」面板（等价于裸 `/btw`）。 */
  onOpenByline?: () => void;
  /** 打开 PR 面板（推送分支 + 建 PR，等价于「更改」卡片的下一步）。 */
  onOpenPr?: () => void;
  /** 打开诊断面板（跑项目自带的类型检查/lint）。 */
  onOpenDiagnostics?: () => void;
}

/**
 * The conversation header's "更多操作" dropdown (浏览器 / 更改 / 旁路问答), extracted
 * so the right sidebar's "＋" can reuse the exact same actions.
 */
export function MoreActionsMenu({
  onToggleTab,
  onAddBrowser,
  onOpenByline,
  onOpenPr,
  onOpenDiagnostics,
}: MoreActionsMenuProps) {
  return (
    <div className="w-52 helix-popover-glass border border-border/40 rounded-xl shadow-xl py-1">
      <button
        data-tip="浏览器"
        onClick={() => (onAddBrowser ? onAddBrowser() : onToggleTab("browser"))}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
      >
        <Globe className="size-3.5" />
        <span className="flex-1 text-left">浏览器</span>
      </button>
      <button
        data-tip="更改"
        onClick={() => onToggleTab("diff")}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
      >
        <FileDiff className="size-3.5" />
        <span className="flex-1 text-left">更改</span>
      </button>
      {onOpenPr && (
        <button
          data-tip="创建 PR"
          onClick={onOpenPr}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
        >
          <GitPullRequest className="size-3.5" />
          <span className="flex-1 text-left">创建 PR</span>
        </button>
      )}
      {onOpenDiagnostics && (
        <button
          data-tip="诊断"
          onClick={onOpenDiagnostics}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
        >
          <FileSearch className="size-3.5" />
          <span className="flex-1 text-left">诊断</span>
        </button>
      )}
      {onOpenByline && (
        <button
          data-tip="旁路问答"
          onClick={onOpenByline}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
        >
          <MessagesSquare className="size-3.5" />
          <span className="flex-1 text-left">旁路问答</span>
        </button>
      )}
    </div>
  );
}
