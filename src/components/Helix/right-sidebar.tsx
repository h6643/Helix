"use client";

import { invoke } from "@tauri-apps/api/core";
import { Globe, Maximize2, Minimize2, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { AgentWorkPanel } from "./agent-work-panel";
import { BylinePanel } from "./byline-panel";
import { CodeEditorPanel } from "./code-editor-panel";
import { DiffSidebarPanel } from "./diff-sidebar-panel";
import { MoreActionsPage } from "./more-actions-page";
import { BrowserToolbar, BrowserView } from "./preview-rail";
import { SessionTreePanel } from "./session-tree-panel";
import { TerminalPanel } from "./terminal-panel";
import { isTauri } from "@/lib/tauri-bridge";
import { cleanUrl, summarizeUrl } from "@/lib/url-utils";
import { useHelixStore } from "@/stores/helix-store";
import type { SidebarPage } from "@/stores/slices/sidebar-session-slice";

type PageKind =
  | "browser"
  | "code"
  | "diff"
  | "agent"
  | "byline"
  | "terminal"
  | "more"
  | "tree";
interface PanelPage {
  id: string;
  kind: PageKind;
  url: string;
}

// 挂在 globalThis 上：HMR 重新求值本模块时模块作用域的计数器会归零，
// 但 React Fast Refresh 保留 pages state（旧 id 还在），两者错位会让新页
// 拿到与旧页重复的 id → pages 里出现两条相同 id → isActive 同时命中两块
// → flex-1 平分高度 → 侧边栏上下分栏。挂 globalThis 后计数器跨 HMR 持久，
// id 不会再重复。
const newPageId = () => {
  const g = globalThis as unknown as { __helixPageSeq?: number };
  if (g.__helixPageSeq === undefined) g.__helixPageSeq = 0;
  return `pg-${++g.__helixPageSeq}`;
};

/** 一条页签的视觉。两级页签（面板行 / 条目行）共用它，包括「✕ 默认完全隐藏、
 *  只在 hover 这一条页签时才露出来」这条热区规则（激活态也不例外——否则每面都挂着
 *  一个 ✕，看着像一堆关闭按钮）。选中态靠**底色高亮**表达，不画下划线（他明确要去掉
 *  border-b 那条 primary 线）；两行各自的 `border-b border-border/20` 才是分隔线。 */
function TabChip({
  label,
  tip,
  icon,
  active,
  onClick,
  onClose,
}: {
  label: string;
  tip?: string;
  icon?: ReactNode;
  active: boolean;
  onClick: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      data-tip={tip ?? label}
      className={`group relative flex items-center gap-1.5 pl-3 pr-4 py-1.5 flex-1 min-w-0 max-w-[200px] rounded-t-md overflow-hidden cursor-pointer text-[calc(var(--helix-transcript-size)*0.8571)] transition-colors ${active ? "bg-primary/15 text-foreground" : "bg-muted/40 text-foreground/60 hover:bg-accent/50"}`}
    >
      {icon}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {onClose && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          data-tip="关闭"
          className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100 hover:text-destructive hover:bg-destructive/10"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/** 面板行的固定顺序（也是「有哪几面」这一行的读法）。
 *
 *  `more`（标题栏「右侧边栏」/ 侧栏「＋」打开的那张卡片菜单页）**故意不在**这里：
 *  它是一页菜单，不是一面要待着的工作台，所以它激活时面板行不出现「更多」便签 ——
 *  便签行只说「有哪几面真正开着」，菜单页的收起走标题栏那个按钮（再点一次）。 */
const PANEL_ORDER: PageKind[] = [
  "browser",
  "diff",
  "agent",
  "byline",
  "terminal",
  "tree",
  "code",
];

/**
 * Right-hand sidebar as a two-level tabbed workspace. Three bands, top down:
 *  1. panel tabs — one per kind that is open (浏览器 / 更改 / 子 Agent / 旁路问答 /
 *     终端 / 代码), plus the panel-level actions at the row's right end.
 *  2. the browser toolbar — only when the 浏览器 panel is the active one.
 *  3. item tabs — the contents *of* the active panel: one per browser page, or
 *     one per open code file. Panels that hold a single item skip this band.
 * Band 1's ✕ closes the whole face: for the browser that means every open web
 * page at once, for a single-item panel it is that one page. Files close through
 * band 3 (closing every editor tab could hit unsaved buffers, so 代码 has no ✕
 * in band 1). The "+" menu creates a new page (browser / diff).
 */
export function RightSidebar() {
  const tab = useHelixStore((s) => s.rightSidebarTab);
  const setTab = useHelixStore((s) => s.setRightSidebarTab);
  const previewRailUrl = useHelixStore((s) => s.previewRailUrl);
  const codeFullscreen = useHelixStore((s) => s.codeFullscreen);
  const toggleCodeFullscreen = useHelixStore((s) => s.toggleCodeFullscreen);
  const editorTabs = useHelixStore((s) => s.editorTabs);
  const activeEditorTabId = useHelixStore((s) => s.activeEditorTabId);
  const activeAgentView = useHelixStore((s) => s.activeAgentView);

  const pages = useHelixStore((s) => s.rightSidebarPages);
  const setPages = useCallback(
    (updater: (prev: SidebarPage[]) => SidebarPage[]) => {
      useHelixStore.getState().setRightSidebarPages(updater(useHelixStore.getState().rightSidebarPages));
    },
    [],
  );
  const setPagesDirect = useCallback(
    (value: SidebarPage[]) => useHelixStore.getState().setRightSidebarPages(value),
    [],
  );
  const activePageId = useHelixStore((s) => s.activePageId) ?? "";
  const setActivePageId = useCallback(
    (id: string | null) => useHelixStore.getState().setActivePageId(id),
    [],
  );

  // Ref to the whole sidebar.
  const sidebarRef = useRef<HTMLDivElement>(null);

  // "Fullscreen" (codeFullscreen, a global store flag) makes this panel fill the
  // MAIN area in the layout flow (handled by helix-layout): the LEFT sidebar
  // stays visible and the conversation card is hidden. Escape exits it. This is
  // a CSS layout expansion, NOT the OS Fullscreen API (which would hide the app
  // title bar and the Windows taskbar).
  useEffect(() => {
    if (!codeFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") toggleCodeFullscreen();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [codeFullscreen, toggleCodeFullscreen]);

  // "+" panel-switcher opens a dedicated sidebar page, not a dropdown.
  const titlePlusRef = useRef<HTMLButtonElement>(null);

  const activePageIdRef = useRef(activePageId);
  activePageIdRef.current = activePageId;

  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  // 待激活的浏览器页 id（navSeq effect 新建页面后写入，渲染后激活）。
  // 不能用 setState updater 内的局部变量同步读：React 的 updater 是异步
  // 执行的（渲染时才跑），updater 外读永远是 null → 新建的页面永远不会被
  // 激活 → 「关闭页签后立刻点链接没反应，等两秒再点才行」。
  const pendingActivateRef = useRef<string | null>(null);

  // Keep the active view in sync with the selected sidebar tab WITHOUT remounting
  // (the header "目录/更改/浏览器" menu just sets `rightSidebarTab`). This replaces
  // the old `key={rightSidebarTab}` remount that rebuilt the whole panel — and the
  // browser <webview> — on every tab switch (the white flash). Code is shown via
  // the editor's own tabs (editorTabs), so selecting "code" just reveals the code
  // view (activePageId = '' means "no browser/diff page active → show code").
  useEffect(() => {
    if (tab === "code") {
      activePageIdRef.current = "";
      setActivePageId("");
      return;
    }
    const kind =
      tab === "diff"
        ? "diff"
        : tab === "browser"
          ? "browser"
          : tab === "agent"
            ? "agent"
            : tab === "byline"
              ? "byline"
              : tab === "terminal"
                ? "terminal"
                : tab === "tree"
                  ? "tree"
                  : tab === "more"
                    ? "more"
                    : null;
    if (!kind) return;
    const existing = pagesRef.current.find((p) => p.kind === kind);
    if (existing) {
      // Update the ref synchronously so the previewRailUrl effect (which runs
      // right after this one in the same commit) navigates THIS page in place
      // instead of creating a second, duplicate browser tab.
      activePageIdRef.current = existing.id;
      setActivePageId(existing.id);
      return;
    }
    // browser 页不在这里新建：它的创建只由两条专用路径负责——链接点击走
    // navSeq effect（更新/新建）、「更多操作 → 浏览器」走 browserAddSeq effect
    // （多开新建）。若这里也新建，点「更多操作 → 浏览器」时 requestAddBrowserPage
    // 同批触发 tab effect + browserAddSeq effect，会各建一个 → 弹出两个浏览器。
    // 只激活已有页；diff 页仍由本 effect 新建（无其他创建入口）。
    if (kind === "browser") return;
    if (kind === "byline") {
      // 同批的 bylineFocusSignal effect 可能也在建 byline 页：互斥防两页签。
      if (bylineCreationInFlightRef.current) return;
      bylineCreationInFlightRef.current = true;
      queueMicrotask(() => {
        bylineCreationInFlightRef.current = false;
      });
    }
    const np: PanelPage = { id: newPageId(), kind, url: "" };
    activePageIdRef.current = np.id;
    setPages((prev) => {
      const next = [...prev, np];
      // 同提交内立即同步 ref：bylineFocusSignal effect 与 tab effect 可能同批
      // 触发，若 ref 还是旧值它就会再建一个 byline 页 → 弹两个旁路面板。
      // （浏览器页的同类竞态当初用「tab effect 不建页」修掉，byline 需要
      // tab effect 建页来支持标题栏切换，故用同步 ref 消除竞态。）
      pagesRef.current = next;
      return next;
    });
    setActivePageId(np.id);
  }, [tab, setPages, setActivePageId]);

  // 「旁路问答」面板的打开落点统一在这里：标题栏「更多操作」、侧栏「＋」、裸
  // `/btw` 都递增 bylineFocusSignal。只靠上面的 tab effect 不够——面板页被 ✕ 关掉
  // 过时 tab 仍停在 "byline"，tab 不变就不会再建页，点入口看起来就没反应。
  const bylineFocusSignal = useHelixStore((s) => s.bylineFocusSignal);
  const lastBylineFocusRef = useRef(bylineFocusSignal);
  // 同批次 tab effect 与 bylineFocusSignal effect 都可能想建 byline 页
  // （「更多操作 → 旁路问答」= setTab + 递增 signal，同一批次触发两个 effect）。
  // 旧实现靠 setPages 的 updater 里同步 pagesRef——但 updater 要到下一次 render
  // 才执行，同批内第二个 effect 仍看到空列表 → 建两个 byline 页（两页签）。
  // 这里用「批次内已建」互斥 ref：任一 effect 决定建页时同步置位，另一个跳过；
  // 批次结束（微任务）复位，不影响下次打开。
  const bylineCreationInFlightRef = useRef(false);
  useEffect(() => {
    const isIncrease = bylineFocusSignal > lastBylineFocusRef.current;
    lastBylineFocusRef.current = bylineFocusSignal;
    if (!isIncrease) return;
    const existing = pagesRef.current.find((p) => p.kind === "byline");
    if (existing) {
      activePageIdRef.current = existing.id;
      setActivePageId(existing.id);
    } else {
      // 同批的 tab effect 已建 byline 页（flag 已置位）：不重复建，避免两页签。
      if (bylineCreationInFlightRef.current) return;
      bylineCreationInFlightRef.current = true;
      queueMicrotask(() => {
        bylineCreationInFlightRef.current = false;
      });
      const np: PanelPage = { id: newPageId(), kind: "byline", url: "" };
      activePageIdRef.current = np.id;
      setPages((prev) => {
        const next = [...prev, np];
        // 与 tab effect 同批触发时，tab effect 建的 byline 页已同步进 ref，
        // 这里 find 就能命中、不再重复建页（两个旁路面板的竞态）。
        pagesRef.current = next;
        return next;
      });
      setActivePageId(np.id);
    }
    setTab("byline");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bylineFocusSignal]);

  // External link (e.g. a message link click) → open / navigate a browser page.
  // Keyed off the monotonically increasing nav sequence (NOT the URL value), so
  // RE-clicking the same link still navigates: when the value is unchanged the
  // freshly-created blank page (from the tab effect) would otherwise be left
  // empty.
  //
  // useRef 的初始值只在首次渲染取一次 = 挂载时的 seq，天然就是"已处理基线"。
  // 不能写 useRef(0)：store 里 previewRailNavSeq 的初始值就是 0，那样本次会话
  // 的第一次链接点击（seq 0→1）会被当成"挂载首次运行"直接吞掉，表现为
  // 「第一次点链接没反应，第二次才跳转」。
  const previewRailNavSeq = useHelixStore((s) => s.previewRailNavSeq);
  const lastNavSeqRef = useRef(previewRailNavSeq);
  useEffect(() => {
    const isIncrease = previewRailNavSeq > lastNavSeqRef.current;
    lastNavSeqRef.current = previewRailNavSeq;
    if (!isIncrease) return;
    const url = cleanUrl(previewRailUrl ?? "");
    if (!url) return;
    // 最近一次是否为「安静」触发（agent / 后台 browser 工具）。
    const isQuiet = useHelixStore.getState().lastPreviewRailQuiet;
    // 允许「新建并激活」浏览器页只限于用户本来就在看浏览器的两种情况：
    //   · 当前激活的页本身就是 browser → 原地导航，不动激活态；
    //   · 侧边栏页签是「浏览器」→ 新建并激活（点消息里的链接走这条）。
    // 其余情况（用户正在看「更改 / 目录 / 代码」）：
    //   · 已有浏览器页 → 后台原地导航（不往标签条里堆新页），不激活；
    //   · 没有浏览器页 + quiet（agent 后台导航）→ 什么都不建，只留 URL。
    //     tab 条是按 pages 渲染的：侧边栏收起时静默建页，会让用户下次打开侧
    //     边栏（如看「更改」）时凭空看见一个网页标签——「只打开了更改，却自己
    //     蹦出一个网页标签」。等用户在 toast 上点「查看」（forceOpen，
    //     quiet=false）时再真正建页。
    const onBrowserTab = tab === "browser";
    setPages((prev) => {
      const active = prev.find((p) => p.id === activePageIdRef.current);
      if (active?.kind === "browser") {
        if (active.url === url) return prev;
        return prev.map((p) => (p.id === active.id ? { ...p, url } : p));
      }
      if (onBrowserTab) {
        const np = { id: newPageId(), kind: "browser" as const, url };
        pendingActivateRef.current = np.id;
        return [...prev, np];
      }
      // 后台：优先复用已有的浏览器页导航（不往标签条里堆新页），不激活。
      const existing = prev.find((p) => p.kind === "browser");
      if (existing) {
        if (existing.url === url) return prev;
        return prev.map((p) => (p.id === existing.id ? { ...p, url } : p));
      }
      // quiet 且当前没有任何浏览器页 → 不凭空新建页签（只留 URL）。
      if (isQuiet) return prev;
      return [...prev, { id: newPageId(), kind: "browser" as const, url }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRailNavSeq]);

  // 渲染后：navSeq effect 新建的浏览器页在这里激活（updater 已执行完，
  // pendingActivateRef 里有值）。不能在上面的 effect 里同步 setActivePageId
  // —— 那会读到 null。依赖 pages 而非 seq，确保新建的页面已进入 state。
  useEffect(() => {
    const id = pendingActivateRef.current;
    if (!id) return;
    pendingActivateRef.current = null;
    activePageIdRef.current = id;
    setActivePageId(id);
  }, [pages, setActivePageId]);

  const updatePageUrl = (id: string, url: string) =>
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, url } : p)));

  const closePages = (ids: string[]) => {
    const gone = new Set(ids);
    if (!pages.some((p) => gone.has(p.id))) return;
    // 第一条被关页的下标：关掉当前页后，落点取"顶上来"的那一条。
    const idx = pages.findIndex((p) => gone.has(p.id));
    const next = pages.filter((p) => !gone.has(p.id));
    setPagesDirect(next);
    let nextActiveId = activePageId;
    if (gone.has(activePageId)) {
      if (next.length > 0) {
        nextActiveId = next[Math.min(idx, next.length - 1)].id;
        setActivePageId(nextActiveId);
      } else {
        // No browser/diff pages left — fall back to the code view if any files
        // are open, otherwise clear the active selection (shell shows).
        nextActiveId = "";
        setActivePageId("");
      }
    }
    // `rightSidebarTab` 是「侧栏要看哪一面」的意图，`pages` 才是「有哪几面」的真相。
    // 关掉某一面最后一条页之后 tab 会停在已经不存在的那一面，而「更多操作」的
    // 入口写的是「tab 已经是这一面 → 只聚焦对应页」——没有页可聚焦就整件事看起来
    // 没反应（终端 / 更改 / 子 Agent / 旁路问答这类单条目面板必现）。所以 tab 必须
    // 跟着现实退位到真正落在屏幕上的那一面。
    const currentTab = useHelixStore.getState().rightSidebarTab;

    // 关掉最后一个"真正的"页签后只剩「更多」菜单页（或全关光），用户视角是
    // 「没有标签了」—— 直接收起侧栏，不等异步收回 effect。
    const hasRealPages = next.some((p) => p.kind !== "more");
    if (!hasRealPages && editorTabs.length === 0) {
      setTab(null);
      if (codeFullscreen) toggleCodeFullscreen();
      return;
    }

    if (currentTab && !next.some((p) => p.kind === currentTab)) {
      const landed = next.find((p) => p.id === nextActiveId);
      if (landed) setTab(landed.kind);
      else if (editorTabs.length > 0) setTab("code");
      else {
        setTab(null);
        if (codeFullscreen) toggleCodeFullscreen();
      }
    }
  };

  const closePage = (id: string) => closePages([id]);

  /** 关掉「一整面」——面板行那个 ✕ 的语义。多条目面板（浏览器）一次关掉它的
   *  全部网页页，单条目面板就是关掉那一条。必须走 `closePages` 一次算完：连着
   *  调 N 次 `closePage` 每次都是从同一个旧 `pages` 算的，只有最后一次生效，
   *  结果就是"点了关整面，只关掉一条"。 */
  const closeKind = (kind: PageKind) =>
    closePages(pages.filter((p) => p.kind === kind).map((p) => p.id));

  // 把「面板里那条网页页」投影到 store：agent 的浏览器工具用它找到要驱动的真窗口。
  // 优先当前激活的 browser 页，否则退回标签条里第一条 browser 页 —— 用户切到「更改」
  // 时那条窗口只是隐藏（DOM 还活着），操作照样有效。pages 的真相仍在这里。
  const setBrowserPageId = useHelixStore((s) => s.setBrowserPageId);
  useEffect(() => {
    const active = pages.find((p) => p.id === activePageId);
    const target =
      active?.kind === "browser"
        ? active
        : pages.find((p) => p.kind === "browser");
    setBrowserPageId(target?.id ?? null);
  }, [pages, activePageId, setBrowserPageId]);

  // 子窗口的生命周期是**进程级**的，`pages` 是内存态：整页重载（vite HMR 全量刷新 /
  // Ctrl+R）之后旧窗口既没人关、也没人再同步矩形，就停在最后一次摆放的位置上，
  // 桌面上凭空多出一张和侧栏并排的「网页」。所以 pages 一变就把名单外的窗口交回
  // 后端销毁——首次挂载时 keep 为空，正好把上一轮遗留全部回收。正常关页时它和
  // BrowserView 卸载时的 close 是同一件事，后端按登记幂等处理。
  useEffect(() => {
    if (!isTauri()) return;
    const keep = pages.filter((p) => p.kind === "browser").map((p) => p.id);
    void invoke("browser_webview_reap", { keep }).catch(() => {});
  }, [pages]);

  // 侧边栏卸载（或 HMR 重载）时清空：不能让自动化拿到一条已经销毁的窗口 id。
  useEffect(
    () => () => useHelixStore.getState().setBrowserPageId(null),
    [],
  );

  // Close one open file tab (from the header strip). Dirty tabs open the
  // unsaved-changes confirmation (handled inside CodeEditorPanel) instead of
  // closing immediately.
  const closeCodeTab = (id: string) => {
    const st = useHelixStore.getState();
    const tab = st.editorTabs.find((t) => t.id === id);
    if (tab?.dirty) {
      st.setPendingCloseId(id);
      return;
    }
    st.closeEditorTab(id);
  };

  // 「更多操作 / ＋ → 浏览器」：总是新建一个浏览器页（多开）。两个菜单都通过
  // store 的 requestAddBrowserPage 递增 browserAddSeq，这里统一监听信号新建。
  const browserAddSeq = useHelixStore((s) => s.browserAddSeq);
  useEffect(() => {
    if (browserAddSeq === 0) return;
    const np = { id: newPageId(), kind: "browser" as const, url: "" };
    setPages((prev) => [...prev, np]);
    activePageIdRef.current = np.id;
    setActivePageId(np.id);
  }, [browserAddSeq, setPages, setActivePageId]);

  // Close the whole code view (empty-state "关闭编辑器" button).
  const closeCodeView = () => {
    useHelixStore.getState().closeAllEditorTabs();
    if (pages.length > 0) setActivePageId(pages[0].id);
    else doRetract();
  };

  // When the last open file is closed while a browser/diff page was the active
  // view, fall back to another page so we don't render a blank panel. (Retracting
  // the whole sidebar when everything is closed is handled separately below.)
  useEffect(() => {
    if (
      editorTabs.length === 0 &&
      pages.length > 0 &&
      !pages.some((p) => p.id === activePageId)
    ) {
      setActivePageId(pages[0].id);
    }
  }, [editorTabs.length, pages, activePageId, setActivePageId]);

  // Track whether the panel has EVER shown content in this session. We use this
  // to distinguish "the user closed the last tab" (→ retract) from "the code view
  // was opened directly with no file yet" (→ keep open, show empty state).
  const everHadContentRef = useRef(false);
  useEffect(() => {
    if (pages.length > 0 || editorTabs.length > 0)
      everHadContentRef.current = true;
  }, [pages.length, editorTabs.length]);

  // Retract the sidebar when every tab is gone. The panel's visibility in the
  // layout is driven by `rightSidebarTab` (null → hidden). Closing the last
  // browser/diff page and/or the last open file must clear the selection so the
  // sidebar collapses instead of sitting open as a blank card.
  //
  // IMPORTANT: also exit fullscreen mode here. If codeFullscreen is still true
  // when we retract, BOTH the conversation card (hidden by codeFullscreen) AND
  // the right sidebar (hidden by rightSidebarTab=null) become invisible —
  // producing a blank screen where nothing renders at all.
  const doRetract = useCallback(() => {
    setTab(null);
    if (codeFullscreen) toggleCodeFullscreen();
  }, [setTab, codeFullscreen, toggleCodeFullscreen]);

  // 用 pagesRef / editorTabsRef 判断「是否还有页签」而不是 effect 闭包里的
  // pages/editorTabs：点击链接时会 setRightSidebarTab('browser') 与页面创建
  // 同时发生，同一渲染里 pages.length 还是 0 —— 用旧闭包值判断会让 doRetract
  // 误触发把 tab 收回 null，导致「第一次点链接没反应，第二次才跳转」。
  // pagesRef 每次渲染同步更新，effect 里读到的是最新值。
  const editorTabsRef = useRef(editorTabs);
  editorTabsRef.current = editorTabs;
  // 记录上一次的 tab 值：tab 刚从 null 变为非 null = 正在打开侧边栏（页面尚在
  // effect 中创建，pages 暂时为空）→ 绝不能 retract。只有 tab 保持非 null 且
  // 页签真的被关光时才收回。
  const prevTabRef = useRef(tab);
  useEffect(() => {
    const prevTab = prevTabRef.current;
    prevTabRef.current = tab;
    if (prevTab === null && tab !== null) return; // 正在打开侧边栏，跳过收回
    if (
      tab !== null &&
      everHadContentRef.current &&
      pagesRef.current.length === 0 &&
      editorTabsRef.current.length === 0
    ) {
      doRetract();
    }
  }, [tab, pages, editorTabs, doRetract]);

  // The sidebar is always mounted (the parent toggles visibility via the `hidden`
  // class). Render a minimal shell when there are no pages AND no open files so
  // the component stays alive — but this early return MUST come AFTER every hook
  // above, otherwise the hooks defined below it would be skipped on the
  // empty-pages render, producing a different hook count than the non-empty
  // render ("Rendered fewer hooks than expected"). All hooks run on every render;
  // only the rendered output differs.
  if (pages.length === 0 && editorTabs.length === 0) {
    return <div ref={sidebarRef} className="h-full w-full" />;
  }

  // 两级页签：第 1 行说「有哪几面」（每种面板一个页签），第 3 行说「这一面里有几条
  // 内容」（浏览器面 = 每条网页页，代码面 = 每个打开的文件）。只有一个条目的面板
  // （更改 / 子 Agent / 旁路问答）不产生第 3 行。
  const codeViewActive = !pages.some((p) => p.id === activePageId);
  const activePage = pages.find((p) => p.id === activePageId);
  const activeKind: PageKind = codeViewActive
    ? "code"
    : (activePage?.kind ?? "code");
  // 工具栏只有一条，打在「正看着的那条网页页」上；不在网页面时整行隐藏。
  const browserTab = activePage?.kind === "browser" ? activePage : undefined;
  const browserPages = pages.filter((p) => p.kind === "browser");
  const panelKinds = PANEL_ORDER.filter((k) =>
    k === "code" ? editorTabs.length > 0 : pages.some((p) => p.kind === k),
  );
  const showPageStrip = activeKind === "browser" && browserPages.length > 0;
  const showFileStrip = activeKind === "code" && editorTabs.length > 0;
  const kindLabel = (k: PageKind) =>
    k === "browser"
      ? "浏览器"
      : k === "diff"
        ? "更改"
        : k === "agent"
          ? activeAgentView?.name || "子 Agent"
          : k === "byline"
            ? "旁路问答"
            : k === "terminal"
              ? "终端"
              : k === "tree"
                ? "会话树"
                : "文件";
  const openKind = (k: PageKind) => {
    if (k === "code") {
      setActivePageId("");
      return;
    }
    const target = pages.find((p) => p.kind === k);
    if (target) setActivePageId(target.id);
  };
  const openMoreActions = () => {
    const target = pagesRef.current.find((p) => p.kind === "more");
    if (target) {
      activePageIdRef.current = target.id;
      setActivePageId(target.id);
      return;
    }
    const np: PanelPage = { id: newPageId(), kind: "more", url: "" };
    activePageIdRef.current = np.id;
    setPages((prev) => {
      const next = [...prev, np];
      pagesRef.current = next;
      return next;
    });
    setActivePageId(np.id);
  };

  return (
    <div
      ref={sidebarRef}
      className="h-full w-full flex flex-col overflow-hidden"
    >
      {/* 三条带（他给的图）：
          1. 面板页签行 —— 「有哪几面」，行尾钉面板级操作（＋ 更多、⛶ 展开全屏）。
             顶部 mt-10 是给窗口拖拽区留的空隙，只有最上面这行需要它。
          2. 浏览器工具栏 —— 只在浏览器面激活时出现（后退/前进/刷新 + 常驻地址输入框
             + 选取元素 + 外部打开），由 preview-rail 的 BrowserToolbar 渲染。
          3. 条目页签行 —— 当前这一面里的内容：每条网页页 / 每个打开的文件。 */}
      <div className="flex items-end gap-0.5 px-1 mt-10 h-9 shrink-0 border-b border-border/20">
        {panelKinds.map((k) => (
          <TabChip
            key={k}
            label={kindLabel(k)}
            icon={
              k === "browser" ? (
                <Globe className="size-3.5 shrink-0 opacity-60" />
              ) : undefined
            }
            active={k === activeKind}
            onClick={() => openKind(k)}
            onClose={
              // 面板行的 ✕ = 关掉这一整面。浏览器是多条目面板，点一下一次关掉它的
              // 全部网页页；单条目面板（更改 / 子 Agent / 旁路问答 / 终端）就是关掉
              // 那一条。代码面不放 ✕：它不在 pages 里（面板行由 editorTabs 决定），
              // 且一次关掉所有打开文件会撞上未保存缓冲区，关闭走第 3 行的文件页签。
              k === "code" ? undefined : () => closeKind(k)
            }
          />
        ))}
        {/* `self-center` 是必需的：整行按页签的视觉基线走 items-end（页签坐在行底
            那条分隔线上），按钮跟着沉底会歪。 */}
        <div className="ml-auto self-center flex items-center gap-0.5 shrink-0 pr-1">
          <button
            ref={titlePlusRef}
            onClick={openMoreActions}
            className="p-1.5 rounded text-foreground/50 hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
            data-tip="更多操作"
          >
            <Plus className="size-4" />
          </button>
          <button
            onClick={() => toggleCodeFullscreen()}
            className={`p-1.5 rounded transition-colors shrink-0 ${codeFullscreen ? "text-primary bg-primary/10" : "text-foreground/50 hover:text-foreground hover:bg-accent/50"}`}
            data-tip={codeFullscreen ? "退出全屏" : "展开全屏"}
          >
            {codeFullscreen ? (
              <Minimize2 className="size-4" />
            ) : (
              <Maximize2 className="size-4" />
            )}
          </button>
        </div>
      </div>

      {browserTab && (
        <BrowserToolbar
          pageId={browserTab.id}
          url={browserTab.url}
          onUrlChange={(u) => updatePageUrl(browserTab.id, u)}
        />
      )}

      {(showPageStrip || showFileStrip) && (
        <div className="flex items-end gap-0.5 px-1 h-9 shrink-0 border-b border-border/20">
          {showPageStrip &&
            browserPages.map((p) => (
              <TabChip
                key={p.id}
                label={summarizeUrl(p.url) || "新标签页"}
                tip={p.url || "新标签页"}
                active={p.id === activePageId}
                onClick={() => setActivePageId(p.id)}
                onClose={() => closePage(p.id)}
              />
            ))}
          {showFileStrip &&
            editorTabs.map((t) => (
              <TabChip
                key={t.id}
                label={t.name}
                tip={t.path}
                active={t.id === activeEditorTabId}
                onClick={() =>
                  useHelixStore.getState().setActiveEditorTab(t.id)
                }
                onClose={() => closeCodeTab(t.id)}
              />
            ))}
        </div>
      )}

      {/* Content: keep every page mounted (hidden if inactive) so switching tabs
          preserves each page's state — same as the old multi-tab browser. The
          file tree lives in the LEFT sidebar (full-area directory view); this
          panel shows the active browser/diff page, or the code editor when no
          browser/diff page is active.
          NOTE: inactive pages rely on `display:none`. We ALSO set it inline so a
          non-active page can never show even if the Tailwind `hidden` utility is
          missing/overridden in a given build — otherwise two stacked browser
          panels (the active one + a leftover blank one) can appear. */}
      {/* `min-w-0` on every flex link is load-bearing: without it a page's
          min-content (e.g. a long path row or the diff header's stats) makes the
          column lay out WIDER than the panel box, and the panel's
          `overflow-hidden` then silently cuts the right-hand side — which is
          where +/- counts live. */}
      <div className="flex-1 min-h-0 min-w-0 flex">
        <div className="flex-1 min-h-0 min-w-0 flex flex-col">
          {/* 用 findIndex 取“第一个”命中 activePageId 的下标：即使 pages 里
              出现两条相同 id（HMR 计数器错位的历史遗留），也只会有一块进
              active 分支，物理上不可能再上下分栏。 */}
          {(() => {
            const activeIdx = pages.findIndex((p) => p.id === activePageId);
            return pages.map((p, i) => {
              const isActive = i === activeIdx;
              return (
                <div
                  key={p.id}
                  className={
                    isActive ? "flex-1 min-h-0 min-w-0 flex flex-col" : "hidden"
                  }
                  style={isActive ? undefined : { display: "none" }}
                >
                  {p.kind === "browser" && (
                    <BrowserView
                      pageId={p.id}
                      url={p.url}
                      onUrlChange={(u) => updatePageUrl(p.id, u)}
                    />
                  )}
                  {p.kind === "diff" && <DiffSidebarPanel />}
                  {p.kind === "agent" && <AgentWorkPanel />}
                  {p.kind === "byline" && <BylinePanel />}
                  {/* 侧栏里的终端：与主区底部抽屉同一个组件，只是宿主可见性由
                      「这一页是不是当前页」决定（切走只是隐藏，shell 与
                      scrollback 留着；关掉页签才杀进程）。 */}
                  {p.kind === "terminal" && (
                    <TerminalPanel
                      mode="side"
                      active={isActive}
                      onClose={() => closePage(p.id)}
                    />
                  )}
                  {p.kind === "more" && <MoreActionsPage />}
                  {p.kind === "tree" && <SessionTreePanel />}
                </div>
              );
            });
          })()}
          {editorTabs.length > 0 && codeViewActive && (
            <div className="flex-1 min-h-0 min-w-0 flex flex-col">
              <CodeEditorPanel onClose={closeCodeView} />
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
