"use client";

/**
 * 会话树（pi 的 `get_tree`）。
 *
 * 当前会话在 pi 眼里是一棵带分支的树：每次 compact / 切换 / 重试都会产生新
 * 叶子，废弃分支仍在树里挂着。这里做**只读**视图——pi 的 RPC 面没有
 * 「把光标移到某个分支」的命令，想从废弃分支继续只能用 `fork`（传 entryId）。
 * 所以节点上的操作只有「从此处分叉」，不假装能原地跳转。
 *
 * 数据形状没有契约：不同版本的 pi 可能返回 entryId / id / timestamp / content
 * （content 可能是字符串，也可能是 role/content 对象数组），所以全部走 normalize
 * 防御式解析，解析不出来就当空值显示，绝不因字段名不同就崩。
 */

import { GitBranch, ListTree, Pencil, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { sendRpc } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

type NormalizedNode = {
  /** 稳定 key；pi 没给 id 时按位置兜底 */
  key: string;
  /** pi 的 entry id，有才能 fork */
  entryId: string | null;
  role: string;
  timestamp: number | null;
  text: string;
  /** pi 标记的废弃分支（不在活跃路径上） */
  branch: boolean;
  /** pi 标记的最新叶子 */
  latest: boolean;
  children: NormalizedNode[];
};

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((x) =>
        typeof x === "string"
          ? x
          : x && typeof x === "object"
            ? String(
                (x as Record<string, unknown>).text ??
                  (x as Record<string, unknown>).content ??
                  "",
              )
            : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
  }
  return "";
}

function normalizeNode(n: unknown, fallbackKey: string): NormalizedNode {
  if (!n || typeof n !== "object") return emptyNode(fallbackKey);
  const o = n as Record<string, unknown>;
  const children = Array.isArray(o.children)
    ? o.children.map((c, i) => normalizeNode(c, `${fallbackKey}/${i}`))
    : [];
  const entryId =
    typeof o.entryId === "string"
      ? o.entryId
      : typeof o.id === "string"
        ? o.id
        : typeof o.id === "number"
          ? String(o.id)
          : null;
  return {
    key: entryId || fallbackKey,
    entryId,
    role:
      typeof o.role === "string"
        ? o.role
        : typeof o.type === "string"
          ? o.type
          : "",
    timestamp:
      typeof o.timestamp === "number"
        ? o.timestamp
        : typeof o.timestamp === "string"
          ? Date.parse(o.timestamp) || null
          : null,
    text: textOf(o.content ?? o.text ?? o.prompt ?? o.thinking),
    branch: Boolean(o.branch ?? o.abandoned ?? o.leaf === false),
    latest: Boolean(o.isLatestLeaf ?? o.latest ?? o.current),
    children,
  };
}

function emptyNode(key: string): NormalizedNode {
  return {
    key,
    entryId: null,
    role: "",
    timestamp: null,
    text: "",
    branch: false,
    latest: false,
    children: [],
  };
}

function countNodes(nodes: NormalizedNode[]): number {
  return nodes.reduce(
    (acc, n) => acc + 1 + countNodes(n.children),
    0,
  );
}

