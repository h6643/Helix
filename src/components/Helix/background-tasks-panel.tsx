"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  X,
  XCircle,
  CheckCircle2,
  Ban,
  Terminal,
  ScrollText,
} from "lucide-react";

/** 后台任务记录（与 pi-background-tasks 扩展的 tasks.json schema 对齐，
 *  经 Rust tasks_list 命令读出——Rust 侧还会把 running 但进程已消失的
 *  任务就地标记为 failed，前端拿来即用）。 */
export interface BgTask {
  id: string;
  command: string;
  pid: number;
  session_id: string;
  started_at: number;
  status: "running" | "completed" | "failed" | "killed";
  exit_code?: number;
  finished_at?: number;
  output_file: string;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m} 分 ${r} 秒` : `${m} 分`;
}

/** 后台任务面板：右上角「后台任务」按钮的弹出卡片。
 *  数据源 = pi-background-tasks 扩展的共享注册表（~/.pi/agent/tasks.json），
 *  由本组件自己轮询（3s），父组件只负责开合与当前会话过滤。 */
export function BackgroundTasksPanel({
  tasks,
  activeSessionId,
  onClose,
  onRefresh,
}: {
  tasks: BgTask[];
  activeSessionId: string | null;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewing, setViewing] = useState<BgTask | null>(null);
  const [outputText, setOutputText] = useState<string>("加载中…");
  const [, setTick] = useState(0);

  // 每秒 tick 刷新运行中任务的耗时显示
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 点击外部关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  // 我的任务：当前会话的任务排前面，其余会话的任务折叠在后（后端 tasks
  // 按 session_id 过滤；会话切换期间 sid 可能为 null → 显示全部）。
  const myTasks = activeSessionId
    ? tasks.filter((t) => t.session_id === activeSessionId)
    : tasks;
  const running = myTasks.filter((t) => t.status === "running");
  const done = myTasks.filter((t) => t.status !== "running");

  const openOutput = useCallback(
    async (task: BgTask) => {
      setViewing(task);
      setOutputText("加载中…");
      try {
        const api = (window as any).electron as any;
        const res = await api?.backgroundTasks?.read?.(task.id, 16384);
        if (res?.ok) {
          setOutputText(res.text || "(暂无输出)");
        } else {
          setOutputText(`读取失败：${res?.error ?? "未知错误"}`);
        }
      } catch (e) {
        setOutputText(`读取失败：${String(e)}`);
      }
    },
    [],
  );

  const killTask = useCallback(
    async (task: BgTask) => {
      try {
        const api = (window as any).electron as any;
        await api?.backgroundTasks?.kill?.(task.id);
      } catch {}
      onRefresh();
    },
    [onRefresh],
  );

  if (viewing) {
    return (
      <div
        ref={ref}
        className="absolute right-0 top-[calc(100%+6px)] z-50 w-[30rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover text-popover-foreground shadow-xl flex flex-col max-h-[60vh]"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0 gap-2">
          <span className="flex-1 min-w-0 truncate font-mono text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/80">
            {viewing.command}
          </span>
          <span
            className={`shrink-0 text-[calc(var(--helix-transcript-size)*0.7143)] ${
              viewing.status === "running"
                ? "text-primary"
                : viewing.status === "completed"
                  ? "text-emerald-500"
                  : "text-red-500"
            }`}
          >
            {viewing.status === "running"
              ? "运行中"
              : viewing.status === "completed"
                ? `完成 (exit 0)`
                : viewing.status === "killed"
                  ? "已终止"
                  : `失败${viewing.exit_code !== undefined ? ` (exit ${viewing.exit_code})` : ""}`}
          </span>
          <button
            onClick={() => setViewing(null)}
            className="p-1 rounded text-foreground/50 hover:text-foreground hover:bg-muted/40 shrink-0"
            data-tip="返回列表"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <pre className="flex-1 overflow-auto min-h-0 px-3 py-2 text-[calc(var(--helix-transcript-size)*0.7143)] font-mono whitespace-pre-wrap break-all text-foreground/80">
          {outputText}
        </pre>
        {viewing.status === "running" && (
          <div className="px-3 py-2 border-t border-border shrink-0 flex gap-2">
            <button
              onClick={() => openOutput(viewing)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[calc(var(--helix-transcript-size)*0.7143)] text-primary hover:bg-primary/10 transition-colors"
            >
              <ScrollText className="size-3" />
              刷新输出
            </button>
            <button
              onClick={() => {
                killTask(viewing);
                setViewing(null);
              }}
              className="flex items-center gap-1 px-2 py-1 rounded text-[calc(var(--helix-transcript-size)*0.7143)] text-red-500 hover:bg-red-500/10 transition-colors"
            >
              <Ban className="size-3" />
              终止任务
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="absolute right-0 top-[calc(100%+6px)] z-50 w-[26rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover text-popover-foreground shadow-xl flex flex-col max-h-[50vh]"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-semibold">
          后台任务
          {running.length > 0 && (
            <span className="ml-1.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-primary font-normal">
              {running.length} 运行中
            </span>
          )}
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded text-foreground/50 hover:text-foreground hover:bg-muted/40"
          data-tip="关闭"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {myTasks.length === 0 && (
          <div className="px-3 py-6 text-center text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/40">
            当前对话没有后台任务。
            <br />
            <span className="text-[calc(var(--helix-transcript-size)*0.7143)]">
              提示模型使用 background 工具启动长任务，这里就能看到。
            </span>
          </div>
        )}
        {[...running, ...done].map((task) => {
          const isRunning = task.status === "running";
          const durationMs =
            (task.finished_at ?? Date.now()) - task.started_at;
          return (
            <div
              key={task.id}
              className="flex items-center gap-2 px-3 py-2 border-b border-border/30 last:border-b-0 hover:bg-muted/20 transition-colors"
            >
              {isRunning ? (
                <Loader2 className="size-3.5 text-primary shrink-0 animate-spin" />
              ) : task.status === "completed" ? (
                <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
              ) : (
                <XCircle className="size-3.5 text-red-500 shrink-0" />
              )}
              <Terminal className="size-3.5 text-foreground/30 shrink-0" />
              <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.7857)] font-mono text-foreground/80">
                {task.command}
              </span>
              <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground shrink-0">
                {formatDuration(durationMs)}
              </span>
              <button
                onClick={() => openOutput(task)}
                className="p-0.5 rounded text-foreground/30 hover:text-foreground hover:bg-muted/40 transition-colors shrink-0"
                data-tip="查看输出"
              >
                <ScrollText className="size-3" />
              </button>
              {isRunning && (
                <button
                  onClick={() => killTask(task)}
                  className="p-0.5 rounded text-foreground/30 hover:text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
                  data-tip="终止"
                >
                  <Ban className="size-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
