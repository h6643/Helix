// 从 settings-ui.tsx 抽出的 React hook，供 fast-refresh 合规
// （react-refresh/only-export-components 要求模块只导出组件）。
// 函数体原样搬迁，未改任何逻辑、参数、返回类型与注释语义。

import { useEffect } from "react";

/**
 * 下拉/弹层打开时锁定最近的背景滚动容器。弹层多为 position:fixed，背景滚动容器
 * （如设置内容卡片）滚动时触发器会移动而弹层留在视口原位，导致两者错位；锁住背景
 * 滚动并补偿滚动条宽度（隐藏滚动条后避免布局横向跳动），关闭时还原。
 */
export function useLockScrollOnOpen(
  open: boolean,
  btnRef: React.RefObject<HTMLElement | null>,
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
