/**
 * pi 扩展的浏览器请求 → 驱动右侧面板里那条**真**网页视图。
 *
 * 协议：pi 的 browser_* 工具往 `~/.pi/agent/browser-requests/*.json` 丢一个
 * `{op,url,reqId,params}`，Rust 的 `poll_browser_requests` 把它转成
 * `helix:browser-request` 事件（helix.rs），这里执行完再用 `browser_write_result`
 * 写 `<reqId>.result.json`，工具那边才解除等待。
 *
 * 为什么不再是「抓 HTML → 塞进隐藏 iframe 跑脚本」：内置浏览器已经是真窗口
 * （src-tauri/src/browser_webview.rs），而静态快照看不见 SPA 渲染出来的内容、
 * 也点不动需要 JS 才生效的控件。现在每个 op 都是往那条窗口注入一段脚本
 * （`browser_webview_eval`），完成值经 `helix:browser-eval` 事件回传。
 *
 * 注入脚本的硬约束（Windows 上就是 `ICoreWebView2::ExecuteScript`）：**不 await
 * Promise、异常不回报**。所以脚本自己 try/catch、同步返回一个值；唯一真异步的
 * 截图拆成「启动 + 轮询 `window.__helixShot`」两步。又因为导航后页面的全局变量
 * 会随文档一起没掉，每次 op 都重发一遍脚本（不缓存"已安装"标记）。
 *
 * 目标页面只认面板投影出来的 `browserPageId`（pages 的唯一真相在 right-sidebar）。
 * 代价是明确的：agent 一 navigate 就会把侧栏从「更改/代码」拽到网页页上 ——
 * 看得见它在点什么，比不被打断重要。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import { electronApp } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

export interface BrowserExecRequest {
  op:
    | "navigate"
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
  pressed?: string;
  /** browser_screenshot：页面渲染快照（PNG data URL）。 */
  image?: string;
  /** 视觉模型转述（配置了视觉模型时尽力而为，供非多模态主模型阅读）。 */
  description?: string;
}

/** 与 Rust `browser_webview::EVAL_EVENT` 一致。 */
const EVAL_EVENT = "helix:browser-eval";

// pi 工具侧等结果约 20s，所有预算都要留得下回写与网络开销。
const OP_TIMEOUT_MS = 12_000;
const NAV_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;
const PAGE_READY_TIMEOUT_MS = 6_000;
const POLL_MS = 250;

/**
 * 注入页面的执行器。每次 op 都连同这段一起发过去（见文件头：导航会清掉页面全局）。
 * 只定义函数、不动 DOM；返回值必须是可 JSON 序列化的普通对象。
 */
const PAGE_SCRIPT = `
(function () {
  // 引用表：read 按 DOM 顺序给每个可交互元素打 data-helix-ref="eN"。真窗口的
  // DOM 会一直活着，所以这张表跨 op 有效，直到页面换掉。
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
    var out = [];
    interactiveElements(selector).forEach(function (el, i) {
      var ref = 'e' + (i + 1);
      try { el.setAttribute('data-helix-ref', ref); } catch (e) {}
      out.push({
        ref: ref,
        tag: (el.tagName || '').toLowerCase(),
        role: (el.getAttribute && el.getAttribute('role')) || undefined,
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
  function describe(target) {
    return target && (target.ref || target.selector)
      ? ': ' + (target.ref || target.selector) : '';
  }
  function findByRefOrSelector(params) {
    if (params && params.ref) {
      var byRef = document.querySelector('[data-helix-ref="' + params.ref + '"]');
      if (byRef) return byRef;
    }
    if (params && params.selector) {
      try { return document.querySelector(params.selector); } catch (e) { return null; }
    }
    return null;
  }
  function doClick(params) {
    var el = findByRefOrSelector(params);
    if (!el) return { ok: false, error: '找不到目标元素（可能已经变了，重新 read 一次再点）' + describe(params) };
    var desc = labelOf(el) || (el.tagName || '').toLowerCase();
    el.scrollIntoView({ block: 'center' });
    el.click();
    var href = el.tagName === 'A' ? el.getAttribute('href') : null;
    return { ok: true, clicked: desc.slice(0, 200), navigated: href || undefined };
  }
  function doType(params) {
    var el = findByRefOrSelector(params);
    if (!el) return { ok: false, error: '找不到目标输入框（可能已经变了，重新 read 一次再填）' + describe(params) };
    el.scrollIntoView({ block: 'center' });
    el.focus();
    // 原生 value setter 绕过 React 的值追踪，页面自己的监听器才看得见这次改动。
    var proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, params.text || '');
    else el.value = params.text || '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (params.submit) {
      if (el.form && typeof el.form.requestSubmit === 'function') {
        try {
          el.form.requestSubmit();
          return { ok: true, typed: (params.text || '').slice(0, 120), navigated: 'form-submit' };
        } catch (e) {}
      }
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true }));
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

  // 截图：真窗口没有原生截图出口（Tauri 2.11 稳定版没暴露），只能把 DOM 序列化
  // 进 SVG foreignObject 画到 canvas。外部样式表与图片在 SVG-as-image 里不会加载，
  // 所以这是「无排版的文字版渲染」——给视觉模型读内容够用，读样式不够用。
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
            resolve({ ok: true, url: location.href, title: document.title || '', image: c.toDataURL('image/png') });
          } catch (err) { reject(err); }
        };
        img.onerror = function () { reject(new Error('页面渲染为图片失败')); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      } catch (err) { reject(err); }
    });
  }

  window.__helixOp = function (op, params) {
    try {
      if (op === 'read') {
        var r = readAll(params && params.selector);
        return { ok: true, url: location.href, title: document.title || '', text: r.text, elements: r.elements };
      }
      if (op === 'click') return doClick(params);
      if (op === 'type') return doType(params);
      if (op === 'press') return doPress(params);
      return { ok: false, error: '未知的 op: ' + op };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  };

  // ExecuteScript 不等同步返回 Promise → 截图自己把结果落到全局变量，前端轮询。
  window.__helixShotStart = function () {
    window.__helixShot = null;
    doScreenshot().then(
      function (r) { window.__helixShot = r; },
      function (e) { window.__helixShot = { ok: false, error: String((e && e.message) || e) }; }
    );
    return { ok: true };
  };
})();
`;

