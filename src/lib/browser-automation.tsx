/**
 * Browser automation executor for the pi-extension request-response protocol.
 *
 * The pi model's browser tools (browser_read / browser_click / browser_type /
 * browser_press) arrive as `helix:browser-request` events (see helix.rs
 * poll_browser_requests). Tauri's main webview cannot script a cross-origin
 * page directly, so — exactly like the "pick element" feature — we fetch the
 * page HTML via the Rust `page_fetch` command, render it into a hidden
 * same-origin `<iframe srcdoc>`, inject an executor script, and receive the
 * result via `window.postMessage`.
 *
 * Execution model: one hidden iframe per request (create → wait HELIX_EXEC_READY
 * → run op → wait HELIX_EXEC_RESULT → cleanup). The snapshot is static HTML:
 * reads see structure/text/interactive elements; clicks on links/submits fire
 * native navigations that surface through the browser panel's normal URL flow.
 * SPA-rendered content is invisible to this path — the model falls back to
 * `navigate` (real webview) when that matters.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface BrowserExecRequest {
  op:
    | "read"
    | "click"
    | "type"
    | "press"
    | "screenshot"
    | "back"
    | "forward"
    | "refresh";
  url?: string;
  reqId: string;
  params?: {
    selector?: string;
    ref?: string;
    text?: string;
    submit?: boolean;
    key?: string;
  };
}

export interface BrowserExecResult {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  text?: string;
  elements?: Array<{
    ref: string;
    tag: string;
    role?: string;
    label?: string;
    text?: string;
    href?: string;
    type?: string;
  }>;
  clicked?: string;
  typed?: string;
  navigated?: string;
  /** browser_screenshot：页面渲染快照（PNG data URL）。 */
  image?: string;
  /** 视觉模型转述（配置了视觉模型时尽力而为，供非多模态主模型阅读）。 */
  description?: string;
}

const EXEC_TIMEOUT_MS = 15_000;

/** Declarative script injected into the srcdoc iframe. Serialized as a string
 *  because srcdoc iframes don't share module scope with the host document.
 *  It installs a one-shot message listener, applies the op to the DOM, and
 *  posts the result back to the parent. */
