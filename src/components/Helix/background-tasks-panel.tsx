"use client";

import {
  Loader2,
  X,
  XCircle,
  CheckCircle2,
  Ban,
  Terminal,
  ScrollText,
  ChevronLeft,
  ChevronDown,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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

/** 任务记录里只有一个 pi 会话 id（sid），这张表把它翻回"属于哪个对话"。
 *  `key` = 前端对话 id（cid），同一个对话的多个历史 sid 会指向同一个 key；
 *  `current` = 该 sid 属于当前打开的这个对话。 */
export interface BgTaskConversation {
  key: string;
  label: string;
  current: boolean;
}

/** 后台任务面板：右上角「后台任务」按钮的弹出卡片。
 *  数据源 = pi-background-tasks 扩展的共享注册表（~/.pi/agent/tasks.json），
 *  由本组件自己轮询（3s），父组件只负责开合与当前会话过滤。 */
export function BackgroundTasksPanel({
  tasks,
  activeSessionId,
  conversationOf,
  onClose,
  onRefresh,
  inline = false,
}: {
  tasks: BgTask[];
  activeSessionId: string | null;
  /** sid → 对话。**不给也能用**：那时除当前对话外，其余按 sid 分组显示成
   *  「未记录会话 <sid 前 8 位>」——总比全部塞进一个匿名桶强。 */
  conversationOf?: Record<string, BgTaskConversation>;
  onClose: () => void;
  onRefresh: () => void;
  /** true = 嵌进「工作面板」当一个 section，不再是绝对定位的右上角弹层。
   *  右上角那个带数量角标的按钮入口已删，工作面板是后台任务的唯一入口。
   *  inline 模式**不画自己的卡片壳**（边框/圆角/阴影/bg-popover 全部交给宿主
   *  的那张卡片，否则就是"卡片里套卡片"），只保留内容排版，并把标题行/条目行
   *  对齐同面板里的子 Agent / 任务清单两个 section；同时去掉固定定位、
   *  max-h 限高、点击外部关闭与右上角关闭 X（高度与关闭由工作面板控制）。 */
  inline?: boolean;
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

  // 点击外部关闭（只有浮层模式；inline 嵌在工作面板里，关不关由工作面板管）
  useEffect(() => {
    if (inline) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [inline, onClose]);

  // ── 按对话分组 ─────────────────────────────────────────────────────────
  // 任务记录里只有 pi 的 sid，要分组就得靠父组件给的 `conversationOf`
  //（sid → 对话）。拿不到映射时按 sid 分组、标成「未记录会话 <sid 前 8 位>」——
  // 总比把别的对话全塞进一个匿名桶强。是否属于"本对话"仍以 live sid
  //（activeSessionId）为准，conversationOf 只负责把 sid 翻译成对话名。
  const convOf = (t: BgTask) => conversationOf?.[t.session_id];
  const isCurrentTask = (t: BgTask) =>
    convOf(t)?.current ??
    (!!activeSessionId && t.session_id === activeSessionId);
  const groupKeyOf = (t: BgTask) =>
    convOf(t)?.key ?? (t.session_id ? `sid:${t.session_id}` : "__unknown__");
  const groupLabelOf = (t: BgTask) =>
    convOf(t)?.label ||
    (t.session_id ? `未记录会话 ${t.session_id.slice(0, 8)}` : "未记录会话");

  const myTasks = activeSessionId ? tasks.filter(isCurrentTask) : tasks;
  const otherTasks = activeSessionId
    ? tasks.filter((t) => !isCurrentTask(t))
    : [];
  // 每个对话一组；tasks 已是「新→旧」（Rust 侧排好），所以组的先后 = 组内
  // 最新任务的位置，最近有活动的对话自然排在前面。
  const otherGroups: Array<{ key: string; label: string; tasks: BgTask[] }> = [];
  {
    const at = new Map<string, number>();
    for (const t of otherTasks) {
      const k = groupKeyOf(t);
      let i = at.get(k);
      if (i === undefined) {
        i = otherGroups.length;
        at.set(k, i);
        otherGroups.push({ key: k, label: groupLabelOf(t), tasks: [] });
      }
      otherGroups[i].tasks.push(t);
    }
  }
  const running = myTasks.filter((t) => t.status === "running");
  const done = myTasks.filter((t) => t.status !== "running");
  const runningAll = tasks.filter((t) => t.status === "running");
  // 每组只列「运行中 + 最近 5 条已结束」——沿用旧「其他来源」的限流（避免历史
  // 堆积把真正在跑的任务挤出视野），只是现在这个上限按**每组**各算。
  const capGroup = (list: BgTask[]) => {
    const run = list.filter((t) => t.status === "running");
    const finished = list.filter((t) => t.status !== "running");
    return {
      list: [...run, ...finished.slice(0, 5)],
      hidden: Math.max(0, finished.length - 5),
    };
  };
  // 其他对话的折叠态：默认"该组有运行中的任务就展开"，用户点过就听用户的。
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});

  // ── inline（嵌进「工作面板」当一个 section）时不画自己的卡片壳 ──────────────
  // 宿主那张 `rounded-2xl border bg-card shadow-2xl` 已经提供了边框/圆角/阴影，
  // 这里再套 `rounded-xl border bg-popover` 就成了"卡片里再套一张卡片"（用户反馈
  // 的「工作面板不要两层」）。所以 inline 只保留**内容排版**，并把标题行/条目行
  // 对齐同面板里的另外两个 section（子 Agent / 任务清单）：标题行
  // `px-2.5 py-2` + size-4 图标 + `text-[0.8571] font-medium`，条目行
  // `px-2 py-1.5 rounded-xl hover:bg-accent/60` 且不画分隔线。
  // 浮层模式（右上角独立弹层）保持原样。
  const shellCls = inline
    ? "w-full flex flex-col text-foreground"
    : "absolute right-0 top-[calc(100%+6px)] z-50 w-[26rem] max-w-[calc(100vw-2rem)] shadow-xl rounded-xl border border-border bg-popover text-popover-foreground flex flex-col";
  const outputShellCls = inline
    ? "w-full flex flex-col text-foreground"
    : "absolute right-0 top-[calc(100%+6px)] z-50 w-[30rem] max-w-[calc(100vw-2rem)] shadow-xl rounded-xl border border-border bg-popover text-popover-foreground flex flex-col";
  const headCls = inline
    ? "flex items-center gap-2.5 min-w-0 px-2.5 py-2 shrink-0"
    : "flex items-center justify-between px-3 py-2 border-b border-border shrink-0";
  const titleCls = inline
    ? "flex-1 min-w-0 truncate flex items-center gap-2.5 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium"
    : "flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] font-semibold";
  const listCls = inline
    ? "flex-1 min-h-0 overflow-y-auto px-1.5 pb-1"
    : "flex-1 overflow-y-auto min-h-0";
  const itemCls = inline
    ? "flex items-center gap-2 px-2 py-1.5 rounded-xl hover:bg-accent/60 transition-colors"
    : "flex items-center gap-2 px-3 py-2 border-b border-border/30 last:border-b-0 hover:bg-muted/20 transition-colors";
  /** 「其他对话」分区的分组标题行（可折叠）。 */
  const groupHeadCls = inline
    ? "w-full flex items-center gap-2 px-2 py-1.5 rounded-xl hover:bg-accent/60 transition-colors text-left text-[calc(var(--helix-transcript-size)*0.7857)]"
    : "w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/20 transition-colors text-left text-[calc(var(--helix-transcript-size)*0.7857)]";
  const otherWrapCls = inline
    ? "mt-1.5 border-t border-border/40"
    : "border-t border-border/50";
  const otherCaptionCls = inline
    ? "px-2.5 py-1.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/70"
    : "px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground bg-muted/30";
  const moreCls = inline
    ? "px-2 py-1 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/50"
    : "px-3 py-1 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/50";

  const openOutput = useCallback(
    async (task: BgTask) => {
      setViewing(task);
      setOutputText("加载中…");
      try {
        const api = (window as any).electron as any;
        const res = await api?.backgroundTasks?.read?.(task.id, 16384);
        if (res?.ok) {
          const text = (res.text || "").trim();
          const kb = res.total_bytes ? ` · 共 ${(res.total_bytes / 1024).toFixed(1)}KB` : "";
          if (text) {
            setOutputText(text + (kb ? `\n\n—— 输出末尾 16KB${kb}` : ""));
          } else {
            // 输出文件存在但为空：区分"还在跑没产出"和"秒退没吐任何东西"
            setOutputText(
              task.status === "running"
                ? "（任务运行中，暂无输出 —— 等它产出后点「刷新输出」）"
                : "（任务已结束，但未产生任何输出 —— 命令可能刚启动就退出了）",
            );
          }
        } else {
          const err = res?.error ?? "未知错误";
          setOutputText(
            err === "output file missing"
              ? "（输出日志文件已不存在 —— 任务是旧会话/重启前启动的，" +
                "扩展重启时清理了日志。之后启动的任务会正常保留输出。）"
              : `读取失败：${err}`,
          );
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
      } catch { /* empty */}
      onRefresh();
    },
    [onRefresh],
  );

  if (viewing) {
    return (
      <div
        ref={ref}
        className={outputShellCls}
      >
        <div
          className={
            inline
              ? "flex items-center gap-2 px-2.5 py-2 shrink-0"
              : "flex items-center justify-between px-3 py-2 border-b border-border shrink-0 gap-2"
          }
        >
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
          {/* 「返回列表」在两种模式下都必须有：浮层里它是关闭按钮（X），
              inline 嵌进工作面板时它是唯一能退回任务列表的入口 ——
              原先 inline 直接不渲染，点开某条输出后就只能把整个工作面板
              关掉才能回去。 */}
          <button
            onClick={() => setViewing(null)}
            className="p-1 rounded text-foreground/50 hover:text-foreground hover:bg-muted/40 shrink-0"
            data-tip={inline ? "返回任务列表" : "关闭"}
          >
            {inline ? <ChevronLeft className="size-3.5" /> : <X className="size-3.5" />}
          </button>
        </div>
        <pre className={`${inline ? "max-h-64" : "flex-1 min-h-0"} overflow-auto px-3 py-2 text-[calc(var(--helix-transcript-size)*0.7143)] font-mono whitespace-pre-wrap break-all text-foreground/80`}
        >
          {outputText}
        </pre>
        {viewing.status === "running" && (
          <div
            className={
              inline
                ? "flex gap-2 px-1.5 py-1.5 shrink-0"
                : "px-3 py-2 border-t border-border shrink-0 flex gap-2"
            }
          >
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

  // 单行任务：状态点 + 终端图标 + 命令 + 耗时 + 看输出（运行中再加终止）。
  // 本对话与其他对话共用同一个渲染（旧版「其他来源」另有一套更小的字号，
  // 分组后没必要再分两套）。
  const taskRow = (task: BgTask, keyPrefix: string) => {
    const isRunning = task.status === "running";
    const durationMs = (task.finished_at ?? Date.now()) - task.started_at;
    return (
      <div key={`${keyPrefix}${task.id}`} className={itemCls}>
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
  };

  return (
    <div
      ref={ref}
      className={shellCls}
    >
      <div className={headCls}>
        <span className={titleCls}>
          {inline && <Terminal className="size-4 text-foreground/50 shrink-0" />}
          后台任务
          {!inline && runningAll.length > 0 && (
            <span className="ml-1.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-primary font-normal">
              {runningAll.length} 运行中
            </span>
          )}
        </span>
        {/* 角标统计：inline 模式（工作面板）只显示本对话任务数；
            独立浮层模式统计全部任务（含其他对话）。 */}
        {inline &&
          (running.length > 0 ? (
            <span className="shrink-0 flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] text-primary">
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              {running.length} 运行中
            </span>
          ) : myTasks.length > 0 ? (
            <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] tabular-nums text-foreground/50">
              {myTasks.length}
            </span>
          ) : undefined)}
        {!inline && (
          <button
            onClick={onClose}
            className="p-1 rounded text-foreground/50 hover:text-foreground hover:bg-muted/40"
            data-tip="关闭"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div className={listCls}>
        {/* 本对话：直接铺开，不折叠（就是用户当前关心的那批）。 */}
        {capGroup(myTasks).list.map((task) => taskRow(task, "my-"))}
        {myTasks.length > 0 && capGroup(myTasks).hidden > 0 && (
          <div className={moreCls}>
            另有 {capGroup(myTasks).hidden} 条已结束任务未列出
          </div>
        )}

        {/* 其他对话：按对话分组、默认折叠（该组有任务在跑就默认展开），
            这样才能一眼看出「别的对话还挂着什么」，而不是糊成一个匿名桶。
            inline 模式（嵌在工作面板里）时隐藏此部分，只显示本对话的任务。 */}
        {!inline && otherGroups.length > 0 && (
          <div className={otherWrapCls}>
            <div className={otherCaptionCls}>
              其他对话（{otherTasks.length}）— 按对话分组
            </div>
            {otherGroups.map((g) => {
              const { list, hidden } = capGroup(g.tasks);
              const runN = g.tasks.filter((t) => t.status === "running").length;
              const open = groupOpen[g.key] ?? runN > 0;
              return (
                <div key={g.key}>
                  <button
                    type="button"
                    onClick={() => setGroupOpen((m) => ({ ...m, [g.key]: !open }))}
                    className={groupHeadCls}
                    data-tip={open ? "收起这个对话的任务" : "展开这个对话的任务"}
                  >
                    <ChevronDown
                      className={`size-3.5 shrink-0 text-foreground/40 transition-transform ${
                        open ? "" : "-rotate-90"
                      }`}
                    />
                    <span className="flex-1 min-w-0 truncate font-medium text-foreground/80">
                      {g.label}
                    </span>
                    {runN > 0 ? (
                      <span className="shrink-0 flex items-center gap-1.5 text-primary">
                        <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                        {runN} 运行中
                      </span>
                    ) : (
                      <span className="shrink-0 tabular-nums text-foreground/50">
                        {g.tasks.length}
                      </span>
                    )}
                  </button>
                  {open && (
                    <div className={inline ? "px-0.5" : ""}>
                      {list.map((task) => taskRow(task, `g:${g.key}:`))}
                      {hidden > 0 && (
                        <div className={moreCls}>
                          另有 {hidden} 条已结束任务未列出
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
