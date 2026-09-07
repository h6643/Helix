"use client";

import {
  X,
  ChevronLeft,
  ChevronRight,
  RotateCw,
  ExternalLink,
  MousePointer2,
  Globe,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { isRealElectron } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";
import { createPortal } from "react-dom";
import { cleanUrl } from "@/lib/url-utils";

// ---------------------------------------------------------------------------
// Suppress benign <webview> navigation-abort noise.
//
// When the Electron <webview> guest redirects, or a newer navigation supersedes
// an in-flight load, Chromium aborts the previous loadURL with ERR_ABORTED
// (-3). Electron surfaces this as a rejected `GUEST_VIEW_MANAGER_CALL` IPC which
// Next.js's dev overlay prints to the console as an "Unexpected error while
// loading URL" unhandled rejection. The page always finishes loading, so this
// is purely cosmetic — we swallow it globally here (registered once per module
// load, guarded so HMR re-imports don't stack listeners).
// ---------------------------------------------------------------------------
if (
  typeof window !== "undefined" &&
  !(window as any).__helixWebviewErrSuppressed
) {
  (window as any).__helixWebviewErrSuppressed = true;
  const isBenignNavError = (e: any): boolean => {
    const msg =
      e?.reason?.message || e?.message || String(e?.reason ?? e ?? "");
    return (
      msg.includes("GUEST_VIEW_MANAGER_CALL") ||
      msg.includes("ERR_ABORTED") ||
      msg.includes("(-3)")
    );
  };
  window.addEventListener("unhandledrejection", (e: any) => {
    if (isBenignNavError(e)) {
      e.preventDefault();
      e.stopImmediatePropagation?.();
    }
  });
  window.addEventListener("error", (e: any) => {
    if (isBenignNavError(e)) {
      e.preventDefault();
      e.stopImmediatePropagation?.();
    }
  });
}

/**
 * A single browser page rendered by RightSidebar. It shows one <webview>/<iframe>
 * for the given `url`, a navigation toolbar (back / forward / refresh), an
 * inline-editable address, and the imported bookmark bar.
 *
 * In Electron we use a real <webview> so sites that forbid iframing
 * (X-Frame-Options / CSP frame-ancestors) still render. Outside Electron we
 * fall back to a plain <iframe>.
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

export function summarizeUrl(url: string): string {
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

export function BrowserView({
  url,
  onUrlChange,
  onPageTitle,
}: {
  url: string;
  onUrlChange: (url: string) => void;
  onPageTitle?: (title: string) => void;
}) {
  const [loaded, setLoaded] = useState(cleanUrl(url));
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const webviewRef = useRef<any>(null);
  const inElectron = isRealElectron();

  // Sync when the controlled `url` prop changes (external link / page switch).
  useEffect(() => {
    const u = cleanUrl(url);
    if (u !== loadedRef.current) setLoaded(u);
  }, [url]);

  const goBack = () => {
    try {
      webviewRef.current?.goBack?.();
    } catch {}
  };
  const goForward = () => {
    try {
      webviewRef.current?.goForward?.();
    } catch {}
  };
  const reload = () => {
    try {
      webviewRef.current?.reload?.();
    } catch {}
  };

  const commitUrl = (raw?: string) => {
    const input = (raw ?? "").trim();
    const u = cleanUrl(normalizeUrl(input));
    if (!u) return;
    // 地址栏导航 → 必须退出选取模式（否则 iframe 仍停留在 srcdoc 渲染的
    // 选取页面，新链接不会加载，表现为"地址栏输入链接没反应"）
    exitPick();
    setLoaded(u);
    setError("");
    onUrlChange(u);
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
  const cancelUrlEdit = () => setEditingUrl(false);

  // ── "选取元素加入聊天" ─────────────────────────────────────────────────
  // 跨域 iframe 无法从父页面访问 DOM，所以进入选择模式时先用 Rust
  // page_fetch 拉取页面 HTML，用 <iframe srcdoc> 渲染（继承父 origin），
  // 注入选择脚本：hover 高亮、点击选取、parent.postMessage 回传元素信息。
  const [pickMode, setPickMode] = useState(false);
  const [pickSrcDoc, setPickSrcDoc] = useState<string | null>(null);
  const [pickError, setPickError] = useState("");
  const pickErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pickedCount, setPickedCount] = useState(0);
  const pickedCountRef = useRef(0);

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
      const res = await (window as any).__TAURI_INTERNALS__?.invoke?.(
        "page_fetch",
        { url: loaded },
      );
      if (!res || typeof res.html !== "string") throw new Error("fetch failed");
      setPickSrcDoc(res.html);
    } catch (e: any) {
      exitPick();
      setPickError(`无法载入页面进行选取：${e?.message || e || "未知错误"}`);
      if (pickErrorTimer.current) clearTimeout(pickErrorTimer.current);
      pickErrorTimer.current = setTimeout(() => setPickError(""), 5000);
    }
  };

  // 接收选取结果 → 注入聊天输入框 → 退出选择模式
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

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
    <div className="flex-1 min-h-0 flex flex-col bg-card">
      {/* Navigation toolbar */}
      <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-border/20 shrink-0 bg-card">
        <button
          onClick={goBack}
          disabled={!inElectron}
          className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          data-tip="后退"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          onClick={goForward}
          disabled={!inElectron}
          className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          data-tip="前进"
        >
          <ChevronRight className="size-4" />
        </button>
        <button
          onClick={reload}
          disabled={!inElectron}
          className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          data-tip="刷新"
        >
          <RotateCw className="size-3.5" />
        </button>
        <div className="flex-1 min-w-0 px-2">
          {editingUrl ? (
            <input
              autoFocus
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitUrlEdit();
                if (e.key === "Escape") cancelUrlEdit();
              }}
              onBlur={submitUrlEdit}
              spellCheck={false}
              className="w-full px-2 py-1 text-[calc(var(--helix-transcript-size)*0.7857)] bg-muted/40 border border-border/50 rounded-md text-foreground outline-none focus:border-primary/60 text-center"
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
            if (loaded) {
              import("@/lib/electron-bridge").then(({ electronShell }) => {
                electronShell.open(loaded);
              });
            }
          }}
          className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/60 transition-colors"
          data-tip="在外部浏览器中打开"
        >
          <ExternalLink className="size-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 bg-card relative">
        {pickMode ? (
          <WebviewFrame
            url={url}
            active
            srcdoc={pickSrcDoc ?? undefined}
            pickMode
            onLoading={setLoading}
            onError={(e) => {
              setError(e);
              setLoading(false);
            }}
            onNavigate={(u) => {
              setLoaded(u);
            }}
            onWebviewRef={(el) => {
              webviewRef.current = el;
            }}
            onPageTitle={onPageTitle}
          />
        ) : url ? (
          <WebviewFrame
            url={url}
            active
            onLoading={setLoading}
            onError={(e) => {
              setError(e);
              setLoading(false);
            }}
            onNavigate={(u) => {
              setLoaded(u);
            }}
            onWebviewRef={(el) => {
              webviewRef.current = el;
            }}
            onPageTitle={onPageTitle}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/40 pointer-events-none">
            点击消息中的链接以预览
          </div>
        )}
        {pickError && (
          <div className="absolute inset-x-0 top-0 z-10 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] text-red-500 bg-red-50/90 border-b border-red-100">
            {pickError}
          </div>
        )}
        {loading && (
          <div className="absolute top-2 right-2 z-10 px-2 py-0.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/70 bg-card/80 rounded pointer-events-none">
            加载中…
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

/** A single webview/iframe frame + its lifecycle listeners and resize sizing. */
function WebviewFrame({
  url,
  active,
  srcdoc,
  pickMode,
  onLoading,
  onError,
  onNavigate,
  onWebviewRef,
  onPageTitle,
}: {
  url: string;
  active: boolean;
  srcdoc?: string;
  pickMode?: boolean;
  onLoading: (loading: boolean) => void;
  onError: (error: string) => void;
  onNavigate: (url: string) => void;
  onWebviewRef?: (el: any) => void;
  onPageTitle?: (title: string) => void;
}) {
  const webviewRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inElectron = isRealElectron();
  // Freeze the INITIAL src to `about:blank` so the <webview> guest process is
  // created exactly once. We must NOT bind `src` to the live `url` — every
  // `src` change makes Electron call loadURL internally, whose ERR_ABORTED
  // rejection is an UN-catchable console error (the GUEST_VIEW_MANAGER_CALL
  // noise). All real navigations go through our own loadURL below, which
  // swallows ERR_ABORTED ourselves.
  const initialSrcRef = useRef<string>("about:blank");
  const urlRef = useRef(url);
  urlRef.current = url;
  // The last url we actually asked the guest to load. Prevents duplicate loads
  // (a duplicate loadURL is exactly what produces the benign ERR_ABORTED -3).
  const lastLoadedRef = useRef<string | null>(null);
  const [guestReady, setGuestReady] = useState(false);
  // Keep callbacks fresh without re-running the mount-once listener effect.
  const onLoadingRef = useRef(onLoading);
  const onErrorRef = useRef(onError);
  const onNavigateRef = useRef(onNavigate);
  const onPageTitleRef = useRef(onPageTitle);
  onLoadingRef.current = onLoading;
  onErrorRef.current = onError;
  onNavigateRef.current = onNavigate;
  onPageTitleRef.current = onPageTitle;
  const setWebviewRef = (el: any) => {
    webviewRef.current = el;
    onWebviewRef?.(el);
  };

  // Electron's <webview> doesn't reflow on container resize (known flex-parent
  // bug). Size it imperatively to the wrapper; ResizeObserver keeps it correct
  // (including when the frame becomes visible again after being hidden).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const rect = wrap.getBoundingClientRect();
      const wv = webviewRef.current;
      if (wv && rect.width > 0) {
        wv.style.width = `${rect.width}px`;
        wv.style.height = `${rect.height}px`;
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Our own loadURL wrapper — the promise is ours, so we can swallow ERR_ABORTED.
  const doLoad = (target: string) => {
    if (!target || lastLoadedRef.current === target) return;
    const el = webviewRef.current;
    if (!el) return;
    lastLoadedRef.current = target;
    onLoadingRef.current(true);
    try {
      el.loadURL(target).catch((err: any) => {
        // ERR_ABORTED (-3): a newer navigation superseded this one (the site
        // redirected, a link was clicked, or a refresh interrupted an in-flight
        // load). Benign — the page always finishes loading. The error arrives
        // serialized across the GUEST_VIEW_MANAGER_CALL IPC, so the `code`
        // property is not always preserved; match on code OR message.
        const msg = err?.message || "";
        const benign =
          err?.code === "ERR_ABORTED" ||
          err?.errno === -3 ||
          msg.includes("ERR_ABORTED") ||
          msg.includes("(-3)");
        if (!benign) onErrorRef.current(err?.message || "页面加载失败");
        onLoadingRef.current(false);
      });
    } catch {
      onLoadingRef.current(false);
    }
  };

  // Lifecycle listeners (Electron <webview> only). Attached once on mount.
  useEffect(() => {
    if (!inElectron) return;
    const el = webviewRef.current;
    if (!el || typeof el.addEventListener !== "function") return;
    const onStart = () => onLoadingRef.current(true);
    const onStop = () => onLoadingRef.current(false);
    const onDomReady = () => {
      setGuestReady(true);
      doLoad(urlRef.current);
    };
    const onNav = (e: any) => {
      if (e?.url) onNavigateRef.current(e.url);
    };
    const onTitle = (e: any) => {
      if (e?.title) onPageTitleRef.current?.(e.title);
    };
    const onFail = (e: any) => {
      // ERR_ABORTED (-3) is a benign navigation supersede — never surface it.
      if (e?.errorCode && e.errorCode !== -3) {
        onErrorRef.current(e?.errorDescription || "页面加载失败");
        onLoadingRef.current(false);
      }
    };
    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("dom-ready", onDomReady);
    el.addEventListener("did-navigate", onNav);
    el.addEventListener("page-title-updated", onTitle);
    el.addEventListener("did-fail-load", onFail);
    // If the guest is already live (dom-ready fired before React attached the
    // listener, e.g. after an HMR remount), load now — otherwise dom-ready will.
    try {
      if (
        typeof el.getWebContentsId === "function" &&
        el.getWebContentsId() != null
      )
        onDomReady();
    } catch {
      /* guest not ready yet; dom-ready will fire */
    }
    return () => {
      el.removeEventListener("did-start-loading", onStart);
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("dom-ready", onDomReady);
      el.removeEventListener("did-navigate", onNav);
      el.removeEventListener("page-title-updated", onTitle);
      el.removeEventListener("did-fail-load", onFail);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load whenever the controlled `url` prop changes (user input / external link).
  // Gated on guestReady so we never call loadURL before the guest exists.
  useEffect(() => {
    if (!inElectron || !guestReady) return;
    const el = webviewRef.current;
    if (!el || !url) return;
    doLoad(url);
  }, [url, guestReady, inElectron]);

  if (!url && !srcdoc) return null;

  return (
    <div ref={wrapRef} className={`absolute inset-0 ${active ? "" : "hidden"}`}>
      {inElectron ? (
        React.createElement(
          "webview",
          {
            ref: setWebviewRef,
            src: initialSrcRef.current,
            allowpopups: "true",
            className: "w-full h-full border-0",
          } as any,
          null,
        )
      ) : (
        <iframe
          ref={setWebviewRef as any}
          src={srcdoc ? undefined : url}
          srcDoc={srcdoc || undefined}
          onLoad={() => {
            // 选择模式：srcdoc iframe 继承父 origin，加载后注入选择脚本
            if (pickMode && srcdoc) {
              const doc = (webviewRef.current as any)?.contentDocument;
              if (doc) injectPickScript(doc);
            }
          }}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          data-tip="Preview"
        />
      )}
    </div>
  );
}

/** 在 srcdoc iframe 的 document 里注入元素选择脚本：hover 高亮、点击选取、
 *  结果通过 parent.postMessage 回传给宿主页面。 */
function injectPickScript(doc: Document) {
  try {
    // 防重复 append（父页面视角）。脚本内部的防重入用 __helixPickerListening。
    if ((doc.defaultView as any)?.__helixPickerInstalled) return;
    (doc.defaultView as any).__helixPickerInstalled = true;
    const script = doc.createElement("script");
    script.textContent = `
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
    (doc.head || doc.documentElement).appendChild(script);
  } catch {
    /* cross-origin guard — picker just won't attach */
  }
}
