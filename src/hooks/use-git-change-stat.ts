"use client";

import { useEffect, useState } from "react";
import { electronGit, isElectron } from "@/lib/electron-bridge";

/** 单个文件在 `git diff --numstat` 里的增减行数；二进制文件无法计数。 */
export interface GitChangeFile {
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
 * 轮询工作区的 `git diff --numstat`（未暂存、已跟踪文件的改动），汇总出每个
 * 文件的 +added / -removed 以及总计。
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
        const res = await electronGit.diffNumstat(workDir);
        if (cancelled) return;
        if (!res.ok || !res.output) {
          setStat(null);
          return;
        }
        let added = 0;
        let removed = 0;
        const files: GitChangeFile[] = [];
        for (const line of res.output.split("\n")) {
          // numstat 行格式：`<added>\t<removed>\t<path>`；二进制文件为 `-\t-\t<path>`。
          const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
          if (!m) continue;
          const binary = m[1] === "-" || m[2] === "-";
          const a = binary ? 0 : Number(m[1]);
          const r = binary ? 0 : Number(m[2]);
          added += a;
          removed += r;
          files.push({ path: m[3], added: a, removed: r, binary });
        }
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
