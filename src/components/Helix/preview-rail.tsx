"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Globe,
  MousePointer2,
  RotateCw,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { capturePagePng } from "@/lib/browser-automation";
import { electronShell } from "@/lib/electron-bridge";
import { isTauri } from "@/lib/tauri-bridge";
import { cleanUrl, normalizeUrl, summarizeUrl } from "@/lib/url-utils";
import { useHelixStore } from "@/stores/helix-store";

/** 面板矩形 → 子窗口边界的采样间隔。几何真相在 DOM，这里只做脏检查后推送。
 *  60ms：拖侧栏宽度/改窗口大小时子窗口最多落后一个周期，太大会看出「橡皮筋」。 */
const SYNC_INTERVAL_MS = 60;

/** 遮挡采样的内缩距离：贴边的点会打到相邻元素的边界上。 */
const OCCLUDE_INSET = 4;

/**
 * 内置浏览器：右侧栏每个页面一条**原生子窗口**（后端见 src-tauri/src/browser_webview.rs）。
 *
 * 为什么不用 iframe：主 webview 里的 `<iframe>` 对绝大多数外网站会被
 * X-Frame-Options / CSP frame-ancestors 直接拒掉，只能退回 page_fetch 抓来的静态
 * 快照 —— 那就是「能看、点不动」。子窗口是真浏览器内核，链接、表单、脚本、cookie
 * 全都正常。非 Tauri 运行时（serve 模式在真浏览器里打开）开不出子窗口，退回 iframe。
 *
 * 子窗口永远浮在 DOM 之上，z-index 管不住它，所以「面板被 Helix 自己的浮层盖住」时
 * 必须让它让路 —— 遮挡判定见 isOccluded，DOM 几何是可见性的唯一真相。
 */

/** 面板是否被 Helix 自己的浮层（模态、下拉、命令面板、tooltip）盖住。两层判定：
 *
 *  1. 五点采样（中心 + 四角）：抓大浮层 —— 全屏遮罩、大面积弹窗必压中其中一点。
 *  2. body 直属 fixed 浮层扫描：抓「小浮层压大面板」—— 加号菜单、toast 只有
 *     一两百像素宽，挂在角落，五个采样点全落在它外面 → 漏判 → 原生子窗口压住
 *     菜单。这些浮层（菜单/toast/命令面板）一律 portal 到 body 且 position:fixed，
 *     只要矩形与面板相交就让路。z 阈值 50：菜单 z-[200]、toast z-[60]、命令面板
 *     z-[310] 都在之上；更低的都是面板内局部元素，不经过 body。 */
function isOccluded(el: HTMLElement, r: DOMRect): boolean {
  const points: Array<[number, number]> = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + OCCLUDE_INSET, r.top + OCCLUDE_INSET],
    [r.right - OCCLUDE_INSET, r.top + OCCLUDE_INSET],
    [r.left + OCCLUDE_INSET, r.bottom - OCCLUDE_INSET],
    [r.right - OCCLUDE_INSET, r.bottom - OCCLUDE_INSET],
  ];
  const pointHit = points.some(([x, y]) => {
    const top = document.elementFromPoint(x, y);
    return !top || !el.contains(top);
  });
  if (pointHit) return true;
  for (const node of document.body.children) {
    if (!(node instanceof HTMLElement) || el.contains(node)) continue;
    const s = getComputedStyle(node);
    if (s.position !== "fixed" || s.pointerEvents === "none") continue;
    const z = Number(s.zIndex);
    if (!Number.isFinite(z) || z < 50) continue;
    const cr = node.getBoundingClientRect();
    if (cr.width < 1 || cr.height < 1) continue;
    if (
      cr.left < r.right &&
      cr.right > r.left &&
      cr.top < r.bottom &&
      cr.bottom > r.top
    ) {
      return true;
    }
  }
  return false;
}

