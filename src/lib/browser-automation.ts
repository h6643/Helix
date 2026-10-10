/**
 * Helix 内置浏览器扩展（browser_* 工具）的请求 → 驱动右侧面板里那条**真**网页视图。
 *
 * 协议：pi 会话里的 browser_* 工具（内置扩展注册——文件由 Helix 写出、经
 * spawn 参数 `--extension` 注入，不进 pi 的扩展目录）往
 * `~/.pi/agent/browser-requests/*.json` 丢一个 `{op,url,reqId,params}`，Rust 的
 * `poll_browser_requests` 把它转成 `helix:browser-request` 事件（helix.rs），
 * 这里执行完再用 `browser_write_result` 写 `<reqId>.result.json`，工具那边才解除等待。
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
import type { BrowserHandoff } from "@/stores/helix-types";

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
    | "refresh"
    | "handoff"
    | "check_login"
    | "hover"
    | "scroll"
    | "drag"
    | "wait"
    | "eval"
    | "upload"
    | "dialog";
  url?: string;
  reqId: string;
  params?: {
    selector?: string;
    ref?: string;
    text?: string;
    submit?: boolean;
    key?: string;
    /** handoff：为什么要交给人工（原样显示在侧栏横幅上）。 */
    reason?: string;
    /** handoff/check_login：登录成功的判据。缺省时只认用户点「我已完成」。 */
    urlIncludes?: string;
    /** drag 的终点。 */
    toRef?: string;
    toSelector?: string;
    /** scroll：方向 + 步长（px），或滚到某个元素。 */
    direction?: string;
    amount?: number;
    block?: string;
    /** eval：页内同步执行的 JS 源码。 */
    js?: string;
    /** wait：等待超时秒数。 */
    seconds?: number;
    /** upload：项目目录内的文件路径（字节由 Rust 读，页内赋值）。 */
    path?: string;
    /** upload：页内读到的文件字节（base64），由前端填充后注入页面。 */
    files?: Array<{ name?: string; type?: string; base64?: string }>;
    /** dialog：设定下一个 confirm/prompt 的应答策略 / 清空记录。 */
    accept?: boolean;
    clear?: boolean;
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
  modifiers?: string;
  hovered?: string;
  dragged?: string;
  uploaded?: string;
  selected?: string;
  scrolled?: { x: number; y: number; viewportHeight: number; pageHeight: number };
  /** browser_eval 的同步返回值（字符串或 JSON 串）。 */
  value?: unknown;
  /** 页面调用过的 alert/confirm/prompt（由初始化脚本记录，不再弹原生框）。 */
  dialogs?: Array<{ type?: string; message?: string; at?: number }>;
  policy?: { accept?: boolean; text?: string | null };
  /** read：可交互元素被截到上限。 */
  truncated?: boolean;
  /** browser_screenshot：真像素（CapturePreview）还是页面自绘的文字版渲染。 */
  via?: string;
  /** browser_screenshot：页面渲染快照（PNG data URL）。 */
  image?: string;
  /** 视觉模型转述（配置了视觉模型时尽力而为，供非多模态主模型阅读）。 */
  description?: string;
  /** handoff/check_login：接管回路的状态，模型据此决定继续干什么。 */
  status?: "awaiting_user" | "cleared" | "still_waiting" | "no_handoff";
  /** handoff/check_login：给人读的一句结论（比让模型自己解析布尔值更不容易跑偏）。 */
  message?: string;
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
  function isInteractive(el) {
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'a') return !!el.getAttribute && el.getAttribute('href') != null;
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'summary' || tag === 'button') return true;
    if (el.hasAttribute && el.hasAttribute('onclick')) return true;
    var role = el.getAttribute ? el.getAttribute('role') : null;
    return role === 'button' || role === 'link' || role === 'tab' || role === 'checkbox' || role === 'radio' || role === 'textbox' || role === 'combobox' || role === 'menuitem';
  }
  // DOM 遍历要穿透 shadow root 和**同源** iframe：现代组件库（材料设计下拉、
  // 富文本编辑器、嵌入式表单）都把可交互元素藏在影子里，扁平 querySelectorAll
  // 看不见它们 —— 读不到也就点不动。跨域 iframe 浏览器不允许脚本进入，只能如实
  // 标注，让模型知道「这块内容存在但取不到」。
  function collect(root, bag, frameUrl, depth, visited) {
    if (!root || depth > 3 || bag.nodes.length >= 400) return;
    if (visited.indexOf(root) >= 0) return;
    visited.push(root);
    var all;
    try {
      all = Array.prototype.slice.call(root.querySelectorAll('*'));
    } catch (e) {
      return;
    }
    all.forEach(function (el) {
      if (el.shadowRoot) collect(el.shadowRoot, bag, frameUrl, depth + 1, visited);
      if (isInteractive(el) && bag.nodes.length < 400) {
        bag.nodes.push({ el: el, frame: frameUrl });
      }
      if ((el.tagName || '') === 'IFRAME' && depth < 2) {
        var cd = null;
        try { cd = el.contentDocument; } catch (e) { cd = null; }
        if (cd && cd.body) {
          bag.frames.push({ url: (el.getAttribute('src') || 'about:blank').slice(0, 120), text: String(cd.body.innerText || '').slice(0, 4000) });
          collect(cd, bag, (el.getAttribute('src') || 'iframe').slice(0, 60), depth + 1, visited);
        } else {
          bag.frames.push({ url: (el.getAttribute('src') || '(未设置 src)').slice(0, 120), crossOrigin: true });
        }
      }
    });
  }
  function refMap() {
    if (!window.__helixRefs) window.__helixRefs = {};
    return window.__helixRefs;
  }
  function interactiveElements(selector) {
    if (selector) {
      // 显式 selector = 用户只要这一片子树，保持原样（不穿透影子，避免跑出范围）。
      var flat = [];
      Array.prototype.slice.call(document.querySelectorAll(selector)).forEach(function (el) {
        if (isVisible(el)) flat.push({ el: el, frame: 'main' });
      });
      return flat;
    }
    var bag = { nodes: [], frames: [] };
    collect(document, bag, 'main', 0, []);
    readAll.frames = bag.frames;
    return bag.nodes;
  }
  function readAll(selector) {
    var out = [];
    readAll.frames = [];
    interactiveElements(selector).forEach(function (item, i) {
      var el = item.el;
      var ref = 'e' + (i + 1);
      refMap()[ref] = el;
      try { el.setAttribute('data-helix-ref', ref); } catch (e) {}
      out.push({
        ref: ref,
        tag: (el.tagName || '').toLowerCase(),
        role: (el.getAttribute && el.getAttribute('role')) || undefined,
        label: labelOf(el) || undefined,
        text: ((el.innerText || el.textContent || '').trim().slice(0, 200)) || undefined,
        href: (el.getAttribute && el.getAttribute('href')) || undefined,
        type: (el.getAttribute && el.getAttribute('type')) || undefined,
        frame: item.frame === 'main' ? undefined : item.frame
      });
    });
    var bodyText = ((document.body && document.body.innerText) || '')
      .trim()
      .replace(/\\n{3,}/g, '\\n\\n');
    var text = bodyText.slice(0, 12000);
    // 同源 iframe 的正文并进同一个 text：模型读的是「这一页上有什么」，不该为
    // 浏览器的帧边界付一次工具调用。跨域的只能列出来。
    (readAll.frames || []).forEach(function (f) {
      if (f.crossOrigin) {
        text += '\\n\\n[跨域 iframe，脚本读不到内容: ' + f.url + ']';
        return;
      }
      var t = String(f.text || '').trim();
      if (t) text += '\\n\\n[iframe ' + f.url + ']\\n' + t.slice(0, 3000);
    });
    var dialogs = (window.__helixDialogs || []).slice(-3);
    return {
      text: text,
      elements: out,
      truncated: out.length >= 400 || undefined,
      dialogs: dialogs.length ? dialogs : undefined,
    };
  }
  function describe(target) {
    return target && (target.ref || target.selector)
      ? ': ' + (target.ref || target.selector) : '';
  }
  function findByRefOrSelector(params) {
    if (params && params.ref) {
      // 引用表存在页面全局里，所以影子 DOM / iframe 里的元素也认得；老路径
      // （data-helix-ref）留作 Light DOM 兜底，节点已脱离文档则不算命中。
      var mapped = window.__helixRefs && window.__helixRefs[params.ref];
      if (mapped && mapped.isConnected !== false) return mapped;
      var byRef = document.querySelector('[data-helix-ref="' + params.ref + '"]');
      if (byRef) return byRef;
    }
    if (params && params.selector) {
      try { return document.querySelector(params.selector); } catch (e) { return null; }
    }
    return null;
  }
  function centerOf(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }
  // 合成鼠标/指针事件序列。isTrusted 为 false，个别只认真实输入的站点会忽略。
  function fireMouse(el, types, pt) {
    types.forEach(function (type) {
      var base = {
        bubbles: true, cancelable: true, view: window, button: 0,
        clientX: pt ? pt.x : 0, clientY: pt ? pt.y : 0,
      };
      try {
        if (/^pointer/.test(type)) {
          el.dispatchEvent(new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, base)));
        } else {
          el.dispatchEvent(new MouseEvent(type, base));
        }
      } catch (e) {}
    });
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
    var text = params && params.text != null ? String(params.text) : '';
    el.scrollIntoView({ block: 'center' });
    var tag = (el.tagName || '').toLowerCase();
    // <select>：value 可能给的是选项文本（模型照着 read 的 label 填），两种都认。
    if (tag === 'select') {
      try { el.focus(); } catch (e) {}
      el.value = text;
      if (el.value !== text) {
        var opts = Array.prototype.slice.call(el.options || []);
        var hit = opts.filter(function (o) {
          return (o.text || '').trim() === text.trim() || o.value === text;
        })[0];
        if (!hit) return { ok: false, error: '下拉里没有这个选项：' + text + '（可选值：' + opts.map(function(o){ return o.text || o.value; }).join(' / ').slice(0, 300) + '）' };
        el.value = hit.value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, typed: text.slice(0, 120), selected: el.value };
    }
    // contenteditable（富文本框、评论编辑器）：execCommand 走的是编辑器自己的
    // beforeinput 路径，React/ProseMirror 之类才看得见这次改动；直接写 textContent
    // 它们会当没发生（提交时内容还是空的）。所以先试 execCommand，再退回文本赋值。
    if (el.isContentEditable) {
      try { el.focus(); } catch (e) {}
      try {
        document.execCommand('selectAll', false, undefined);
        var done = document.execCommand('insertText', false, text);
        if (!done) throw new Error('execCommand 不可用');
      } catch (e) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      if (params && params.submit) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true, cancelable: true }));
        return { ok: true, typed: text.slice(0, 120), navigated: 'enter' };
      }
      return { ok: true, typed: text.slice(0, 120) };
    }
    el.focus();
    // 原生 value setter 绕过 React 的值追踪，页面自己的监听器才看得见这次改动。
    var proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (params && params.submit) {
      if (el.form && typeof el.form.requestSubmit === 'function') {
        try {
          el.form.requestSubmit();
          return { ok: true, typed: text.slice(0, 120), navigated: 'form-submit' };
        } catch (e) {}
      }
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true }));
      return { ok: true, typed: text.slice(0, 120), navigated: 'enter' };
    }
    return { ok: true, typed: text.slice(0, 120) };
  }
  function parseCombo(raw) {
    var parts = String(raw || 'Enter').split('+');
    var key = parts.pop() || 'Enter';
    var mods = parts.join('+').toLowerCase();
    var k = key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1);
    return {
      key: k,
      code: k.length === 1 ? 'Key' + k.toUpperCase() : k,
      ctrlKey: /ctrl|control/.test(mods),
      altKey: /alt/.test(mods),
      shiftKey: /shift/.test(mods),
      metaKey: /meta|cmd|command|win/.test(mods),
    };
  }
  function doPress(params) {
    var init = parseCombo(params && params.key);
    var el = document.activeElement || document.body;
    // keydown 之后必须补 keyup：很多监听器成对判（按下-松开才算一次），只发
    // keydown 的按键会被它们当成"还按着"，下一次 op 才生效或者永远不生效。
    ['keydown', 'keyup'].forEach(function (type) {
      var ev;
      try {
        ev = new KeyboardEvent(type, Object.assign({ bubbles: true, cancelable: true }, init));
      } catch (e) {
        ev = document.createEvent('KeyboardEvent');
        ev.initKeyboardEvent(type, true, true, null, init.key, 0, '', '', '', '');
      }
      el.dispatchEvent(ev);
    });
    return { ok: true, pressed: init.key, modifiers: [init.ctrlKey && 'ctrl', init.altKey && 'alt', init.shiftKey && 'shift', init.metaKey && 'meta'].filter(Boolean).join('+') || undefined };
  }
  function doHover(params) {
    var el = findByRefOrSelector(params);
    if (!el) return { ok: false, error: '找不到目标元素（可能已经变了，重新 read 一次再悬停）' + describe(params) };
    el.scrollIntoView({ block: 'center' });
    var pt = centerOf(el);
    fireMouse(el, ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'], pt);
    return { ok: true, hovered: (labelOf(el) || (el.tagName || '').toLowerCase()).slice(0, 200) };
  }
  function doScroll(params) {
    var p = params || {};
    var target = findByRefOrSelector(p);
    if (target) {
      target.scrollIntoView({ block: p.block === 'start' ? 'start' : p.block === 'end' ? 'end' : 'center' });
    } else {
      var dir = String(p.direction || 'down').toLowerCase();
      var vh = window.innerHeight || 800;
      var amount = Number(p.amount) > 0 ? Number(p.amount) : Math.round(vh * 0.8);
      if (dir === 'top') window.scrollTo(0, 0);
      else if (dir === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
      else if (dir === 'up') window.scrollBy(-0, -amount);
      else if (dir === 'left') window.scrollBy(-amount, 0);
      else if (dir === 'right') window.scrollBy(amount, 0);
      else window.scrollBy(0, amount);
    }
    var docEl = document.documentElement;
    return {
      ok: true,
      scrolled: {
        x: Math.round(window.scrollX || window.pageXOffset || 0),
        y: Math.round(window.scrollY || window.pageYOffset || 0),
        viewportHeight: Math.round(window.innerHeight || 0),
        pageHeight: docEl.scrollHeight,
      },
    };
  }
  function doDrag(params) {
    var p = params || {};
    var from = findByRefOrSelector(p);
    var to = (p.toRef || p.toSelector)
      ? findByRefOrSelector({ ref: p.toRef, selector: p.toSelector })
      : null;
    if (!from) return { ok: false, error: '找不到拖拽起点（重新 read 一次再试）' + describe(p) };
    if (!to) return { ok: false, error: '找不到拖拽终点 toRef/toSelector（重新 read 一次再试）' };
    from.scrollIntoView({ block: 'center' });
    to.scrollIntoView({ block: 'center' });
    var a = centerOf(from), b = centerOf(to);
    var dt = null;
    try { dt = new DataTransfer(); } catch (e) {}
    fireMouse(from, ['pointerdown', 'mousedown'], a);
    if (dt) {
      try {
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: b.x, clientY: b.y }));
        to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: b.x, clientY: b.y }));
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      } catch (e) {}
    }
    fireMouse(from, ['mousemove', 'mouseup'], b);
    return {
      ok: true,
      dragged: ((labelOf(from) || from.tagName) + ' → ' + (labelOf(to) || to.tagName)).slice(0, 200),
      note: '合成事件（isTrusted=false）：HTML5 拖放与常见指针库能走通，只认真实输入的控件可能无效，用 read/截图确认结果。',
    };
  }
  // ExecuteScript 不 await Promise，也不回报异常 → 异步结果一律拒绝并给出改法。
  // 这里是**故意**的任意 JS 执行，但它被关在页面自己的 origin 里：capabilities 只
  // 信任 main 窗口（见 browser_webview.rs），所以脚本碰不到任何 Tauri IPC；能做的
  // 就是这个人正在看的网页里的事。站点 CSP 拒绝 new Function 时报错，不静默。
  function doEval(params) {
    var code = String((params && params.js) || '');
    if (!code.trim()) return { ok: false, error: 'browser_eval 需要 js' };
    var out;
    try {
      out = (new Function(code)).call(window);
    } catch (e) {
      return { ok: false, error: '脚本抛错（也可能是站点 CSP 禁止 new Function）：' + String((e && e.message) || e) };
    }
    if (out && typeof out.then === 'function') {
      return { ok: false, error: '脚本返回了 Promise，但页面注入不 await：改成同步取值，或者先把结果写进一个全局变量（window.__x = …），再用 browser_eval 读那个变量' };
    }
    var v;
    try { v = typeof out === 'string' ? out : JSON.stringify(out); } catch (e) { v = String(out); }
    return { ok: true, value: v === undefined ? null : String(v === undefined ? '' : v).slice(0, 20000), url: location.href };
  }
  // 页内赋 File：Chromium 允许 new DataTransfer() + 构造 File，赋给 input.files
  // 后派发 change，多数上传组件就能走通（比 CDP 那套轻，代价是 isTrusted=false）。
  function doUpload(params) {
    var el = findByRefOrSelector(params);
    if (!el) return { ok: false, error: '找不到目标 input（重新 read 一次再试）' + describe(params) };
    if ((el.tagName || '').toLowerCase() !== 'input' || (el.getAttribute('type') || '').toLowerCase() !== 'file') {
      return { ok: false, error: 'browser_upload 只能打在 <input type="file"> 上' };
    }
    var files = (params && params.files) || [];
    if (!files.length) return { ok: false, error: '没有可写入的文件内容' };
    try {
      var dt = new DataTransfer();
      files.forEach(function (f) {
        var bin = atob(String(f.base64 || ''));
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        dt.items.add(new File([arr], String(f.name || 'file'), { type: String(f.type || 'application/octet-stream') }));
      });
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, uploaded: files.map(function (f) { return f.name; }).join(', ').slice(0, 300) };
    } catch (e) {
      return { ok: false, error: '写入文件失败：' + String((e && e.message) || e) };
    }
  }
  // 原生 alert/confirm/prompt 由初始化脚本改成了「记录 + 立即返回」，见 Rust 的
  // DIALOG_SHIM_SCRIPT：真弹窗会占住页面的脚本线程，之后每条注入都要等到超时。
  function doDialog(params) {
    var p = params || {};
    if (window.__helixDialogs) {
      if (p.clear) window.__helixDialogs = [];
      if (p.accept !== undefined || p.text !== undefined) {
        window.__helixDialogPolicy = {
          accept: p.accept === true || p.accept === 'true',
          text: p.text == null ? null : String(p.text),
        };
      }
    }
    return {
      ok: true,
      dialogs: (window.__helixDialogs || []).slice(-5),
      policy: window.__helixDialogPolicy || { accept: false, text: null },
    };
  }

  // 登录判据探针：只读，不动引用表 —— 接管期间不该往人类正在用的页面上打标记。
  function doLoginProbe(params) {
    var sel = (params && params.selector) || '';
    var needle = (params && params.urlIncludes) || '';
    var found = false;
    if (sel) { try { found = !!document.querySelector(sel); } catch (e) { found = false; } }
    return {
      ok: true,
      url: location.href,
      title: document.title || '',
      found: found,
      urlMatched: !!needle && location.href.indexOf(needle) >= 0
    };
  }

  // canvas.toDataURL 在大页面上可能抛 SecurityError。这类失败必须变成 ok:false 的
  // 结果而不是一枚异常 —— __helixOp 有 try/catch，异步链没有，让 Promise reject 会
  // 一路漏到 window.__helixShot 之外，前端只能干等到超时。
  function toDataUrl(canvas) {
    try { return canvas.toDataURL('image/png'); } catch (e) {
      throw new Error('页面向量过大或被安全策略拦截，无法导出图片：' + String((e && e.message) || e));
    }
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
            resolve({ ok: true, url: location.href, title: document.title || '', image: toDataUrl(c) });
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
        var out = { ok: true, url: location.href, title: document.title || '', text: r.text, elements: r.elements };
        // 这两项是 readAll 附带的能力证明：truncated 说明 400 条上限碰到了，
        // dialogs 让人类页面弹过的 alert/confirm 不用另调一次 browser_dialog 才看见。
        if (r.truncated) out.truncated = r.truncated;
        if (r.dialogs) out.dialogs = r.dialogs;
        return out;
      }
      if (op === 'click') return doClick(params);
      if (op === 'type') return doType(params);
      if (op === 'press') return doPress(params);
      if (op === 'hover') return doHover(params);
      if (op === 'scroll') return doScroll(params);
      if (op === 'drag') return doDrag(params);
      if (op === 'eval') return doEval(params);
      if (op === 'upload') return doUpload(params);
      if (op === 'dialog') return doDialog(params);
      if (op === 'loginprobe') return doLoginProbe(params);
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

