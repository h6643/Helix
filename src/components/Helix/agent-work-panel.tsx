"use client";

import {
  Loader2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { isElectron } from "@/lib/electron-bridge";
import { resolveBackendSids } from "@/lib/session-map";
import {
  isSyntheticSubAgentToolRow,
  getToolIcon,
  getToolLabel,
  extractCommandSnippet,
} from "@/lib/tool-display-utils";
import { cn } from "@/lib/utils";
import { classifyTool } from "@/lib/tool-merge";
import { useHelixStore } from "@/stores/helix-store";
import { HelixMarkdown } from "@/components/Helix/helix-markdown";

interface Delegation {
  id: string;
  path: string;
  agent_id?: string;
}

interface TimelineEntry {
  kind: string;
  tool_name?: string;
  preview?: string;
  status: string;
  timestamp?: string;
}

type StepStatus = "running" | "success" | "error";

/** 一条原始工具行。detail 只用于悬停提示，不再逐条铺在面板上。 */
interface RawStep {
  toolName: string;
  detail: string;
  status: StepStatus;
}

/** 合并同类后的一行：`查阅 · 2 搜索, 1 文件`。items 保留组内原始工具行，供展开。 */
interface MergedStep {
  icon: ReactNode;
  label: string;
  detail: string;
  status: StepStatus;
  tip: string;
  items: RawStep[];
}

// 工具名 → 「类目动词 + 细分类目」的权威判定已抽到 @/lib/tool-merge 的
// classifyTool（与子 Agent 面板、主对话区共用同一份规则，避免动词表漂移）。

function oneLine(s: string, max: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 「合并同类」：连续同类目的工具收成一行（查阅 · 2 搜索, 1 文件），
 * 不再一条工具一行地铺原始参数 JSON。失败步单独成行，保证错误可见。
 */
function mergeSteps(raw: RawStep[]): MergedStep[] {
  const groups: Array<{ verb: string; items: RawStep[] }> = [];
  for (const s of raw) {
    const { verb } = classifyTool(s.toolName);
    const last = groups[groups.length - 1];
    const lastFailed = !!last && last.items.some((i) => i.status === "error");
    if (last && last.verb === verb && !lastFailed) last.items.push(s);
    else groups.push({ verb, items: [s] });
  }
  return groups.map((g) => {
    const counts = new Map<string, number>();
    for (const i of g.items) {
      const { kind } = classifyTool(i.toolName);
      counts.set(kind, (counts.get(kind) || 0) + 1);
    }
    const status: StepStatus = g.items.some((i) => i.status === "error")
      ? "error"
      : g.items.some((i) => i.status === "running")
        ? "running"
        : "success";
    // 终端：只有一条时把命令本体顶上来（信息量大于计数），多条才收成计数。
    const detail =
      g.verb === "终端"
        ? g.items.length === 1
          ? oneLine(
              extractCommandSnippet({ raw: g.items[0].detail }) ||
                g.items[0].detail,
              60,
            ) || "1 个命令"
          : `${g.items.length} 个命令`
        : [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
    return {
      icon: getToolIcon(g.items[0].toolName),
      label: g.verb,
      detail,
      status,
      items: g.items,
      tip: g.items
        .map((i) => `${i.toolName}${i.detail ? `  ${i.detail}` : ""}`)
        .join("\n"),
    };
  });
}

export function AgentWorkPanel() {
  const agent = useHelixStore((s) => s.activeAgentView);
  const subAgents = useHelixStore((s) => s.subAgents);

  const [delegation, setDelegation] = useState<Delegation | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineFound, setTimelineFound] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  // 执行流每组合并行的展开态。默认全折叠（只显示合并摘要），点击展开看组内原始工具。
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const live = agent
    ? subAgents.find((a) => a.id === agent.id || a.name === agent.id)
    : undefined;
  const isRunning = live?.status === "running";
  // 切换子 agent 时收起展开态，避免上个 agent 的指令/执行流展开态残留。
  useEffect(() => {
    setPromptOpen(false);
    setExpanded(new Set());
  }, [agent?.id]);

  const load = useCallback(
    async (silent = false) => {
      if (!isElectron() || !agent) return;
      try {
        const api = (window as any).electron as any;
        const sids = await resolveBackendSids(
          useHelixStore.getState().currentSessionId,
        );
        if (sids.length === 0) {
          setDelegation(null);
          return;
        }
        const res = await api?.delegations?.list?.(sids);
        if (res?.ok) {
          const found =
            ((res.delegations || []) as Delegation[]).find(
              (d) => d.id === agent.id,
            ) || null;
          setDelegation(found);
        }
      } catch {
        /* silent */
      }
    },
    // key 用 agent.id（原始值）而非 agent 对象引用，避免 sub-agent 状态刷新
    // 导致 agent 对象换新引用 → load/pollTimeline 重建 → effect 反复重建定时器
    [agent?.id],
  );

  useEffect(() => {
    load();
    const timer = setInterval(() => load(true), 10000);
    return () => clearInterval(timer);
  }, [load]);

  const pollTimeline = useCallback(
    async (silent = true) => {
      if (!isElectron() || !agent) return;
      try {
        const api = (window as any).electron as any;
        const store = useHelixStore.getState();
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
        if (delegation?.agent_id && delegation.agent_id !== cardAgentId) {
          const res = await api?.delegations?.timeline?.(
            delegation.agent_id,
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
        const mapSids = await resolveBackendSids(store.currentSessionId);
        if (mapSids.length === 0) return;
        for (const sid of mapSids) {
          const mapRes = await api?.subagentMap?.list?.(sid);
          const mapped: { agent_id: string } | undefined =
            ((mapRes?.agents || []) as { tool_call_id: string; agent_id: string }[]).find(
              (m) => m.tool_call_id === agent.id,
            );
          if (!mapped?.agent_id) continue;
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
            return;
          }
        }
      } catch {
        /* silent */
      }
    },
    // 同上：subAgents 数组随 sub-agent 事件频繁换引用，key 到原始值避免定时器反复重建
    [agent?.id, live?.agentId, delegation?.agent_id],
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
  }, [pollTimeline, isRunning]);

  useEffect(() => {
    setTimeline([]);
    setTimelineFound(false);
  }, [agent?.id]);

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

  const storeRows = (live?.toolCalls || []).filter(
    (tc) => !isSyntheticSubAgentToolRow(tc.toolName),
  );

  // 取原始工具行（timeline 优先，回退 store）。明细只喂给悬停提示，
  // 渲染统一走 mergeSteps 的「合并同类」，不再逐条摊开参数 JSON。
  const rawSteps: RawStep[] = timelineFound
    ? timeline.slice(-20).map((tc) => ({
        toolName: tc.tool_name || tc.kind,
        detail: tc.preview || "",
        status:
          tc.status === "error"
            ? "error"
            : tc.status === "success"
              ? "success"
              : "running",
      }))
    : storeRows
        .filter((tc) => tc.toolName !== "progress")
        .slice(-20)
        .map((tc) => ({
          toolName: tc.toolName,
          detail: tc.params || "",
          status: tc.status as StepStatus,
        }));

  const steps = mergeSteps(rawSteps);

  const statusLabel = isRunning
    ? "运行中"
    : live?.status === "completed"
      ? "已完成"
      : live?.status === "failed"
        ? "已失败"
        : live?.status === "cancelled"
          ? "已取消"
          : "已停止";

  return (
    <div className="flex flex-col h-full w-full min-h-0 min-w-0 bg-card">
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {/* ── Prompt card ─────────────────────────────────────────────── */}
        {live && (
          <div className="rounded-xl border border-border/40 bg-muted/30 px-4 py-3">
            <div className="text-[length:var(--helix-transcript-size)] text-foreground/85 leading-relaxed whitespace-pre-wrap break-words">
              {live.description || live.name}
            </div>
            {/* 完整指令：description 是 3–5 词短标签，text 才是子 agent 真实
                执行的 prompt。默认折叠，点击展开全文，避免"只跑了短标题"的误解。 */}
            {live.text && (
              <div className="mt-2 pt-2 border-t border-border/30">
                <button
                  type="button"
                  onClick={() => setPromptOpen((v) => !v)}
                  className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground hover:text-foreground transition-colors"
                  data-tip={promptOpen ? "收起完整指令" : "展开完整指令"}
                >
                  <span className="select-none text-foreground/40 mr-1">
                    {promptOpen ? "▾" : "▸"}
                  </span>
                  完整指令
                </button>
                {promptOpen && (
                  <pre className="mt-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/75 leading-relaxed whitespace-pre-wrap break-words font-mono">
                    {live.text}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Status line ─────────────────────────────────────────────── */}
        {live && (
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-[calc(var(--helix-transcript-size)*0.8571)]",
                isRunning
                  ? "text-primary"
                  : live.status === "completed"
                    ? "text-emerald-600"
                    : live.status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground",
              )}
            >
              {statusLabel}
            </span>
            {isRunning && (
              <Loader2 className="size-3.5 animate-spin text-primary" />
            )}
          </div>
        )}

        {/* ── Execution flow ──────────────────────────────────────────── */}
        {live && (
          <div className="space-y-0.5">
            {steps.length > 0 &&
              steps.map((step, i) => {
                const open = expanded.has(i);
                return (
                  <div key={i} className="py-0.5">
                    <button
                      type="button"
                      title={step.tip}
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(i)) next.delete(i);
                          else next.add(i);
                          return next;
                        })
                      }
                      className="flex items-center gap-2 w-full text-left py-1 px-1 -mx-1 rounded-sm hover:bg-muted/40 transition-colors text-[calc(var(--helix-transcript-size)*0.8571)]"
                    >
                      <span
                        className={cn(
                          "shrink-0 mt-0.5",
                          step.status === "error"
                            ? "text-destructive"
                            : step.status === "running"
                              ? "text-primary"
                              : "text-muted-foreground",
                        )}
                      >
                        {step.icon}
                      </span>
                      <div className="flex-1 min-w-0 flex items-baseline gap-1">
                        <span className="text-foreground/80 shrink-0">
                          {step.label}
                        </span>
                        {step.detail && (
                          <span className="text-muted-foreground/70 min-w-0 truncate">
                            · {step.detail}
                          </span>
                        )}
                      </div>
                    </button>
                    {open && (
                      <div className="ml-5 mt-0.5 space-y-0.5">
                        {step.items.map((it, j) => (
                          <div
                            key={j}
                            className="flex items-start gap-2 py-0.5 text-[calc(var(--helix-transcript-size)*0.7857)]"
                          >
                            <span
                              className={cn(
                                "shrink-0 mt-0.5",
                                it.status === "error"
                                  ? "text-destructive"
                                  : it.status === "running"
                                    ? "text-primary"
                                    : "text-muted-foreground/60",
                              )}
                            >
                              {getToolIcon(it.toolName)}
                            </span>
                            <div className="flex-1 min-w-0">
                              <span className="text-foreground/70 shrink-0">
                                {getToolLabel(it.toolName) || it.toolName}
                              </span>
                              {it.detail && (
                                <span className="text-muted-foreground/60 ml-1.5 min-w-0 truncate">
                                  {oneLine(it.detail, 90)}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

            {/* Running but no steps yet */}
            {isRunning && steps.length === 0 && (
              <div className="flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground py-1">
                <Loader2 className="size-3 animate-spin" />
                正在启动，等待第一个工具调用…
              </div>
            )}
          </div>
        )}

        {/* ── Result ──────────────────────────────────────────────────── */}
        {live?.result && (
          <HelixMarkdown
            text={live.result}
            className="text-[calc(var(--helix-transcript-size)*0.8571)]"
          />
        )}

        {/* ── Modified files ──────────────────────────────────────────── */}
        {(live?.filesModified || []).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {(live?.filesModified || []).slice(0, 8).map((f, i) => (
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
      </div>
    </div>
  );
}