const EXECUTOR_SCRIPT = `
<script>
(function() {
  if (window.__helixExecInstalled) return;
  window.__helixExecInstalled = true;

  // Ref registry: every interactive element gets a stable "eN" id assigned in
  // DOM order. Rebuilt per read; clicks resolve refs against the live DOM.
  function isVisible(el) {
    if (!el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    var s = (window.getComputedStyle ? getComputedStyle(el) : el.style) || {};
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    return true;
  }
  function labelOf(el) {
    var t = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (t) return t.slice(0, 120);
    var v = el.getAttribute && (el.getAttribute('value') || '');
    if (v) return String(v).slice(0, 120);
    var ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) return String(ph).slice(0, 120);
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return String(aria).slice(0, 120);
    var forId = el.getAttribute && el.getAttribute('for');
    if (forId) {
      var lab = document.querySelector('label[for="' + forId + '"]');
      if (lab) return (lab.innerText || '').trim().slice(0, 120);
    }
    return '';
  }
  function interactiveElements(selector) {
    var nodes = selector
      ? Array.prototype.slice.call(document.querySelectorAll(selector))
      : Array.prototype.slice.call(
          document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], summary')
        );
    return nodes.filter(function (el) { return isVisible(el); });
  }
  function readAll(selector) {
    var els = interactiveElements(selector);
    var out = [];
    els.forEach(function (el, i) {
      var ref = 'e' + (i + 1);
      try { el.setAttribute('data-helix-ref', ref); } catch (e) {}
      out.push({
        ref: ref,
        tag: (el.tagName || '').toLowerCase(),
        role: el.getAttribute && el.getAttribute('role') || undefined,
        label: labelOf(el) || undefined,
        text: ((el.innerText || el.textContent || '').trim().slice(0, 200)) || undefined,
        href: (el.getAttribute && el.getAttribute('href')) || undefined,
        type: (el.getAttribute && el.getAttribute('type')) || undefined
      });
    });
    var bodyText = ((document.body && document.body.innerText) || '')
      .trim()
      .replace(/\\n{3,}/g, '\\n\\n');
    return { text: bodyText.slice(0, 12000), elements: out };
  }
  function findByRefOrSelector(params) {
    if (params && params.ref) {
      var byRef = document.querySelector('[data-helix-ref="' + params.ref + '"]');
      if (byRef) return byRef;
      // Ref registry not built for THIS page yet (fresh srcdoc) — a ref without
      // a prior read can't resolve; fall through to selector if present.
    }
    if (params && params.selector) {
      try { return document.querySelector(params.selector) || null; } catch (e) { return null; }
    }
    return null;
  }
  function doClick(params) {
    var el = findByRefOrSelector(params);
    if (!el) return { ok: false, error: '找不到目标元素' + (params && (params.ref || params.selector) ? ': ' + (params.ref || params.selector) : '') };
    var desc = labelOf(el) || (el.tagName || '').toLowerCase();
    el.scrollIntoView({ block: 'center' });
    el.click();
    var href = el.getAttribute && (el.tagName === 'A' ? el.getAttribute('href') : null);
    return { ok: true, clicked: desc.slice(0, 200), navigated: href || undefined };
  }
  function doType(params) {
    var el = findByRefOrSelector(params);
    if (!el) return { ok: false, error: '找不到目标输入框' + (params && (params.ref || params.selector) ? ': ' + (params.ref || params.selector) : '') };
    el.scrollIntoView({ block: 'center' });
    el.focus();
    // Native value setter bypasses React's value tracking so the page's
    // listeners actually see the change.
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    var taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    var proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    var d = el instanceof HTMLTextAreaElement ? taSetter : setter;
    if (d && d.set) d.set.call(el, params.text || '');
    else el.value = params.text || '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (params.submit) {
      if (el.form && typeof el.form.requestSubmit === 'function') {
        try { el.form.requestSubmit(); return { ok: true, typed: (params.text || '').slice(0, 120), navigated: 'form-submit' }; } catch (e) {}
      }
      var ke = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true });
      el.dispatchEvent(ke);
      return { ok: true, typed: (params.text || '').slice(0, 120), navigated: 'enter' };
    }
    return { ok: true, typed: (params.text || '').slice(0, 120) };
  }
  function doPress(params) {
    var key = (params && params.key) || 'Enter';
    var el = document.activeElement || document.body;
    var ev;
    try {
      ev = new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true });
    } catch (e) {
      ev = document.createEvent('KeyboardEvent');
      ev.initKeyboardEvent('keydown', true, true, null, key, 0, '', '', '', '');
    }
    el.dispatchEvent(ev);
    return { ok: true, pressed: key };
  }

  // 截图：把当前渲染的 DOM 序列化进 SVG foreignObject，画到 canvas 转 PNG。
  // srcdoc 快照与宿主同源，可直接 drawImage；无外部样式表时是未排版渲染，
  // 但有总比没有强——视觉模型能读出布局/文本/大体结构。
  function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function doScreenshot() {
    return new Promise(function (resolve, reject) {
      try {
        var docEl = document.documentElement;
        var w = Math.max(docEl.scrollWidth, 1280);
        var h = Math.max(docEl.scrollHeight, 800);
        var svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
          '<foreignObject width="100%" height="100%">' +
          '<div xmlns="http://www.w3.org/1999/xhtml">' +
          escapeXml(docEl.outerHTML) +
          '</div></foreignObject></svg>';
        var img = new Image();
        img.onload = function () {
          try {
            var c = document.createElement('canvas');
            c.width = w; c.height = h;
            var ctx = c.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            resolve({ ok: true, image: c.toDataURL('image/png') });
          } catch (err) { reject(err); }
        };
        img.onerror = function () { reject(new Error('页面渲染为图片失败')); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      } catch (err) { reject(err); }
    });
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'HELIX_EXEC_RUN') return;
    var done = function (res) {
      parent.postMessage({ type: 'HELIX_EXEC_RESULT', reqId: d.reqId, result: res }, '*');
    };
    try {
      if (d.op === 'screenshot') {
        doScreenshot().then(done, function (err) {
          done({ ok: false, error: String((err && err.message) || err) });
        });
        return;
      }
      var res;
      if (d.op === 'read') {
        var r = readAll(d.params && d.params.selector);
        res = { ok: true, url: d.url, title: document.title || '', text: r.text, elements: r.elements };
      } else if (d.op === 'click') {
        res = doClick(d.params);
        if (res.ok) { res.url = d.url; res.title = document.title || ''; }
      } else if (d.op === 'type') {
        res = doType(d.params);
        if (res.ok) { res.url = d.url; res.title = document.title || ''; }
      } else if (d.op === 'press') {
        res = doPress(d.params);
      } else {
        res = { ok: false, error: 'unknown op: ' + d.op };
      }
      done(res);
    } catch (err) {
      done({ ok: false, error: String((err && err.message) || err) });
    }
  });

  parent.postMessage({ type: 'HELIX_EXEC_READY' }, '*');
})();
</script>
`;


