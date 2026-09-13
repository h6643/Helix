"use client";

import { FilePlus } from "lucide-react";
import { useGitChangeStat } from "@/hooks/use-git-change-stat";
import { useHelixStore } from "@/stores/helix-store";

/**
 * Right-sidebar "更改" tab：git 工作区「未提交的更改」的真实状态，逐文件
 * +N/-M（二进制标注）。工作面板（右上角）只显示总体数字，明细统一放在这里。
 *
 * 文件列表**铺满整个面板**（原先 max-h-72 + 底部弹性空白会把列表截断、
 * 下面留一大块无意义的空白）。提交 / 提交并推送统一走右上角工作面板，
 * 这里不再重复一份提交框。
 */
export function DiffSidebarPanel() {
  const currentWorkDir = useHelixStore((s) => s.selectedWorkDir);
  const activeSessionWorkDir = useHelixStore((s) => s.activeSessionWorkDir);
  const currentSessionId = useHelixStore((s) => s.currentSessionId);

  // 与右上角「更改」胶囊同一口径：活跃会话用自己的目录，全新对话才回退到
  // 已选项目目录（项目外会话保持隐藏）。
  const gitWorkDir =
    activeSessionWorkDir ?? (currentSessionId === null ? currentWorkDir : null);
  const gitStat = useGitChangeStat(gitWorkDir);

  return (
    <div className="h-full w-full flex flex-col min-h-0 bg-card">
      {gitStat ? (
        <section className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
          <div className="shrink-0 flex items-center gap-2 min-w-0 px-3 py-2">
            <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-semibold">
              未提交的更改
            </span>
            <span className="shrink-0 flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.7143)] tabular-nums">
              <span className="text-muted-foreground">
                {gitStat.files.length} 个文件
              </span>
              <span className="text-emerald-500">+{gitStat.added}</span>
              <span className="text-red-500">-{gitStat.removed}</span>
            </span>
          </div>
          {/* 列表吃掉剩余全部高度（flex-1 + min-h-0），文件多就自己滚。 */}
          <ul className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1 pb-1.5">
            {gitStat.files.map((f) => (
              <li
                key={f.path}
                title={f.path}
                className="flex items-center gap-2 min-w-0 px-2 py-1 rounded text-[calc(var(--helix-transcript-size)*0.7857)] hover:bg-accent/40 transition-colors"
              >
                <FilePlus className="size-3.5 text-foreground/40 shrink-0" />
                <span className="flex-1 min-w-0 truncate font-mono text-foreground/80">
                  {f.path}
                </span>
                {f.binary ? (
                  <span className="shrink-0 text-foreground/40">二进制</span>
                ) : (
                  <>
                    <span className="shrink-0 tabular-nums text-emerald-500">
                      +{f.added}
                    </span>
                    <span className="shrink-0 tabular-nums text-red-500">
                      -{f.removed}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        // 无改动 / 非 git 仓库 / 非 Electron：给一句说明，不留一块死白。
        <div className="flex-1 min-h-0 flex items-center justify-center px-4 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
          没有未提交的更改
        </div>
      )}
    </div>
  );
}