/** 页面状态探针：不依赖 PAGE_SCRIPT，导航期间也要能问出当前 URL。 */
const PROBE_EXPR =
  "({ url: location.href, title: document.title || '', ready: document.readyState })";

// ── eval 通道：命令发出即返回，结果由 helix:browser-eval 事件配对回来 ──────────

const evalWaiters = new Map<string, (value: string) => void>();
let evalSeq = 0;
let listenerPromise: Promise<void> | null = null;

// 监听器是模块级单例：HMR 让 hook 重挂载也只是多挂一条，靠 reqId 配对无害
// （第一个应答者会把 waiter 摘掉）。
function ensureEvalListener(): Promise<void> {
  if (!listenerPromise) {
    listenerPromise = listen<{ reqId?: string; value?: string }>(EVAL_EVENT, (e) => {
      const reqId = e.payload?.reqId;
      if (!reqId) return;
      const resolve = evalWaiters.get(reqId);
      if (!resolve) return;
      evalWaiters.delete(reqId);
      resolve(String(e.payload?.value ?? ""));
    })
      .then(() => undefined)
      .catch((err) => {
        listenerPromise = null;
        throw err;
      });
  }
  return listenerPromise;
}

function toErr(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(typeof e === "string" ? e : String(e));
}

function errText(e: unknown): string {
  return toErr(e).message || String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function evalRaw(
  page: string,
  js: string,
  timeoutMs: number,
): Promise<string> {
  await ensureEvalListener();
  const reqId = `ev-${Date.now().toString(36)}-${++evalSeq}`;
  const delivered = new Promise<string>((resolve, reject) => {
    evalWaiters.set(reqId, resolve);
    invoke("browser_webview_eval", { page, js, reqId }).catch((e) => {
      evalWaiters.delete(reqId);
      reject(toErr(e));
    });
  });
  try {
    return await withTimeout(
      delivered,
      timeoutMs,
      `页面对脚本无响应（${Math.round(timeoutMs / 1000)}s）`,
    );
  } finally {
    evalWaiters.delete(reqId);
  }
}

/** 注入返回 null/空 = 脚本被页面吞了（ExecuteScript 不回报异常），如实报错。 */
async function evalInPage<T>(
  page: string,
  js: string,
  timeoutMs: number,
): Promise<T> {
  const raw = await evalRaw(page, js, timeoutMs);
  if (raw === "" || raw === "null" || raw === "undefined") {
    throw new Error("脚本在页面里没有返回值（被页面拒绝执行或抛了异常）");
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`脚本返回了非 JSON：${raw.slice(0, 160)}`);
  }
}

// ── 真像素截图：browser_webview_screenshot → helix:browser-shot ─────────────────
//
// 和上面 eval 通道同一个形状（发出即返回、结果走事件、前端配对 reqId）。区别在值的
// 载体：页面里的 canvas 拍不到外部样式表和图片（见 PAGE_SCRIPT 里 doScreenshot 的注释），
// 而 WebView2 的 CapturePreview 拍的是合成后的位图 —— 工具栏那颗截图按钮要的是用户
// 眼睛看到的那张图。

/** 与 Rust `browser_webview::SHOT_EVENT` 一致。 */
const SHOT_EVENT = "helix:browser-shot";