/**
 * 「这页交给人了」的兜底时长。到期自动解锁 —— 用户走开了、忘了点「我已完成」，
 * 侧栏不该被永久锁死，模型也不该永远拿不到写权限。
 */
const HANDOFF_TTL_MS = 10 * 60_000;

/**
 * 接管期间要挡住的写操作。人类正在那张页面上打字/拖验证码，agent 一次 navigate
 * 或一次 click 就把他的表单冲掉了；只读的 read/screenshot 不动 DOM，照常放行，
 * 所以 agent 并没有瞎掉 —— 它只是不能踩。
 */
const HANDOFF_BLOCKED_OPS = new Set<BrowserExecRequest["op"]>([
  "navigate",
  "click",
  "type",
  "press",
  "back",
  "forward",
  "refresh",
  // 会改动页面或抢走人类视野/焦点的那一类：滚动会挪走他正在填的表单，hover 会
  // 弹掉他点开的菜单，eval 什么都能干，upload/drag 直接动控件。
  "hover",
  "scroll",
  "drag",
  "eval",
  "upload",
]);

let handoffExpiry: ReturnType<typeof setTimeout> | null = null;

function clearHandoff(): void {
  if (handoffExpiry) {
    clearTimeout(handoffExpiry);
    handoffExpiry = null;
  }
  useHelixStore.getState().setBrowserHandoff(null);
}

