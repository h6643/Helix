"use client";

import { useEffect, useState } from "react";
import { electronGit, isElectron } from "@/lib/electron-bridge";
import { isRemoteWorkDir } from "@/lib/remote-projects";
import { useHelixStore } from "@/stores/helix-store";
import type { GitNumstatFailureCode } from "@/types/electron";

/** 单个文件在 `git diff --numstat` 里的增减行数；二进制文件无法计数。 */
interface GitChangeFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

interface GitChangeStat {
  added: number;
  removed: number;
  files: GitChangeFile[];
}

/**
 * 「统计不了」的原因。`no_work_dir` / `remote` / `git_unavailable`（当前环境没有
 * git IPC）在这里同步判定，后四种来自后端 `git.rs` 的 `code` 字段。
 *
 * 存在的意义：以前所有失败都渲染成「没有未提交的更改」，于是「这不是仓库」和
 * 「真的没改动」长得一模一样，用户只能瞎猜。
 */
export type GitStatUnavailable =
  | "no_work_dir"
  | "remote"
  | "not_a_repository"
  | "git_unavailable"
  | "git_timeout"
  | "work_dir_not_found"
  | "git_failed";

export interface GitChangeState {
  /** 有未提交改动时的明细；干净或统计不了时为 null。 */
  stat: GitChangeStat | null;
  /** `stat === null` 时的原因；「干净」为 null（那是唯一的"没问题"状态）。 */
  unavailable: GitStatUnavailable | null;
  /** 后端的原始错误文本，供悬停排查（不发请求就能判定的三种没有它）。 */
  detail: string | null;
}

const CLEAN: GitChangeState = {
  stat: null,
  unavailable: null,
  detail: null,
};

/**
 * 轮询工作区「未提交的更改」：已跟踪文件 vs HEAD（含删除、含已暂存）
 * **加上未跟踪的新文件**，汇总出每个文件的 +added / -removed 以及总计。
 *
 * - 每 5s 轮询一次；`workDir` 变化（切会话 / 切项目）或 store 的
 *   `gitChangeRevision` 递增（edit/write 登记、卡片撤销、提交完成）会重算。
 *   重算延迟 400ms 合并：一轮里十几个 write 连着登记时，不要每个工具结束都起
 *   一个 `git` 子进程。
 * - 工作面板只需要总计，右侧栏「更改」tab 需要文件明细，两边共用同一份逻辑。
 * - 云端对话（`remote://…` 虚拟键）不发请求：本机 git 打不开远端仓库。
 */
export function useGitChangeStat(
  workDir: string | null | undefined,
): GitChangeState {
  // 不用发请求就能判定的三种：同步算，避免先闪一下「没有未提交的更改」。
  const preflight: GitStatUnavailable | null = !workDir
    ? "no_work_dir"
    : isRemoteWorkDir(workDir)
      ? "remote"
      : !isElectron()
        ? "git_unavailable"
        : null;
  const revision = useHelixStore((s) => s.gitChangeRevision);
  const [probed, setProbed] = useState<GitChangeState>(CLEAN);

  useEffect(() => {
    if (preflight) return;
    let cancelled = false;
    const load = async () => {
      try {
        // 用 diffNumstatFull（不是 diffNumstat）：git 不给未跟踪文件出
        // numstat，write 新建的文件在旧接口里完全不可见。
        const res = await electronGit.diffNumstatFull(workDir);
        if (cancelled) return;
        if (!res.ok) {
          setProbed({
            stat: null,
            unavailable:
              (res.code as GitNumstatFailureCode | undefined) ?? "git_failed",
            detail: res.error ?? null,
          });
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
        if (!files.length) {
          // 仓库里确实没有未提交改动 —— 与「统计不了」是两种状态。
          setProbed(CLEAN);
          return;
        }
        const added = res.added ?? files.reduce((s, f) => s + f.added, 0);
        const removed = res.removed ?? files.reduce((s, f) => s + f.removed, 0);
        setProbed({
          stat: { added, removed, files },
          unavailable: null,
          detail: null,
        });
      } catch (e) {
        if (!cancelled) {
          setProbed({
            stat: null,
            unavailable: "git_unavailable",
            detail: String(e),
          });
        }
      }
    };
    const timer = setTimeout(load, 400);
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [workDir, preflight, revision]);

  return preflight
    ? { stat: null, unavailable: preflight, detail: null }
    : probed;
}
