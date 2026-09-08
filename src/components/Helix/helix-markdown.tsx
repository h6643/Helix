"use client";

/**
 * HelixMarkdown — markdown renderer for assistant messages.
 *
 * Renders react-markdown + remark-gfm through the upstream agent
 * preprocess pipeline (lib/markdown-preprocess.ts), then applies the official
 * desktop renderer's component overrides (markdown-text.tsx): heading sizes,
 * quiet `---` spacing, GFM alert blockquotes, styled tables, code cards, and
 * inline-code direction. Renders into the existing `.helix-md` stylesheet;
 * code fences emit `<pre><div>` so `.helix-md pre > div` paints the code card.
 */

import {
  cloneElement,
  isValidElement,
  memo,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  Info,
  Play,
  type LucideIcon,
  Zap,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { useHelixStore } from "@/stores/helix-store";

import { sanitizeLanguageTag } from "@/lib/markdown-code";
import { preprocessMarkdown } from "@/lib/markdown-preprocess";
import { HighlightedCode } from "@/components/Helix/shiki-code";

interface HelixMarkdownProps {
  text: string;
  className?: string;
}

// ── GFM alerts (`> [!NOTE]` blockquotes) — ported from embeds/alert.tsx ──

type AlertType = "caution" | "important" | "note" | "tip" | "warning";

interface AlertStyle {
  accent: string;
  icon: LucideIcon;
  label: string;
}

// GitHub's five alert kinds, mapped to our icon set + a tinted accent.
const ALERT_STYLES: Record<AlertType, AlertStyle> = {
  caution: { accent: "text-rose-500", icon: AlertTriangle, label: "Caution" },
  important: {
    accent: "text-violet-500",
    icon: AlertCircle,
    label: "Important",
  },
  note: { accent: "text-blue-500", icon: Info, label: "Note" },
  tip: { accent: "text-emerald-500", icon: Zap, label: "Tip" },
  warning: { accent: "text-amber-500", icon: AlertTriangle, label: "Warning" },
};

const MARKER_RE = /^\s*\[!(note|tip|important|warning|caution)\]\s*\n?/i;

function firstText(node: ReactNode): string {
  if (typeof node === "string") {
    return node;
  }

  if (typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      const text = firstText(child);

      if (text.trim()) {
        return text;
      }
    }

    return "";
  }

  if (isValidElement(node)) {
    return firstText((node.props as { children?: ReactNode }).children);
  }

  return "";
}

// Remove the leading `[!TYPE]` token from the first text node that carries it,
// leaving the rest of the blockquote body intact. One-shot via the `state` flag.
function stripMarker(node: ReactNode, state: { done: boolean }): ReactNode {
  if (state.done) {
    return node;
  }

  if (typeof node === "string") {
    const replaced = node.replace(MARKER_RE, "");

    if (replaced !== node) {
      state.done = true;

      return replaced;
    }

    return node;
  }

  if (Array.isArray(node)) {
    return node.map((child, index) => (
      <Fragmentless key={index} node={stripMarker(child, state)} />
    ));
  }

  if (isValidElement(node)) {
    const children = (node.props as { children?: ReactNode }).children;

    if (children == null) {
      return node;
    }

    return cloneElement(node, undefined, stripMarker(children, state));
  }

  return node;
}

function Fragmentless({ node }: { node: ReactNode }) {
  return <>{node}</>;
}

function extractAlert(
  children: ReactNode,
): { body: ReactNode; type: AlertType } | null {
  const match = firstText(children).match(MARKER_RE);

  if (!match) {
    return null;
  }

  return {
    body: stripMarker(children, { done: false }),
    type: match[1].toLowerCase() as AlertType,
  };
}

function MarkdownAlert({
  children,
  type,
}: {
  children: ReactNode;
  type: AlertType;
}) {
  const style = ALERT_STYLES[type];
  const Icon = style.icon;

  return (
    <div className="my-2 rounded-lg border border-border/50 bg-muted/25 px-3 py-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <div
        className={`mb-1 flex items-center gap-1.5 text-[0.8125rem] font-semibold ${style.accent}`}
      >
        <Icon className="size-4 shrink-0" />
        {style.label}
      </div>
      {children}
    </div>
  );
}

// ── Code cards ───────────────────────────────────────────────────────────