const PICK_SCRIPT = `
  (function() {
    // 注意：用独立的标志名 —— 父页面 injectPickScript 已设
    // __helixPickerInstalled（防重复 append），脚本内部若检查同一个标志
    // 会因已 true 而直接 return，事件监听器一个都不注册（hover 无高亮、
    // 点击无响应）。这里用 __helixPickerListening 区分。
    if (window.__helixPickerListening) return;
    window.__helixPickerListening = true;
    try { parent.postMessage({ type: 'HELIX_PICKER_READY' }, '*'); } catch (e) {}
    var current = null;
    document.addEventListener('mouseover', function(e) {
      var el = e.target;
      if (!el || el === current) return;
      if (current && current.style) current.style.outline = '';
      current = el;
      if (el.style) { el.style.outline = '2px solid #f59e0b'; el.style.outlineOffset = '-2px'; }
    }, true);
    document.addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      var el = e.target;
      if (!el) return;
      if (current && current.style) current.style.outline = '';
      var text = (el.innerText || el.textContent || '').trim().slice(0, 8000);
      var html = (el.outerHTML || '').slice(0, 20000);
      var href = '';
      var src = '';
      try {
        href = el.href || el.getAttribute('href') || '';
        src = el.src || el.getAttribute('src') || '';
      } catch (err) {}
      parent.postMessage({ type: 'HELIX_PICKED', info: {
        tag: (el.tagName || '').toLowerCase(),
        text: text,
        html: html,
        href: href,
        src: src,
        title: document.title || ''
      } }, '*');
    }, true);
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (current && current.style) current.style.outline = '';
        parent.postMessage({ type: 'HELIX_PICKED_CANCEL' }, '*');
      }
    }, true);
    document.body.style.cursor = 'crosshair';
  })();
`;

/** 在 srcdoc iframe 的 document 里注入元素选择脚本：hover 高亮、点击选取、
 *  结果通过 parent.postMessage 回传给宿主页面。 */
function injectPickScript(doc: Document) {
  try {
    if ((doc.defaultView as any)?.__helixPickerInstalled) return;
    (doc.defaultView as any).__helixPickerInstalled = true;
    const script = doc.createElement("script");
    script.textContent = PICK_SCRIPT;
    (doc.head || doc.documentElement).appendChild(script);
  } catch {
    /* cross-origin guard — picker just won't attach */
  }
}

/** 工具栏上的后退/前进/刷新打的就是这一页的原生子窗口。 */
function browserHistory(pageId: string, dir: "back" | "forward" | "reload") {
  return invoke("browser_webview_history", { page: pageId, dir });
}

const CTRL_BTN =
  "shrink-0 p-1.5 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 transition-colors";

/**
 * 浏览器工具栏（右侧栏的第二行）。
 *
 * 只有一条：右侧栏为**当前激活的网页页**渲染它，而不是每页各挂一条 —— 页签是
 * keep-alive 的，每页一条会把这一行叠成一堆。因此它和真正干活的 BrowserView 不是
 * 父子关系，「这一页在加载 / 在选取」都从 store 按 pageId 派生。
 *
 * 地址栏是常驻输入框（不再点一下才展开成胶囊）：没聚焦时显示页面当前 URL，聚焦后
 * 草稿接管，失焦即丢弃 —— 否则页面自己跳转（nav 事件回写 url）会把用户正在敲的
 * 半个地址吃掉。
 */
