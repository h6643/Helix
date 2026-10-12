"use client";

import {
  ArrowUp,
  Square,
  Zap,
  FileText,
  ShieldCheck,
  ShieldQuestion,
  ChevronDown,
  Check,
  Plus,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BusyBehaviorSelector,
  ReasoningEffortControl,
} from "./agent-flow-panel";
import { ContextUsageIndicator } from "./context-usage";
import {
  BUILTIN_SLASH_COMMANDS,
  runCompactCommand,
} from "./slash-commands";
import { TranscriptMessage } from "./transcript-message";
import { formatDuration } from "./transcript-utils";
import { parseChannelModelLabel } from "@/lib/channel-model";
import { loadSessionMap } from "@/lib/session-map";
import { normalizeAcpContent } from "@/lib/text-utils";
import { useHelixStore } from "@/stores/helix-store";
import type { ApprovalMode, PermissionTier, ReasoningEffortLevel } from "@/stores/helix-types";
import {
  APPROVAL_MODE_ITEMS,
  approvalModeOf,
} from "@/stores/helix-types";

/** 档位表里的 icon 是字符串（为了让 helix-types 不依赖 lucide），这里落地成组件。 */
const MODE_ICONS = {
  ShieldQuestion,
  ShieldCheck,
  Zap,
  FileText,
} as const;

/** 旁路会话草稿键：还没有真实会话时，模型/推理选择先挂在这个键上，
    首个问题创建会话后再搬到真实 cid。与主对话的 DRAFT_SESSION_KEY 同一约定。 */
const BYLINE_DRAFT_KEY = "__byline_draft__";

