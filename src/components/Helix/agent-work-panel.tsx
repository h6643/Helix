"use client";

import {
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCw,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { isElectron } from "@/lib/electron-bridge";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useHelixStore } from "@/stores/helix-store";

interface DelegationTask {
  name: string;
  path: string;
  size: number;
  modified: number;
  preview: string;
  goal?: string;
  status?: string;
}

interface Delegation {
  id: string;
  path: string;
  tasks: DelegationTask[];
}

function formatSize(bytes: number) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 右侧栏「子 Agent 工作内容」页：在多面板里点某个 agent 后打开。
 *
 * 上半部分是本次会话该 agent 的实时工具调用（store.subAgents，由 subagent.*
 * 事件写入）；下半部分是磁盘上它留下的任务记录（delegate_task 每次委托生成
 * 的 live 日志），点某条任务即可读日志内容。
 */
export function AgentWorkPanel() {
  const agent = useHelixStore((s) => s.activeAgentView);
  const subAgents = useHelixStore((s) => s.subAgents);

  const [delegation, setDelegation] = useState<Delegation | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [logContent, setLogContent] = useState("");
  const [logLoading, setLogLoading] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!isElectron() || !agent) {
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const api = (window as any).electron as any;
        const sid = useHelixStore.getState().currentSessionId || undefined;
        const res = await api?.delegations?.list?.(sid);
        if (res?.ok) {
          const found =
            ((res.delegations || []) as Delegation[]).find(
              (d) => d.id === agent.id,
            ) || null;
          setDelegation(found);
        }
      } catch {
        /* 静默失败：面板保留上一次内容 */
      } finally {
        setLoading(false);
      }
    },
    [agent],
  );

  useEffect(() => {
    load();
    // 委托仍在跑时磁盘日志会持续追加，静默轮询保持最新。
    const timer = setInterval(() => load(true), 10000);
    return () => clearInterval(timer);
  }, [load]);

  // 切换 agent 时清掉上一条日志，避免张冠李戴。
  useEffect(() => {
    setSelectedTask(null);
    setLogContent("");
  }, [agent?.id]);

  const openLog = useCallback(async (path: string, name: string) => {
    setSelectedTask({ path, name });
    setLogLoading(true);
    setLogContent("");
    try {
      const api = (window as any).electron as any;
      const res = await api?.delegations?.readLog?.(path, 400);
      setLogContent(res?.ok ? res.content || "" : res?.error || "读取失败");
    } catch (e) {
      setLogContent(String(e));
    } finally {
      setLogLoading(false);
    }
  }, []);

  if (!isElectron()) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-[length:var(--helix-transcript-size)]">
        子 Agent 面板仅在桌面版可用
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground/70">
        <Users className="size-8 opacity-40" />
        <span className="text-[length:var(--helix-transcript-size)]">
          未选择子 Agent
        </span>
      </div>
    );
  }

  const live = subAgents.find((a) => a.id === agent.id || a.name === agent.id);
  const tasks = delegation?.tasks || [];

  return (
    <div className="flex flex-col h-full w-full min-h-0 min-w-0 bg-card">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-border/40">
        <Terminal className="size-3.5 text-primary shrink-0" />
        <span
          className="flex-1 min-w-0 truncate font-mono text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/85"
          title={agent.name}
        >
          {agent.name}
        </span>
        <button
          onClick={() => load()}
          className="p-1 text-foreground/40 hover:text-foreground rounded transition-colors shrink-0"
          data-tip="刷新"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* 实时：本次会话该 agent 的工具调用 */}
        {live && (
          <section className="px-3 py-2 border-b border-border/40">
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className={cn(
                  "flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.7857)] px-1.5 py-0.5 rounded",
                  live.status === "running"
                    ? "bg-primary/10 text-primary"
                    : live.status === "completed"
                      ? "bg-emerald-500/10 text-emerald-600"
                      : live.status === "failed"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted text-muted-foreground",
                )}
              >
                {live.status === "running" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-3" />
                )}
                {live.status === "running" ? "进行中" : live.status}
              </span>
              <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground truncate">
                {live.description || live.name}
              </span>
            </div>
            {(live.toolCalls || []).length > 0 && (
              <div className="space-y-0.5">
                {(live.toolCalls || []).slice(-12).map((tc, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-1.5 text-[calc(var(--helix-transcript-size)*0.7857)]"
                  >
                    <span className="text-primary shrink-0">▸</span>
                    <span className="text-foreground/70 font-mono shrink-0">
                      {tc.toolName}
                    </span>
                    {tc.params && (
                      <span className="text-muted-foreground truncate min-w-0 flex-1">
                        {tc.params}
                      </span>
                    )}
                    <span
                      className={cn(
                        "ml-auto shrink-0",
                        tc.status === "error"
                          ? "text-destructive"
                          : tc.status === "success"
                            ? "text-emerald-500"
                            : "text-muted-foreground",
                      )}
                    >
                      {tc.status === "running"
                        ? "…"
                        : tc.status === "success"
                          ? "✓"
                          : "✗"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {live.result && (
              <div className="mt-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/70 whitespace-pre-wrap break-words">
                {live.result}
              </div>
            )}
            {(live.filesModified || []).length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {(live.filesModified || []).slice(0, 8).map((f, i) => (
                  <span
                    key={i}
                    className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground font-mono truncate max-w-full"
                    title={f}
                  >
                    {f.split(/[/\\]/).pop()}
                  </span>
                ))}
              </div>
            )}
          </section>
        )}

        {/* 任务记录 */}
        <section className="px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/70">
              任务记录
            </span>
            <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground">
              {tasks.length} 个
            </span>
          </div>
          {loading ? (
            <div className="flex items-center justify-center h-20">
              <Loader2 className="size-4 animate-spin text-primary" />
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center gap-1 py-8 text-muted-foreground/60">
              <FileText className="size-6 opacity-40" />
              <span className="text-[calc(var(--helix-transcript-size)*0.8571)]">
                暂无任务记录
              </span>
            </div>
          ) : (
            <div className="space-y-1">
              {tasks.map((task) => (
                <button
                  key={task.name}
                  onClick={() => openLog(task.path, task.name)}
                  className={cn(
                    "w-full flex flex-col gap-0.5 px-2 py-1.5 rounded-md text-left transition-colors",
                    selectedTask?.path === task.path
                      ? "bg-accent/40"
                      : "hover:bg-accent/25",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <FileText className="size-3 text-muted-foreground shrink-0" />
                    <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-mono text-foreground/70">
                      {task.name}
                    </span>
                    {task.status && task.status !== "running" && (
                      <span
                        className={cn(
                          "text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded shrink-0",
                          task.status === "failed" || task.status === "error"
                            ? "bg-destructive/10 text-destructive"
                            : task.status === "interrupted" ||
                                task.status === "cancelled"
                              ? "bg-muted text-muted-foreground"
                              : "bg-emerald-500/10 text-emerald-600",
                        )}
                      >
                        {task.status}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 pl-5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
                    <span>{formatSize(task.size)}</span>
                    <span>{timeAgo(task.modified)}</span>
                  </div>
                  {task.goal && (
                    <div className="pl-5 text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/60 line-clamp-2">
                      {task.goal}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Log viewer */}
      {selectedTask && (
        <div className="shrink-0 border-t border-border/60">
          <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30">
            <div className="flex items-center gap-2 min-w-0">
              <Terminal className="size-3 text-primary shrink-0" />
              <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-mono text-foreground/70 truncate">
                {selectedTask.name}
              </span>
            </div>
            <button
              onClick={() => setSelectedTask(null)}
              className="p-1 text-foreground/40 hover:text-foreground shrink-0"
            >
              <X className="size-3" />
            </button>
          </div>
          <div className="h-56 overflow-auto p-3 bg-background/50">
            {logLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="size-4 animate-spin text-primary" />
              </div>
            ) : (
              <pre className="text-[calc(var(--helix-transcript-size)*0.7857)] font-mono text-foreground/70 whitespace-pre-wrap break-all">
                {logContent || "（空）"}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