const shotWaiters = new Map<
  string,
  (payload: { image?: string; error?: string }) => void
>();
let shotSeq = 0;
let shotListener: Promise<void> | null = null;

function ensureShotListener(): Promise<void> {
  if (!shotListener) {
    shotListener = listen<{ reqId?: string; image?: string; error?: string }>(
      SHOT_EVENT,
      (e) => {
        const reqId = e.payload?.reqId;
        if (!reqId) return;
        const settle = shotWaiters.get(reqId);
        if (!settle) return;
        shotWaiters.delete(reqId);
        settle(e.payload ?? {});
      },
    )
      .then(() => undefined)
      .catch((err) => {
        shotListener = null;
        throw err;
      });
  }
  return shotListener;
}

/** 拍当前页的真像素，成功返回 PNG data URL，失败抛错（Rust 侧每一步失败都会回 error）。 */
export async function capturePagePng(
  page: string,
  timeoutMs = OP_TIMEOUT_MS,
): Promise<string> {
  await ensureShotListener();
  const reqId = `shot-${Date.now().toString(36)}-${++shotSeq}`;
  const delivered = new Promise<{ image?: string; error?: string }>(
    (resolve, reject) => {
      shotWaiters.set(reqId, resolve);
      invoke("browser_webview_screenshot", { page, reqId }).catch((e) => {
        shotWaiters.delete(reqId);
        reject(toErr(e));
      });
    },
  );
  try {
    const r = await withTimeout(
      delivered,
      timeoutMs,
      `网页截图超时（${Math.round(timeoutMs / 1000)}s）`,
    );
    if (r.error) throw new Error(r.error);
    if (!r.image) throw new Error("截图没有返回图片");
    return r.image;
  } finally {
    shotWaiters.delete(reqId);
  }
}

interface Probe {
  url: string;
  title: string;
  ready: string;
}

async function probePage(page: string): Promise<Probe> {
  return evalInPage<Probe>(page, PROBE_EXPR, PROBE_TIMEOUT_MS);
}

function opScript(op: string, params: unknown): string {
  return `${PAGE_SCRIPT};__helixOp(${JSON.stringify(op)},${JSON.stringify(params ?? {})})`;
}

// ── 页面选择与导航等待 ───────────────────────────────────────────────────────

function requirePageId(): string {
  const id = useHelixStore.getState().browserPageId;
  if (!id) {
    throw new Error(
      "当前没有打开的浏览器页——先用 navigate 打开一个网址，或让用户在右侧栏点开网页页",
    );
  }
  return id;
}

/**
 * navigate 之后等页面真正落地。两段判据缺一不可：
 * 1. **先跳走**（URL 变了，或 readyState 回到 loading）——否则会把「还停在旧页面
 *    且 complete」当成功，这正是旧实现在 Rust 里提前 ack 造成的错：open_browser
 *    报成功、紧随其后的 read 读到上一个页面。
 * 2. 再**连续两次** complete 且 URL 不变——302 / JS 跳转链会连着换几次 URL。
 */
async function waitForNav(
  page: string,
  beforeUrl: string,
  budgetMs: number,
): Promise<Probe> {
  const deadline = Date.now() + budgetMs;
  let committed = !beforeUrl;
  let lastUrl = "";
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const p = await probePage(page).catch(() => null);
    if (!p) continue; // 窗口还在创建，或导航正忙 → 下一轮再问
    if (!committed) {
      if (p.ready !== "complete") committed = true;
      else if (p.url !== beforeUrl && p.url !== "about:blank") committed = true;
      else continue;
    }
    if (p.ready === "complete") {
      if (p.url === lastUrl) return p;
      lastUrl = p.url;
    }
  }
  const final = await probePage(page).catch(() => null);
  if (final && final.ready === "complete") return final;
  throw new Error(`导航超时（${Math.round(budgetMs / 1000)}s 内页面没有加载完）`);
}

/** 等面板真的建出网页页、并且那条窗口能应答脚本。 */
async function waitForPage(budgetMs: number): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const id = useHelixStore.getState().browserPageId;
    if (id && (await probePage(id).then(() => true).catch(() => false))) return id;
    if (Date.now() > deadline) break;
    await sleep(POLL_MS);
  }
  throw new Error("浏览器页没能打开（右侧栏被关掉或子窗口创建失败）");
}

/**
 * 让面板停在 `url` 上。URL 这个事实的唯一写入者是面板（store 的 previewRailUrl
 * → right-sidebar 的 navSeq effect → 子窗口），这里只负责等它落地并回报结果。
 * `forceOpen=true`：agent 的 navigate 明确选定要出现在用户眼前。
 */