/** 视觉模型转述（尽力而为）：把截图 data URL 交给 vision_describe，返回文字描述。 */
async function describeImage(image: string): Promise<string | null> {
  try {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const desc = await internals?.invoke?.("vision_describe", {
      image,
      prompt: null,
    });
    return typeof desc === "string" && desc ? desc : null;
  } catch {
    return null;
  }
}
/** Fetch a page's HTML through the Rust page_fetch command (server-side fetch:
 *  bypasses CORS entirely). Returns null on failure. */
async function fetchPageHtml(url: string): Promise<string | null> {
  try {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const res = (await internals?.invoke?.("page_fetch", { url })) as
      | { html?: unknown }
      | null
      | undefined;
    if (res && typeof res.html === "string" && res.html) return res.html;
    return null;
  } catch {
    return null;
  }
}

/** Inject the executor script into fetched HTML. Kept simple: append to the
 *  end of <body> (or the document end) so the DOM is parsed when it runs. */
function withExecutor(html: string): string {
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<\/body>/i, EXECUTOR_SCRIPT + "</body>");
  }
  return html + EXECUTOR_SCRIPT;
}

/**
 * React hook mounting a hidden automation iframe + a request queue. The
 * layout component feeds each `helix:browser-request` into `enqueue`; the
 * hook executes it against the page snapshot and posts the result back via
 * the `browserWriteResult` Rust command. Only ONE op runs at a time — ops
 * against the same conversation should serialize anyway, and pi's tools
 * await each result before issuing the next request.
 */