/**
 * 当前页是否正处于人工接管中。
 * 按 pageId 精确匹配：接管那条页被切走/关掉之后，锁就自然失效（继续锁另一条页
 * 毫无道理）。顺带在这里做 TTL 兜底，这样即使定时器没跑到也不会留下僵尸锁。
 */
function handoffOnCurrentPage(): BrowserHandoff | null {
  const st = useHelixStore.getState();
  const h = st.browserHandoff;
  if (!h) return null;
  if (Date.now() - h.since >= HANDOFF_TTL_MS) {
    clearHandoff();
    return null;
  }
  return h.pageId === st.browserPageId ? h : null;
}

/**
 * 把页面交给人：登记接管态 + 锁写操作 + 抢焦点，然后**立刻**回 ack。
 * 非阻塞是这条路径的全部意义 —— 不等用户，模型拿到 ack 就该去干别的活。
 */
async function doHandoff(
  params: BrowserExecRequest["params"],
): Promise<BrowserExecResult> {
  const page = requirePageId();
  const reason = (params?.reason ?? "").trim() || "需要人工验证（登录/验证码）";
  const selector = (params?.selector ?? "").trim();
  const urlIncludes = (params?.urlIncludes ?? "").trim();
  const expect =
    selector || urlIncludes
      ? {
          ...(selector ? { selector } : {}),
          ...(urlIncludes ? { urlIncludes } : {}),
        }
      : undefined;

  useHelixStore.getState().setBrowserHandoff({
    pageId: page,
    reason,
    expect,
    since: Date.now(),
  });
  if (handoffExpiry) clearTimeout(handoffExpiry);
  handoffExpiry = setTimeout(clearHandoff, HANDOFF_TTL_MS);
  // 把侧栏切到这条网页页，人才看得见横幅。刻意不碰 previewRailUrl：那会递增
  // navSeq，子窗口收到 open 就重新导航一次，把用户填了一半的表单冲掉。
  useHelixStore.getState().setRightSidebarTab("browser");

  // 焦点抢不到不算失败：横幅已经在那儿了，用户看得见。
  await invoke("browser_webview_focus", { page }).catch(() => null);
  const p = await probePage(page).catch(() => null);
  return {
    ok: true,
    status: "awaiting_user",
    url: p?.url,
    title: p?.title,
    message: expect
      ? `已把页面交给人工（原因：${reason}），该页的写操作已锁定，只读工具不受影响。现在先去做不依赖这个页面的工作，之后再调 browser_check_login（判据已登记：${expect.selector ?? expect.urlIncludes}）确认。`
      : `已把页面交给人工（原因：${reason}），该页的写操作已锁定，只读工具不受影响。现在先去做不依赖这个页面的工作；用户点侧栏的「我已完成」或验证页自己跳出登录墙之后，用 browser_read 确认。`,
  };
}