async function doNavigate(url: string): Promise<BrowserExecResult> {
  const st = useHelixStore.getState();
  let page = st.browserPageId;
  const beforeUrl = page
    ? await probePage(page)
        .then((p) => p.url)
        .catch(() => "")
    : "";
  st.setPreviewRailUrl(url, true);
  if (!page) page = await waitForPage(PAGE_READY_TIMEOUT_MS);
  const p = await waitForNav(page, beforeUrl, NAV_TIMEOUT_MS);
  return { ok: true, url: p.url, title: p.title };
}

async function doHistory(
  op: "back" | "forward" | "refresh",
): Promise<BrowserExecResult> {
  const page = requirePageId();
  const beforeUrl = await probePage(page)
    .then((p) => p.url)
    .catch(() => "");
  // 历史与刷新直接交给 webview 自己：页面内部的 302、location.replace 都算在它的
  // 历史里，前端另记一份栈只会和它不一致。
  await invoke("browser_webview_history", {
    page,
    dir: op === "refresh" ? "reload" : op,
  });
  const p = await waitForNav(page, beforeUrl, NAV_TIMEOUT_MS);
  return { ok: true, url: p.url, title: p.title };
}

/** 截图 = 启动 + 轮询全局变量（ExecuteScript 不 await Promise）。 */
async function doScreenshot(page: string): Promise<BrowserExecResult> {
  await evalInPage<{ ok: boolean }>(
    page,
    `${PAGE_SCRIPT};__helixShotStart()`,
    OP_TIMEOUT_MS,
  );
  const deadline = Date.now() + OP_TIMEOUT_MS;
  for (;;) {
    await sleep(POLL_MS);
    // 用 {pending:true} 而不是 null 当占位：null 会和"脚本没有返回值"撞车，
    // 那样窗口中途被关掉也会一路转到超时。
    const r = await evalInPage<BrowserExecResult & { pending?: boolean }>(
      page,
      "window.__helixShot || { pending: true }",
      PROBE_TIMEOUT_MS,
    );
    if (!r.pending) return r;
    if (Date.now() > deadline) throw new Error("页面截图超时");
  }
}

/** 视觉模型转述（尽力而为）：截图 data URL → vision_describe → 文字描述。 */
async function describeImage(image: string): Promise<string | null> {
  try {
    const desc = await invoke("vision_describe", { image, prompt: null });
    return typeof desc === "string" && desc ? desc : null;
  } catch {
    return null;
  }
}

function httpish(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

async function dispatch(
  req: BrowserExecRequest,
): Promise<BrowserExecResult> {
  if (req.op === "navigate") {
    const url = httpish(req.url);
    if (!url) return { ok: false, error: "navigate 需要一个 http/https 地址" };
    return doNavigate(url);
  }
  if (req.op === "back" || req.op === "forward" || req.op === "refresh") {
    return doHistory(req.op);
  }
  const page = requirePageId();
  if (req.op === "screenshot") return doScreenshot(page);
  return evalInPage<BrowserExecResult>(
    page,
    opScript(req.op, req.params),
    OP_TIMEOUT_MS,
  );
}

/**
 * hook：把 `helix:browser-request` 逐条跑完并回写结果。串行队列——这些 op 全都
 * 打在同一个页面上，并发只会互相踩（read 还没完就 click 到旧 DOM 上）。
 */
export function useBrowserAutomation() {
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const inFlightRef = useRef<Set<string>>(new Set());

  // 界面卸载（HMR / 布局重建）时，队列里还没跑完的请求必须给个交代，否则 pi 工具
  // 干等到自己那侧超时。
  useEffect(() => {
    const inFlight = inFlightRef.current;
    return () => {
      for (const reqId of inFlight) {
        void electronApp.browserWriteResult?.(reqId, {
          ok: false,
          error: "执行环境已卸载：Helix 界面重载了，请重新发起操作",
        } satisfies BrowserExecResult);
      }
      inFlight.clear();
    };
  }, []);

  const handleRequest = useCallback((req: BrowserExecRequest) => {
    if (!req.reqId) return;
    inFlightRef.current.add(req.reqId);
    queueRef.current = queueRef.current
      .then(async () => {
        let result: BrowserExecResult;
        try {
          result = await dispatch(req);
        } catch (e) {
          result = { ok: false, error: errText(e) };
        }
        inFlightRef.current.delete(req.reqId);
        // browser_screenshot：顺手让视觉模型把图转述成文字，原图一并回传，
        // 多模态主模型可以直接看图。
        if (result.ok && result.image) {
          const desc = await describeImage(result.image);
          if (desc) result = { ...result, description: desc };
        }
        await electronApp.browserWriteResult?.(req.reqId, result);
      })
      .catch((e) => {
        inFlightRef.current.delete(req.reqId);
        console.warn("[Helix] 浏览器操作执行失败:", errText(e));
      });
  }, []);

  return { handleRequest };
}
