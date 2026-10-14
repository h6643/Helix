"use client";

import {
  Aperture,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Folder,
  Search,
  Send,
  Settings,
} from "lucide-react";
import type { ReactNode, SVGProps } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  useGitChangeStat,
  type GitChangeState,
  type GitStatUnavailable,
} from "@/hooks/use-git-change-stat";
import { previewKindOf } from "@/lib/doc-preview";
import { electronFS, electronGit } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

/* ── brand icons (inline SVG) ─────────────────────────────────────────── */

function GitIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M15.698 7.287L8.712.302a.513.513 0 00-.732.014L5.562 2.44l2.396 2.396a.187.187 0 01.19.31l-1.72 2.236a.19.19 0 00.014.26l.045.045a.187.187 0 00.26-.014l1.72-2.236a.187.187 0 01.31.19l-.192 2.444 2.396 2.396a.513.513 0 00.732-.014l3.136-3.136a.513.513 0 00.014-.732zM6.554 8.01L4.23 5.687l5.614-5.614 2.324 2.324zM4.34 8.17l2.214-2.214 1.534 1.534-2.214 2.214zM8.97 10.7l1.808-1.808 1.534 1.534-1.808 1.808z" />
    </svg>
  );
}

function RustIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M8 0a4 4 0 00-4 4v.5H2.5A1.5 1.5 0 001 6v1.5h14V6a1.5 1.5 0 00-1.5-1.5H12V4a4 4 0 00-4-4zm2.5 4.5H5.5V4a2.5 2.5 0 115 0v.5zM1 8.5v5a1.5 1.5 0 001.5 1.5h11a1.5 1.5 0 001.5-1.5v-5H1zm4 1.5a1 1 0 011 1v2a1 1 0 01-2 0v-2a1 1 0 011-1zm5 0a1 1 0 011 1v2a1 1 0 01-2 0v-2a1 1 0 011-1z" />
    </svg>
  );
}

function CssIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
      <rect x="0.5" y="1" width="15" height="14" rx="2" fill="#264de4" />
      <text x="8" y="11.5" textAnchor="middle" fontSize="7" fontWeight="bold" fontFamily="monospace" fill="white">css</text>
    </svg>
  );
}

function TsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
      <rect x="0.5" y="1" width="15" height="14" rx="2" fill="#3178c6" />
      <text x="8" y="11.5" textAnchor="middle" fontSize="7" fontWeight="bold" fontFamily="monospace" fill="white">ts</text>
    </svg>
  );
}

function JsxIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
      <rect x="0.5" y="1" width="15" height="14" rx="2" fill="#61dafb" />
      <text x="8" y="11.5" textAnchor="middle" fontSize="7" fontWeight="bold" fontFamily="monospace" fill="#1a1a2e">jsx</text>
    </svg>
  );
}

function JsonIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M4 3a2 2 0 00-2 2v1.5a.5.5 0 01-1 0V5a3 3 0 013-3h.5a.5.5 0 010 1H4z" fill="#f5a623" />
      <path d="M12 3a2 2 0 012 2v1.5a.5.5 0 001 0V5a3 3 0 00-3-3h-.5a.5.5 0 000 1H12z" fill="#f5a623" />
      <path d="M4 13a2 2 0 01-2-2v-1.5a.5.5 0 00-1 0V11a3 3 0 003 3h.5a.5.5 0 000-1H4z" fill="#f5a623" />
      <path d="M12 13a2 2 0 002-2v-1.5a.5.5 0 011 0V11a3 3 0 01-3 3h-.5a.5.5 0 010-1H12z" fill="#f5a623" />
      <circle cx="8" cy="8" r="1.5" fill="#f5a623" />
    </svg>
  );
}

function HtmlIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
      <rect x="0.5" y="1" width="15" height="14" rx="2" fill="#e44d26" />
      <text x="8" y="11.5" textAnchor="middle" fontSize="7" fontWeight="bold" fontFamily="monospace" fill="white">html</text>
    </svg>
  );
}

function TomlIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
      <rect x="0.5" y="1" width="15" height="14" rx="2" fill="#9c4221" />
      <text x="8" y="11.5" textAnchor="middle" fontSize="7" fontWeight="bold" fontFamily="monospace" fill="white">toml</text>
    </svg>
  );
}

function DefaultFileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M3 1.5A1.5 1.5 0 014.5 0h3.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V14.5a1.5 1.5 0 01-1.5 1.5h-6A1.5 1.5 0 013 14.5v-13z" fill="#8b949e" opacity="0.3" />
      <path d="M4.5 0A1.5 1.5 0 003 1.5v13A1.5 1.5 0 004.5 16h6a1.5 1.5 0 001.5-1.5V4.707a1 1 0 00-.293-.707L10.293.293A1 1 0 009.586 0H4.5z" fill="none" stroke="#8b949e" strokeWidth="0.5" />
    </svg>
  );
}

/* ── icon resolver ────────────────────────────────────────────────────── */

type IconEntry = {
  match: (ext: string) => boolean;
  icon: React.FC<SVGProps<SVGSVGElement>>;
  color: string;
};

const ICON_RULES: IconEntry[] = [
  { match: (e) => e === "rs",       icon: RustIcon,   color: "text-orange-500" },
  { match: (e) => e === "gitignore" || e === "gitattributes", icon: GitIcon, color: "text-orange-600" },
  { match: (e) => e === "css" || e === "scss" || e === "less" || e === "sass", icon: CssIcon, color: "text-blue-500" },
  { match: (e) => e === "ts",        icon: TsIcon,     color: "text-blue-500" },
  { match: (e) => e === "tsx" || e === "jsx", icon: JsxIcon, color: "text-blue-400" },
  { match: (e) => e === "js" || e === "mjs" || e === "cjs", icon: Settings, color: "text-amber-400" },
  { match: (e) => e === "json" || e === "jsonc", icon: JsonIcon, color: "text-yellow-500" },
  { match: (e) => e === "html" || e === "htm", icon: HtmlIcon, color: "text-orange-500" },
  { match: (e) => e === "toml" || e === "yaml" || e === "yml", icon: TomlIcon, color: "text-amber-700" },
  { match: (e) => e === "md" || e === "mdx", icon: DefaultFileIcon, color: "text-gray-400" },
];

function getFileIconInfo(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  for (const rule of ICON_RULES) {
    if (rule.match(ext)) return rule;
  }
  return { icon: Aperture, color: "text-muted-foreground/50" };
}

/* ── helpers ──────────────────────────────────────────────────────────── */

/**
 * 「统计不了」各自的说明。以前所有失败都是同一句「没有未提交的更改」，于是
 * 「云端对话 / 不是仓库 / 没 git / 目录没了」全被当成「确实没改动」。
 * 悬停还能看到后端的原始错误（`detail`）。
 */
const UNAVAILABLE_TEXT: Record<GitStatUnavailable, string> = {
  no_work_dir: "这条对话不在项目目录里，没有可统计的仓库",
  remote: "云端对话的仓库在远端机器上，本机 git 看不到它——逐文件改动看消息里的「已修改」卡片",
  not_a_repository: "这个目录不是 git 仓库，没有可比对的基准版本",
  work_dir_not_found: "工作目录不存在，可能被删除或移动了",
  git_unavailable: "本机找不到 git 可执行文件",
  git_timeout: "git 统计超时（仓库过大或磁盘繁忙）",
  git_failed: "git 没能给出改动列表",
};

/**
 * 从 unified diff 取第一处改动在新文件里的行范围（`@@ -a,b +c,d @@` 的 c..d）。
 * 「点击更改就显示更改的地方」= 打开文件后滚到这一处并高亮（revealEditorRange）。
 */
function firstHunk(
  diffText: string,
): { start: number; end: number } | null {
  const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(diffText);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
  return { start, end: start + Math.max(0, count - 1) };
}

