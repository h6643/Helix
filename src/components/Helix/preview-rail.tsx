"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronLeft,
  ChevronRight,
  RotateCw,
  ExternalLink,
  MousePointer2,
  Globe,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { electronShell } from "@/lib/electron-bridge";
import { isTauri } from "@/lib/tauri-bridge";
import { cleanUrl } from "@/lib/url-utils";
import { useHelixStore } from "@/stores/helix-store";

/** 面板矩形 → 子窗口边界的采样间隔。几何真相在 DOM，这里只做脏检查后推送。 */
const SYNC_INTERVAL_MS = 120;

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

function cleanInput(raw: string): string {
  let t = raw.trim();
  const linkMatch = t.match(/^\[[^\]]*\]\(([^)]+)\)$/);
  if (linkMatch) t = linkMatch[1].trim();
  t = t.replace(/^<([^>]+)>$/, "$1");
  t = t.replace(/[*_`]/g, "");
  t = t.replace(/[.,;:!?。，；！？)…'"\]}»>]+$/, "");
  return t.trim();
}

function normalizeUrl(raw: string): string {
  const t = cleanInput(raw);
  if (!t) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return t;
  if (
    t.startsWith("localhost") ||
    /^\d{1,3}(\.\d{1,3}){3}/.test(t) ||
    t.startsWith("[")
  )
    return `http://${t}`;
  return `https://${t}`;
}

function summarizeUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.protocol === "file:") {
      const name = decodeURIComponent(u.pathname).split("/").pop();
      return name || url;
    }
    return u.hostname || url;
  } catch {
    return url;
  }
}

/** 面板是否被 Helix 自己的浮层（模态、下拉、命令面板、tooltip）盖住。取五点：
 *  命中元素只要有一个不属于本面板，就说明上面还压着别的东西，子窗口必须让路。 */