/**
 * 问页面「验证过了没」：命中判据就顺手解锁。
 * 判据缺省回退到 handoff 时登记的那份 —— 模型传参时常忘，回退比报参数缺失有用。
 */
async function doCheckLogin(
  params: BrowserExecRequest["params"],
): Promise<BrowserExecResult> {
  const page = requirePageId();
  const active = handoffOnCurrentPage();
  const fallback = active?.expect;
  const selector = (params?.selector ?? "").trim() || fallback?.selector || "";
  const urlIncludes =
    (params?.urlIncludes ?? "").trim() || fallback?.urlIncludes || "";
  if (!selector && !urlIncludes) {
    return {
      ok: false,
      error:
        "browser_check_login 需要一个判据（selector=登录后的标志元素，或 urlIncludes=离开登录页的 URL 片段）；没有判据时请让用户点侧栏的「我已完成」解锁",
    };
  }
  const r = await evalInPage<{
    url?: string;
    title?: string;
    found?: boolean;
    urlMatched?: boolean;
  }>(
    page,
    opScript("loginprobe", { selector, urlIncludes }),
    OP_TIMEOUT_MS,
  );
  const matched = (selector && r.found) || (urlIncludes && r.urlMatched);
  if (matched) {
    if (active) clearHandoff();
    return {
      ok: true,
      status: "cleared",
      url: r.url,
      title: r.title,
      message: "验证已通过，人工接管解除，可以正常操作该页了。",
    };
  }
  return {
    ok: true,
    status: active ? "still_waiting" : "no_handoff",
    url: r.url,
    title: r.title,
    message: active
      ? "还没通过验证（判据未命中）。页面仍在人工接管中，写操作会继续被拒；先去做别的工作，过一会儿再 check 一次。"
      : `判据未命中（当前没有人工接管，写操作不受限）。页面地址：${r.url ?? ""}`,
  };
}

