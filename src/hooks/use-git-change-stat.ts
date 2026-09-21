"use client";

import { useEffect, useState } from "react";
import { electronGit, isElectron } from "@/lib/electron-bridge";

/** 单个文件在 `git diff --numstat` 里的增减行数；二进制文件无法计数。 */
interface GitChangeFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface GitChangeStat {
  added: number;
  removed: number;
  files: GitChangeFile[];
}

/**
 * 轮询工作区「未提交的更改」：已跟踪文件 vs HEAD（含删除、含已暂存）
 * **加上未跟踪的新文件**，汇总出每个文件的 +added / -removed 以及总计。
 *
 * - 每 5s 轮询一次（agent 改文件很频繁）；`workDir` 变化（切会话 / 切项目）或
 *   `revision` 递增（提交完成后）会立即重算。
 * - 非 Electron、无工作目录、非 git 仓库、零改动 → 返回 null，调用方据此隐藏 UI。
 *
 * 工作面板只需要总计，右侧栏「更改」tab 需要文件明细，两边共用同一份逻辑。
 */
export function useGitChangeStat(
  workDir: string | null | undefined,
  revision = 0,
): GitChangeStat | null {
  const [stat, setStat] = useState<GitChangeStat | null>(null);

  useEffect(() => {
    if (!isElectron() || !workDir) {
      setStat(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        // 用 diffNumstatFull（不是 diffNumstat）：git 不给未跟踪文件出
        // numstat，write 新建的文件在旧接口里完全不可见。
        const res = await electronGit.diffNumstatFull(workDir);
        if (cancelled) return;
        if (!res.ok) {
          setStat(null);
          return;
        }
        const files = (res.files ?? [])
          .filter((f) => typeof f.path === "string" && f.path.length > 0)
          .map((f) => ({
            path: f.path,
            added: f.added ?? 0,
            removed: f.removed ?? 0,
            binary: !!f.binary,
          }));
        const added = res.added ?? files.reduce((s, f) => s + f.added, 0);
        const removed = res.removed ?? files.reduce((s, f) => s + f.removed, 0);
        setStat(files.length ? { added, removed, files } : null);
      } catch {
        if (!cancelled) setStat(null);
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workDir, revision]);

  return stat;
}
