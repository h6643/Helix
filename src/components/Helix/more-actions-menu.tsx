"use client";

import { FileDiff, Globe } from "lucide-react";

interface MoreActionsMenuProps {
  onToggleTab: (kind: "browser" | "diff") => void;
  /** 点「浏览器」时总是新开一个浏览器页（多开）。缺省时退化为 onToggleTab（切换）。 */
  onAddBrowser?: () => void;
}

/**
 * The conversation header's "更多操作" dropdown (浏览器 / 变更), extracted
 * so the right sidebar's "＋" can reuse the exact same actions.
 */
export function MoreActionsMenu({
  onToggleTab,
  onAddBrowser,
}: MoreActionsMenuProps) {
  return (
    <div className="w-52 bg-card border border-border/80 rounded-lg shadow-xl py-1">
      <button
        data-tip="浏览器"
        onClick={() => (onAddBrowser ? onAddBrowser() : onToggleTab("browser"))}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
      >
        <Globe className="size-3.5" />
        <span className="flex-1 text-left">浏览器</span>
      </button>
      <button
        data-tip="变更"
        onClick={() => onToggleTab("diff")}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
      >
        <FileDiff className="size-3.5" />
        <span className="flex-1 text-left">变更</span>
      </button>
    </div>
  );
}