// Box Drawing (U+2500–U+257F) plus Block Elements (U+2580–U+259F): tree
// connectors (├── └── │) and progress-bar/shading glyphs (█ ░ ▒ ▓).
// Ported from helix-desktop AgentMarkdown: a fence is a "box diagram" only
// when box-drawing characters dominate it (≥ half of its non-empty lines).
// Such output must never go through shiki — per-glyph token spans fragment
// and misalign under imperfect Unicode metrics. A stray │ in a comment must
// NOT demote a real source file.
const BOX_DRAWING_RE = /[\u2500-\u259F]/;

function isBoxDiagram(code: string): boolean {
  const lines = code.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return false;
  const boxLines = lines.filter((line) => BOX_DRAWING_RE.test(line)).length;
  return boxLines * 2 >= lines.length;
}

// Diff viewer with colored +/-/@@ lines (ported from helix-desktop).
function DiffView({ code }: { code: string }) {
  const lines = code.split("\n");

  return (
    <div className="helix-diff-content">
      {lines.map((line, i) => {
        let cls = "helix-diff-line";
        if (line.startsWith("+")) cls += " helix-diff-add";
        else if (line.startsWith("-")) cls += " helix-diff-remove";
        else if (line.startsWith("@@")) cls += " helix-diff-hunk";
        return (
          <div key={i} className={cls}>
            {line || "\u00A0"}
          </div>
        );
      })}
    </div>
  );
}

// Source-position ids of code blocks the user has expanded. Kept at module
// scope so the choice survives the remounts react-markdown causes while a
// message is still streaming (index-based keys shift as the AST grows, which
// would otherwise reset a per-component useState back to collapsed).
const expandedCodeBlocks = new Set<string>();

// 只有真正可执行的命令/脚本语言才显示「执行」按钮（白名单）。
const RUNNABLE_LANGS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "powershell",
  "pwsh",
  "cmd",
  "batch",
  "python",
  "py",
  "javascript",
  "js",
  "typescript",
  "ts",
  "node",
  "go",
  "ruby",
  "php",
  "perl",
  "java",
  "c",
  "cpp",
  "csharp",
  "rust",
  "swift",
  "kotlin",
  "lua",
  "r",
]);

/** Walk the table's React children into a row-major matrix of cell text. */
function tableRows(children: ReactNode): string[][] {
  const rows: string[][] = [];
  const collect = (nodes: ReactNode): void => {
    const arr = Array.isArray(nodes) ? nodes : nodes == null ? [] : [nodes];
    for (const n of arr) {
      if (!isValidElement(n)) continue;
      const tag = typeof n.type === "string" ? n.type : "";
      if (tag === "tr") {
        const cellChildren: unknown = (n.props as { children?: ReactNode })
          ?.children;
        const cellArr: unknown[] = Array.isArray(cellChildren)
          ? cellChildren
          : cellChildren == null
            ? []
            : [cellChildren];
        rows.push(cellArr.map((c) => codeText(c)));
      } else {
        collect((n.props as { children?: ReactNode })?.children);
      }
    }
  };
  collect(children);
  return rows;
}

/** Serialize a markdown table back to a copyable Markdown table. */
function tableToMarkdown(children: ReactNode): string {
  const rows = tableRows(children);
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    "| " +
    Array.from({ length: cols }, (_, i) =>
      (cells[i] ?? "").replace(/\|/g, "\\|"),
    ).join(" | ") +
    " |";
  const sep =
    "| " + Array.from({ length: cols }, () => "---").join(" | ") + " |";
  return rows
    .flatMap((r, i) => (i === 0 ? [line(r), sep] : [line(r)]))
    .join("\n");
}

