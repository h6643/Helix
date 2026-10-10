"use client";

import { FileDiff, Globe, MessagesSquare, TerminalSquare } from "lucide-react";

interface MoreActionsMenuProps {
  onToggleTab: (kind: "browser" | "diff" | "terminal") => void;
  /** 点「浏览器」时总是新开一个浏览器页（多开）。缺省时退化为 onToggleTab（切换）。 */
  onAddBrowser?: () => void;
  /** 打开右侧「旁路问答」面板（等价于裸 `/btw`）。 */
  onOpenByline?: () => void;
}

/**
 * The conversation header's "更多操作" dropdown (浏览器 / 更改 / 终端 / 旁路问答), extracted
 * so the right sidebar's "＋" can reuse the exact same actions. 「终端」开在右侧边栏的
 * 一页里，与标题栏「终端」的主区底部抽屉是两个宿主、两套 shell。
 */
export function MoreActionsMenu({
  onToggleTab,
  onAddBrowser,
  onOpenByline,
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
      <button
        data-tip="终端"
        onClick={() => onToggleTab("terminal")}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
      >
        <TerminalSquare className="size-3.5" />
        <span className="flex-1 text-left">终端</span>
      </button>
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