/** 模型名超长截断：超过 18 字加省略号，与主对话一致。 */
function truncateModelLabel(name: string): string {
  if (name.length <= 18) return name;
  return `${name.slice(0, 18)}…`;
}

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
// mainOnly 的命令（开全局面板那类）在这里不出现——旁路输入框没有它们的落点。
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
    (c) => !c.mainOnly && c.name.toLowerCase().startsWith(q),
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
  const uploadFileInputRef = useRef<HTMLInputElement>(null);
  const bylineFocusSignal = useHelixStore((s) => s.bylineFocusSignal);
  // ── 旁路会话的两条轴（与主线同款语义）──────────────────────────────
  // 权限档：真相是 pi-permission 的 settings.json，这里只是回读缓存。界面只写
  // 「本对话」那一层，身份取**主线这条对话**的 sid —— 旁路问答是它的一个分支，
  // 用户眼里的「本对话」就是眼前这条对话；主线还没建起来（没有 sid）时那次选档
  // 先记在 store 的待落盘表里，同主输入框一个规则。
  // plan：按会话那一轴，写旁路自己的 cid（btw- 前缀）。每轮 run 前
  // agent-flow-panel 的 handleRun 会把合成值经 session/set_mode 送到该会话的
  // pi 实例（网关按 session_id 路由），所以这里只写状态、不另发 RPC。
  const permissionMode = useHelixStore((s) => s.permissionMode);
  const planModeBySession = useHelixStore((s) => s.planModeBySession);
  const setPermissionMode = useHelixStore((s) => s.setPermissionMode);
  const setPlanModeForSession = useHelixStore(
    (s) => s.setPlanModeForSession,
  );
  const modelBySession = useHelixStore((s) => s.modelBySession);
  const setModelForSession = useHelixStore((s) => s.setModelForSession);
  const apiConfig = useHelixStore((s) => s.apiConfig);
  const activeModel = useHelixStore((s) => s.activeModel);
  const providers = useHelixStore((s) => s.providers);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffortLevel>("medium");
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // 模型下拉 portal 到 body 后不在 toolbarRef 树内——外点关闭要同时检查面板
  // 自己的 ref，否则点面板内部也算"外部"，一碰就关。
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  // 开下拉那一刻量好的 fixed 定位（相对视口）。portal 到 body 是为了逃出
  // 右栏/面板根那串 overflow-hidden——二级 flyout 向左开，不 portal 会被
  // 侧栏左缘整个裁掉（表现为二级菜单"被档"）。
  const [modelDropdownPos, setModelDropdownPos] = useState<{
    left: number;
    bottom: number;
    flyoutLeft: boolean;
  } | null>(null);
  const modelDropdownAnchorRef = useRef<HTMLElement | null>(null);

  const toggleModelDropdown = (anchor: HTMLElement | null) => {
    if (!showModelDropdown) {
      modelDropdownAnchorRef.current = anchor;
      if (anchor) {
        const r = anchor.getBoundingClientRect();
        const PANEL_W = 224; // w-56
        const FLYOUT_W = 264; // w-64 + pr-1
        // 面板右缘对齐按钮右缘，再夹回视口内（按钮贴右栏时防溢出）。
        const left = Math.round(
          Math.min(r.right - PANEL_W, window.innerWidth - PANEL_W - 8),
        );
        setModelDropdownPos({
          left,
          bottom: Math.round(window.innerHeight - r.top + 8),
          flyoutLeft: left - FLYOUT_W >= 8,
        });
      }
    } else {
      setModelDropdownPos(null);
    }
    setShowModelDropdown(!showModelDropdown);
    setShowModeDropdown(false);
  };

  // 下拉点外部关闭（与主线输入框工具条同一交互约定）
  useEffect(() => {
    if (!showModeDropdown && !showModelDropdown) return;
    const onDown = (event: MouseEvent) => {
      if (
        !toolbarRef.current?.contains(event.target as Node) &&
        !modelDropdownPanelRef.current?.contains(event.target as Node)
      ) {
        setShowModeDropdown(false);
        setShowModelDropdown(false);
        setModelDropdownPos(null);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showModeDropdown, showModelDropdown]);
  // 面板是 fixed 定位：开的期间跟着 scroll/resize 重算（旁路对话流滚动时
  // 输入框会留在原位，但保险起见与主线同一处理）。
  useEffect(() => {
    if (!showModelDropdown) return;
    const update = () => {
      const anchor = modelDropdownAnchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const PANEL_W = 224;
      const FLYOUT_W = 264;
      const left = Math.round(
        Math.min(r.right - PANEL_W, window.innerWidth - PANEL_W - 8),
      );
      const bottom = Math.round(window.innerHeight - r.top + 8);
      setModelDropdownPos((prev) => {
        const next = {
          left,
          bottom,
          flyoutLeft: left - FLYOUT_W >= 8,
        };
        if (
          prev &&
          prev.left === next.left &&
          prev.bottom === next.bottom &&
          prev.flyoutLeft === next.flyoutLeft
        ) {
          return prev;
        }
        return next;
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [showModelDropdown]);
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

  // 工具条目标：覆盖值挂在旁路会话自己的 cid 上。还没有旁路会话时用草稿键，
  // 让模型/推理选择能在发消息前就生效；首个问题创建会话后再搬到真实 cid。
  const btwCid = byCid ?? BYLINE_DRAFT_KEY;

  // 会话创建后把草稿期选的模型/推理搬到真实 cid，并清掉草稿键。
  useEffect(() => {
    if (!byCid) return;
    const st = useHelixStore.getState();
    const draftModel = st.modelBySession[BYLINE_DRAFT_KEY];
    if (draftModel) {
      st.setModelForSession(byCid, draftModel);
    }
    // 清掉草稿键（下次新会话不会误用旧草稿）
    if (st.modelBySession[BYLINE_DRAFT_KEY]) {
      st.setModelForSession(BYLINE_DRAFT_KEY, { provider: "", model: "" });
    }
  }, [byCid]);
  // 主线这条对话还没建起来时，那次选档还挂在待落盘表上——芯片要跟着它显示，
  // 否则旁路上看到的档位和主输入框上那枚芯片不是同一个值。
  const pendingTier = useHelixStore(
    (s) => s.pendingPermissionTier[mainCid],
  );
  const displayTier = pendingTier ?? permissionMode;
  // 芯片显示的是两条轴合成的那一个值（plan 优先）。合成规则只在
  // helix-types 的 approvalModeOf 里写一次，两个面板共用。
  const effectiveMode: ApprovalMode = approvalModeOf(
    displayTier,
    !!btwCid && !!planModeBySession[btwCid],
  );
  const modelOverride = btwCid ? modelBySession[btwCid] : undefined;
  const effectiveModel = modelOverride?.model || apiConfig?.model || activeModel;

  // 供应商分组（与主对话同一结构）：一级列表按 provider 分组，hover 展开二级飞入菜单
  const piChannelProviders = useHelixStore((s) => s.piChannelProviders);
  const providerModelGroups = useMemo(() => {
    const activeProviderId = apiConfig?.provider;
    const groups: {
      id: string;
      name: string;
      baseUrl: string;
      models: string[];
      labels?: Record<string, string>;
    }[] = [];
    for (const p of providers) {
      const models = new Set<string>();
      (p.models || []).forEach((m) => {
        if (m) models.add(m);
      });
      if (
        apiConfig.model &&
        !models.has(apiConfig.model) &&
        (p.id === activeProviderId ||
          (apiConfig.baseUrl && p.baseUrl === apiConfig.baseUrl))
      ) {
        models.add(apiConfig.model);
      }
      if (models.size > 0) {
        groups.push({
          id: p.id,
          name: p.name || p.id,
          baseUrl: p.baseUrl,
          models: Array.from(models),
        });
      }
    }
    for (const cp of piChannelProviders) {
      if (cp.models.length > 0) {
        groups.push({
          id: `pi:${cp.id}`,
          name: cp.name,
          baseUrl: "",
          models: cp.models.map((x) => x.id),
          labels: Object.fromEntries(cp.models.map((x) => [x.id, x.label])),
        });
      }
    }
    return groups;
  }, [providers, apiConfig, piChannelProviders]);

  // 档位表与主输入框共用同一份（helix-types 的 APPROVAL_MODE_ITEMS）——本地
  // 复制一份必然出现「主界面两档、旁路四档」的对不上。
  const MODE_ITEMS = APPROVAL_MODE_ITEMS.map((m) => ({
    ...m,
    icon: MODE_ICONS[m.icon],
  }));
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

  /**
   * 旁路这里改权限档，写的是**主线这条对话**的会话覆盖：旁路问答是它的一个分支，
   * 用户眼里的「本对话」就是眼前这条对话，不是 `btw-` 那条内部会话。
   * 主线还没建起来（没有 sid）时 store 会把这一档记进待落盘表，第一条消息发出时
   * 落盘 —— 与主输入框那条路径同一个动作，两个面板不会各写一套。
   */
  const writePermissionTier = async (tier: PermissionTier) => {
    await ensureSessionMap();
    const st = useHelixStore.getState();
    await setPermissionMode(tier, {
      sessionId: sessionMapCacheRef.current.get(mainCid)?.sid ?? null,
      cwd: st.activeSessionWorkDir ?? st.selectedWorkDir ?? null,
      cid: mainCid,
    });
  };

  // 输入 /compact 前缀时预热磁盘映射（惰性，不阻塞打字）。
  useEffect(() => {
    if (
      slashQuery !== null &&
      slashQuery.toLowerCase().startsWith("compa")
    ) {
      void ensureSessionMap();
    }
  }, [slashQuery]);

  // 清空草稿后把 textarea 高度压回单行基准（onInput 只在键入时触发，
  // setDraft("") 是程序清空——不重置的话多行输入发送后框会停在长高状态）。
  const resetInputHeight = () => {
    if (inputRef.current) inputRef.current.style.height = "36px";
  };

  // 上传文件：读取文本内容追加到草稿，二进制文件跳过。
  const TEXTUAL_EXT = /\.(txt|md|markdown|mdx|json|yml|yaml|toml|csv|ts|tsx|js|jsx|py|java|c|cpp|h|hpp|go|rs|rb|php|sh|bash|zsh|sql|html|htm|css|scss|less|xml|log|env|gitignore|dockerfile|makefile|rst|tex)$/i;
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const parts: string[] = [];
    for (const file of Array.from(files)) {
      if (TEXTUAL_EXT.test(file.name)) {
        try {
          const text = await file.text();
          if (text.trim()) {
            parts.push(`\n\n[附件: ${file.name}]\n${text}`);
          }
        } catch {
          parts.push(`\n\n[附件: ${file.name} 读取失败]`);
        }
      } else {
        parts.push(`\n\n[附件: ${file.name} (${file.size} 字节)]`);
      }
    }
    if (parts.length > 0) {
      setDraft((prev) => prev + parts.join(""));
    }
    e.target.value = "";
  };

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
        resetInputHeight();
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
        resetInputHeight();
        showToast({
          type: "warning",
          title: "/btw 请从主对话输入框发送",
        });
        return;
      }
    }

    setDraft("");
    resetInputHeight();
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
              target.style.height = "auto";
              const ch = target.scrollHeight;
              const min = 36;
              const nextHeight = ch > min ? Math.min(ch, 200) : min;
              target.style.height = nextHeight + "px";
            }}
            placeholder="输入问题..."
            className="chat-input w-full min-w-0 resize-none bg-transparent caret-foreground text-left placeholder:text-left placeholder:text-muted-foreground/70 text-[length:var(--helix-transcript-size)] min-h-[36px] max-h-[200px] px-3 pt-2 pb-1 leading-[1.45] break-all overflow-x-hidden overflow-y-auto text-foreground outline-none"
            style={{
              overflowX: "hidden",
              overflowY: "auto",
              height: "36px",
              wordBreak: "break-all",
              overflowWrap: "anywhere",
            }}
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-2.5 flex-wrap">
            {/* 会话级工具条：plan 与模型只作用于当前旁路会话（写 planModeBySession /
                modelBySession 的 btw-cid 键，handleRun 每轮经 set_mode / set_model
                透传到该会话的实例）；权限档写的是主线那条对话在扩展配置里的格子。 */}
            <div className="relative min-w-0 flex items-center gap-1" ref={toolbarRef}>
              {/* 上传文件按钮 */}
              <button
                type="button"
                onClick={() => uploadFileInputRef.current?.click()}
                data-tip="上传附件"
                className="p-2 rounded-xl text-muted-foreground/50 hover:text-foreground hover:bg-muted/40 transition-all duration-200"
              >
                <Plus className="size-4" />
              </button>
              <input
                ref={uploadFileInputRef}
                type="file"
                multiple
                accept="*/*"
                onChange={handleFileUpload}
                className="hidden"
              />
              {(
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setShowModeDropdown((v) => !v);
                      setShowModelDropdown(false);
                    }}
                    data-tip={`${
                      (MODE_ITEMS.find((m) => m.id === effectiveMode)?.title) ??
                      "自动审批"
                    } — ${
                      effectiveMode === "plan"
                        ? "制定计划：只对本旁路会话生效，选一个权限档即退出"
                        : "审批模式：只对本旁路会话所属的那条对话生效（值来自 pi-permission 的配置）"
                    }`}
                    className="flex items-center gap-1.5 px-2.5 h-8 rounded-xl ui-text-sm2 transition-all duration-200 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  >
                    <ShieldQuestion className="size-3.5" />
                    <ChevronDown className="size-3" />
                  </button>
                  <BusyBehaviorSelector compact />
                  <ContextUsageIndicator sessionId={btwCid} />
                  <div className="relative min-w-0 max-w-[140px]">
                    <button
                      type="button"
                      onClick={(e) => {
                        toggleModelDropdown(e.currentTarget);
                      }}
                      data-tip="模型（仅本旁路会话）"
                      className="flex w-full items-center justify-between gap-1.5 min-w-0 px-2.5 h-8 rounded-xl ui-text-sm2 transition-all duration-200 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    >
                      <span className="truncate min-w-0 text-left">
                        {effectiveModel
                          ? effectiveModel.length > 8
                            ? effectiveModel.slice(0, 8) + "…"
                            : effectiveModel
                          : "选择模型"}
                      </span>
                    </button>
                  </div>
                  <ReasoningEffortControl
                    value={reasoningEffort}
                    onChange={(v) => setReasoningEffort(v)}
                  />
                  {isRunning ? (
                    <button
                      type="button"
                      onClick={stopByline}
                      data-tip="停止"
                      className="flex items-center gap-1.5 px-2.5 h-8 rounded-xl transition-all duration-200 flex items-center justify-center text-foreground border border-border/60 bg-muted/40 hover:bg-muted/70"
                    >
                      <Square className="size-3.5 text-foreground fill-foreground shrink-0" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!draft.trim()}
                      data-tip="发送"
                      className="flex items-center gap-1.5 px-2.5 h-8 rounded-xl transition-all duration-200 flex items-center justify-center border border-border/60 bg-muted/40 hover:bg-muted/70 text-foreground/40 disabled:opacity-40"
                    >
                      <ArrowUp className="size-3.5 shrink-0" />
                    </button>
                  )}
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
                          setShowModeDropdown(false);
                          if (mode.id === "plan") {
                            // plan 只作用于这条旁路会话（下一轮 run 经 set_mode
                            // 送到它的 pi 实例）。
                            setPlanModeForSession(btwCid, true);
                            return;
                          }
                          // 权限档：写的是 pi-permission 的 settings.json 里属于
                          // 主线那条对话的那一格（见 writePermissionTier）。旁路
                          // 与主线共用同一格，所以不会出现「主界面自动审批、旁路
                          // 完全访问」—— 那本来就不可能存在，扩展只读一个文件，
                          // 闸门用的就是它解析出的生效档。
                          setPlanModeForSession(btwCid, false);
                          void writePermissionTier(mode.id);
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

              {showModelDropdown && btwCid && modelDropdownPos &&
                createPortal(
                  <div
                    ref={modelDropdownPanelRef}
                    style={{
                      position: "fixed",
                      left: modelDropdownPos.left,
                      bottom: modelDropdownPos.bottom,
                    }}
                    className="w-56 overflow-visible bg-card rounded-xl border border-border/40 shadow-xl z-50 animate-scale-in"
                  >
                  <div className="py-1">
                    {providerModelGroups.length === 0 && (
                      <div className="px-3 py-4 text-center text-[length:var(--helix-transcript-size)] text-foreground/40">
                        暂无可用模型
                      </div>
                    )}
                    {providerModelGroups.map((g) => (
                      <div
                        key={g.id}
                        className="group relative flex items-center gap-1.5 px-2 py-1.5 cursor-default transition-colors rounded-lg hover:bg-muted/70"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="truncate ui-text-sm2 font-semibold text-foreground">
                            {g.name}
                          </span>
                        </div>
                        <svg
                          className="size-4 shrink-0 text-muted-foreground/50"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="m9 18 6-6-6-6" />
                        </svg>
                        <div className={`invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-opacity duration-100 absolute bottom-0 ${
                          modelDropdownPos?.flyoutLeft
                            ? "right-full pr-1"
                            : "left-full pl-1"
                        }`}>
                          <div
                            className={`${g.labels ? "w-64 max-w-[256px]" : "w-52 max-w-[208px]"} max-h-[min(360px,55vh)] overflow-y-auto overscroll-contain rounded-xl border border-border/40 bg-card shadow-xl z-50 py-1`}
                          >
                            {g.models.length === 0 ? (
                              <div className="px-3 py-3 text-center text-[length:var(--helix-transcript-size)*0.8571] text-foreground/40">
                                该供应商暂无模型
                              </div>
                            ) : (
                              g.models.map((m) => {
                                const label = g.labels?.[m];
                                const parts = label
                                  ? parseChannelModelLabel(label)
                                  : undefined;
                                const active = effectiveModel === m;
                                return (
                                  <button
                                    key={m}
                                    type="button"
                                    onClick={() => {
                                      const owner = g.id.startsWith("pi:")
                                        ? g.id.slice(3)
                                        : useHelixStore
                                            .getState()
                                            .resolveModelProvider(m)?.name ||
                                            (apiConfig?.provider &&
                                            apiConfig.provider !== "__custom__"
                                              ? apiConfig.provider
                                              : "custom");
                                      setModelForSession(btwCid, {
                                        provider: owner,
                                        model: m,
                                      });
                                      showToast({
                                        type: "success",
                                        title: `本会话模型切换为 ${m}`,
                                      });
                                      setShowModelDropdown(false);
                                    }}
                                    className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left transition-colors rounded-lg hover:bg-muted/70"
                                  >
                                    {parts ? (
                                      <>
                                        <span
                                          className="flex min-w-0 flex-1 items-baseline gap-1.5"
                                          data-tip={m}
                                        >
                                          <span className="min-w-0 shrink truncate font-mono ui-text text-foreground">
                                            {parts.name}
                                          </span>
                                          {parts.notes.length > 0 && (
                                            <span className="min-w-0 shrink truncate text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/50">
                                              {parts.notes.join(" ")}
                                            </span>
                                          )}
                                        </span>
                                        <span className="w-11 shrink-0 text-right font-mono tabular-nums text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
                                          {parts.factor}
                                        </span>
                                      </>
                                    ) : (
                                      <span
                                        className="min-w-0 flex-1 truncate font-mono ui-text text-foreground"
                                        data-tip={m}
                                      >
                                        {truncateModelLabel(m)}
                                      </span>
                                    )}
                                    <span className="flex w-3.5 shrink-0 items-center justify-center">
                                      {active && (
                                        <span
                                          className="text-foreground/50"
                                          data-tip="当前模型"
                                        >
                                          <Check className="size-3.5" />
                                        </span>
                                      )}
                                    </span>
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  </div>,
                  document.body,
                )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
