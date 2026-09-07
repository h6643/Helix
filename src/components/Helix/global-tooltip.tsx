"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface TipState {
  text: string;
  x: number;
  y: number;
  placement: "top" | "bottom" | "left" | "right";
}

/**
 * Themed replacement for the native `data-tip=""` tooltip.
 *
 * Every icon button in the app previously relied on the browser-native
 * `title` attribute, which the OS renders in its own un-themable style
 * (yellow box on Windows, grey box on Linux/WebKitGTK) — it never follows
 * the Catppuccin/shadcn tokens. Those `title=` attributes have been renamed
 * to `data-tip=` across the codebase; this single component reads them via
 * event delegation and renders one portal tooltip styled with the app's
 * semantic tokens, so it tracks light/dark and all 25 themes automatically.
 *
 * Event-delegated (one global listener) so it works for any element that
 * gains a `data-tip` attribute without per-call wiring.
 */
export function GlobalTooltip() {
  const [state, setState] = useState<TipState | null>(null);
  const timer = useRef<number | null>(null);
  const current = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
    const hide = () => {
      clearTimer();
      current.current = null;
      setState(null);
    };
    const showFor = (el: HTMLElement) => {
      const text = (el.getAttribute("data-tip") || "").trim();
      if (!text) return;
      const rect = el.getBoundingClientRect();
      const gap = 8;
      // 全部往左展开、一行显示：右边缘对齐触发元素，向左生长——贴近屏幕右缘
      // 时不会伸出屏幕外。垂直方向优先下方，下方放不下才放上方；水平越界由
      // 下方的 useLayoutEffect 按实际尺寸钳回视口内。
      const placement: TipState["placement"] =
        rect.bottom + gap + 32 <= window.innerHeight ? "bottom" : "top";
      setState({
        text,
        x: rect.right,
        y: placement === "top" ? rect.top - gap : rect.bottom + gap,
        placement,
      });
    };
    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const el = t.closest("[data-tip]") as HTMLElement | null;
      if (!el || !(el.getAttribute("data-tip") || "").trim()) {
        hide();
        return;
      }
      if (el === current.current) return;
      current.current = el;
      clearTimer();
      timer.current = window.setTimeout(() => showFor(el), 350);
    };
    const onOut = (e: MouseEvent) => {
      const related = e.relatedTarget as HTMLElement | null;
      if (!related || !related.closest("[data-tip]")) hide();
    };
    const onScroll = () => hide();

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      window.removeEventListener("scroll", onScroll, true);
      clearTimer();
    };
  }, []);

  // 真实尺寸钳制：估算宽高与实际有偏差（中文/长文本），且贴边元素（如聊天
  // 输入栏里的卡片）的 tooltip 会伸出屏幕外被截断。按实际 offsetWidth/Height
  // 把锚点 x/y 夹回视口内（transform 已按 placement 生效，反推盒边界）。
  useLayoutEffect(() => {
    if (!state || !tipRef.current) return;
    const el = tipRef.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const m = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = state.x;
    let y = state.y;
    if (state.placement === "top") {
      x = Math.min(Math.max(x, w + m), vw - m);
      y = Math.min(Math.max(y, h + m), vh - m);
    } else if (state.placement === "bottom") {
      x = Math.min(Math.max(x, w + m), vw - m);
      y = Math.min(Math.max(y, m), vh - h - m);
    } else if (state.placement === "left") {
      x = Math.min(Math.max(x, w + m), vw - m);
      y = Math.min(Math.max(y, h / 2 + m), vh - h / 2 - m);
    } else {
      // right
      x = Math.min(Math.max(x, m), vw - w - m);
      y = Math.min(Math.max(y, h / 2 + m), vh - h / 2 - m);
    }
    if (x !== state.x || y !== state.y) setState({ ...state, x, y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!state || typeof document === "undefined") return null;

  const transform =
    state.placement === "top"
      ? "translate(-100%, -100%)"
      : state.placement === "bottom"
        ? "translate(-100%, 0)"
        : state.placement === "left"
          ? "translate(-100%, -50%)"
          : "translate(0, -50%)";

  const style: React.CSSProperties = {
    position: "fixed",
    left: state.x,
    top: state.y,
    transform,
  };

  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      style={style}
      className="pointer-events-none z-[9999] whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] leading-relaxed text-foreground shadow-md"
    >
      {state.text}
    </div>,
    document.body,
  );
}
