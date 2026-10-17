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
      // data-tip-side="left|right" 可强制横向放置（按钮右侧贴边时避免提示
      // 盖住下方内容，如插件中心/计划任务页头的操作按钮）。
      const side = el.getAttribute("data-tip-side");
      const placement: TipState["placement"] =
        side === "left" || side === "right"
          ? side
          : rect.bottom + gap + 32 <= window.innerHeight
            ? "bottom"
            : "top";
      setState({
        text,
        // 横向放置（left/right）时锚在按钮边缘外侧、垂直居中，不盖住按钮；
        // 纵向（top/bottom）保持触发元素水平居中。
        x:
          side === "left"
            ? rect.left - gap
            : side === "right"
              ? rect.right + gap
              : rect.left + rect.width / 2,
        y:
          side === "left" || side === "right"
            ? rect.top + rect.height / 2
            : placement === "top"
              ? rect.top - gap
              : rect.bottom + gap,
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
    const halfW = w / 2;
    if (state.placement === "top") {
      x = Math.min(Math.max(x, halfW + m), vw - halfW - m);
      y = Math.min(Math.max(y, h + m), vh - m);
    } else if (state.placement === "bottom") {
      x = Math.min(Math.max(x, halfW + m), vw - halfW - m);
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
     
  }, [state]);

  if (!state || typeof document === "undefined") return null;

  const transform =
    state.placement === "top"
      ? "translate(-50%, -100%)"
      : state.placement === "bottom"
        ? "translate(-50%, 0)"
        : state.placement === "left"
          ? "translate(-100%, -50%)"
          : "translate(0, -50%)";

  const style: React.CSSProperties = {
    position: "fixed",
    left: state.x,
    top: state.y,
    transform,
    // width:max-content 让盒子按「不换行的完整内容宽度」收缩。
    //
    // 只用 max-width 是不够的：position:fixed 元素的默认宽度是
    // shrink-to-fit = min(max(preferred_minimum, available), preferred)。
    // white-space:pre-line 允许在任意位置折行（中文每个汉字都是合法断点），
    // 于是 preferred_minimum 退化到「单个汉字 + padding」；当 available 被
    // 算窄时（贴边的按钮、窄侧栏、或 WebView2 下 100vw 与可视区不一致），
    // shrink-to-fit 就会取到那个极窄的 preferred_minimum——「关闭」被拆成
    // 「关 / 闭」两行竖排（见用户反馈）。
    //
    // 显式声明 max-content 后，短提示（关关、复制、编辑）稳定保持一行，
    // 只有内容真的超过 max-width（长说明文字）时才折行，不会溢出圆角框。
    width: "max-content",
  };

  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      style={style}
      // `whitespace-pre-line`（而不是 nowrap）：盒子宽度有 420px 上限，长文本在
      // nowrap 下会**溢出到圆角框外面**画出去（overflow 默认 visible），看起来像
      // 渲染坏了。换行后长提示在框内折行；下面的 useLayoutEffect 按实际
      // offsetHeight 钳位，折高了自己会跟着缩回来。
      //
      // 光有 pre-line + max-width 还不够：pre-line 允许中文逐字折行，
      // position:fixed 的 shrink-to-fit 会把 preferred_minimum 退化到单字宽，
      // 「关闭」这类两字提示会被拆成竖排（关 / 闭 两行）。配套的
      // `width: max-content`（见上方 style）让盒子先按完整内容宽度取值，
      // 只有超过 max-width 才真正折行。两者缺一不可。
      className="pointer-events-none z-[9999] max-w-[min(420px,calc(100vw-16px))] whitespace-pre-line break-words rounded-lg border border-border helix-popover-glass px-2 py-1 text-[10px] leading-relaxed text-foreground shadow-xl"
    >
      {state.text}
    </div>,
    document.body,
  );
}
