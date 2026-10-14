"use client";

import {
  FileDiff,
  FileText,
  Globe,
  ListTree,
  MessagesSquare,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import { electronDialog } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

interface MoreActionsCard {
  key: string;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}

/**
 * 右侧边栏的「更多操作」页：一列卡片，每张卡开右侧面板的一面。
 * 卡片只有图标 + 标题——第二行的说明、快捷键都不放（快捷键仍生效，见
 * DEFAULT_SHORTCUTS / keyboard-shortcuts）。
 *
 * 为什么不做成标题栏的小弹窗：右侧面板本来就是一块常驻的区域，菜单摊开成面板里的
 * 一页，点完还能看见自己打开了什么；弹窗一关信息就没了。标题栏「右侧边栏」按钮
 * 与侧栏「＋」都落到这一页（tab = "more"）。
 */
export function MoreActionsPage() {
  const cards: MoreActionsCard[] = [
    {
      key: "browser",
      icon: Globe,
      label: "打开内置浏览器",
      onClick: () => useHelixStore.getState().requestAddBrowserPage(),
    },
    {
      key: "review",
      icon: FileDiff,
      label: "打开审阅",
      onClick: () => useHelixStore.getState().setRightSidebarTab("diff"),
    },
    {
      key: "tree",
      icon: ListTree,
      label: "会话树",
      onClick: () => useHelixStore.getState().setRightSidebarTab("tree"),
    },
    {
      key: "terminal",
      icon: TerminalSquare,
      label: "打开终端",
      onClick: () => useHelixStore.getState().setRightSidebarTab("terminal"),
    },
    {
      key: "byline",
      icon: MessagesSquare,
      label: "旁路问答",
      onClick: () => {
        const st = useHelixStore.getState();
        st.setRightSidebarTab("byline");
        st.focusBylineInput();
      },
    },
  ];

  return (
    // 整列卡片在面板里居中（`m-auto` 而不是 items-center：列比面板高时
    // items-center 会把顶部裁掉且滚不上去，m-auto 超高时两侧 auto 退化为 0）。
    <div className="flex-1 min-h-0 min-w-0 overflow-y-auto p-4 flex flex-col">
      <div className="m-auto w-full max-w-[280px] flex flex-col gap-2">
        {cards.map((card) => (
          <button
            key={card.key}
            onClick={card.onClick}
            className="w-full flex items-center gap-3 rounded-xl border border-border/40 bg-card/60 hover:bg-accent/40 transition-colors px-4 py-3 text-left"
          >
            <span className="shrink-0 flex items-center justify-center rounded-lg bg-muted/50 size-9">
              <card.icon className="size-4.5 text-foreground/70" />
            </span>
            <span className="min-w-0 flex-1 text-[calc(var(--helix-transcript-size)*1)] font-medium text-foreground truncate">
              {card.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
