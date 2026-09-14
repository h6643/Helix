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
import { resolveBackendSid } from "@/lib/session-map";
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
 * 实时区有两层数据：subagent.* 事件写入的 store 卡片（后台启动确认），
 * 以及 pi-subagents 的 .output 转录时间线（子代理真实的逐个工具调用）。
 * 后台子代理不再向父会话流进度——转录文件是它运行期间唯一的实时记录，
 * 所以运行中的子代理以 3s 轮询时间线为准；完成后回落到 store 的结果。
 * 磁盘任务记录（旧 delegate_task live 日志）在最下面，点某条读日志。
 */

interface TimelineEntry {
  kind: string;
  tool_name?: string;
  preview?: string;
  status: string;
  timestamp?: string;
}

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
  // .output 转录时间线（子代理真实工具活动）与是否已定位到转录。
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineFound, setTimelineFound] = useState(false);

  const live = agent
    ? subAgents.find((a) => a.id === agent.id || a.name === agent.id)
    : undefined;
  const isRunning = live?.status === "running";

  const load = useCallback(
    async (silent = false) => {
      if (!isElectron() || !agent) {
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const api = (window as any).electron as any;
        // 过滤键 = pi 后端 sid（manifest.json 里的命名空间），不是前端会话 id。
        // 无后端会话 → 无磁盘记录，不退化为列出全部。
        const sid = await resolveBackendSid(
          useHelixStore.getState().currentSessionId,
        );
        if (!sid) {
          setDelegation(null);
          return;
        }
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

  // ── .output 转录时间线 ──────────────────────────────────────────────────
  // agent.id 是父会话的 Agent 工具调用 id；.output 文件名是扩展的子代理
  // id。优先用卡片上绑定的 agentId（后台启动确认带回，重启不丢）；缺失时
  // 退回查 subagent_map（只对网关未重启的会话有效）。运行中 3s 轮询。
  const pollTimeline = useCallback(
    async (silent = true) => {
      if (!isElectron() || !agent) return;
      try {
        const api = (window as any).electron as any;
        const store = useHelixStore.getState();
        // 卡片上绑定的扩展子代理 id —— 首选，不依赖任何内存状态。
        const cardAgentId =
          live?.agentId ||
          subAgents.find((a) => a.id === agent.id)?.agentId;
        if (cardAgentId) {
          const res = await api?.delegations?.timeline?.(
            cardAgentId,
            undefined,
            undefined,
            60,
          );
          if (res?.ok && res.found) {
            setTimelineFound(true);
            setTimeline((res.entries || []) as TimelineEntry[]);
            return;
          }
        }
        // 兜底：网关内存映射（会话键是 pi 后端 sid）。
        // subagent_map / .output 目录的会话键都是 pi 后端 sid。无后端会话
        // → 无转录可读，直接跳过（不传键会扫全部实例，跨会话串台）。
        const sid = await resolveBackendSid(store.currentSessionId);
        if (!sid) return;
        const mapRes = await api?.subagentMap?.list?.(sid);
        const mapped: { agent_id: string } | undefined =
          ((mapRes?.agents || []) as { tool_call_id: string; agent_id: string }[]).find(
            (m) => m.tool_call_id === agent.id,
          );
        if (!mapped?.agent_id) return;
        const workDir = store.activeSessionWorkDir || store.selectedWorkDir || undefined;
        const res = await api?.delegations?.timeline?.(
          mapped.agent_id,
          workDir,
          sid,
          60,
        );
        if (res?.ok && res.found) {
          setTimelineFound(true);
          setTimeline((res.entries || []) as TimelineEntry[]);
        }
      } catch {
        /* 静默失败：保留上一次时间线 */
      }
    },
    [agent, live?.agentId, subAgents],
  );

  useEffect(() => {
    if (!isElectron() || !agent) return;
    setTimeline([]);
    setTimelineFound(false);
    pollTimeline(false);
    const interval = setInterval(
      () => pollTimeline(true),
      isRunning ? 3000 : 10000,
    );
    return () => clearInterval(interval);
    // isRunning 变化（完成/失败）时重设轮询频率。
  }, [pollTimeline, isRunning]);

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

  const tasks = delegation?.tasks || [];
  // 标题优先用真实任务描述；agent.name 常是 call_… 工具调用 id（点磁盘
  // 历史项 / 卡片描述缺失时传入），直接显示既丑也不说明任何事。
  const headerTitle =
    live?.description ||
    live?.name ||
    (agent.name && !agent.name.startsWith("call_") ? agent.name : "") ||
    delegation?.tasks?.[0]?.goal ||
    "子 Agent";

  return (
    <div className="flex flex-col h-full w-full min-h-0 min-w-0 bg-card">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-border/40">
        <Terminal className="size-3.5 text-primary shrink-0" />
        <span
          className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/85"
          title={headerTitle}
        >
          {headerTitle}
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
            {/* 优先展示 .output 转录时间线：后台子代理的真实逐个工具
                调用（含结果状态），运行中 3s 轮询。 */}
            {timelineFound && timeline.length > 0 && (
              <div className="space-y-0.5">
                {timeline.slice(-14).map((tc, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-1.5 text-[calc(var(--helix-transcript-size)*0.7857)]"
                  >
                    <span className="text-primary shrink-0">▸</span>
                    <span className="text-foreground/70 font-mono shrink-0">
                      {tc.tool_name || tc.kind}
                    </span>
                    {tc.preview && (
                      <span className="text-muted-foreground truncate min-w-0 flex-1" title={tc.preview}>
                        {tc.preview}
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
                      {tc.status === "running" ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : tc.status === "success" ? (
                        "✓"
                      ) : (
                        "✗"
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {/* store 卡片的工具行（subagent.* 事件）——时间线不可用时的兜底。 */}
            {!timelineFound && (live.toolCalls || []).length > 0 && (
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
            {/* 运行中但时间线还没出现（后台 spawn 刚发生/转录尚未落盘）：
                给出可感知的等待态，而不是空白。 */}
            {isRunning && !timelineFound && (live.toolCalls || []).length === 0 && (
              <div className="flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                正在启动，等待第一个工具调用…
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

        {/* 任务记录（旧 delegate_task 磁盘日志）：只在确实有记录时渲染，
            空列表整个隐藏，避免出现“任务记录 0 个”占一屏。 */}
        {!loading && tasks.length > 0 && (
          <section className="px-3 py-2">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/70">
                任务记录
              </span>
              <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground">
                {tasks.length} 个
              </span>
            </div>
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
          </section>
        )}
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
