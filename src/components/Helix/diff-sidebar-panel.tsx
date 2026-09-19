"use client";

import { Aperture, Settings } from "lucide-react";
import type { SVGProps } from "react";
import { useGitChangeStat } from "@/hooks/use-git-change-stat";
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

function splitFilePath(filePath: string) {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) return { name: filePath, dir: "" };
  return {
    name: filePath.slice(lastSlash + 1),
    dir: filePath.slice(0, lastSlash),
  };
}

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

  const gitWorkDir =
    activeSessionWorkDir ?? (currentSessionId === null ? currentWorkDir : null);
  const gitStat = useGitChangeStat(gitWorkDir);

  return (
    <div className="h-full w-full flex flex-col min-h-0 bg-background/50">
      {gitStat ? (
        <section className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
          <div className="shrink-0 flex items-center gap-2 min-w-0 px-3 py-2">
            <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.9286)] font-semibold">
              未提交的更改
            </span>
            <span className="shrink-0 flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.7857)] tabular-nums">
              <span className="text-muted-foreground">
                {gitStat.files.length} 个文件
              </span>
              <span className="text-emerald-500">+{gitStat.added}</span>
              <span className="text-red-500">-{gitStat.removed}</span>
            </span>
          </div>
          <ul className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1 pb-1.5">
            {gitStat.files.map((f) => {
              const { name, dir } = splitFilePath(f.path);
              const { icon: Icon, color } = getFileIconInfo(f.path);
              return (
                <li
                  key={f.path}
                  className="flex items-center gap-2.5 min-w-0 px-2 py-1.5 rounded text-[calc(var(--helix-transcript-size)*0.8571)] hover:bg-accent/40 transition-colors"
                >
                  <Icon className={`size-5 shrink-0 ${color}`} />
                  <span className="flex-1 min-w-0 truncate">
                    <span className="font-medium text-foreground/90">{name}</span>
                    {dir && (
                      <span className="ml-1.5 text-muted-foreground/60 text-[0.9em]">{dir}</span>
                    )}
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
              );
            })}
          </ul>
        </section>
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center px-4 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
          没有未提交的更改
        </div>
      )}
    </div>
  );
}