/**
 * 等页面上出现某段文本或某个元素。
 * 「等」只能在前端做：ExecuteScript 不 await Promise，让页面自己写轮询脚本会占住
 * 它的脚本线程。这里用一条不碰引用表的小探针反复问，命中即回。
 */
async function doWait(
  params: BrowserExecRequest["params"],
): Promise<BrowserExecResult> {
  const page = requirePageId();
  const text = (params?.text ?? "").trim();
  const selector = (params?.selector ?? "").trim();
  if (!text && !selector) {
    return { ok: false, error: "browser_wait 需要 text 或 selector 之一" };
  }
  const seconds = Math.min(25, Math.max(1, Number(params?.seconds ?? 8) || 8));
  const needle = text || selector;
  const expr =
    `(function(){var t=${JSON.stringify(text)},s=${JSON.stringify(selector)};` +
    "var found=false;" +
    "try{found=s?!!document.querySelector(s):!!(document.body&&(document.body.innerText||'').indexOf(t)>=0);}catch(e){}" +
    "return ({found:found,url:location.href,title:document.title||''});})()";
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const r = await evalInPage<{
      found?: boolean;
      url?: string;
      title?: string;
    }>(page, expr, PROBE_TIMEOUT_MS).catch(() => null);
    if (r?.found) {
      return {
        ok: true,
        url: r.url,
        title: r.title,
        message: `已出现：${needle}`,
      };
    }
    if (Date.now() > deadline) {
      const p = await probePage(page).catch(() => null);
      return {
        ok: false,
        error: `等待超时（${seconds}s 内没出现「${needle}」）。当前地址：${p?.url ?? ""}｜标题：${p?.title ?? ""}`,
        url: p?.url,
        title: p?.title,
      };
    }
    await sleep(POLL_MS);
  }
}

