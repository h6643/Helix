"use client";

import { useEffect, useRef, useState } from "react";
import { GitBranch, Search, Plus, Check, AlertCircle, X } from "lucide-react";
import { isElectron, electronGit } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

interface DirtyFile {
  name: string;
  added: number;
  removed: number;
}

interface BranchPickerProps {
  workDir: string | null;
  currentBranch: string | null;
  onBranchChange: (branch: string) => void;
  /** Popover direction relative to the trigger. 'down' for the conversation
   *  header (room below), 'up' for bottom-anchored bars. */
  drop?: "up" | "down";
  /** Optional extra classes for the trigger button. */
  className?: string;
}

/**
 * A clickable Git branch selector. The trigger shows the current branch;
 * clicking it opens a popover listing every local branch (with a search box),
 * lets you switch branches, and create + checkout a new one.
 *
 * When uncommitted changes exist and the user tries to switch branches,
 * a VSCode-style "Commit & Switch" modal is shown listing every affected
 * file with +/- line counts, offering "Cancel" or "Commit & Switch…".
 */
export function BranchPicker({
  workDir,
  currentBranch,
  onBranchChange,
  drop = "down",
  className,
}: BranchPickerProps) {
  const storeActions = useHelixStore.getState();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [dirtyCount, setDirtyCount] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // ── "Commit & Switch" confirmation dialog state ──
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    targetBranch: string;
    files: DirtyFile[];
    committing: boolean;
  }>({ open: false, targetBranch: "", files: [], committing: false });

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Close confirm dialog on Escape.
  useEffect(() => {
    if (!confirmDialog.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape")
        setConfirmDialog((prev) => ({ ...prev, open: false }));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmDialog.open]);

  const refresh = () => {
    if (!isElectron() || !workDir) return;
    electronGit
      .branchList(workDir)
      .then((res: { ok: boolean; branches?: string[]; error?: string }) => {
        if (res.ok && res.branches) setList(res.branches);
      })
      .catch(() => {});
    electronGit
      .status(workDir)
      .then((res: { ok: boolean; output?: string }) => {
        if (res.ok && res.output) {
          const lines = res.output.split("\n");
          const count = lines.filter((l) => /^[12]/.test(l)).length;
          setDirtyCount(count);
        } else {
          setDirtyCount(0);
        }
      })
      .catch(() => setDirtyCount(0));
  };

  /** Parse `git diff --numstat` output into DirtyFile[]. */
  const parseNumstat = (output: string): DirtyFile[] =>
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) return null;
        return { name: m[3], added: Number(m[1]), removed: Number(m[2]) };
      })
      .filter((f): f is DirtyFile => f !== null);

  const handleOpen = () => {
    const willOpen = !open;
    setOpen(willOpen);
    setSearch("");
    setCreating(false);
    setNewName("");
    if (willOpen) refresh();
  };

  const handleSwitch = async (b: string) => {
    if (!isElectron() || !workDir) return;

    // If there are dirty files, show the confirmation dialog.
    if (dirtyCount > 0) {
      try {
        const res = await electronGit.diffNumstat(workDir);
        if (res.ok && res.output) {
          const files = parseNumstat(res.output);
          setConfirmDialog({
            open: true,
            targetBranch: b,
            files,
            committing: false,
          });
          setOpen(false);
          return;
        }
      } catch (_) {
        /* fall through to direct switch */
      }
    }

    // No dirty files (or fetch failed) — switch directly.
    doSwitch(b);
  };

  const doSwitch = async (b: string) => {
    const res = await electronGit.branchSwitch(b, workDir);
    if (res.ok) {
      onBranchChange(b);
      setOpen(false);
      storeActions.showToast({ type: "success", title: `已切换到 ${b}` });
    } else {
      storeActions.showToast({
        type: "error",
        title: "切换分支失败",
        description: res.error,
      });
    }
  };

  /** Commit all changes then switch to the target branch. */
  const commitAndSwitch = async () => {
    setConfirmDialog((prev) => ({ ...prev, committing: true }));
    const commitRes = await electronGit.commit(
      `chore: 切换前自动提交 (${new Date().toLocaleString("zh-CN")})`,
    );
    if (!commitRes.ok) {
      storeActions.showToast({
        type: "error",
        title: "提交失败",
        description: commitRes.error,
      });
      setConfirmDialog((prev) => ({ ...prev, committing: false }));
      return;
    }
    await doSwitch(confirmDialog.targetBranch);
    setConfirmDialog({
      open: false,
      targetBranch: "",
      files: [],
      committing: false,
    });
  };

  const handleCreate = async (name: string) => {
    if (!isElectron() || !workDir) return;
    const res = await electronGit.branchCreate(name, workDir);
    if (res.ok) {
      onBranchChange(name);
      setOpen(false);
      storeActions.showToast({
        type: "success",
        title: `已创建并检出 ${name}`,
      });
      // Refresh list so the new branch shows up next time.
      electronGit
        .branchList(workDir)
        .then((r: { ok: boolean; branches?: string[] }) => {
          if (r.ok && r.branches) setList(r.branches);
        })
        .catch(() => {});
    } else {
      storeActions.showToast({
        type: "error",
        title: "创建分支失败",
        description: res.error,
      });
    }
  };

  const popoverPosition =
    drop === "up" ? "bottom-full left-0 mb-1.5" : "top-full left-0 mt-1.5";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={handleOpen}
        disabled={!currentBranch}
        className={`flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/60 bg-accent/40 px-2 py-1 rounded-lg shrink-0 transition-colors hover:text-foreground hover:bg-accent/60 disabled:opacity-50 disabled:cursor-default ${className ?? ""}`}
        data-tip={currentBranch ? `当前分支：${currentBranch}` : undefined}
      >
        <GitBranch className="size-3.5 text-muted-foreground" />
        <span className="whitespace-nowrap">{currentBranch}</span>
      </button>
      {open && (
        <div
          className={`absolute ${popoverPosition} w-64 bg-background/95 backdrop-blur-sm rounded-xl border border-border/30 shadow-lg shadow-black/8 z-50 flex flex-col max-h-80`}
        >
          {/* Search */}
          <div className="px-3 pt-2.5 pb-1.5 border-b border-border/20">
            <div className="flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
              <Search className="size-3.5 shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索分支"
                className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground/50"
                autoFocus
              />
            </div>
          </div>

          {/* Branch list */}
          <div className="flex-1 overflow-y-auto py-1 min-h-0">
            <div className="px-3 py-1 text-[calc(var(--helix-transcript-size)*0.7857)] font-medium text-muted-foreground">
              分支
            </div>
            {list
              .filter(
                (b) =>
                  !search || b.toLowerCase().includes(search.toLowerCase()),
              )
              .map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => handleSwitch(b)}
                  className={`w-full flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.9286)] px-3 py-1.5 transition-colors ${b === currentBranch ? "bg-primary/8 text-primary" : "text-foreground/80 hover:bg-muted/40"}`}
                >
                  <GitBranch className="size-3.5 shrink-0 text-foreground/40" />
                  <span className="truncate flex-1 text-left">{b}</span>
                  {b === currentBranch && (
                    <div className="flex items-center gap-2 shrink-0">
                      {dirtyCount > 0 && (
                        <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground">
                          未提交：{dirtyCount} 个文件
                        </span>
                      )}
                      <Check
                        className="size-4 text-primary"
                        strokeWidth={2.5}
                      />
                    </div>
                  )}
                </button>
              ))}
          </div>

          {/* Create branch */}
          <div className="border-t border-border/20">
            {!creating ? (
              <button
                type="button"
                onClick={() => {
                  setCreating(true);
                  setNewName("");
                }}
                className="w-full flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] px-3 py-2 text-foreground/50 hover:text-foreground hover:bg-muted/30 transition-colors"
              >
                <Plus className="size-3" />
                创建并检出新分支...
              </button>
            ) : (
              <div className="px-3 py-2 space-y-1.5">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newName.trim())
                      handleCreate(newName.trim());
                    if (e.key === "Escape") setCreating(false);
                  }}
                  placeholder="新分支名称"
                  className="w-full text-[calc(var(--helix-transcript-size)*0.8571)] px-2 py-1 rounded-md bg-muted/40 border border-border/30 outline-none focus:border-primary/50"
                  autoFocus
                />
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleCreate(newName.trim())}
                    disabled={!newName.trim()}
                    className="flex-1 text-[calc(var(--helix-transcript-size)*0.7857)] py-1 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-30"
                  >
                    创建
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreating(false)}
                    className="flex-1 text-[calc(var(--helix-transcript-size)*0.7857)] py-1 rounded-md bg-muted/40 text-foreground/70 hover:bg-muted/60 transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── "Commit & Switch" confirmation modal (VSCode-style) ── */}
      {confirmDialog.open && typeof window !== "undefined" && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/30 z-[300]"
            onClick={() =>
              setConfirmDialog((prev) => ({ ...prev, open: false }))
            }
          />
          {/* Dialog */}
          <div className="fixed z-[310] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[520px] max-h-[70vh] bg-card rounded-xl border border-border/50 shadow-2xl flex flex-col overflow-hidden">
            {/* Header */}
            <div className="shrink-0 px-5 pt-5 pb-1 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-[calc(var(--helix-transcript-size)*1.1429)] font-semibold text-foreground leading-tight">
                  提交更改以切换分支
                </h3>
                <p className="mt-1 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
                  你对以下文件的更改将被检出操作覆盖：
                </p>
              </div>
              <button
                onClick={() =>
                  setConfirmDialog((prev) => ({ ...prev, open: false }))
                }
                className="shrink-0 p-1 rounded text-foreground/40 hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Warning */}
            <div className="shrink-0 mx-5 mt-3 px-3 py-2.5 rounded-lg bg-warning/8 border border-warning/20 flex items-start gap-2.5">
              <AlertCircle className="size-4 text-warning mt-0.5 shrink-0" />
              <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-warning/90 font-medium">
                请先提交当前更改，再继续切换分支。
              </span>
            </div>

            {/* File list */}
            <div className="flex-1 min-h-0 mx-5 mt-3 mb-4 border border-border/30 rounded-lg overflow-hidden flex flex-col">
              <div className="shrink-0 px-3 py-2 bg-muted/30 border-b border-border/20 flex items-center justify-between">
                <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/80">
                  受影响文件
                </span>
                <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground">
                  {confirmDialog.files.length} 个文件
                </span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto max-h-[280px]">
                {confirmDialog.files.map((f) => (
                  <div
                    key={f.name}
                    className="flex items-center gap-2.5 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.9286)] border-b border-border/10 last:border-b-0 hover:bg-accent/30 transition-colors"
                  >
                    <GitBranch className="size-3.5 shrink-0 text-primary/60" />
                    <span className="truncate flex-1 min-w-0 text-foreground/80">
                      {f.name}
                    </span>
                    <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400 font-medium">
                      +{f.added}
                    </span>
                    <span className="shrink-0 tabular-nums text-red-500 dark:text-red-400 font-medium">
                      −{f.removed}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Footer buttons */}
            <div className="shrink-0 px-5 pb-5 flex items-center justify-end gap-2.5">
              <button
                onClick={() =>
                  setConfirmDialog((prev) => ({ ...prev, open: false }))
                }
                disabled={confirmDialog.committing}
                className="px-4 py-2 rounded-lg text-[calc(var(--helix-transcript-size)*0.9286)] font-medium text-foreground/70 bg-muted/50 hover:bg-muted/80 transition-colors disabled:opacity-40"
              >
                取消
              </button>
              <button
                onClick={commitAndSwitch}
                disabled={confirmDialog.committing}
                className="px-4 py-2 rounded-lg text-[calc(var(--helix-transcript-size)*0.9286)] font-medium text-white bg-foreground hover:bg-foreground/90 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {confirmDialog.committing && (
                  <svg
                    className="animate-spin size-4"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="3"
                      className="opacity-25"
                    />
                    <path
                      d="M4 12a8 8 0 018-8"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      className="opacity-75"
                    />
                  </svg>
                )}
                提交并切换分支…
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