/**
 * Right-sidebar "更改" tab：VS Code 源代码管理式两栏。
 *   · 右栏 = 未提交改动的目录树（M/U/D 状态字母 + 筛选框），点文件选中之；
 *   · 左栏 = 选中文件的内联 diff（行号 + 增删着色 + 「N 行未改动」折叠条，
 *     点折叠条展开真实上下文 —— 后端 diff_head 带 context 参数一次拿全文）。
 * 顶部一行：未提交 + 总 +N/-M + 「提交或推送」（打开右上角统一工作面板）。
 * 双击文件 = 在「文件」面打开并跳到第一处改动。
 */
export function DiffSidebarPanel() {
  const currentWorkDir = useHelixStore((s) => s.selectedWorkDir);
  const activeSessionWorkDir = useHelixStore((s) => s.activeSessionWorkDir);
  const currentSessionId = useHelixStore((s) => s.currentSessionId);
  const showToast = useHelixStore((s) => s.showToast);
  const gitChangeRevision = useHelixStore((s) => s.gitChangeRevision);

  const gitWorkDir =
    activeSessionWorkDir ?? (currentSessionId === null ? currentWorkDir : null);
  const git = useGitChangeStat(gitWorkDir);
  const gitStat = git.stat;
  const files = useMemo(() => gitStat?.files ?? [], [gitStat]);

  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(
    () => new Set(),
  );
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  // 进入面板自动选中第一个文件；选中的文件从列表消失（提交/撤销掉）就跟丢
  useEffect(() => {
    if (!files.length) {
      if (selected !== null) setSelected(null);
      return;
    }
    if (!selected || !files.some((f) => f.path === selected)) {
      setSelected(files[0].path);
    }
  }, [files, selected]);

  // 选中文件的 diff。context=100000 一次拿全上下文，「N 行未改动」折叠条
  // 展开时不需要再请求。未跟踪文件对 HEAD 没有 diff：读内容伪造成全增。
  useEffect(() => {
    if (!selected || !gitWorkDir) {
      setDiffText(null);
      setDiffError(null);
      return;
    }
    const f = files.find((x) => x.path === selected);
    if (!f) return;
    let cancelled = false;
    setDiffError(null);
    if (f.binary) {
      setDiffText(null);
      return;
    }
    const abs = joinWorkPath(gitWorkDir, selected);
    void (async () => {
      try {
        if (f.untracked) {
          const content = await electronFS.readFile(abs);
          if (cancelled) return;
          const ls = content.replace(/\r\n?/g, "\n").split("\n");
          setDiffText(
            `@@ -0,0 +1,${ls.length} @@\n${ls.map((l) => `+${l}`).join("\n")}`,
          );
          return;
        }
        const res = await electronGit.diffHead(abs, 100000);
        if (cancelled) return;
        if (res.ok) setDiffText(res.diff ?? "");
        else setDiffError(res.error ?? "git diff 失败");
      } catch (e) {
        if (!cancelled)
          setDiffError((e as { message?: string })?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // files 不入 deps：轮询每 5s 换引用会让 diff 重刷；改动由 revision 驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, gitWorkDir, gitChangeRevision]);

  // 点一个改动文件：在「文件」面打开它，并跳到第一处改动。
  // 未跟踪新文件对 HEAD 没有 diff、删除的文件读不出来 —— 都只按能做的做。
  const openChangedFile = async (relPath: string) => {
    if (!gitWorkDir) return;
    const st = useHelixStore.getState();
    const abs = joinWorkPath(gitWorkDir, relPath);
    const name = relPath.split(/[/\\]/).pop() || relPath;
    st.setRightSidebarTab("code");
    if (previewKindOf(name)) {
      st.openDocument(abs);
      return;
    }
    const createdEmpty = st.ensureEditorTab(abs, name);
    try {
      const content = await electronFS.readFile(abs);
      if (content == null) throw new Error("读取为空");
      st.fillEditorTabContent(abs, content);
    } catch (e) {
      if (createdEmpty) st.closeEditorTab(abs);
      showToast({
        type: "error",
        title: "无法打开",
        description: (e as { message?: string })?.message || relPath,
      });
      return;
    }
    try {
      const res = await electronGit.diffHead(abs);
      const hunk = res.ok && res.diff ? firstHunk(res.diff) : null;
      if (hunk) st.revealEditorRange(abs, hunk.start, hunk.end);
    } catch {
      /* 定位失败不影响打开本身 */
    }
  };

  const shownFiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, filter]);
  const tree = useMemo(() => buildTree(shownFiles), [shownFiles]);
  const selectedFile = files.find((f) => f.path === selected) ?? null;

  const renderDir = (node: DirNode, depth: number): ReactNode => {
    const collapsed = collapsedDirs.has(node.path);
    return (
      <li key={`d:${node.path}`}>
        <button
          onClick={() =>
            setCollapsedDirs((prev) => {
              const next = new Set(prev);
              if (next.has(node.path)) next.delete(node.path);
              else next.add(node.path);
              return next;
            })
          }
          className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-accent/40 text-left text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80"
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          {collapsed ? (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/50" />
          )}
          <Folder className="size-4 shrink-0 text-muted-foreground/60" />
          <span className="min-w-0 truncate">{node.name}</span>
        </button>
        {!collapsed && (
          <>
            <ul>{node.dirs.map((d) => renderDir(d, depth + 1))}</ul>
            <ul>{node.files.map((f) => renderFile(f, depth + 1))}</ul>
          </>
        )}
      </li>
    );
  };
  const renderFile = (f: ChangeFile, depth: number): ReactNode => {
    const { icon: Icon, color } = getFileIconInfo(f.path);
    const { ch, cls } = statusLetterOf(f);
    const active = f.path === selected;
    return (
      <li key={f.path}>
        <div
          onClick={() => setSelected(f.path)}
          onDoubleClick={() => void openChangedFile(f.path)}
          data-tip={`${f.path}（双击打开并跳到改动处）`}
          className={`flex items-center gap-1.5 min-w-0 px-2 py-1 rounded cursor-pointer text-[calc(var(--helix-transcript-size)*0.8571)] transition-colors ${active ? "bg-primary/15 text-foreground" : "hover:bg-accent/40 text-foreground/85"}`}
          style={{ paddingLeft: 10 + depth * 14 }}
        >
          <Icon className={`size-4 shrink-0 ${color}`} />
          <span className="flex-1 min-w-0 truncate">{f.path.split("/").pop()}</span>
          <span className={`shrink-0 font-medium ${cls}`}>{ch}</span>
        </div>
      </li>
    );
  };

  return (
    <div className="h-full w-full flex flex-col min-h-0 bg-background/50">
      {gitStat ? (
        <>
          <div className="shrink-0 flex items-center gap-2 min-w-0 px-3 py-2">
            <span className="min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.9286)] font-semibold">
              未提交
            </span>
            <span className="shrink-0 flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] tabular-nums">
              <span className="text-emerald-500">+{gitStat.added}</span>
              <span className="text-red-500">-{gitStat.removed}</span>
            </span>
            <button
              onClick={() =>
                useHelixStore.getState().requestWorkPanelOpen()
              }
              data-tip="打开右上角工作面板完成提交 / 推送"
              className="ml-auto shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border/60 text-[calc(var(--helix-transcript-size)*0.8571)] hover:bg-accent/50 transition-colors"
            >
              <Send className="size-3.5" />
              提交或推送
            </button>
          </div>
          <div className="flex-1 min-h-0 min-w-0 flex">
            {/* 左：选中文件的内联 diff */}
            <div className="flex-1 min-w-0 flex flex-col border-r border-border/20">
              {selectedFile && (
                <div className="shrink-0 flex items-center gap-2 min-w-0 px-2 py-1.5 border-b border-border/20">
                  {(() => {
                    const { icon: Icon, color } = getFileIconInfo(
                      selectedFile.path,
                    );
                    return <Icon className={`size-4 shrink-0 ${color}`} />;
                  })()}
                  <span
                    className="min-w-0 flex-1 truncate text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/85"
                    data-tip={selectedFile.path}
                  >
                    {selectedFile.path}
                  </span>
                  {selectedFile.binary ? (
                    <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/40">
                      二进制
                    </span>
                  ) : (
                    <span className="shrink-0 flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] tabular-nums">
                      <span className="text-emerald-500">
                        +{selectedFile.added}
                      </span>
                      <span className="text-red-500">
                        -{selectedFile.removed}
                      </span>
                    </span>
                  )}
                  <button
                    onClick={() => void openChangedFile(selectedFile.path)}
                    data-tip="在「文件」面打开并跳到改动处"
                    className="shrink-0 p-1 rounded text-foreground/50 hover:text-foreground hover:bg-accent/50 transition-colors"
                  >
                    <ExternalLink className="size-3.5" />
                  </button>
                </div>
              )}
              <div className="flex-1 min-h-0 overflow-auto">
                {selectedFile?.binary ? (
                  <div className="h-full flex items-center justify-center px-4 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">
                    二进制文件，无法显示文本差异
                  </div>
                ) : diffError ? (
                  <div className="h-full flex items-center justify-center px-4 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">
                    {diffError}
                  </div>
                ) : diffText ? (
                  <GitDiffView key={selected ?? ""} text={diffText} />
                ) : (
                  <div className="h-full flex items-center justify-center gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/40">
                    <Search className="size-3.5" />
                    选择一个文件查看改动
                  </div>
                )}
              </div>
            </div>
            {/* 右：目录树 + 筛选 */}
            <div className="w-[42%] min-w-[170px] max-w-[300px] shrink-0 flex flex-col min-h-0">
              <div className="shrink-0 p-1.5">
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-border/40 bg-muted/30">
                  <Search className="size-3 shrink-0 text-muted-foreground/50" />
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="筛选文件…"
                    className="flex-1 min-w-0 bg-transparent outline-none text-[calc(var(--helix-transcript-size)*0.8571)] placeholder:text-muted-foreground/40"
                  />
                </div>
              </div>
              <ul className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1 pb-1.5">
                {tree.dirs.map((d) => renderDir(d, 0))}
                {tree.files.map((f) => renderFile(f, 0))}
                {!shownFiles.length && (
                  <li className="px-2 py-3 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/50">
                    {filter ? "没有匹配的文件" : "没有未提交的更改"}
                  </li>
                )}
              </ul>
            </div>
          </div>
        </>
      ) : (
        <div
          className="flex-1 min-h-0 flex items-center justify-center px-4 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70"
          data-tip={git.detail ?? undefined}
        >
          {git.unavailable
            ? UNAVAILABLE_TEXT[git.unavailable]
            : "没有未提交的更改"}
        </div>
      )}
    </div>
  );
}

/* ── 两栏共用的数据小件 ─────────────────────────────────────────────────── */

type ChangeFile = NonNullable<GitChangeState["stat"]>["files"][number];

function joinWorkPath(base: string, rel: string): string {
  return `${base.replace(/[\\/]+$/, "")}/${rel.replace(/\\/g, "/")}`;
}

/** 状态字母：未跟踪=U；只删不增≈D（numstat 没有状态位，这是可靠近似）；其余 M。 */
function statusLetterOf(f: ChangeFile): { ch: string; cls: string } {
  if (f.untracked) return { ch: "U", cls: "text-emerald-500" };
  if (!f.binary && f.added === 0 && f.removed > 0)
    return { ch: "D", cls: "text-red-500" };
  return { ch: "M", cls: "text-amber-500" };
}

interface DirNode {
  name: string;
  path: string;
  dirs: DirNode[];
  files: ChangeFile[];
}

/** 把仓库相对路径铺成目录树（目录名升序、目录在前由渲染顺序保证）。 */
function buildTree(list: ChangeFile[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: [], files: [] };
  const map = new Map<string, DirNode>([["", root]]);
  const ensureDir = (p: string): DirNode => {
    const hit = map.get(p);
    if (hit) return hit;
    const i = p.lastIndexOf("/");
    const parent = ensureDir(i === -1 ? "" : p.slice(0, i));
    const node: DirNode = { name: p.slice(i + 1), path: p, dirs: [], files: [] };
    parent.dirs.push(node);
    map.set(p, node);
    return node;
  };
  for (const f of list) {
    const norm = f.path.replace(/\\/g, "/");
    const i = norm.lastIndexOf("/");
    ensureDir(i === -1 ? "" : norm.slice(0, i)).files.push(f);
  }
  const sort = (n: DirNode) => {
    n.dirs.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => a.path.localeCompare(b.path));
    n.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

/* ── 内联 diff 视图 ─────────────────────────────────────────────────────── */

interface DiffLine {
  kind: "ctx" | "add" | "del";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

/** 解析 `git diff -U<大>`：丢文件头（diff --git/index/---/+++/mode），
 *  从第一个 @@ 起按行记新旧行号。未跟踪文件的伪 diff（单 @@ + 全 + 行）同式。 */
function parseDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (!m) continue;
      oldNo = parseInt(m[1], 10);
      newNo = parseInt(m[2], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      out.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    } else {
      out.push({
        kind: "ctx",
        oldNo: oldNo++,
        newNo: newNo++,
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
      });
    }
  }
  return out;
}

/** 连续未改动行 ≥ 这个数默认收成「N unmodified lines」折叠条（对齐截图行为）。 */
const UNCHANGED_COLLAPSE_MIN = 7;

function GitDiffView({ text }: { text: string }) {
  const lines = useMemo(() => parseDiff(text), [text]);
  const [openRuns, setOpenRuns] = useState<Set<number>>(() => new Set());

  type Seg =
    | { run: false; from: number; lines: DiffLine[] }
    | { run: true; from: number; lines: DiffLine[] };
  const segs = useMemo(() => {
    const res: Seg[] = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind === "ctx") {
        let j = i;
        while (j < lines.length && lines[j].kind === "ctx") j++;
        const chunk = lines.slice(i, j);
        if (chunk.length >= UNCHANGED_COLLAPSE_MIN)
          res.push({ run: true, from: i, lines: chunk });
        else res.push({ run: false, from: i, lines: chunk });
        i = j;
      } else {
        let j = i;
        while (j < lines.length && lines[j].kind !== "ctx") j++;
        res.push({ run: false, from: i, lines: lines.slice(i, j) });
        i = j;
      }
    }
    return res;
  }, [lines]);

  return (
    <div className="font-mono text-[calc(var(--helix-transcript-size)*0.7857)] leading-[1.5] py-1">
      {segs.map((seg) => {
        if (seg.run && !openRuns.has(seg.from)) {
          return (
            <button
              key={seg.from}
              onClick={() =>
                setOpenRuns((prev) => new Set(prev).add(seg.from))
              }
              className="w-full text-left px-2 py-0.5 text-sky-400/90 hover:bg-accent/40 transition-colors"
            >
              {seg.lines.length} unmodified lines
            </button>
          );
        }
        return seg.lines.map((l, k) => (
          <DiffRow key={`${seg.from}:${k}`} line={l} />
        ));
      })}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const bg =
    line.kind === "add"
      ? "bg-emerald-500/10 border-l-2 border-emerald-500"
      : line.kind === "del"
        ? "bg-red-500/10 border-l-2 border-red-500"
        : "border-l-2 border-transparent";
  const fg =
    line.kind === "add"
      ? "text-emerald-300/90"
      : line.kind === "del"
        ? "text-red-300/90"
        : "text-foreground/75";
  return (
    <div className={`flex ${bg}`}>
      <span className="shrink-0 w-10 pr-1.5 text-right select-none tabular-nums text-muted-foreground/35">
        {line.oldNo ?? ""}
      </span>
      <span className="shrink-0 w-10 pr-2 text-right select-none tabular-nums text-muted-foreground/50">
        {line.newNo ?? ""}
      </span>
      <span className={`min-w-0 flex-1 whitespace-pre break-normal ${fg}`}>
        {line.text}
      </span>
    </div>
  );
}
