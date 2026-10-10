"use client";

import {
  CircleCheck,
  ExternalLink,
  GitPullRequest,
  Info,
  Link2,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { isElectron } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

interface PrPanelProps {
  onClose: () => void;
}

interface GhStatus {
  available: boolean;
  authenticated: boolean;
  hint?: string;
}

interface RepoInfo {
  host?: string;
  owner?: string;
  repo?: string;
  head?: string | null;
  base?: string;
  uncommitted?: number;
  code?: string;
  error?: string;
}

interface PrResult {
  method?: "gh" | "compare";
  url?: string;
  head?: string;
  base?: string;
  ghError?: string;
  note?: string;
}

export function PrPanel({ onClose }: PrPanelProps) {
  const showToast = useHelixStore((s) => s.showToast);
  const workDir = useHelixStore(
    (s) => s.activeSessionWorkDir ?? s.selectedWorkDir,
  );

  const [gh, setGh] = useState<GhStatus | null>(null);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [result, setResult] = useState<PrResult | null>(null);
  const [blocker, setBlocker] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = window.electron?.github;
    if (!api || !workDir) return;
    setLoading(true);
    setBlocker(null);
    try {
      const [ghInfo, repoInfo] = await Promise.all([
        api.ghStatus(workDir),
        api.repo(workDir),
      ]);
      setGh({
        available: !!ghInfo.available,
        authenticated: !!ghInfo.authenticated,
        hint: ghInfo.hint,
      });
      if (!repoInfo.ok) {
        setRepo(null);
        setBlocker(repoInfo.error || "无法读取仓库信息");
      } else {
        setRepo(repoInfo);
      }
    } catch (e) {
      setBlocker(String(e));
    } finally {
      setLoading(false);
    }
  }, [workDir]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const api = window.electron?.github;
    if (!api) return;
    setSubmitting(true);
    try {
      const r = await api.prCreate({
        title: title.trim() || undefined,
        body: body.trim() || undefined,
        base: repo?.base,
        cwd: workDir ?? undefined,
        draft,
      });
      if (r.ok) {
        setResult(r);
        showToast({
          type: "success",
          title: r.method === "gh" ? "PR 已创建" : "分支已推送",
          description:
            r.method === "gh"
              ? r.url
              : "未装 gh，已在浏览器打开确认页，点一下即提交",
        });
        if (r.method === "compare" && r.url) {
          void window.electron?.shell?.open?.(r.url);
        }
      } else {
        setBlocker(r.error || "创建失败");
      }
    } catch (e) {
      setBlocker(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (!isElectron()) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground">
          PR 功能仅在桌面版可用
        </p>
      </div>
    );
  }

  const uncommitted = repo?.uncommitted ?? 0;
  const sameBranch =
    !!repo?.head && !!repo?.base && repo.head === repo.base;

  return (
    <div className="h-full flex flex-col bg-background select-none">
      <div className="shrink-0 px-4 pr-36 py-3 border-b border-border/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitPullRequest className="size-4 text-muted-foreground" />
          <h2 className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
            创建 Pull Request
          </h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
            data-tip="重新读取仓库状态"
          >
            <RefreshCw
              className={`size-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
          >
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)]">
              关闭
            </span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {/* 仓库与分支 */}
        <div className="rounded-xl border border-border/50 bg-card/50 px-3.5 py-3 space-y-1.5">
          <p className="text-[calc(var(--helix-transcript-size)*0.8571)] font-mono text-foreground/80 truncate">
            {repo?.owner ? `${repo.owner}/${repo.repo}` : "—"}
          </p>
          <div className="flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.7857)] font-mono">
            <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground truncate max-w-[12rem]">
              {repo?.head ?? "游离 HEAD"}
            </span>
            <span className="text-muted-foreground/50">→</span>
            <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground truncate max-w-[12rem]">
              {repo?.base ?? "main"}
            </span>
          </div>
          {/* gh 状态只影响最后一步是直建还是浏览器确认，这里说清楚 */}
          <p className="flex items-start gap-1.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/70 pt-0.5">
            {gh?.available && gh.authenticated ? (
              <>
                <CircleCheck className="size-3 mt-0.5 text-emerald-500 shrink-0" />
                <span>检测到已登录的 gh CLI，将直接创建 PR</span>
              </>
            ) : gh?.available ? (
              <>
                <TriangleAlert className="size-3 mt-0.5 text-amber-500 shrink-0" />
                <span>{gh.hint ?? "gh 已安装但未登录"}</span>
              </>
            ) : (
              <>
                <Info className="size-3 mt-0.5 shrink-0" />
                <span>
                  未安装 gh CLI：这里会推送分支并给出 GitHub 确认页链接
                </span>
              </>
            )}
          </p>
        </div>

        {/* 拦截项：改动没提交 / 就在基线分支上 */}
        {(uncommitted > 0 || sameBranch || blocker) && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-3.5 py-3 space-y-1.5">
            {blocker && (
              <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-amber-500 break-words">
                {blocker}
              </p>
            )}
            {uncommitted > 0 && (
              <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground">
                有 {uncommitted} 个未提交改动 —— PR 只包含已提交的内容，先提交（
                <button
                  onClick={() => {
                    onClose();
                    useHelixStore.getState().setRightSidebarTab("diff");
                  }}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  查看「更改」
                </button>
                ）
              </p>
            )}
            {sameBranch && (
              <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground">
                当前就在 <span className="font-mono">{repo?.base}</span> 分支上，
                先切一个功能分支
              </p>
            )}
          </div>
        )}

        {result ? (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-3.5 py-3 space-y-2">
            <p className="flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-emerald-500">
              <CircleCheck className="size-3.5" />
              {result.method === "gh"
                ? "PR 已创建"
                : `分支 ${result.head} 已推送，去浏览器点最后一步`}
            </p>
            {result.url && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void window.electron?.shell?.open?.(result.url!)}
                  className="px-2.5 py-1 flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                >
                  <ExternalLink className="size-3" />
                  打开 {result.url.replace(/^https:\/\//, "").slice(0, 40)}
                </button>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(result.url!);
                      showToast({ type: "success", title: "链接已复制" });
                    } catch {
                      showToast({ type: "error", title: "复制失败" });
                    }
                  }}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
                  data-tip="复制链接"
                >
                  <Link2 className="size-3.5" />
                </button>
              </div>
            )}
            {result.ghError && (
              <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground break-words">
                gh 报错（已改用浏览器确认）：{result.ghError}
              </p>
            )}
            {result.note && (
              <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
                {result.note}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                gh?.authenticated
                  ? "标题（留空则由 gh 从提交信息推断）"
                  : "标题（会预填进 GitHub 确认页）"
              }
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/40"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="描述（可选）"
              rows={5}
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[calc(var(--helix-transcript-size)*0.9286)] text-foreground placeholder:text-muted-foreground/40 resize-y font-mono"
            />
            <label className="flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={draft}
                onChange={(e) => setDraft(e.target.checked)}
                className="size-3 accent-primary"
              />
              先存为草稿 PR（仅 gh 路径支持）
            </label>
          </div>
        )}
      </div>

      {!result && (
        <div className="shrink-0 px-4 py-3 border-t border-border/40 flex justify-end">
          <button
            onClick={() => void create()}
            disabled={
              submitting ||
              loading ||
              !repo ||
              uncommitted > 0 ||
              sameBranch ||
              !repo.head
            }
            className="px-3.5 py-2 flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <GitPullRequest className="size-3.5" />
            )}
            推送分支并创建 PR
          </button>
        </div>
      )}
    </div>
  );
}
