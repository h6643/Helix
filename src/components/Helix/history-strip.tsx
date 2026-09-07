"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useHelixStore } from "@/stores/helix-store";

const PAGE_SIZE = 20;

export function HistoryStrip() {
  const chatMessages = useHelixStore((s) => s.chatMessages);
  const currentSessionId = useHelixStore((s) => s.currentSessionId);
  const [hovered, setHovered] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pageOffset, setPageOffset] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(
    () =>
      chatMessages.filter(
        (m) =>
          (!m.sessionId || m.sessionId === currentSessionId) &&
          m.role === "user",
      ),
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
    const viewport = document.querySelector(
      ".msg-scroll-viewport",
    ) as HTMLElement | null;
    const root = viewport ?? document;
    const el = root.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
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

  if (messages.length === 0) return null;

  const isAnyHovered = hovered !== null;

  return (
    // 命中范围恒为 28px 条带：外层盒与文字层均 pointer-events-none，
    // 只有条带本体响应 hover/滚轮。悬停时所有标题一起展开（全部展开保留），
    // 但文字不占命中区——鼠标可穿过文字直接点到对话内容。
    <div
      className="absolute left-5 top-[6%] bottom-[12%] z-30 pointer-events-none"
      ref={containerRef}
    >
      <div
        className="flex flex-col gap-1.5 overflow-y-auto hide-scrollbar py-1 pointer-events-auto"
        onMouseLeave={() => setHovered(null)}
        onWheel={onWheel}
      >
        {pageMessages.map((m) => {
          const isActive = activeId === m.id;
          const isHovered = hovered === m.id;

          return (
            <button
              key={m.id}
              type="button"
              onClick={() => locate(m.id)}
              onMouseEnter={() => setHovered(m.id)}
              className={`
                flex items-center h-2.5 w-7 shrink-0 px-1 rounded-md
                transition-colors duration-150
                ${isHovered ? "bg-muted/60" : ""}
              `}
            >
              {/* 细线 */}
              <span
                className={`
                  w-5 h-1 rounded-full shrink-0 transition-colors duration-200
                  ${isActive ? "bg-primary" : "bg-primary/30"}
                `}
              />
            </button>
          );
        })}

        {totalPages > 1 && (
          <div className="flex items-center gap-0.5 pt-1 mt-0.5 border-t border-border/40">
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

      {/* 文字层：与左侧条带逐行对齐（h-2.5 + gap-1.5 同节奏，top-1 对齐 py-1），
          pointer-events-none —— 悬停时全部标题一起显示，但不占命中区。 */}
      <div className="absolute left-8 top-1 flex flex-col gap-1.5 pointer-events-none">
        {pageMessages.map((m) => {
          const raw = (m.content ?? "").trim() || "(空消息)";
          const text = raw.replace(/\s+/g, " ").slice(0, 10);
          return (
            <span
              key={m.id}
              className={`
                flex h-2.5 items-center whitespace-nowrap text-foreground/75
                transition-opacity duration-200
                text-[calc(var(--helix-transcript-size)*0.8571)]
                ${isAnyHovered ? "opacity-100" : "opacity-0"}
              `}
            >
              {text}
            </span>
          );
        })}
      </div>
    </div>
  );
}