function isOccluded(el: HTMLElement, r: DOMRect): boolean {
  const points: Array<[number, number]> = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + OCCLUDE_INSET, r.top + OCCLUDE_INSET],
    [r.right - OCCLUDE_INSET, r.top + OCCLUDE_INSET],
    [r.left + OCCLUDE_INSET, r.bottom - OCCLUDE_INSET],
    [r.right - OCCLUDE_INSET, r.bottom - OCCLUDE_INSET],
  ];
  return points.some(([x, y]) => {
    const top = document.elementFromPoint(x, y);
    return !top || !el.contains(top);
  });
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const contentRef = useRef<HTMLDivElement | null>(null);

  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  // ── "选取元素加入聊天" ─────────────────────────────────────────────────
  // 真页面在另一条原生窗口里，宿主拿不到它的 DOM，所以选取仍然走 page_fetch 快照 +
  // 同源 <iframe srcdoc>：继承父 origin，注入选择脚本，parent.postMessage 回传。
  // 代价是选取看到的仍是静态快照；好处是快照页没有脚本状态，选到的就是服务端 HTML 里
  // 的东西。进入选取时子窗口会hide（几何同步里判 pickMode）。
  const [pickMode, setPickMode] = useState(false);
  const [pickSrcDoc, setPickSrcDoc] = useState<string | null>(null);
  const [pickError, setPickError] = useState("");
  const pickErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickedCountRef = useRef(0);
  const [pickedCount, setPickedCount] = useState(0);

  const exitPick = () => {
    setPickMode(false);
    setPickSrcDoc(null);
    setPickedCount(0);
    pickedCountRef.current = 0;
  };

  const enterPick = async () => {
    if (!loaded) return;
    setPickError("");
    setPickMode(true);
    try {
      const res = (await invoke("page_fetch", { url: loaded })) as
        | { html?: unknown }
        | null
        | undefined;
      if (!res || typeof res.html !== "string") throw new Error("fetch failed");
      setPickSrcDoc(res.html);
    } catch (e: any) {
      exitPick();
      setPickError(`无法载入页面进行选取：${e?.message || e || "未知错误"}`);
      if (pickErrorTimer.current) clearTimeout(pickErrorTimer.current);
      pickErrorTimer.current = setTimeout(() => setPickError(""), 5000);
    }
  };

  /** 让页面去这个 URL：子窗口已存在则复用（后端内部就是 navigate）。 */
  const applyUrl = useCallback(
    (u: string) => {
      loadedRef.current = u;
      appliedRef.current = u;
      setLoaded(u);
      if (!u) return;
      if (native) {
        setLoading(true);
        void call("browser_webview_open", { url: u }).catch((e: any) => {
          setLoading(false);
          setError(String(e?.message ?? e ?? "无法打开浏览器视图"));
        });
      }
    },
    [native, call],
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
      }).catch(() => {
        // 窗口此刻还不存在（open 的 IPC 还在路上）或已被关掉：不要把这次意图当成
        // 已经落地，否则脏检查键会永远停在「已同步」，子窗口留在屏幕外不显示。
        lastKey = "";
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
          setLoading(true);
          return;
        }
        setLoading(false);
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
  }, [native, pageId]);

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

  const goHistory = (dir: "back" | "forward" | "reload") => {
    if (!native) return;
    void call("browser_webview_history", { dir }).catch((e: any) =>
      setError(String(e?.message ?? e ?? "操作失败")),
    );
  };

  const commitUrl = (raw?: string) => {
    const u = cleanUrl(normalizeUrl((raw ?? "").trim()));
    if (!u) return;
    // 地址栏导航 → 必须退出选取模式（否则看到的还是 srcdoc 快照那页，新链接不会加载）。
    exitPick();
    setError("");
    applyUrl(u);
  };

  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const startUrlEdit = () => {
    exitPick();
    setUrlDraft(loaded);
    setEditingUrl(true);
  };
  const submitUrlEdit = () => {
    commitUrl(urlDraft);
    setEditingUrl(false);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-background/50">
      {/* Navigation toolbar */}
      <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-border/20 shrink-0 bg-background/50">
        <button
          onClick={() => goHistory("back")}
          disabled={!native}
          className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          data-tip={native ? "后退" : "内嵌浏览器视图不可用"}
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          onClick={() => goHistory("forward")}
          disabled={!native}
          className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          data-tip={native ? "前进" : "内嵌浏览器视图不可用"}
        >
          <ChevronRight className="size-4" />
        </button>
        <button
          onClick={() => goHistory("reload")}
          disabled={!native}
          className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          data-tip="刷新"
        >
          <RotateCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        <div className="flex-1 min-w-0 px-2">
          {editingUrl ? (
            <input
              autoFocus
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitUrlEdit();
                if (e.key === "Escape") setEditingUrl(false);
              }}
              onBlur={submitUrlEdit}
              spellCheck={false}
              className="w-full px-2 py-1 text-[calc(var(--helix-transcript-size)*0.7857)] bg-muted/40 border border-border/50 rounded-md text-foreground outline-none text-center"
            />
          ) : (
            <button
              onClick={startUrlEdit}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1 text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/80 bg-muted/30 border border-border/40 rounded-md hover:bg-muted/50 hover:border-border/60 hover:text-foreground transition-colors"
              data-tip={loaded}
            >
              <Globe className="size-3 text-muted-foreground/70 shrink-0" />
              <span className="truncate">{summarizeUrl(loaded)}</span>
            </button>
          )}
        </div>
        {/* 选取元素加入聊天（放在地址栏右侧，远离刷新/后退，避免误触） */}
        <button
          onClick={() => {
            if (!loaded) {
              useHelixStore.getState().showToast({
                type: "info",
                title: "没有可选取的页面",
                description: "请先在地址栏输入网址，加载后再选取元素",
              });
              return;
            }
            pickMode ? exitPick() : enterPick();
          }}
          className={`p-1 rounded transition-colors ${pickMode ? "text-primary bg-primary/10" : "text-foreground/60 hover:text-foreground hover:bg-accent/60"}`}
          data-tip={loaded ? "选取网页元素加入聊天" : "请先打开网页再选取元素"}
        >
          <MousePointer2 className="size-3.5" />
        </button>
        <button
          onClick={() => {
            if (loaded) void electronShell.open(loaded);
          }}
          className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 transition-colors"
          data-tip="在外部浏览器中打开"
        >
          <ExternalLink className="size-3.5" />
        </button>
      </div>

      {/* Content：原生子窗口精确盖在这块矩形上，所以这里的 DOM 只在窗口让路时才看得见 */}
      <div ref={contentRef} className="flex-1 min-h-0 bg-background/50 relative">
        {pickMode ? (
          <iframe
            srcDoc={pickSrcDoc ?? undefined}
            onLoad={(e) => {
              const doc = (e.currentTarget as HTMLIFrameElement).contentDocument;
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
            onLoad={() => setLoading(false)}
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