export function useBrowserAutomation() {
  const [pending, setPending] = useState<BrowserExecRequest | null>(null);
  const [frameHtml, setFrameHtml] = useState<string | null>(null);

  // Result listener bound at parent scope: receives from the srcdoc iframe.
  // `pending` drives the effect that OWNS the current request; `pendingRef`
  // tracks it so cleanup can settle a request that outlived the unmount
  // (otherwise the pi tool would block for its 20s result timeout).
  const pendingRef = useRef<BrowserExecRequest | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(
    () => () => {
      const cur = pendingRef.current;
      if (!cur) return;
      pendingRef.current = null;
      import("@/lib/electron-bridge").then(({ electronApp }) => {
        electronApp.browserWriteResult?.(cur.reqId, {
          ok: false,
          error: `执行环境已卸载（${cur.op}）：Helix 界面重载了，请重新发起操作`,
        } as BrowserExecResult);
      });
    },
    [],
  );
  useEffect(() => {
    if (!pending) return;
    let done = false;
    const finish = (result: BrowserExecResult) => {
      if (done) return;
      done = true;
      const reqId = pending.reqId;
      // browser_screenshot：尽量用视觉模型把截图转述成文字，供非多模态
      // 主模型阅读（原图也一并回传，多模态模型可直接看图）。
      if (result.ok && result.image && !result.description) {
        void describeImage(result.image).then((desc) => {
          import("@/lib/electron-bridge").then(({ electronApp }) => {
            electronApp.browserWriteResult?.(reqId, {
              ...result,
              description: desc ?? undefined,
            });
          });
          setPending(null);
          setFrameHtml(null);
        });
        return;
      }
      import("@/lib/electron-bridge").then(({ electronApp }) => {
        electronApp.browserWriteResult?.(reqId, result);
      });
      setPending(null);
      setFrameHtml(null);
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as
        | {
            type?: string;
            reqId?: string;
            result?: BrowserExecResult;
          }
        | null;
      if (!d || typeof d !== "object" || !d.reqId) return;
      if (d.type === "HELIX_EXEC_RESULT" && d.reqId === pending.reqId) {
        finish(d.result as BrowserExecResult);
      }
    };
    window.addEventListener("message", onMsg);
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: `执行超时（${pending.op}）`,
        } as BrowserExecResult),
      EXEC_TIMEOUT_MS,
    );
    return () => {
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
    };
  }, [pending]);

  // Drive the iframe: load snapshot HTML for the request's URL, then run the
  // op once the iframe signals HELIX_EXEC_READY.
  //
  // Two paths: `frameHtml` starts null for each request, so on the first pass
  // we fetch the snapshot and arm the iframe via setState. On subsequent
  // passes (pending or frameHtml changed after the fetch resolved) the iframe
  // element already exists in the DOM and is polled synchronously — without
  // the extra render round-trip (and its potential staleness) the ready
  // signal can arrive between poll ticks and be missed.
  useEffect(() => {
    if (!pending || !pending.url) return;
    let cancelled = false;
    const fail = (error: string) => {
      if (cancelled || pendingRef.current?.reqId !== pending.reqId) return;
      pendingRef.current = null;
      import("@/lib/electron-bridge").then(({ electronApp }) => {
        electronApp.browserWriteResult?.(pending.reqId, {
          ok: false,
          error,
        } as BrowserExecResult);
      });
      setPending(null);
      setFrameHtml(null);
    };

    // Arm the iframe and wait for the injected script to report ready.
    const armAndRun = () => {
      if (cancelled || pendingRef.current?.reqId !== pending.reqId) return;
      const started = Date.now();
      const tick = () => {
        if (cancelled || pendingRef.current?.reqId !== pending.reqId) return;
        const frame = document.getElementById(
          "helix-browser-exec-frame",
        ) as HTMLIFrameElement | null;
        const win = frame?.contentWindow as
          | (Window & { __helixExecInstalled?: boolean })
          | null
          | undefined;
        if (win && win.__helixExecInstalled) {
          win.postMessage(
            {
              type: "HELIX_EXEC_RUN",
              op: pending.op,
              reqId: pending.reqId,
              url: pending.url,
              params: pending.params ?? {},
            },
            "*",
          );
          return;
        }
        if (Date.now() - started > EXEC_TIMEOUT_MS) {
          fail("页面快照注入脚本超时未就绪");
          return;
        }
        setTimeout(tick, 80);
      };
      setTimeout(tick, 60);
    };

    if (frameHtml !== null) {
      // Snapshot already armed by a prior effect pass — poll the live frame.
      armAndRun();
      return;
    }

    // First pass: fetch the snapshot, arm the iframe; the frameHtml state
    // change re-runs this effect into the polling path above.
    (async () => {
      const html = await fetchPageHtml(pending.url!);
      if (cancelled || pendingRef.current?.reqId !== pending.reqId) return;
      if (!html) {
        fail(`无法抓取页面（page_fetch 失败）：${pending.url}`);
        return;
      }
      setFrameHtml(withExecutor(html));
    })();
    return () => {
      cancelled = true;
    };
    // frameHtml intentionally re-triggers this effect (arm-then-poll split).
  }, [pending, frameHtml]);

  // `enqueue` keeps its identity for the parent's ref pattern; functional
  // update means the queue never drops a request for a finished one.
  const enqueue = useCallback((req: BrowserExecRequest) => {
    setPending((prev) => prev ?? req);
  }, []);

  return { enqueue, frameHtml };
}

/**
 * The hidden automation iframe. Mount once in the layout; it only renders
 * while a request with a URL is in flight (click/type/press target the page
 * from the preceding read — the pi tools always read first, so the URL rides
 * along on every request via the layout dispatcher).
 */
export function BrowserExecFrame({ html }: { html: string | null }) {
  if (!html) return null;
  return (
    <iframe
      id="helix-browser-exec-frame"
      srcDoc={html}
      style={{
        position: "fixed",
        left: "-9999px",
        top: "0",
        width: "1280px",
        height: "800px",
        border: "0",
        display: "block",
        zIndex: -1,
        pointerEvents: "none",
      }}
      sandbox="allow-scripts allow-same-origin allow-forms"
      title="helix-browser-exec"
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