export function BrowserToolbar({
  pageId,
  url,
  onUrlChange,
}: {
  pageId: string;
  url: string;
  onUrlChange: (url: string) => void;
}) {
  const native = isTauri();
  const loading = useHelixStore((s) => s.browserLoadingPageId === pageId);
  const picking = useHelixStore((s) => s.browserPickPageId === pageId);
  // null = 没有草稿，显示页面真实 URL。
  const [draft, setDraft] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);

  const go = (dir: "back" | "forward" | "reload") => {
    if (!native) return;
    void browserHistory(pageId, dir).catch((e: any) =>
      useHelixStore.getState().showToast({
        type: "error",
        title: dir === "reload" ? "刷新失败" : "翻页失败",
        description: String(e?.message ?? e ?? ""),
      }),
    );
  };

  const commit = (raw: string) => {
    const st = useHelixStore.getState();
    st.setBrowserPickPageId(null);
    const u = cleanUrl(normalizeUrl(raw));
    if (!u) return;
    // 地址没变 → 受控 url 不变，BrowserView 的 effect 不会重新导航，用户按回车要的
    // 就是「再来一次」，所以走刷新。
    if (u === url) go("reload");
    else onUrlChange(u);
  };

  const togglePick = () => {
    const st = useHelixStore.getState();
    if (!url) {
      st.showToast({
        type: "info",
        title: "没有可选取的页面",
        description: "先在地址栏输入网址，加载后再选取元素",
      });
      return;
    }
    st.setBrowserPickPageId(st.browserPickPageId === pageId ? null : pageId);
  };

  // 截图 = WebView2 拍真像素（不是页面里画 canvas，那样拍不到外部样式和图片），
  // 拍完只把 PNG 交给 store 的一次性请求，收件方是聊天面板的输入框：pendingImages
  // 的所有权在那儿，这里不越界去改别人的 state。
  const shoot = async () => {
    const st = useHelixStore.getState();
    if (!url) {
      st.showToast({
        type: "info",
        title: "没有可截图的页面",
        description: "先在地址栏输入网址，加载后再截图",
      });
      return;
    }
    setShooting(true);
    try {
      const dataUrl = await capturePagePng(pageId);
      const host = summarizeUrl(url) || "page";
      st.requestComposerImage({
        dataUrl,
        name: `screenshot-${host}.png`,
      });
      st.showToast({
        type: "success",
        title: "已截取网页",
        description: "图片已放进聊天输入框，可以直接问 Agent",
      });
    } catch (e: any) {
      st.showToast({
        type: "error",
        title: "截图失败",
        description: String(e?.message ?? e ?? "未知错误"),
      });
    } finally {
      setShooting(false);
    }
  };

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 shrink-0 border-b border-border/20">
      <button
        onClick={() => go("back")}
        disabled={!native}
        className={`${CTRL_BTN} disabled:opacity-30 disabled:hover:bg-transparent`}
        data-tip="后退"
      >
        <ChevronLeft className="size-4" />
      </button>
      <button
        onClick={() => go("forward")}
        disabled={!native}
        className={`${CTRL_BTN} disabled:opacity-30 disabled:hover:bg-transparent`}
        data-tip="前进"
      >
        <ChevronRight className="size-4" />
      </button>
      <button
        onClick={() => go("reload")}
        disabled={!native}
        className={`${CTRL_BTN} disabled:opacity-30 disabled:hover:bg-transparent`}
        data-tip="刷新"
      >
        <RotateCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
      </button>
      <div className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1 rounded-full border border-border/40 bg-muted/30 focus-within:border-primary/60 focus-within:bg-muted/50 transition-colors">
        <Globe className="size-3 shrink-0 text-muted-foreground/70" />
        <input
          value={draft ?? url}
          onFocus={(e) => setDraft(e.currentTarget.value)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            // 不让按键继续冒泡：全局快捷键会把这里当成命令面板/搜索的触发点。
            e.stopPropagation();
            if (e.key === "Enter") {
              commit(e.currentTarget.value);
              setDraft(null);
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setDraft(null);
              e.currentTarget.blur();
            }
          }}
          spellCheck={false}
          placeholder="输入网址，例如 localhost:3000"
          className="flex-1 min-w-0 bg-transparent text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground placeholder:text-muted-foreground/50 outline-none"
        />
      </div>
      <button
        onClick={() => void shoot()}
        disabled={!native || shooting}
        className={`${CTRL_BTN} disabled:opacity-40`}
        data-tip={shooting ? "正在截图…" : "截图，加入聊天输入框"}
      >
        <Camera className={`size-3.5 ${shooting ? "animate-pulse" : ""}`} />
      </button>
      <button
        onClick={togglePick}
        className={`${CTRL_BTN} ${picking ? "text-primary bg-primary/10" : ""}`}
        data-tip={url ? "选取网页元素加入聊天" : "请先打开网页再选取元素"}
      >
        <MousePointer2 className="size-3.5" />
      </button>
      <button
        onClick={() => {
          if (url) void electronShell.open(url);
        }}
        className={CTRL_BTN}
        data-tip="在外部浏览器中打开"
      >
        <ExternalLink className="size-3.5" />
      </button>
    </div>
  );
}