function formatTime(ts: number | null): string {
  if (!ts || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

const ROLE_LABEL: Record<string, string> = {
  user: "用户",
  assistant: "助手",
  system: "系统",
  tool: "工具",
};

function NodeView({
  node,
  depth,
  onFork,
}: {
  node: NormalizedNode;
  depth: number;
  onFork: (entryId: string) => void;
}) {
  const hasKids = node.children.length > 0;
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div
        className={`group flex items-start gap-1.5 rounded-md px-1.5 py-1 text-[length:var(--helix-transcript-size)*0.9] ${node.latest ? "bg-primary/10" : node.branch ? "opacity-55" : ""} hover:bg-accent/40`}
        style={{ marginLeft: depth * 14 }}
      >
        {hasKids ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 w-3.5 text-muted-foreground/70 hover:text-foreground text-center"
            aria-label={open ? "折叠" : "展开"}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="shrink-0 w-3.5 text-center">
            <GitBranch
              className={`size-2.5 inline -mt-0.5 ${node.latest ? "text-primary" : "text-muted-foreground/50"}`}
            />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`shrink-0 px-1 rounded text-[calc(var(--helix-transcript-size)*0.7143)] font-medium ${node.role === "user" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : node.role === "assistant" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-muted/60 text-muted-foreground"}`}
            >
              {ROLE_LABEL[node.role] || node.role || "条目"}
            </span>
            <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60 tabular-nums">
              {formatTime(node.timestamp)}
            </span>
            {node.latest && (
              <span className="shrink-0 px-1 rounded text-[calc(var(--helix-transcript-size)*0.7143)] bg-primary/15 text-primary font-medium">
                最新
              </span>
            )}
            {node.branch && !node.latest && (
              <span className="shrink-0 px-1 rounded text-[calc(var(--helix-transcript-size)*0.7143)] bg-muted/60 text-muted-foreground/70">
                废弃分支
              </span>
            )}
          </div>
          {node.text ? (
            <p
              className="mt-0.5 text-[length:var(--helix-transcript-size)*0.85] text-muted-foreground/80 break-words"
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {node.text.replace(/\s+/g, " ")}
            </p>
          ) : null}
        </div>
        {node.entryId ? (
          <button
            type="button"
            onClick={() => onFork(node.entryId!)}
            title="从这一处分叉出一个新会话"
            className="shrink-0 self-center px-1 py-0.5 rounded text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/40 hover:text-primary hover:bg-primary/10 opacity-0 group-hover:opacity-100 transition-all"
          >
            分叉
          </button>
        ) : null}
      </div>
      {hasKids && open
        ? node.children.map((c) => (
            <NodeView
              key={c.key}
              node={c}
              depth={depth + 1}
              onFork={onFork}
            />
          ))
        : null}
    </div>
  );
}

export function SessionTreePanel() {
  const sessionId = useHelixStore((s) => s.currentSessionId);
  const [nodes, setNodes] = useState<NormalizedNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    setRaw(null);
    try {
      const r = (await sendRpc("get_tree", { session_id: sessionId })) as {
        tree?: unknown;
        root?: unknown;
        nodes?: unknown;
        entries?: unknown;
      } | null;
      if (!r) {
        setError("get_tree 返回空结果");
        return;
      }
      const list = r.tree ?? r.root ?? r.nodes ?? r.entries;
      const arr = Array.isArray(list)
        ? list
        : list
          ? [list]
          : [];
      setNodes(arr.map((n, i) => normalizeNode(n, `n${i}`)));
    } catch (e) {
      setError((e as Error)?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (sessionId) void load();
  }, [sessionId, load]);

  const handleFork = useCallback(
    async (entryId: string) => {
      if (!sessionId) return;
      try {
        // 网关只路由 Helix 命名的 `session/fork`（它内部翻译成 pi 的 fork/clone
        // 并处理实例重钥）；裸 `fork` 不在 passthrough 白名单里，会报
        // 「pi adapter does not implement fork」。
        await sendRpc("session/fork", { session_id: sessionId, entryId });
        setError(null);
      } catch (e) {
        setError(`分叉失败：${(e as Error)?.message || e}`);
      }
    },
    [sessionId],
  );

  const saveName = useCallback(async () => {
    const name = nameDraft.trim();
    if (!name || !sessionId) return;
    setNaming(true);
    try {
      await sendRpc("set_session_name", { session_id: sessionId, name });
      setError(null);
      setNameDraft("");
    } catch (e) {
      setError(`命名失败：${(e as Error)?.message || e}`);
    } finally {
      setNaming(false);
    }
  }, [nameDraft, sessionId]);

  return (
    <div className="h-full w-full flex flex-col min-h-0 bg-background/50">
      <div className="flex items-center gap-1 px-3 pt-10 pb-2 shrink-0 border-b border-border/20">
        <ListTree className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
          会话树
        </span>
        <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60 tabular-nums">
          {nodes ? `${countNodes(nodes)} 个条目` : ""}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setNaming((v) => !v)}
            title="给当前会话命名（写入会话文件，出现在会话列表里）"
            className="px-1.5 py-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || !sessionId}
            title="刷新"
            className="px-1.5 py-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40"
          >
            <RefreshCw
              className={`size-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-2">
        {naming && (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
                if (e.key === "Escape") setNaming(false);
              }}
              placeholder="会话名称…"
              className="flex-1 min-w-0 px-2 py-1 bg-muted/50 border border-border/50 rounded-md text-[length:var(--helix-transcript-size)*0.9] text-foreground placeholder:text-muted-foreground/50"
            />
            <button
              type="button"
              onClick={() => void saveName()}
              disabled={naming || !nameDraft.trim()}
              className="px-2 py-1 rounded-md bg-primary/10 text-primary text-[length:var(--helix-transcript-size)*0.85] disabled:opacity-40"
            >
              命名
            </button>
          </div>
        )}

        {!sessionId ? (
          <div className="text-[length:var(--helix-transcript-size)] text-muted-foreground/60 px-2">
            还没有活跃会话
          </div>
        ) : loading && !nodes ? (
          <div className="text-[length:var(--helix-transcript-size)] text-muted-foreground/60 px-2">
            加载中…
          </div>
        ) : nodes && nodes.length === 0 ? (
          <div className="text-[length:var(--helix-transcript-size)] text-muted-foreground/60 px-2">
            会话还没有条目
          </div>
        ) : nodes ? (
          <div className="space-y-0.5">
            {nodes.map((n) => (
              <NodeView
                key={n.key}
                node={n}
                depth={0}
                onFork={(id) => void handleFork(id)}
              />
            ))}
          </div>
        ) : null}

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-red-500 break-words">
            {error}
          </div>
        )}
        {raw && (
          <pre className="text-[calc(var(--helix-transcript-size)*0.7143)] font-mono text-muted-foreground/50 whitespace-pre-wrap break-all p-2 rounded-md bg-muted/30">
            {raw}
          </pre>
        )}
      </div>
    </div>
  );
}
