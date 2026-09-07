"use client";

import { Globe, Plus, X, Maximize2, Minimize2, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cleanUrl } from "@/lib/url-utils";
import { useHelixStore } from "@/stores/helix-store";
import { CodeEditorPanel } from "./code-editor-panel";
import { DiffSidebarPanel } from "./diff-sidebar-panel";
import { BrowserView } from "./preview-rail";
import { summarizeUrl } from "@/lib/url-utils";
import { MoreActionsMenu } from "./more-actions-menu";

type PageKind = "browser" | "code" | "diff";
interface PanelPage {
  id: string;
  kind: PageKind;
  url: string;
  title?: string;
}

let pageSeq = 0;
const newPageId = () => `pg-${++pageSeq}`;

/**
 * Right-hand sidebar as a tabbed workspace. The single header tab strip holds:
 *  - browser pages  → one BrowserView (one URL) each
 *  - the diff page  → the git diff view
 *  - every open code file → its own tab (the in-editor per-file tab bar was
 *    removed to avoid a duplicate "file name" row; the editor just shows the
 *    active file now).
 * All tabs can be switched / closed independently; the "+" menu creates a new
 * page (browser / diff / terminal).
 */
export function RightSidebar() {
  const tab = useHelixStore((s) => s.rightSidebarTab);
  const setTab = useHelixStore((s) => s.setRightSidebarTab);
  const previewRailUrl = useHelixStore((s) => s.previewRailUrl);
  const codeFullscreen = useHelixStore((s) => s.codeFullscreen);
  const toggleCodeFullscreen = useHelixStore((s) => s.toggleCodeFullscreen);
  const toggleTerminal = useHelixStore((s) => s.toggleTerminal);
  const isTerminalOpen = useHelixStore((s) => s.isTerminalOpen);
  const editorTabs = useHelixStore((s) => s.editorTabs);
  const activeEditorTabId = useHelixStore((s) => s.activeEditorTabId);

  const [pages, setPages] = useState<PanelPage[]>(() => {
    const start = cleanUrl(previewRailUrl ?? "") || "";
    if (tab === "diff") return [{ id: newPageId(), kind: "diff", url: "" }];
    if (tab === "browser")
      return [{ id: newPageId(), kind: "browser", url: start }];
    return [];
  });
  const [activePageId, setActivePageId] = useState<string>(
    () => pages[0]?.id ?? "",
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

  // "+" panel-switcher dropdown.
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const titlePlusRef = useRef<HTMLButtonElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!plusMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        titlePlusRef.current?.contains(target) ||
        plusMenuRef.current?.contains(target)
      )
        return;
      setPlusMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [plusMenuOpen]);

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
  // (the header "目录/变更/浏览器" menu just sets `rightSidebarTab`). This replaces
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
    const kind = tab === "diff" ? "diff" : tab === "browser" ? "browser" : null;
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
    const np: PanelPage = { id: newPageId(), kind, url: "" };
    activePageIdRef.current = np.id;
    setPages((prev) => [...prev, np]);
    setActivePageId(np.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // External link (e.g. a message link click) → open / navigate a browser page.
  // Keyed off the monotonically increasing nav sequence (NOT the URL value), so
  // RE-clicking the same link still navigates: when the value is unchanged the
  // freshly-created blank page (from the tab effect) would otherwise be left
  // empty. seq 0 is the initial mount value — skipping it avoids hijacking other
  // tabs (e.g. the diff panel) with a stale previewRailUrl on first render.
  const previewRailNavSeq = useHelixStore((s) => s.previewRailNavSeq);
  useEffect(() => {
    if (previewRailNavSeq === 0) return;
    const url = cleanUrl(previewRailUrl ?? "");
    if (!url) return;
    // React 的 setState updater 在渲染阶段才执行，updater 内赋值的局部变量
    // 在 effect 同步代码里读不到 → 用 ref 记录待激活的 id，渲染后激活。
    // 点击链接时 tab effect 已先建了一个空 url 的 browser 页并同步更新了
    // activePageIdRef（同一渲染批内 effect 按声明顺序执行），这里更新它即可。
    // 当前激活的页不是 browser（diff / code / 无页）→ 新建一个 browser 页，
    // 这样「更多操作 → 浏览器」每次都能开新的浏览器标签（多开）。
    setPages((prev) => {
      const active = prev.find((p) => p.id === activePageIdRef.current);
      if (active?.kind === "browser") {
        if (active.url === url) return prev;
        return prev.map((p) => (p.id === active.id ? { ...p, url } : p));
      }
      const np = { id: newPageId(), kind: "browser" as const, url };
      pendingActivateRef.current = np.id;
      return [...prev, np];
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  const updatePageUrl = (id: string, url: string) =>
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, url } : p)));

  const updatePageTitle = (id: string, title: string) =>
    setPages((prev) =>
      prev.map((p) =>
        p.id === id ? (p.title === title ? p : { ...p, title }) : p,
      ),
    );

  const closePage = (id: string) => {
    const idx = pages.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const next = pages.filter((p) => p.id !== id);
    setPages(next);
    if (id === activePageId) {
      if (next.length > 0) {
        setActivePageId(next[Math.min(idx, next.length - 1)].id);
      } else {
        // No browser/diff pages left — fall back to the code view if any files
        // are open, otherwise clear the active selection (shell shows).
        setActivePageId("");
      }
    }
  };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserAddSeq]);

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
  }, [editorTabs.length, pages, activePageId]);

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
  const doRetract = () => {
    setTab(null);
    if (codeFullscreen) toggleCodeFullscreen();
  };

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
  }, [tab, pages, editorTabs]);

  // The sidebar is always mounted (the parent toggles visibility via the `hidden`
  // class). Render a minimal shell when there are no pages AND no open files so
  // the component stays alive — but this early return MUST come AFTER every hook
  // above, otherwise the hooks defined below it would be skipped on the
  // empty-pages render, producing a different hook count than the non-empty
  // render ("Rendered fewer hooks than expected"). All hooks run on every render;
  // only the rendered output differs.
  if (pages.length === 0 && editorTabs.length === 0) {
    return <div ref={sidebarRef} className="h-full w-full bg-card" />;
  }

  // The header strip holds browser/diff pages PLUS every open code file.
  const stripPages = pages.filter((p) => p.kind !== "code");
  const codeViewActive = !pages.some((p) => p.id === activePageId);

  return (
    <div
      ref={sidebarRef}
      className="h-full w-full bg-card flex flex-col overflow-hidden"
    >
      {/* Unified tab strip: browser / diff pages AND every open file share ONE
          row (the editor's own per-file tab bar was removed so the file name is
          never shown twice). Tabs compress / truncate as more are added. */}
      {(stripPages.length > 0 || editorTabs.length > 0) && (
        <div className="flex items-end gap-0.5 px-1 pt-1 h-9 shrink-0 bg-card border-b border-border/40">
          {stripPages.map((p) => {
            const label =
              p.kind === "browser"
                ? p.title || summarizeUrl(p.url) || "网页"
                : "变更";
            const active = p.id === activePageId;
            return (
              <div
                key={p.id}
                onClick={() => setActivePageId(p.id)}
                data-tip={label}
                className={`group relative flex items-center gap-1.5 pl-3 pr-4 py-1.5 flex-1 min-w-0 max-w-[200px] rounded-t-md overflow-hidden cursor-pointer text-[calc(var(--helix-transcript-size)*0.8571)] border-b-2 transition-colors ${active ? "bg-primary/10 border-primary text-foreground" : "bg-muted/40 border-transparent text-foreground/60 hover:bg-accent/50"}`}
              >
                {p.kind === "browser" && (
                  <Globe className="size-3.5 shrink-0 opacity-60" />
                )}
                <span className="flex-1 min-w-0 truncate">{label}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closePage(p.id);
                  }}
                  data-tip="关闭"
                  className={`absolute right-0.5 top-1/2 -translate-y-1/2 rounded p-0.5 transition-opacity ${active ? "opacity-60 hover:opacity-100 hover:text-destructive hover:bg-destructive/10" : "opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:text-destructive hover:bg-destructive/10"}`}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
          {editorTabs.map((t) => {
            const active = t.id === activeEditorTabId && codeViewActive;
            return (
              <div
                key={t.id}
                onClick={() => {
                  useHelixStore.getState().setActiveEditorTab(t.id);
                  setActivePageId("");
                }}
                data-tip={t.path}
                className={`group relative flex items-center gap-1.5 pl-3 pr-4 py-1.5 flex-1 min-w-0 max-w-[200px] rounded-t-md overflow-hidden cursor-pointer text-[calc(var(--helix-transcript-size)*0.8571)] border-b-2 transition-colors ${active ? "bg-primary/10 border-primary text-foreground" : "bg-muted/40 border-transparent text-foreground/60 hover:bg-accent/50"}`}
              >
                <span className="flex-1 min-w-0 truncate">{t.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeCodeTab(t.id);
                  }}
                  data-tip="关闭"
                  className={`absolute right-0.5 top-1/2 -translate-y-1/2 rounded p-0.5 transition-opacity ${active ? "opacity-60 hover:opacity-100 hover:text-destructive hover:bg-destructive/10" : "opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:text-destructive hover:bg-destructive/10"}`}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
          <button
            ref={titlePlusRef}
            onClick={() => setPlusMenuOpen((v) => !v)}
            className="ml-0.5 mb-0.5 p-1.5 rounded text-foreground/50 hover:text-foreground hover:bg-accent/50 transition-colors shrink-0 self-end"
            data-tip="更多操作"
          >
            <Plus className="size-3.5" />
          </button>
          <button
            onClick={() => toggleCodeFullscreen()}
            className={`mb-0.5 p-1.5 rounded transition-colors shrink-0 self-end ${codeFullscreen ? "text-primary bg-primary/10" : "text-foreground/50 hover:text-foreground hover:bg-accent/50"}`}
            data-tip={codeFullscreen ? "退出全屏" : "展开全屏"}
          >
            {codeFullscreen ? (
              <Minimize2 className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
          </button>
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
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-h-0 flex flex-col">
          {pages.map((p) => {
            const isActive = p.id === activePageId;
            return (
              <div
                key={p.id}
                className={isActive ? "flex-1 min-h-0 flex flex-col" : "hidden"}
                style={isActive ? undefined : { display: "none" }}
              >
                {p.kind === "browser" && (
                  <BrowserView
                    url={p.url}
                    onUrlChange={(u) => updatePageUrl(p.id, u)}
                    onPageTitle={(t) => updatePageTitle(p.id, t)}
                  />
                )}
                {p.kind === "diff" && <DiffSidebarPanel />}
              </div>
            );
          })}
          {editorTabs.length > 0 && codeViewActive && (
            <div className="flex-1 min-h-0 flex flex-col">
              <CodeEditorPanel onClose={closeCodeView} />
            </div>
          )}
        </div>
      </div>

      {plusMenuOpen &&
        typeof window !== "undefined" &&
        createPortal(
          <div
            className="fixed z-[200]"
            style={{
              top:
                (titlePlusRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
              right:
                typeof window !== "undefined"
                  ? window.innerWidth -
                    (titlePlusRef.current?.getBoundingClientRect().right ?? 0)
                  : 0,
            }}
          >
            <div ref={plusMenuRef}>
              <MoreActionsMenu
                onToggleTab={(kind) => {
                  // 已打开的页签再次点击 → 只聚焦对应页，不关闭、不收起侧边栏
                  // （关闭走页签的 ✕）。尚未打开 → 打开。
                  if (tab === kind) {
                    const target = pagesRef.current.find(
                      (p) => p.kind === kind,
                    );
                    if (target) setActivePageId(target.id);
                  } else {
                    setTab(kind);
                  }
                  setPlusMenuOpen(false);
                }}
                onAddBrowser={() => {
                  useHelixStore.getState().requestAddBrowserPage();
                  setPlusMenuOpen(false);
                }}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