export function BrowserView({
  pageId,
  url,
  onUrlChange,
}: {
  pageId: string;
  url: string;
  onUrlChange: (url: string) => void;
}) {
  const native = isTauri();
  const call = useCallback(
    (cmd: string, args?: Record<string, unknown>) =>
      invoke(cmd, { page: pageId, ...args }),
    [pageId],
  );

  const [loaded, setLoaded] = useState(cleanUrl(url));
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  // 子窗口当前真正停在哪个 URL。地址栏回读时靠它区分「这页自己跳的」和「外部把新
  // 链接塞给了这一页」：前者绝不能再 navigate 一次，否则每次导航都变成重新加载。
  const appliedRef = useRef("");
  const [error, setError] = useState("");
  const contentRef = useRef<HTMLDivElement | null>(null);

  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  // 「这一页正在加载」同样投影进 store：刷新图标在工具栏那一行，和这个组件不是同一
  // 个渲染树，各存一份布尔值会不同步。
  const setBusy = useCallback(
    (busy: boolean) =>
      useHelixStore.getState().setBrowserLoadingPageId(busy ? pageId : null),
    [pageId],
  );

  // ── "选取元素加入聊天" ─────────────────────────────────────────────────
  // 真页面在另一条原生窗口里，宿主拿不到它的 DOM，所以选取仍然走 page_fetch 快照 +
  // 同源 <iframe srcdoc>：继承父 origin，注入选择脚本，parent.postMessage 回传。
  // 代价是选取看到的仍是静态快照；好处是快照页没有脚本状态，选到的就是服务端 HTML 里
  // 的东西。进入选取时子窗口会hide（几何同步里判 pickMode）。
  //
  // 「哪一页在选取 / 在加载」存在 store 里而不是本地 state：工具栏是右侧栏为**当前
  // 激活的那条网页页**单独渲染的一行，和干活的 BrowserView 不是父子组件，两边各存
  // 一份布尔值就会出现「按钮亮着、页面没进选取」。这里只按 `id === 自己` 派生。
  const pickMode = useHelixStore((s) => s.browserPickPageId === pageId);
  const [pickSrcDoc, setPickSrcDoc] = useState<string | null>(null);
  const [pickError, setPickError] = useState("");
  const pickErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickedCountRef = useRef(0);
  const [pickedCount, setPickedCount] = useState(0);

  // 这一个 effect 拥有「进入/退出选取时这一页该是什么样」：退出就清掉快照与计数，
  // 进入就抓快照（抓不到则直接退出选取，而不是留一个空白页给用户点）。
  useEffect(() => {
    if (!pickMode) {
      setPickSrcDoc(null);
      setPickedCount(0);
      pickedCountRef.current = 0;
      return;
    }
    let cancelled = false;
    setPickError("");
    void (async () => {
      try {
        const res = (await invoke("page_fetch", { url: loadedRef.current })) as
          { html?: unknown } | null | undefined;
        if (!res || typeof res.html !== "string")
          throw new Error("fetch failed");
        if (!cancelled) setPickSrcDoc(res.html);
      } catch (e: any) {
        if (cancelled) return;
        useHelixStore.getState().setBrowserPickPageId(null);
        setPickError(`无法载入页面进行选取：${e?.message || e || "未知错误"}`);
        if (pickErrorTimer.current) clearTimeout(pickErrorTimer.current);
        pickErrorTimer.current = setTimeout(() => setPickError(""), 5000);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pickMode]);

  const exitPick = () => useHelixStore.getState().setBrowserPickPageId(null);

  /** 让页面去这个 URL：子窗口已存在则复用（后端内部就是 navigate）。 */
  const applyUrl = useCallback(
    (u: string) => {
      loadedRef.current = u;
      appliedRef.current = u;
      setLoaded(u);
      if (!u) return;
      if (native) {
        setBusy(true);
        void call("browser_webview_open", { url: u }).catch((e: any) => {
          setBusy(false);
          setError(String(e?.message ?? e ?? "无法打开浏览器视图"));
        });
      }
    },
    [native, call, setBusy],
  );

  // 受控 `url` 变化（点消息里的链接、切换页面）→ 加载。
  useEffect(() => {
    const u = cleanUrl(url);
    if (u && u !== appliedRef.current) applyUrl(u);
  }, [url, applyUrl]);

  // 几何同步 + 显隐。面板矩形是唯一真相：尺寸变了、面板被收起、被浮层盖住、进入
  // 元素选取，都只在这里判定并推给后端。
  useEffect(() => {
    if (!native) return;
    let lastKey = "";
    const push = () => {
      const el = contentRef.current;
      if (!el) return;
      // 还没打开任何页面时后端没有子窗口，推几何只会拿到「页面不存在」，白跑一趟 IPC。
      if (!loadedRef.current) return;
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const visible =
        r.width >= 1 && r.height >= 1 && !pickMode && !isOccluded(el, r);
      const key = `${Math.round(r.left)}|${Math.round(r.top)}|${Math.round(
        r.width,
      )}|${Math.round(r.height)}|${visible ? 1 : 0}|${dpr}`;
      if (key === lastKey) return;
      lastKey = key;
      void call("browser_webview_set_rect", {
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        dpr,
        visible,
      }).catch((e: unknown) => {
        // 窗口此刻还不存在（open 的 IPC 还在路上）或已被关掉：不要把这次意图当成
        // 已经落地，否则脏检查键会永远停在「已同步」，子窗口留在屏幕外不显示。
        lastKey = "";
        setError(
          `浏览器视图对齐失败：${String((e as { message?: string })?.message ?? e)}`,
        );
      });
    };
    push();
    const timer = setInterval(push, SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [native, call, pickMode]);

  // 页面关闭（组件卸载）→ 销毁子窗口。
  useEffect(() => {
    return () => {
      if (native) void call("browser_webview_close").catch(() => {});
    };
  }, [native, call]);

  // 子窗口的导航事件 → 地址栏跟随。外部页面拿不到 Tauri IPC（capabilities 只信任
  // 应用 origin），不能自己上报，所以后端的 on_page_load 是唯一 URL 来源。
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<{ page: string; url: string; started: boolean }>(
      "helix:browser-nav",
      (e) => {
        const d = e.payload;
        if (!d || d.page !== pageId) return;
        if (d.started) {
          setBusy(true);
          return;
        }
        setBusy(false);
        setError("");
        appliedRef.current = d.url;
        loadedRef.current = d.url;
        setLoaded(d.url);
        onUrlChangeRef.current(d.url);
      },
    ).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [native, pageId, setBusy]);

  // 接收选取结果 → 注入聊天输入框 → 保持选取模式，可以连续点选。
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const data = e?.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "HELIX_PICKED") {
        const info = data.info || {};
        const text = String(info.text || "").trim();
        const link = String(info.href || info.src || "").trim();
        if (link) {
          // 链接不再以纯文本塞进输入框（多个会拥挤），改为底部"网页链接"卡片
          useHelixStore.getState().addLinkAttachment({
            id: `link-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            url: link,
            title: text.slice(0, 80) || "",
          });
          pickedCountRef.current += 1;
          const n = pickedCountRef.current;
          setPickedCount(n);
          useHelixStore.getState().showToast({
            type: "info",
            title: `已添加 ${n} 个网页链接`,
            duration: 1200,
          });
        }
      } else if (data.type === "HELIX_PICKED_CANCEL") {
        exitPick();
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Esc 退出选择模式
  useEffect(() => {
    if (!pickMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitPick();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickMode]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Content：原生子窗口精确盖在这块矩形上，所以这里的 DOM 只在窗口让路时才看得见 */}
      {/* 这里**不涂背景**：侧栏的可见底色只由面板根 `.helix-sidebar-right` 提供
          （全局背景图激活时它是 88% 蒙罩）。以前涂 bg-card 会在那块玻璃上贴出一
          块实色，子窗口一让位就看见「网页区比上面几条工具条更白」。 */}
      <div ref={contentRef} className="flex-1 min-h-0 relative">
        {pickMode ? (
          <iframe
            srcDoc={pickSrcDoc ?? undefined}
            onLoad={(e) => {
              const doc = (e.currentTarget as HTMLIFrameElement)
                .contentDocument;
              if (doc) injectPickScript(doc);
            }}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : native ? (
          !loaded && (
            <div className="absolute inset-0 flex items-center justify-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/40 pointer-events-none">
              点击消息中的链接以预览
            </div>
          )
        ) : (
          <iframe
            src={loaded || undefined}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        )}
        {pickMode && (
          <div className="absolute top-2 right-2 z-10 px-2 py-0.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground bg-card/80 rounded pointer-events-none">
            选取中 · 已添加 {pickedCount} 个 · Esc 退出
          </div>
        )}
        {pickError && (
          <div className="absolute inset-x-0 top-0 z-10 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] text-red-500 bg-red-50/90 border-b border-red-100">
            {pickError}
          </div>
        )}
        {error && (
          <div className="absolute inset-x-0 top-0 z-10 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] text-red-500 bg-red-50/90 border-b border-red-100">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
