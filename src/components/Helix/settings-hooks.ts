// 从 settings-ui.tsx 抽出的 React hook，供 fast-refresh 合规
// （react-refresh/only-export-components 要求模块只导出组件）。
// 函数体原样搬迁，未改任何逻辑、参数、返回类型与注释语义。

import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * 下拉/弹层打开时锁定最近的背景滚动容器。弹层多为 position:fixed，背景滚动容器
 * （如设置内容卡片）滚动时触发器会移动而弹层留在视口原位，导致两者错位；锁住背景
 * 滚动并补偿滚动条宽度（隐藏滚动条后避免布局横向跳动），关闭时还原。
 */
export function useLockScrollOnOpen(
  open: boolean,
  btnRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    let el: HTMLElement | null = btnRef.current;
    let scroller: HTMLElement | null = null;
    while (el && el !== document.body && el !== document.documentElement) {
      const s = getComputedStyle(el);
      if (
        s.overflowY === "auto" ||
        s.overflowY === "scroll" ||
        s.overflowY === "overlay"
      ) {
        scroller = el;
        break;
      }
      el = el.parentElement;
    }
    if (!scroller) return;
    // 锁定背景滚动，但不动 paddingRight——弹窗是 fixed 定位，本身不受
    // 滚动容器 padding 影响；加 paddingRight 会让滚动容器内容区变窄，
    // 其他元素（左侧文字/卡片）整体往左挤，造成可见的布局抖动。
    // 只需要防止用户滚动背景，不需要补偿滚动条宽度。
    const prevOverflow = scroller.style.overflowY;
    scroller.style.overflowY = "hidden";
    return () => {
      if (!scroller) return;
      scroller.style.overflowY = prevOverflow;
    };
  }, [open, btnRef]);
}

export interface AnchoredPos {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/**
 * 把 fixed 弹层钉在触发器上，并在触发器移动时**重新贴合**。
 *
 * 只在 open 的那一帧算一次坐标是不够的：打开后任何让触发器移动的因素都会让
 * 弹层留在旧位置，出现「弹窗与按钮分家」。实测过的真实触发场景：
 *   - 背景滚动容器并非 useLockScrollOnOpen 找到的那一个（例如设置内容卡片
 *     之外还有一层可滚动祖先被滚动了）；
 *   - 弹层自身滚动到边界后 overscroll 冒泡把背景滚了；
 *   - 触发器在虚拟列表 / 折叠区里，展开收起改变其位置；
 *   - 窗口 resize、字号设置变化引起重排。
 *
 * 这里用 capture 阶段的 scroll 事件 + ResizeObserver 持续重算，滚动期间直接
 * 写 DOM style（不走 setState）—— 跟手且不引发额外渲染；只有位置真的变了才
 * setState，供依赖 pos 的调用方（如翻转判断）使用。
 */
export function useAnchoredPopup(
  open: boolean,
  btnRef: RefObject<HTMLElement | null>,
  popRef: RefObject<HTMLElement | null>,
  opts: { width?: number; enabled?: boolean } = {},
) {
  const { width: preferredWidth, enabled = true } = opts;
  const [pos, setPos] = useState<AnchoredPos | null>(null);

  const reposition = useCallback(
    (flip: boolean) => {
      const btn = btnRef.current;
      const pop = popRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const w = r.width || preferredWidth || 224;
      // 向下展开时的可用空间（留 8px 底部边距）
      let maxHeight = Math.max(120, window.innerHeight - r.bottom - 8);
      let top = r.bottom + 4;
      const left = Math.max(
        8,
        Math.min(r.right - w, window.innerWidth - w - 8),
      );
      if (flip && pop) {
        const ph = pop.getBoundingClientRect().height;
        const downSpaceTooSmall = maxHeight < 200;
        if (
          downSpaceTooSmall &&
          r.top - ph - 4 >= 8 &&
          window.innerHeight - r.bottom < ph
        ) {
          // 翻到触发器上方
          top = Math.max(8, r.top - ph - 4);
          maxHeight = Math.max(120, r.top - 8);
        }
      }
      const next = { left, top, width: w, maxHeight };
      if (pop) {
        const cur = pop.getBoundingClientRect();
        const moved =
          Math.abs(cur.left - left) > 0.5 || Math.abs(cur.top - top) > 0.5;
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
        pop.style.width = `${w}px`;
        pop.style.maxHeight = `${maxHeight}px`;
        if (moved) {
          pop.setAttribute("data-reanchored", "1");
          queueMicrotask(() => pop.removeAttribute("data-reanchored"));
        }
      }
      setPos((prev) =>
        prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.maxHeight === next.maxHeight
          ? prev
          : next,
      );
    },
    [btnRef, popRef, preferredWidth],
  );

  useEffect(() => {
    if (!open || !enabled) {
      setPos(null);
      return;
    }
    // 首帧：先摆到触发器下方，拿到真实高度后再判断要不要翻到上方。
    reposition(false);
    const id = requestAnimationFrame(() => reposition(true));

    const onScroll = () => reposition(true);
    // capture 阶段才能收到任意祖先容器的滚动（含 overscroll 冒泡到 body 的）。
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    // 触发器尺寸变化（文案换行、字号设置改变）也要跟随。
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onScroll);
      if (btnRef.current) ro.observe(btnRef.current);
    }
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      ro?.disconnect();
    };
  }, [open, enabled, reposition, btnRef, popRef]);

  return pos;
}