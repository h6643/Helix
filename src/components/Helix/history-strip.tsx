"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useRef,
} from "react";
import { useHelixStore } from "@/stores/helix-store";

const PAGE_SIZE = 20;

export function HistoryStrip() {
  const chatMessages = useHelixStore((s) => s.chatMessages);
  const currentSessionId = useHelixStore((s) => s.currentSessionId);
  const rightSidebarOpen = useHelixStore(
    (s) => s.rightSidebarTab !== null && s.rightSidebarOpen,
  );
  const [hovered, setHovered] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pageOffset, setPageOffset] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardTop, setCardTop] = useState(0);

  // 悬停清空走「延迟 + 取消」：指针从横杠移到预览卡片要跨出条带盒，
  // 立刻清空会让卡片在途中消失（根本点不到）。离开后 80ms 内没有新的
  // 进入事件才真正收起。
  const clearTimerRef = useRef<number | null>(null);
  const cancelClear = useCallback(() => {
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
  }, []);
  const scheduleClear = useCallback(() => {
    cancelClear();
    clearTimerRef.current = window.setTimeout(() => setHovered(null), 80);
  }, [cancelClear]);
  useEffect(() => cancelClear, [cancelClear]);

  const messages = useMemo(
    () =>
      chatMessages.filter((m) => {
        // 与 agent-flow-panel 的 sessionMessages 同一规则（严格二选一）：
        // 「无 sessionId 的消息」属于**新对话**（currentSessionId 为 null）那一屏，
        // 不是"每个会话都能看到"。旧写法 `!m.sessionId || …` 会让草稿期的用户输入
        // 出现在所有会话的定位条里，点进去却找不到对应消息（它根本不在那个会话里）。
        const own = currentSessionId
          ? m.sessionId === currentSessionId
          : !m.sessionId;
        return own && m.role === "user";
      }),
    [chatMessages, currentSessionId],
  );

  const totalPages = Math.max(1, Math.ceil(messages.length / PAGE_SIZE));
  useEffect(() => {
    setPageOffset(0);
  }, [currentSessionId]);
  const safeOffset = Math.min(pageOffset, totalPages - 1);
  const pageStart = Math.max(0, messages.length - (safeOffset + 1) * PAGE_SIZE);
  const pageMessages = messages.slice(pageStart, pageStart + PAGE_SIZE);
  const curPage = safeOffset + 1;

  const locate = useCallback((id: string) => {
    let tries = 12;
    const attempt = () => {
      const viewport = document.querySelector(
        ".msg-scroll-viewport",
      ) as HTMLElement | null;
      const root = viewport ?? document;
      const el = root.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
      if (!el) {
        // 目标消息可能还没挂载（切会话/流式渲染中）——按帧重试，
        // 不能一击不中就静默放弃（点击"没反应"的来源之一）。
        if (--tries > 0) requestAnimationFrame(attempt);
        return;
      }
      if (viewport) {
        // 只滚对话视口自己：scrollIntoView 会连带滚动所有可滚祖先，
        // 外层若可滚会把整页/整栏挪走，对话区看起来就是"没跳"。
        const vpRect = viewport.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const top =
          viewport.scrollTop +
          (elRect.top - vpRect.top) -
          (viewport.clientHeight - elRect.height) / 2;
        viewport.scrollTo({ top, behavior: "smooth" });
      } else {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    };
    attempt();
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (totalPages <= 1) return;
      // Need passive: false to allow preventDefault
      e.preventDefault();
      if (e.deltaY < 0) {
        setPageOffset((p) => Math.min(p + 1, totalPages - 1));
      } else if (e.deltaY > 0) {
        setPageOffset((p) => Math.max(p - 1, 0));
      }
    },
    [totalPages],
  );

  useEffect(() => {
    const viewport = document.querySelector(
      ".msg-scroll-viewport",
    ) as HTMLElement | null;
    if (!viewport || messages.length === 0) return;

    let raf = 0;
    const update = () => {
      const vTop = viewport.scrollTop;
      const vCenter = vTop + viewport.clientHeight / 2;
      let best: string | null = null;
      let bestDist = Infinity;
      for (const m of messages) {
        const el = viewport.querySelector(
          `[data-message-id="${CSS.escape(m.id)}"]`,
        ) as HTMLElement | null;
        if (!el) continue;
        const elCenter = el.offsetTop + el.offsetHeight / 2;
        const dist = Math.abs(elCenter - vCenter);
        if (dist < bestDist) {
          bestDist = dist;
          best = m.id;
        }
      }
      setActiveId(best);
    };

    update();
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    viewport.addEventListener("scroll", onScroll, { passive: false });
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [messages]);

  // 右侧边栏打开时，条带变窄（让出空间），对话长条显示成一个个点
  const compact = rightSidebarOpen;

  // 悬停的消息 → 卡片内容：粗体 = 开头一行，灰色 = 后续内容（3 行截断加 …）
  const hoveredMsg =
    hovered !== null
      ? (pageMessages.find((m) => m.id === hovered) ?? null)
      : null;
  const rawCard = (hoveredMsg?.content ?? "").trim();
  const nlIdx = rawCard.indexOf("\n");
  const cardTitle = rawCard
    ? nlIdx === -1
      ? rawCard
      : rawCard.slice(0, nlIdx)
    : "(空消息)";
  const cardPreview = nlIdx === -1 ? "" : rawCard.slice(nlIdx + 1).trim();

  // 卡片定位：与悬停横杠对齐（上移 8px），并在条带容器高度内夹紧，
  // 防止悬停首/尾条时卡片溢出容器上下缘。用 rect 而非 offsetTop ——
  // 横杠在可滚动列表里，offsetTop 不随滚动变化会错位。
  useLayoutEffect(() => {
    if (!hoveredMsg) return;
    const cont = containerRef.current;
    const card = cardRef.current;
    if (!cont || !card) return;
    const btn = cont.querySelector<HTMLElement>(
      `[data-bar-id="${CSS.escape(hoveredMsg.id)}"]`,
    );
    if (!btn) return;
    const cRect = cont.getBoundingClientRect();
    const bRect = btn.getBoundingClientRect();
    const top = Math.max(
      0,
      Math.min(bRect.top - cRect.top - 8, cRect.height - card.offsetHeight),
    );
    setCardTop(top);
    // 宽度兜底：窄面板（侧栏全开）时 320px 卡片可能越过视口右缘，
    // 按条带到视口右缘的可用宽度收缩。
    const maxW = Math.max(160, window.innerWidth - cRect.left - 48);
    card.style.width = `${Math.min(320, maxW)}px`;
  }, [hoveredMsg]);

  if (messages.length === 0) return null;

  return (
    // 外层盒与条带区 pointer-events-none / auto 分工：只有条带列和预览卡片
    // 响应鼠标，卡片紧贴条带右缘（left-2.5 = 横杠宽度），中间无死区，
    // 指针滑过去靠延迟清空（scheduleClear）保持悬停态。
    <div
      className="absolute left-2 top-[6%] bottom-[12%] z-30 pointer-events-none"
      ref={containerRef}
    >
      <div
        className="flex flex-col gap-1.5 overflow-y-auto hide-scrollbar py-1 pointer-events-auto"
        onMouseEnter={cancelClear}
        onMouseLeave={scheduleClear}
        onWheel={onWheel}
      >
        {pageMessages.map((m) => {
          const isActive = activeId === m.id;
          const isHovered = hovered === m.id;

          return (
            <button
              key={m.id}
              type="button"
              data-bar-id={m.id}
              onClick={() => locate(m.id)}
              onMouseEnter={() => {
                cancelClear();
                setHovered(m.id);
              }}
              className={`
                flex items-center h-1.5 shrink-0 rounded-md
                transition-all duration-200
                ${compact ? "w-2.5 px-0" : "w-2.5 px-0"}
                ${isHovered ? "bg-muted/60" : ""}
              `}
            >
              {/* 细线 / 圆点 */}
              <span
                className={`
                  rounded-full shrink-0 transition-all duration-200
                  ${compact ? "size-1" : "w-2 h-0.5"}
                  ${isActive ? "bg-primary" : "bg-primary/30"}
                `}
              />
            </button>
          );
        })}

        {totalPages > 1 && !compact && (
          <div className="relative z-10 flex items-center gap-0.5 pt-1 mt-0.5 border-t border-border/40">
            <button
              type="button"
              onClick={() =>
                setPageOffset((p) => Math.min(p + 1, totalPages - 1))
              }
              disabled={safeOffset >= totalPages - 1}
              className="p-0.5 rounded text-sidebar-foreground/40 hover:text-sidebar-foreground disabled:opacity-25 transition-colors"
            >
              <ChevronUp className="size-3" />
            </button>
            <span
              className="px-0.5 text-[calc(var(--helix-transcript-size)*0.6429)] text-sidebar-foreground/30 select-none"
              style={{ lineHeight: 1 }}
            >
              {curPage}/{totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPageOffset((p) => Math.max(p - 1, 0))}
              disabled={safeOffset <= 0}
              className="p-0.5 rounded text-sidebar-foreground/40 hover:text-sidebar-foreground disabled:opacity-25 transition-colors"
            >
              <ChevronDown className="size-3" />
            </button>
          </div>
        )}
      </div>

      {/* 预览卡片：只显示悬停的那一条消息——粗体开头一行 + 灰色后续内容
          （line-clamp-3，超出加省略号）。可点击：点卡片 = 跳到这条消息
          （旧版标题层 pointer-events-none，点标题只会穿透到对话区，
          表现为"点了不跳转"）。对话不再整段淡出，卡片浮在上方。 */}
      {hoveredMsg && (
        <div
          ref={cardRef}
          style={{ top: cardTop }}
          onMouseEnter={cancelClear}
          onMouseLeave={scheduleClear}
          onClick={() => locate(hoveredMsg.id)}
          className="absolute left-2.5 bg-card border border-border/40 rounded-xl shadow-lg px-4 py-3 pointer-events-auto cursor-pointer select-none"
        >
          <div className="truncate text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
            {cardTitle}
          </div>
          {cardPreview && (
            <div className="mt-1 text-[calc(var(--helix-transcript-size)*0.8571)] leading-relaxed text-muted-foreground line-clamp-3">
              {cardPreview}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