function MarkdownTable({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-2 max-w-full rounded-[0.375rem] border border-border/50">
      <div className="flex items-center justify-end px-1 pt-0.5">
        <button
          type="button"
          aria-label="复制表格"
          title="复制表格"
          onClick={() => {
            const text = tableToMarkdown(children);
            if (!text) return;
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
          className="p-1 rounded text-foreground/40 hover:text-foreground/70 hover:bg-foreground/5 transition-colors cursor-pointer"
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="m-0 w-full min-w-[18rem] border-collapse text-[0.8125rem] [&_tr]:border-b [&_tr]:border-border/50 last:[&_tr]:border-0">
          {children}
        </table>
      </div>
    </div>
  );
}

export function CodeCard({
  language,
  code,
  blockId,
  showRunButton = true,
  className,
  collapsible = true,
}: {
  language: string;
  code: string;
  blockId?: string;
  showRunButton?: boolean;
  className?: string;
  collapsible?: boolean;
}) {
  const trimmed = code.replace(/^\n+/, "").trimEnd();
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const canRun = RUNNABLE_LANGS.has(language);
  const [collapsed, setCollapsed] = useState(() =>
    blockId ? !expandedCodeBlocks.has(blockId) : true,
  );
  const isDiff = language === "diff";
  // Diffs win over the box-diagram check: DiffView is already a plain
  // per-line renderer (no shiki), so a patch touching a tree diagram must
  // keep its colored +/- view.
  const boxDiagram = !isDiff && isBoxDiagram(trimmed);
  const lineCount = trimmed.split("\n").length;
  const isLong = lineCount > 15 || trimmed.length > 800;
  // collapsible=false 时（如工具卡片里的命令/结果代码）永不折叠：内容全量显示，
  // 不套 max-height 截断、不渲染"展开全部/收起"按钮，点击即见全部。
  const foldable = collapsible !== false && isLong;

  const body = isDiff ? (
    <DiffView code={trimmed} />
  ) : boxDiagram ? (
    <code dir="ltr" className="helix-box-diagram block">
      {trimmed}
    </code>
  ) : (
    <HighlightedCode code={trimmed} language={language} />
  );

  const runCode = () => {
    const isShell = [
      "bash",
      "sh",
      "zsh",
      "fish",
      "powershell",
      "pwsh",
      "cmd",
      "batch",
    ].includes(language);
    const fenceLang = language ? `${language}\n` : "";
    const prompt = `${isShell ? "请执行以下命令" : "请执行以下代码"}并输出执行结果：\n\n\`\`\`${fenceLang}${trimmed}\n\`\`\``;
    useHelixStore.getState().injectAndSend(prompt);
    setSent(true);
    setTimeout(() => setSent(false), 2000);
  };

  return (
    <pre className={className} data-code-card-header="true">
      {/* 头部：不透明背景，显示语言类型和操作按钮（helix-code-card-header 由
          globals.css 以 !important 压制 .helix-md pre > div 的通用透明规则） */}
      <div className="flex items-center justify-between px-2 py-1 helix-code-card-header border-b border-border rounded-t-md">
        <span className="text-[calc(var(--helix-transcript-size)*0.7143)] uppercase tracking-wider text-foreground/40 select-none font-medium">
          {isDiff ? "diff" : language || (boxDiagram ? "text" : "code")}
        </span>
        <span className="flex items-center gap-1">
          {showRunButton && canRun && (
            <button
              type="button"
              aria-label="执行代码"
              title="执行代码"
              onClick={runCode}
              className="p-1 rounded text-foreground/40 hover:text-foreground/70 hover:bg-foreground/5 transition-colors cursor-pointer"
            >
              {sent ? (
                <Check className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            aria-label="复制代码"
            title="复制代码"
            onClick={() => {
              try {
                void navigator.clipboard?.writeText(trimmed);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                /* clipboard unavailable */
              }
            }}
            className="p-1 rounded text-foreground/40 hover:text-foreground/70 hover:bg-foreground/5 transition-colors cursor-pointer"
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        </span>
      </div>
      {/* 代码内容区域：透明背景（helix-code-body：globals.css 恢复被
          .helix-md pre > div { padding:0 } 清零的左右内边距） */}
      <div className="px-3 py-2 bg-transparent helix-code-body">
        <div className={foldable && collapsed ? "helix-code-collapsed" : ""}>
          {body}
        </div>
        {foldable && (
          <button
            type="button"
            className="helix-code-expand-btn"
            onClick={() =>
              setCollapsed((prev) => {
                const next = !prev;
                if (blockId) {
                  if (next) expandedCodeBlocks.delete(blockId);
                  else expandedCodeBlocks.add(blockId);
                }
                return next;
              })
            }
          >
            {collapsed ? "展开全部" : "收起"}
          </button>
        )}
      </div>
    </pre>
  );
}

/** Extract a `<code>` block's child text nodes into a plain string. */
function codeText(children: unknown): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(codeText).join("");
  if (isValidElement(children)) {
    return codeText((children.props as { children?: unknown })?.children);
  }
  return "";
}

const HelixMarkdown = memo(function HelixMarkdown({
  text,
  className,
}: HelixMarkdownProps) {
  const processed = useMemo(
    () => (text ? preprocessMarkdown(text) : ""),
    [text],
  );
  const setPreviewRailUrl = useHelixStore((s) => s.setPreviewRailUrl);
  const setRightSidebarTab = useHelixStore((s) => s.setRightSidebarTab);

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[
          [remarkMath, { singleDollarTextMath: true }],
          remarkGfm,
        ]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // Headings shrink to chat scale (official HEADING_SIZES table).
          h1: (props) => (
            <h1
              className="my-1 font-semibold text-[1rem] tracking-tight"
              {...props}
            />
          ),
          h2: (props) => (
            <h2
              className="my-1 font-semibold text-[0.9375rem] tracking-tight"
              {...props}
            />
          ),
          h3: (props) => (
            <h3 className="my-1 font-semibold text-[0.875rem]" {...props} />
          ),
          h4: (props) => (
            <h4 className="my-1 font-semibold text-[0.8125rem]" {...props} />
          ),
          p: (props) => <p {...props} />,
          a: ({ children, href, ...props }) => {
            const isExternal = !!href && /^https?:\/\//i.test(href);
            const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
              if (!isExternal) return;
              // 修饰键 / 中键 → 放行系统默认（在外部浏览器打开）
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)
                return;
              e.preventDefault();
              // 统一在侧边栏内嵌浏览器打开（Tauri 走 iframe，Electron 走 webview）。
              setPreviewRailUrl(href!);
              setRightSidebarTab("browser");
            };
            return (
              <a
                href={href}
                onClick={handleClick}
                {...(isExternal ? {} : { target: "_blank" })}
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            );
          },
          // Inline code must not vote when an ancestor resolves `dir="auto"`
          // (mirrors the official `inlineCode` override). Fenced code goes
          // through the `pre` override below, never here.
          code: ({ className, ...props }) => (
            <code className={className} dir="ltr" {...props} />
          ),
          // `---` as quiet spacing, not a heavy full-width rule.
          hr: () => <div aria-hidden className="my-3" />,
          // `> [!NOTE]`-style blockquotes render as a GFM alert callout;
          // everything else stays a plain quote.
          blockquote: ({ children, className, ...props }) => {
            const alert = extractAlert(children);

            if (alert) {
              return (
                <MarkdownAlert type={alert.type}>{alert.body}</MarkdownAlert>
              );
            }

            return (
              <blockquote
                className={`border-s-2 border-border/50 ps-3 text-muted-foreground italic ${className || ""}`}
                dir="auto"
                {...props}
              >
                {children}
              </blockquote>
            );
          },
          ul: ({ className, ...props }) => (
            <ul
              className={`my-1 gap-0 ${className || ""}`}
              dir="auto"
              {...props}
            />
          ),
          ol: ({ className, ...props }) => (
            <ol
              className={`my-1 gap-0 ${className || ""}`}
              dir="auto"
              {...props}
            />
          ),
          li: ({ className, ...props }) => (
            <li className={className} {...props} />
          ),
          // Tables — official: rounded card wrapper + header bg + nowrap th +
          // row separators (last row un-bordered) + a copy button in the corner.
          table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
          thead: ({ className, ...props }) => (
            <thead
              className={`m-0 bg-muted/35 text-muted-foreground ${className || ""}`}
              {...props}
            />
          ),
          th: ({ className, ...props }) => (
            <th
              className={`whitespace-nowrap px-2.5 py-1.5 text-left align-middle text-[0.75rem] font-medium text-muted-foreground ${className || ""}`}
              {...props}
            />
          ),
          td: ({ className, ...props }) => (
            <td
              className={`px-2.5 py-1.5 align-top text-[0.8125rem] leading-snug ${className || ""}`}
              {...props}
            />
          ),
          img: ({ alt, src, ...props }) => (
            <img
              alt={alt || ""}
              src={src}
              className="my-2 block h-auto max-w-full rounded-lg object-contain"
              {...props}
            />
          ),
          // Fenced code → the `.helix-md pre > div` code card.
          pre: ({ children, node }) => {
            const child = Array.isArray(children) ? children[0] : children;
            const codeEl = (child as React.ReactElement | null) || null;
            const classNameRaw =
              codeEl && typeof codeEl === "object" && "props" in codeEl
                ? String(
                    (codeEl.props as { className?: string } | undefined)
                      ?.className ?? "",
                  )
                : "";
            const match = /language-([\w+#-]+)/.exec(classNameRaw);
            const language = match ? sanitizeLanguageTag(match[1]) : "";
            const code = codeText(
              (codeEl?.props as { children?: unknown } | undefined)?.children,
            );
            // Source offset of the opening fence is stable as the block streams,
            // so it survives react-markdown's streaming remounts (unlike index
            // keys) and uniquely identifies this block within the message.
            const start = node?.position?.start;
            const blockId =
              start != null
                ? `${start.offset ?? start.line}:${classNameRaw}`
                : undefined;

            return (
              <CodeCard language={language} code={code} blockId={blockId} />
            );
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
});

export { HelixMarkdown };