/**
 * 把项目目录内的一个文件塞进 `<input type=file>`。
 * 字节由 Rust 读（`browser_read_upload_file` 负责边界与体积），base64 随注入脚本
 * 进页面，页内用 DataTransfer + File 赋值 —— WebView2 没有 CDP 那套
 * `DOM.setFileInputFiles`，这是不引调试协议能走通的最远一步。
 */
async function doUpload(
  params: BrowserExecRequest["params"],
): Promise<BrowserExecResult> {
  const page = requirePageId();
  const path = (params?.path ?? "").trim();
  if (!path) {
    return { ok: false, error: "browser_upload 需要 path（项目目录内的文件路径）" };
  }
  const st = useHelixStore.getState();
  const workDir = st.activeSessionWorkDir ?? st.selectedWorkDir ?? "";
  if (workDir.startsWith("remote://")) {
    return {
      ok: false,
      error: "远程工作区下不能上传本地文件（文件边界按本地项目目录判定）",
    };
  }
  let file: { name?: string; type?: string; base64?: string };
  try {
    file = await invoke<{ name?: string; type?: string; base64?: string }>(
      "browser_read_upload_file",
      { path, workDir },
    );
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  return evalInPage<BrowserExecResult>(
    page,
    opScript("upload", { ...params, files: [file] }),
    OP_TIMEOUT_MS,
  );
}

/** 截图 = 启动 + 轮询全局变量（ExecuteScript 不 await Promise）。 */
async function inPageScreenshot(page: string): Promise<BrowserExecResult> {
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

/**
 * 截图：先拍真像素（WebView2 CapturePreview，和用户眼睛看到的一致，样式与图片都
 * 在），失败才退回页面自绘的 SVG→canvas 版本（拍不到外部样式表，是「无排版的文字
 * 版渲染」）。窗口被浮层遮住或正在导航时 CapturePreview 会失败，这时候有内容比
 * 没有强 —— `via` 如实标出是哪一种，模型据此决定要不要重拍。
 */
async function doScreenshot(page: string): Promise<BrowserExecResult> {
  try {
    const image = await capturePagePng(page);
    const p = await probePage(page).catch(() => null);
    return { ok: true, image, url: p?.url, title: p?.title, via: "capturePreview" };
  } catch {
    const r = await inPageScreenshot(page);
    return { ...r, via: "dom" };
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
  if (req.op === "handoff") return doHandoff(req.params);
  if (req.op === "check_login") return doCheckLogin(req.params);
  // 只读探针，接管期间也放行（模型靠它看进展）。
  if (req.op === "wait") return doWait(req.params);
  // 人工接管优先于一切写操作：先挡下来，别让队列里的脚本落在人类手底下的页面上。
  if (HANDOFF_BLOCKED_OPS.has(req.op)) {
    const blocked = handoffOnCurrentPage();
    if (blocked) {
      return {
        ok: false,
        error: `用户正在侧栏手动操作这个页面（原因：${blocked.reason}），完成前不要改动它。只读的 browser_read / browser_screenshot / browser_wait 仍然可用；要确认进展就用它们，或等用户点「我已完成」/ 用 browser_check_login 验证。`,
      };
    }
  }
  if (req.op === "upload") return doUpload(req.params);
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
