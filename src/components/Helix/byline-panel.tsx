"use client";

import {
  Send,
  Square,
  Zap,
  Hand,
  Clock,
  AlertTriangle,
  FileText,
  ChevronDown,
  Check,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadSessionMap } from "@/lib/session-map";
import { useHelixStore } from "@/stores/helix-store";
import type { ApprovalMode } from "@/stores/helix-types";
import { normalizeAcpContent } from "@/lib/text-utils";
import { TranscriptMessage, formatDuration } from "./transcript-message";
import {
  BUILTIN_SLASH_COMMANDS,
  runCompactCommand,
} from "./slash-commands";

/** 剥掉 user 消息里注入的指令段，只留问题正文（首段，到空行为止）。 */
function displayUserContent(raw: string): string {
  const text = raw.trim();
  const idx = text.indexOf("\n\n");
  return idx >= 0 ? text.slice(0, idx) : text;
}

/**
 * 运行中计时（每秒自转）。锚点与主对话同源（draft.startedAt，派发丢失时
 * 兜底记录 ts），避免「旁路只要工作中、连个计时都没有」的悬停观感。
 */
function ElapsedTicker({ startedAt }: { startedAt: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (!startedAt) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return (
    <span className="tabular-nums text-foreground/35">
      {formatDuration(seconds)}
    </span>
  );
}

// 输入 / 时显示的快捷命令提示条：与主对话同一份注册表
// （BUILTIN_SLASH_COMMANDS），按已输前缀过滤；选中项 Enter 补全进输入框。
function SlashHint({
  query,
  onSelect,
}: {
  query: string;
  onSelect: (cmd: string) => void;
}) {
  const [sel, setSel] = useState(0);
  const q = query.toLowerCase();
  const items = BUILTIN_SLASH_COMMANDS.filter(
    (c) => c.name.toLowerCase().startsWith(q),
  );
  useEffect(() => setSel(0), [q]);
  if (items.length === 0) return null;
  const clamped = Math.min(sel, items.length - 1);
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (s + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (s - 1 + items.length) % items.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      // 选中补全进输入框（不直接发）：compact 这类命令后面不跟参数，
      // Enter 补全后下一下 Enter 才发送，与主对话的输入体验一致。
      e.preventDefault();
      onSelect(`/${items[clamped].name} `);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onSelect("");
    }
  };
  return (
    <div
      className="shrink-0 px-3 pb-1.5 space-y-0.5"
      onKeyDown={handleKey}
    >
      {items.map((c, i) => (
        <button
          key={c.name}
          type="button"
          onMouseEnter={() => setSel(i)}
          onClick={() => onSelect(`/${c.name} `)}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
            i === clamped
              ? "bg-muted/60 text-foreground"
              : "text-muted-foreground hover:bg-muted/30"
          }`}
        >
          <span className="ui-text-sm2 font-medium shrink-0">
            /{c.name}
          </span>
          <span className="ui-text-xs text-muted-foreground/70 truncate">
            {c.description}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * 右侧边栏的「旁路问答」面板（rightSidebarTab === "byline"）——一个对话界面。
 *
 * 读**主线会话**（currentSessionId）名下的旁路记录 bylineReplies[mainCid]：
 *  - 对话流 = chatMessages 里 sessionId === rec.sessionId 的 user/assistant 消息
 *    （多轮追问全部累积在同一旁路会话里）；
 *  - 运行中实时追加 streamingDrafts[rec.sessionId] 的流式草稿；
 *  - 底部输入框可多轮追问：提交经 bylineAskSignal 通知 AgentFlowPanel 的
 *    handleBtwAsk（有开放旁路会话则追问，没有则新建），主线视图完全不动；
 *  - 输入 / 弹出快捷命令提示条（与主对话同一份 BUILTIN_SLASH_COMMANDS）：
 *    /compact 直接在本面板压缩当前主线上下文（共享执行体 runCompactCommand）；
 *    /btw 在本面板只是补全提示——真正的 /btw 发问入口是主对话输入框，
 *    选中 /btw 只是把 "/btw " 补全进输入框，发送时提示用户到主对话发问。
 */
export function BylinePanel() {
  const currentSessionId = useHelixStore((s) => s.currentSessionId);
  const bylineReplies = useHelixStore((s) => s.bylineReplies);
  const streamingDrafts = useHelixStore((s) => s.streamingDrafts);
  const chatMessages = useHelixStore((s) => s.chatMessages);
  const bylineAsk = useHelixStore((s) => s.bylineAsk);
  const stopByline = useHelixStore((s) => s.stopByline);
  const showToast = useHelixStore((s) => s.showToast);
  const transcriptFontSize = useHelixStore((s) => s.transcriptFontSize);

  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bylineFocusSignal = useHelixStore((s) => s.bylineFocusSignal);
  // ── 按会话的审批模式 / 模型覆盖（与主线同款语义，只作用于旁路会话）──
  // 覆盖值挂在旁路会话自己的 cid（btw- 前缀）上，handleRun 每轮解析：
  // set_mode / set_model 都带 session_id，网关路由到该会话的 pi 实例。
  const approvalMode = useHelixStore((s) => s.approvalMode);
  const approvalModeBySession = useHelixStore((s) => s.approvalModeBySession);
  const setApprovalModeForSession = useHelixStore(
    (s) => s.setApprovalModeForSession,
  );
  const modelBySession = useHelixStore((s) => s.modelBySession);
  const setModelForSession = useHelixStore((s) => s.setModelForSession);
  const apiConfig = useHelixStore((s) => s.apiConfig);
  const activeModel = useHelixStore((s) => s.activeModel);
  const providers = useHelixStore((s) => s.providers);
  const providerModels = useHelixStore((s) => s.providerModels);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // 下拉点外部关闭（与主线输入框工具条同一交互约定）
  useEffect(() => {
    if (!showModeDropdown && !showModelDropdown) return;
    const onDown = (event: MouseEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) {
        setShowModeDropdown(false);
        setShowModelDropdown(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showModeDropdown, showModelDropdown]);
  // /compact 需要 live 的 cid→sid 映射；旁路面板没有组件级 ref，发命令前
  // 现拉磁盘映射即可（映射在 agent-flow-panel 侧已按事件持久化）。
  const sessionMapCacheRef = useRef<Map<string, import("@/lib/session-map").SessionMapEntry>>(
    new Map(),
  );

  // 面板刚打开（右栏隐藏→可见，display:none 下的 textarea 拿不到焦点）时聚焦
  // 输入框；裸 /btw 也会递增 bylineFocusSignal 强制聚焦一次。
  useEffect(() => {
    if (bylineFocusSignal === 0) return;
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [bylineFocusSignal]);
  // 主线会话 id 的兜底：新对话尚未分配 id（currentSessionId 为 null）时用
  // "__draft__"，与 agent-flow-panel.tsx 的 DRAFT_SESSION_KEY 及 helix-store 的
  // 兜底约定一致——否则新对话里第一次 /btw 在面板侧查不到记录（键不匹配）。
  const mainCid = currentSessionId ?? "__draft__";

  const rec = bylineReplies[mainCid];
  const byCid = rec?.sessionId;

  // 工具条目标：覆盖值挂在旁路会话自己的 cid 上。还没有旁路会话时下拉
  // 禁用（写入没有落点；首个问题仍用全局默认起会话）。
  const btwCid = byCid ?? null;
  const effectiveMode: ApprovalMode =
    (btwCid && approvalModeBySession[btwCid]) || approvalMode;
  const modelOverride = btwCid ? modelBySession[btwCid] : undefined;
  const effectiveModel = modelOverride?.model || apiConfig?.model || activeModel;
  // 候选列表与主线同一来源（provider store 的模型目录），另把当前生效值
  // 兜底加进去，避免瞬时空列表让按钮显示退化。
  const modelChoices = useMemo(() => {
    const set = new Set<string>();
    for (const p of providers) {
      if (p.id && providerModels[p.id]?.length) {
        providerModels[p.id].forEach((m) => m && set.add(m));
      }
      if (p.models?.length) {
        p.models.forEach((m) => m && set.add(m));
      }
    }
    if (apiConfig?.model) set.add(apiConfig.model);
    if (activeModel) set.add(activeModel);
    if (modelOverride?.model) set.add(modelOverride.model);
    return Array.from(set);
  }, [providers, providerModels, apiConfig?.model, activeModel, modelOverride]);

  const MODE_ITEMS: Array<{
    id: ApprovalMode;
    icon: typeof Hand;
    title: string;
    desc: string;
  }> = [
    { id: "default", icon: Hand, title: "请求批准", desc: "全部需批准" },
    { id: "accept_edits", icon: Clock, title: "替我审批", desc: "风险才批准" },
    { id: "dont_ask", icon: AlertTriangle, title: "完全访问", desc: "完全放开" },
    { id: "plan", icon: FileText, title: "制定计划", desc: "先规划后做" },
  ];
  const msgs = byCid
    ? chatMessages.filter((m) => m.sessionId === byCid)
    : [];
  const d = rec ? streamingDrafts[rec.sessionId] : undefined;
  // 运行中判定与主对话对齐：以记录自身的 running 状态为准（草稿还没建立的
  // 派发瞬间/派发丢失场景下也成立），完成后由 finalize 翻 done/error。
  const isRunning = !!rec && rec.status === "running";
  // 流式草稿 → TranscriptMessage 的 blocks 分支（与主对话同一条渲染路径）。
  // 此前只渲染 textBuffer 纯文本：思考/工具阶段没有折叠卡、外面还多包一层
  // helix-md，这是「旁路输出样式和主对话不一样」的根因。实时思考只在还没
  // 有任何块落盘时注入（与主对话 showStreamThinking 规则一致），落盘后由
  // blocks 接管。
  const liveBlocks = (() => {
    const rb = d?.responseBlocks ?? [];
    if (rb.length > 0) return rb;
    const t = d?.streamThinking?.trim();
    return t ? [{ type: "thinking" as const, content: t }] : [];
  })();
  const hasLiveContent = liveBlocks.length > 0 || !!d?.textBuffer?.trim();
  // 计时锚点：与主对话同源（draft.startedAt，handleRun 落 draft 时写入）。
  // 兜底用记录的 ts——派发丢失/草稿未建时也显示已等待时长，不再是无计时的
  // 「工作中」悬停态。
  const startedAt = d?.startedAt || rec?.ts || 0;

  // 输入 / 触发提示条：只显示「/」之后的前缀部分。
  const slashQuery = useMemo(() => {
    if (!draft.startsWith("/")) return null;
    const rest = draft.slice(1);
    // 输入了空格说明已在命令名后——不再提示（已选中补全的状态）。
    if (rest.includes(" ")) return null;
    return rest;
  }, [draft]);

  const handleSlashSelect = (text: string) => {
    setDraft(text.trim() ? text : "");
    inputRef.current?.focus();
  };

  // 发 /compact 前先确保映射在手：handleSend 是同步入口，真命中命令时
  // await 它（预热 effect 可能还没拉完，也可能根本未触发）。
  const ensureSessionMap = async () => {
    if (sessionMapCacheRef.current.size > 0) return sessionMapCacheRef.current;
    try {
      sessionMapCacheRef.current = await loadSessionMap();
    } catch {
      sessionMapCacheRef.current = new Map();
    }
    return sessionMapCacheRef.current;
  };

  // 输入 /compact 前缀时预热磁盘映射（惰性，不阻塞打字）。
  useEffect(() => {
    if (
      slashQuery !== null &&
      slashQuery.toLowerCase().startsWith("compa")
    ) {
      void ensureSessionMap();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashQuery]);

  const handleSend = () => {
    const q = draft.trim();
    if (!q) return;

    // Enter 只发送：旁路回答还在流式输出时忽略发送——追问会经 handleRun 的
    // 后台分支派发，那条路径对「运行中的会话」是 handleStop（toggle）语义，
    // 会让 Enter 变成「停止」。要中断用停止按钮（isRunning 时按钮本身
    // 已切换成停止态）。
    if (isRunning) return;

    // / 快捷命令拦截：与主对话同一套客户端内置命令，纯客户端动作，/ 前缀
    // 绝不发给模型。只有「内置命令名」才在这里截住（/compact、/btw），
    // 其他 /xxx 保持主对话语义——交给旁路会话当普通文本处理（/ 前缀在
    // 主对话是技能名/指令前缀，旁路里模型同样能按文本理解），不搞一刀切。
    const m = q.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (m) {
      const name = m[1].toLowerCase();
      const cmd = BUILTIN_SLASH_COMMANDS.find((c) => c.name === name);
      if (cmd?.action === "compact") {
        setDraft("");
        void (async () => {
          // 发命令前先确保 cid→sid 磁盘映射在手（handleSend 是同步入口，
          // 预热 effect 可能还没拉完）。
          await ensureSessionMap();
          await runCompactCommand(currentSessionId, {
            sessionMap: sessionMapCacheRef.current,
          }).catch((e) => {
            // runCompactCommand 内部已 toast；这里兜住未捕获异常。
            showToast({
              type: "error",
              title: "压缩失败",
              description: String(e),
            });
          });
          // 压缩改的是主线消息，磁盘映射可能已更新——清缓存下次重拉。
          sessionMapCacheRef.current = new Map();
        })();
        return;
      }
      if (cmd?.action === "btw") {
        // /btw 的落点就是本面板本身（主对话发 /btw 才是发问入口）：选中/输入
        // 只补全提示，发送时说明入口，不发空命令。
        setDraft("");
        showToast({
          type: "warning",
          title: "/btw 请从主对话输入框发送",
          description:
            "这里已是旁路问答面板：直接在输入框输入问题（Enter 发送）即可，也可多轮追问。",
        });
        return;
      }
    }

    setDraft("");
    // 附带提交瞬间的主线 cid：面板可能已不是 currentSessionId，追问必须进
    // 提交时那条主线名下开放的旁路会话。
    bylineAsk(q, mainCid);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden bg-background/50">
      {/* 对话流 */}
      <div
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3"
      >
        {msgs.map((m) =>
          m.role === "assistant" ? (
            // 与主对话同一组件：折叠卡（已完成/思考/N 个操作）+ markdown 正文，
            // 视觉上逐字一致。旁路面板不支持搜索/分叉/撤回，传省略。
            <TranscriptMessage
              key={m.id}
              msg={m}
              fontSize={transcriptFontSize}
            />
          ) : (
            // user 气泡：与主对话同款样式（圆角描边、右对齐），但只剥指令段
            // 显示问题正文（指令段是给模型的，不该出现在旁路面板里）。
            <div
              key={m.id}
              data-message-id={m.id}
              className="step-enter flex w-full justify-end"
            >
              <div className="group w-fit max-w-[80%]">
                <div
                  className="px-4 py-2.5 rounded-xl border border-border bg-transparent text-foreground whitespace-pre-wrap break-words text-justify leading-normal"
                  style={{ fontSize: transcriptFontSize }}
                >
                  {displayUserContent(normalizeAcpContent(m.content))}
                </div>
              </div>
            </div>
          ),
        )}
        {isRunning && (
          <div className="step-enter flex w-full justify-start">
            <div className="w-full">
              {/* 顶部运行状态条：与主对话「工作中 + 计时」同款（ 工作中 +
                  formatDuration ）。无论流式内容是否已经落草稿都显示——
                  派发丢失/后端未流式时也不再是「无计时的正悬停态」。 */}
              <div
                className="flex items-center gap-1.5 my-1 text-foreground/50"
                style={{ fontSize: transcriptFontSize + 2 }}
              >
                <span className="font-medium">工作中</span>
                <ElapsedTicker startedAt={startedAt} />
              </div>
              {hasLiveContent ? (
                // 流式态与完成态同组件同路径：思考折叠卡（思考中脉冲）、
                // 工具卡、markdown 正文，样式与主对话一致。
                <TranscriptMessage
                  msg={{
                    id: "__byline-streaming__",
                    role: "assistant",
                    content: d?.textBuffer ?? "",
                    blocks: liveBlocks,
                    timestamp: Date.now(),
                    isStreaming: true,
                  }}
                  fontSize={transcriptFontSize}
                />
              ) : (
                <div className="flex items-center gap-2 text-muted-foreground px-1 py-1">
                  <Zap className="size-3.5 text-violet-500 shrink-0" />
                  <span className="ui-text-sm2">正在回答…</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* / 快捷命令提示条（与主对话同一注册表，选中 Enter 补全） */}
      {slashQuery !== null && (
        <SlashHint query={slashQuery} onSelect={handleSlashSelect} />
      )}

      {/* 底部输入框 */}
      <div className="shrink-0 px-3 py-2">
        <div className="helix-chat-input-card border transition-all duration-200 relative shadow-sm border-border/30 rounded-xl hover:border-border/40">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              const prevHeight = target.style.height || "38px";
              target.style.height = "auto";
              const ch = target.scrollHeight;
              const min = 38;
              const nextHeight = ch > min ? Math.min(ch, 300) : min;
              target.style.height = nextHeight + "px";
            }}
            placeholder="随心输入...（/ 查看快捷命令）"
            className="chat-input w-full min-w-0 resize-none bg-transparent caret-foreground text-left placeholder:text-left placeholder:text-muted-foreground/60 text-[length:var(--helix-transcript-size)] min-h-[38px] max-h-[300px] px-2.5 pt-2 pb-0.5 leading-[1.45] break-all overflow-x-hidden overflow-y-auto text-foreground outline-none"
            style={{
              overflowX: "hidden",
              overflowY: "auto",
              height: "38px",
              wordBreak: "break-all",
              overflowWrap: "anywhere",
            }}
          />
          <div className="flex items-center justify-between px-2 pb-1.5 pt-0">
            {/* 会话级工具条：审批模式 + 模型，只作用于当前旁路会话。
                覆盖值写入 modelBySession / approvalModeBySession 的 btw-cid 键，
                handleRun 每轮经 set_mode / set_model 透传到该会话的实例。 */}
            <div className="relative min-w-0 flex items-center gap-1" ref={toolbarRef}>
              {btwCid && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setShowModeDropdown((v) => !v);
                      setShowModelDropdown(false);
                    }}
                    data-tip="审批模式（仅本旁路会话）"
                    className="h-7 min-w-0 shrink px-1.5 rounded-lg transition-all duration-200 flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-muted/40 text-xs"
                  >
                    {effectiveMode === "default" && <Hand className="size-3" />}
                    {effectiveMode === "accept_edits" && (
                      <Clock className="size-3" />
                    )}
                    {effectiveMode === "dont_ask" && (
                      <AlertTriangle className="size-3" />
                    )}
                    {effectiveMode === "plan" && <FileText className="size-3" />}
                    <span className="truncate min-w-0">
                      {MODE_ITEMS.find((m) => m.id === effectiveMode)?.title}
                    </span>
                    <ChevronDown className="size-2.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowModelDropdown((v) => !v);
                      setShowModeDropdown(false);
                    }}
                    data-tip="模型（仅本旁路会话）"
                    className="h-7 min-w-0 shrink px-1.5 rounded-lg transition-all duration-200 flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-muted/40 text-xs"
                  >
                    <span className="truncate min-w-0 max-w-[120px]">
                      {effectiveModel || "选择模型"}
                    </span>
                    <ChevronDown className="size-2.5" />
                  </button>
                </>
              )}

              {showModeDropdown && btwCid && (
                <div className="absolute bottom-full left-0 mb-2 w-44 bg-card/60 rounded-xl border border-border/40 shadow-xl py-1 z-50 animate-scale-in">
                  {MODE_ITEMS.map((mode) => {
                    const Icon = mode.icon;
                    const active = effectiveMode === mode.id;
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        onClick={() => {
                          setApprovalModeForSession(btwCid, mode.id);
                          setShowModeDropdown(false);
                        }}
                        className={`w-full px-3 py-1.5 flex items-start gap-2 text-left hover:bg-muted/60 transition-colors ${
                          active ? "text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        <Icon className="size-3.5 mt-0.5 shrink-0" />
                        <span className="min-w-0">
                          <span className="block ui-text-sm2 font-medium text-foreground">
                            {mode.title}
                          </span>
                          <span className="block ui-text-sm2 text-muted-foreground">
                            {mode.desc}
                          </span>
                        </span>
                        {active && <Check className="size-3.5 ml-auto mt-0.5" />}
                      </button>
                    );
                  })}
                </div>
              )}

              {showModelDropdown && btwCid && (
                <div className="absolute bottom-full left-0 mb-2 w-56 max-h-72 overflow-y-auto bg-card/60 rounded-xl border border-border/40 shadow-xl py-1 z-50 animate-scale-in">
                  {modelChoices.map((m) => {
                    const active = effectiveModel === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setModelForSession(btwCid, {
                            provider:
                              apiConfig?.provider &&
                              apiConfig.provider !== "__custom__"
                                ? apiConfig.provider
                                : "custom",
                            model: m,
                          });
                          setShowModelDropdown(false);
                        }}
                        className={`w-full px-3 py-1.5 flex items-center gap-2 text-left ui-text-sm2 hover:bg-muted/60 transition-colors ${
                          active
                            ? "text-foreground font-medium"
                            : "text-muted-foreground"
                        }`}
                      >
                        <span className="truncate min-w-0 flex-1">{m}</span>
                        {active && <Check className="size-3.5 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {isRunning ? (
              // 运行中 = 显式停止按钮：经 bylineStopSignal 让 AgentFlowPanel
              // 对旁路会话调 handleStop。Enter 不承担停止（只发送）。
              <button
                type="button"
                onClick={stopByline}
                data-tip="停止"
                className="h-9 w-9 shrink-0 rounded-xl transition-all duration-200 flex items-center justify-center text-muted-foreground hover:text-foreground bg-muted/30 border border-border/30 hover:bg-muted/40"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!draft.trim()}
                data-tip="发送"
                className="h-9 w-9 shrink-0 rounded-xl transition-all duration-200 flex items-center justify-center text-muted-foreground hover:text-foreground bg-muted/30 border border-border/30 hover:bg-muted/40 disabled:opacity-40"
              >
                <Send className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
