/**
 * helix-browser — Helix 内置扩展：让 pi 模型能驱动 Helix 侧边栏的嵌入浏览器。
 *
 * 这不是 pi 插件：本文件由 Helix 启动时按内容安装到
 * `~/.pi/agent/helix-internal/browser-extension.js`（刻意放在 pi 扩展扫描
 * 目录 `extensions/` 之外），仅通过 Pi 网关 spawn 时附加的
 * `pi --extension <path>` 加载——终端里的 `pi` 看不到这些工具，只有
 * Helix 会话有。本文件（vendor 副本）是唯一权威，安装产物每次启动按内容
 * 差量刷新；不要直接在安装位编辑。
 *
 * 工作原理（请求-响应协议）：
 *   1. 工具写请求文件 `<reqId>.json` = { op, url, reqId, ts, params }
 *   2. Helix 前端 Tauri 轮询该目录 → Rust emit `helix:browser-request`
 *   3. 前端在右侧栏那条**真**浏览器窗口上执行（src-tauri/src/browser_webview.rs：
 *      navigate/历史走 webview，read/click/type/press 注入脚本读写实时 DOM）
 *   4. 前端调 Rust `browser_write_result` 写 `<reqId>.result.json`
 *   5. 本扩展轮询等结果文件 → 删除 → 把结果返回给模型
 *
 * 注意：所有 op 都打在用户正看着的同一条页面上，SPA 渲染出来的内容读得到。
 * 唯一的例外是「选取元素加入聊天」（侧栏自己的功能），它仍走静态快照。
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const REQ_DIR = join(homedir(), ".pi", "agent", "browser-requests");
const MAX_KEEP = 50;
/** 最长等待前端执行并回写结果的时间（read 可能要 page_fetch + 注入）。 */
const RESULT_TIMEOUT_MS = 60_000;
const RESULT_POLL_MS = 120;
/** 请求文件的 TTL：超过这个年龄的未消费请求说明 Helix 在前端不可用时
 *  留下了垃圾（它的轮询器只消费 *新鲜的* 请求），读之前清理掉，避免模型
 *  对着死请求空等整个超时。 */
const STALE_AFTER_MS = 5 * 60_000;

function ensureDir() {
  mkdirSync(REQ_DIR, { recursive: true });
}

function pruneOld() {
  try {
    const files = readdirSync(REQ_DIR)
      .filter((f) => f.endsWith(".json") && f !== "latest.json")
      .sort();
    while (files.length > MAX_KEEP) {
      const old = files.shift();
      if (old) unlinkSync(join(REQ_DIR, old));
    }
  } catch {
    /* best-effort */
  }
}

/** 删除"过期未消费"的请求文件（其 reqId 前缀就是写入时的 Date.now()）。
 *  返回被删除的文件名，供新请求发起前调用。 */
function dropStale() {
  const dropped = [];
  try {
    const now = Date.now();
    for (const f of readdirSync(REQ_DIR)) {
      if (!f.endsWith(".json") || f === "latest.json") continue;
      const m = f.match(/^(\d+)-/);
      if (!m) continue;
      if (now - Number(m[1]) <= STALE_AFTER_MS) continue;
      try {
        unlinkSync(join(REQ_DIR, f));
        dropped.push(f);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
  return dropped;
}

/** 发一个请求并等待前端执行结果（轮询 <reqId>.result.json）。 */
async function request(op, opts = {}) {
  const url = (opts.url ?? "").trim();
  if (op === "navigate" && (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return { ok: false, error: `navigate 的 url 必须是有效的 http(s) URL，收到: "${url}"` };
  }
  ensureDir();
  pruneOld();
  // 清掉残留的过期请求（上一次 Helix 没在线时留下的），避免误导模型
  // 以为有未完成的浏览器会话。
  dropStale();
  const reqId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  writeFileSync(
    join(REQ_DIR, `${reqId}.json`),
    JSON.stringify({ op, url: url || undefined, reqId, ts: Date.now(), params: opts.params ?? {} }),
    "utf-8",
  );
  // 轮询结果文件（前端 Rust 命令 browser_write_result 写入）。
  const resultPath = join(REQ_DIR, `${reqId}.result.json`);
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RESULT_POLL_MS));
    if (!existsSync(resultPath)) continue;
    try {
      const raw = readFileSync(resultPath, "utf-8");
      const parsed = JSON.parse(raw);
      return parsed?.result ?? parsed;
    } finally {
      try { unlinkSync(resultPath); } catch { /* already gone */ }
    }
  }
  return { ok: false, error: `浏览器请求超时（${op}）：Helix 前端 ${RESULT_TIMEOUT_MS / 1000}s 内未回写结果——Helix 可能没有运行（或前端未轮询请求队列），重试无用，请改用其他工具（如 web_search / 直接读文件）完成任务` };
}

/** 工具描述前缀：说明执行环境与限制，模型据此决定用法。 */
const SNAPNOTE =
  "在 Helix 右侧栏那条真实浏览器窗口（WebView2，用户正看着它）上执行操作，走请求-响应文件协议。\n" +
  "前提：当前必须有一条已打开的浏览器页面（先 open_browser / browser_navigate）；" +
  "没有打开页面时 read/click/type 会直接报错。\n" +
  "read/click/type/press 注入脚本读写那条页的**实时 DOM**（SPA 渲染出来的内容读得到），" +
  "navigate/back/forward/refresh 直接作用于同一条窗口。每次导航会重新打一遍元素引用表。\n" +
  "撞登录墙/验证码时：用 browser_handoff 把页面交给人工（那条页的写操作会锁，只读工具照常），" +
  "然后继续做不依赖该页的工作，不要原地等。";

function registerTool(pi, tool) {
  pi.registerTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: { type: "object", properties: tool.params, required: tool.required ?? [] },
    async execute(_id, params) {
      try {
        const result = await tool.run(params ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result).slice(0, 60000) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `浏览器操作失败: ${e?.message ?? e}` }] };
      }
    },
  });
}

export default function register(pi) {
  registerTool(pi, {
    name: "open_browser",
    label: "Open Browser",
    description:
      "在 Helix 侧边栏的嵌入浏览器中打开一个 URL（真实 webview 导航）。" +
      "当用户要求查看网页、展示外部内容时使用。",
    params: { url: { type: "string", description: "完整 URL（http/https）" } },
    required: ["url"],
    run: (p) => request("navigate", { url: String(p?.url ?? "") }),
  });

  registerTool(pi, {
    name: "browser_read",
    label: "Browser Read",
    description:
      SNAPNOTE +
      "\n读取当前页面的标题、URL、可见文本摘要与可交互元素（链接/按钮/输入框）的清单。" +
      "遍历会穿透 shadow DOM 和**同源** iframe（组件库藏在影子里的控件也列得出来，元素的 " +
      "`frame` 字段标出它在哪一帧；跨域 iframe 只会以「读不到」标注）。" +
      "返回的元素带 ref 序号（如 e12），可直接用于 browser_click / browser_type / browser_hover / browser_drag 定位；" +
      "ref 认的是页面全局的引用表，跨请求有效，但 navigate、页面重渲染、或另一次 read" +
      "（会按新的 DOM 顺序重编号）都可能让它指错东西 —— 拿不准就再 read 一次，或改用稳定 selector。" +
      "元素超过约 400 个时 `truncated:true`，用 selector 参数缩小范围。" +
      "页面调用过 alert/confirm/prompt 的话会在 `dialogs` 里带最近几条（Helix 不弹原生框）。",
    params: {
      selector: {
        type: "string",
        description: "可选：只返回匹配 CSS 选择器的元素（缺省=全页可交互元素）",
      },
    },
    run: (p) =>
      request("read", {
        params: p?.selector ? { selector: String(p.selector) } : {},
      }),
  });

  registerTool(pi, {
    name: "browser_click",
    label: "Browser Click",
    description:
      SNAPNOTE +
      "\n点击页面上的元素。定位优先级：selector（跨请求稳定，推荐）> ref（由上一次 browser_read 打在那条实时 DOM 上）。" +
      "ref 不需要紧跟着 read 就用 —— 但 navigate、页面重渲染或另一次 read 之后编号可能已经指到别的东西上，" +
      "所以点完要 read/截图确认，定位不到就重新 read。" +
      "点击链接/提交按钮会触发导航——导航后的新页面需再 browser_read 确认。",
    params: {
      ref: {
        type: "string",
        description:
          "上一次 browser_read 返回的元素 ref（如 e12）；中间没有 navigate/另一次 read 时仍然有效",
      },
      selector: {
        type: "string",
        description: "首选：稳定 CSS 选择器（ref 缺省/失效时用），跨请求可靠",
      },
    },
    run: (p) =>
      request("click", {
        params: {
          ref: p?.ref ? String(p.ref) : undefined,
          selector: p?.selector ? String(p.selector) : undefined,
        },
      }),
  });

  registerTool(pi, {
    name: "browser_type",
    label: "Browser Type",
    description:
      SNAPNOTE +
      "\n向输入框填入文本（input / textarea / contenteditable 富文本框 / `<select>` 都能填：" +
      "富文本走 insertText 所以编辑器自己的监听器看得见；下拉可以直接给选项文本，给错会列出可选值）。" +
      "定位同 browser_click：优先稳定 selector，ref 在没被导航/另一次 read 打乱前也有效。" +
      "submit=true 时填完回车提交（触发导航，新页面需再 read 确认）。",
    params: {
      ref: {
        type: "string",
        description:
          "上一次 browser_read 返回的输入框 ref；中间没有 navigate/另一次 read 时仍然有效",
      },
      selector: {
        type: "string",
        description: "首选：稳定 CSS 选择器（如 input[name=q] / #q），跨请求可靠",
      },
      text: { type: "string", description: "要输入的文本" },
      submit: { type: "boolean", description: "填完后按 Enter 提交（默认 false）" },
    },
    required: ["text"],
    run: (p) =>
      request("type", {
        params: {
          ref: p?.ref ? String(p.ref) : undefined,
          selector: p?.selector ? String(p.selector) : undefined,
          text: String(p?.text ?? ""),
          submit: p?.submit === true || p?.submit === "true",
        },
      }),
  });

  registerTool(pi, {
    name: "browser_press",
    label: "Browser Press",
    description: SNAPNOTE + "\n对当前焦点元素按一个键或组合键（Enter / Escape / Tab，或 Ctrl+A、Shift+Tab、Ctrl+Shift+P 这类写法）。会成对派发 keydown+keyup。",
    params: { key: { type: "string", description: "键名，如 Enter / Escape / Tab" } },
    required: ["key"],
    run: (p) => request("press", { params: { key: String(p?.key ?? "Enter") } }),
  });

  registerTool(pi, {
    name: "browser_navigate",
    label: "Browser Navigate",
    description:
      "在 Helix 侧边栏嵌入浏览器的当前页导航到新 URL（真实 webview）。与 open_browser 等价，保留两者以兼容旧调用。",
    params: { url: { type: "string", description: "完整 URL（http/https）" } },
    required: ["url"],
    run: (p) => request("navigate", { url: String(p?.url ?? "") }),
  });

  registerTool(pi, {
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      SNAPNOTE +
      "\n截取当前页面的渲染快照（PNG，base64）。适合需要\"看\"页面布局、视觉元素、" +
      "或确认渲染结果时使用；返回的 image 会尽量经视觉模型转述为文字 description" +
      "（配置了视觉模型时），主模型据此理解页面外观。",
    params: {},
    run: () => request("screenshot", {}),
  });

  registerTool(pi, {
    name: "browser_history",
    label: "Browser History",
    description: SNAPNOTE + "\n控制当前页导航历史：back（后退）/ forward（前进）/ refresh（刷新，作用于真实 webview）。",
    params: { action: { type: "string", description: "back | forward | refresh" } },
    required: ["action"],
    run: (p) => {
      const a = String(p?.action ?? "").toLowerCase();
      if (a !== "back" && a !== "forward" && a !== "refresh") {
        return Promise.resolve({ ok: false, error: `action 必须是 back/forward/refresh，收到: "${a}"` });
      }
      return request(a);
    },
  });

  registerTool(pi, {
    name: "browser_handoff",
    label: "交给人工验证",
    description:
      "把当前页面交给人来完成登录/验证码/扫码/人工授权。\n" +
      "效果：右侧栏那条网页页会挂出「人工验证中 · 原因」横幅并把键盘焦点交给它，同时**锁住该页的写操作**" +
      "（navigate/click/type/press/hover/scroll/drag/eval/upload/back/forward/refresh 一律被拒绝，返回里会说明原因）；" +
      "browser_read / browser_screenshot / browser_wait 这类只读的仍然可用，你能看见进展。\n" +
      "⚠ 这个工具**不等用户**：它立刻返回。拿到返回后必须继续做不依赖这个页面的工作" +
      "（读代码、改文件、查别的站点、推进别的步骤），过一会儿再用 browser_check_login 回来看 —— " +
      "在这里停下来干等，就等于把整个任务卡死了。\n" +
      "可选登记判据（selector 或 urlIncludes），之后 browser_check_login 会自动用它。" +
      "用户点横幅上的「我已完成」会直接解锁；10 分钟无人响应则自动解锁（防止侧栏被永久锁死）。",
    params: {
      reason: {
        type: "string",
        description: "为什么要人工介入，原样显示在侧栏横幅上（如「需要 GitHub 登录并输验证码」）",
      },
      selector: {
        type: "string",
        description: "可选：登录成功后页面上必然存在的 CSS 选择器（判据）",
      },
      urlIncludes: {
        type: "string",
        description: "可选：登录成功后 URL 必然包含的片段（判据），如站点首页路径",
      },
    },
    required: ["reason"],
    run: (p) =>
      request("handoff", {
        params: {
          reason: String(p?.reason ?? ""),
          selector: p?.selector ? String(p.selector) : undefined,
          urlIncludes: p?.urlIncludes ? String(p.urlIncludes) : undefined,
        },
      }),
  });

  registerTool(pi, {
    name: "browser_check_login",
    label: "检查人工验证",
    description:
      "问一句「人工那边的验证完成了没」（只读探针，不动页面内容）。返回 status：\n" +
      "cleared=判据命中、接管已解除、写操作恢复，可以继续；" +
      "still_waiting=还没好，页面仍锁着 —— 去做别的工作，别在这里轮询等。\n" +
      "判据缺省时沿用 browser_handoff 登记的那份；两个都不传时只能靠用户点「我已完成」解锁。" +
      "当前没有接管时，这个工具照样可以用判据问一句页面状态。",
    params: {
      selector: { type: "string", description: "登录成功后页面上存在的 CSS 选择器" },
      urlIncludes: { type: "string", description: "登录成功后 URL 必然包含的片段" },
    },
    run: (p) =>
      request("check_login", {
        params: {
          selector: p?.selector ? String(p.selector) : undefined,
          urlIncludes: p?.urlIncludes ? String(p.urlIncludes) : undefined,
        },
      }),
  });

  registerTool(pi, {
    name: "browser_hover",
    label: "悬停元素",
    description:
      SNAPNOTE +
      "\n对元素悬停（派发 pointerover/mouseenter/mousemove 一整套合成事件）。" +
      "只有 hover 才出现的下拉菜单、工具提示、悬浮面板要先 hover 再 read 才能看到里面的东西。" +
      "事件是合成的（isTrusted=false），个别只认真实指针的控件不会响应 —— 没效果就 read/截图确认，" +
      "或改用 click / browser_eval 直接改样式。",
    params: {
      ref: { type: "string", description: "上一次 browser_read 返回的元素 ref" },
      selector: { type: "string", description: "首选：稳定 CSS 选择器" },
    },
    run: (p) =>
      request("hover", {
        params: {
          ref: p?.ref ? String(p.ref) : undefined,
          selector: p?.selector ? String(p.selector) : undefined,
        },
      }),
  });

  registerTool(pi, {
    name: "browser_scroll",
    label: "滚动页面",
    description:
      SNAPNOTE +
      "\n滚动页面：direction=down/up/left/right/top/bottom，amount=像素（缺省约 0.8 视口高）。" +
      "传 ref/selector 时改为把那个元素滚到视野中间。返回当前滚动位置与页面总高 —— " +
      "懒加载列表要「滚一段 read 一段」，一次滚到底再 read 可能只拿到最后一屏的内容。",
    params: {
      direction: { type: "string", description: "down | up | left | right | top | bottom（缺省 down）" },
      amount: { type: "number", description: "滚动像素，缺省约 0.8 屏高" },
      ref: { type: "string", description: "可选：滚到某个元素（上一次 read 的 ref）" },
      selector: { type: "string", description: "可选：滚到某个元素（CSS 选择器）" },
    },
    run: (p) =>
      request("scroll", {
        params: {
          direction: p?.direction ? String(p.direction) : undefined,
          amount: p?.amount != null ? Number(p.amount) : undefined,
          ref: p?.ref ? String(p.ref) : undefined,
          selector: p?.selector ? String(p.selector) : undefined,
        },
      }),
  });

  registerTool(pi, {
    name: "browser_drag",
    label: "拖拽元素",
    description:
      SNAPNOTE +
      "\n把一个元素拖到另一个元素上（起点/终点都用上一次 browser_read 的 ref 或稳定 selector）。" +
      "同时派发 HTML5 拖放事件（dragstart/dragover/drop/dragend + DataTransfer）和一套指针序列，" +
      "所以 sortable 列表、文件拖入区、看板卡片这类通常能走通。" +
      "⚠ 合成事件 isTrusted=false，依赖真实指针捕获的库可能无效 → 拖完一定要 read 或截图确认结果。",
    params: {
      ref: { type: "string", description: "起点元素 ref" },
      selector: { type: "string", description: "起点元素 CSS 选择器" },
      toRef: { type: "string", description: "终点元素 ref" },
      toSelector: { type: "string", description: "终点元素 CSS 选择器" },
    },
    run: (p) =>
      request("drag", {
        params: {
          ref: p?.ref ? String(p.ref) : undefined,
          selector: p?.selector ? String(p.selector) : undefined,
          toRef: p?.toRef ? String(p.toRef) : undefined,
          toSelector: p?.toSelector ? String(p.toSelector) : undefined,
        },
      }),
  });

  registerTool(pi, {
    name: "browser_wait",
    label: "等待页面内容",
    description:
      SNAPNOTE +
      "\n等页面上出现某段文本（text）或某个元素（selector），最多等 seconds 秒（缺省 8，上限 25）。" +
      "命中即返回；超时返回 ok:false 并附上当前地址与标题。\n" +
      "用它的理由：SPA 渲染、异步列表、跳转后的落地页都需要等一下，而反复 browser_read 轮询每轮都要付一次" +
      "请求往返 —— 要等就用这个，别靠连续 read 硬凑。接管人工验证期间也可以调（只读）。",
    params: {
      text: { type: "string", description: "等这段文本出现在页面可见文字里" },
      selector: { type: "string", description: "等这个 CSS 选择器命中元素（优先于 text）" },
      seconds: { type: "number", description: "最长等待秒数，缺省 8、上限 25" },
    },
    run: (p) =>
      request("wait", {
        params: {
          text: p?.text ? String(p.text) : undefined,
          selector: p?.selector ? String(p.selector) : undefined,
          seconds: p?.seconds != null ? Number(p.seconds) : undefined,
        },
      }),
  });

  registerTool(pi, {
    name: "browser_eval",
    label: "页面执行脚本",
    description:
      SNAPNOTE +
      "\n在页面里执行一段 JS 并把返回值给模型。其它工具做不到的事再用它（读框架状态、" +
      "改样式、批量取 DOM、翻 localStorage）。\n" +
      "硬约束：脚本**同步返回**，不能 await —— 页面注入（ExecuteScript）不等 Promise，也不回报异常，" +
      "返回 Promise 会被拒。要异步结果就分两步：先调一次把值写进全局（window.__x = …），" +
      "过一会儿再 browser_eval 读那个全局变量。" +
      "返回值必须是可 JSON 序列化的；站点 CSP 禁止 new Function 时会报错。" +
      "运行在页面自己的 origin 里（碰不到 Helix 的任何能力），但它**能改这个页面**，" +
      "所以视同写操作：人工接管期间会被拒绝。",
    params: {
      js: {
        type: "string",
        description: "函数体源码（不用包 function），必须 return 一个可序列化值，如：JSON.stringify([...document.querySelectorAll('h2')].map(h=>h.innerText))",
      },
    },
    required: ["js"],
    run: (p) => request("eval", { params: { js: String(p?.js ?? "") } }),
  });

  registerTool(pi, {
    name: "browser_upload",
    label: "上传本地文件",
    description:
      SNAPNOTE +
      "\n把一个**本地文件**塞进 `<input type=\"file\">`（页内用 DataTransfer + File 赋值，再派发 change）。" +
      "path 必须在当前项目目录之内，单文件上限 8MB —— 越界或过大直接拒绝，这是刻意的边界。\n" +
      "定位用 ref 或 selector，指向的必须真是 file input（不是它的兄弟 label/按钮）。" +
      "传完要 read 或截图确认站点收到了文件；个别校验 isTrusted 的上传组件不会认这次赋值，" +
      "那就 browser_handoff 交给人点。",
    params: {
      path: { type: "string", description: "文件路径（项目目录内的相对或绝对路径）" },
      ref: { type: "string", description: "<input type=file> 的 ref" },
      selector: { type: "string", description: "<input type=file> 的 CSS 选择器（推荐）" },
    },
    required: ["path"],
    run: (p) =>
      request("upload", {
        params: {
          path: String(p?.path ?? ""),
          ref: p?.ref ? String(p.ref) : undefined,
          selector: p?.selector ? String(p.selector) : undefined,
        },
      }),
  });

  registerTool(pi, {
    name: "browser_dialog",
    label: "页面弹窗",
    description:
      SNAPNOTE +
      "\nHelix 不弹原生 alert/confirm/prompt（那会占住页面的脚本线程，把之后所有浏览器工具一起拖死）：" +
      "页面调用它们时只**记一条记录**并立刻按「取消」返回（confirm→false、prompt→null、alert→无）。\n" +
      "所以点了一个会弹确认框的按钮之后，用这个工具看 dialogs 里记了什么；" +
      "要让下一次 confirm 回答「确定」就先调 `accept:true`（prompt 还可以带 text），然后再点按钮 —— " +
      "已经发生的那次不会追溯生效。clear:true 清空记录。\n" +
      "browser_read 的返回里也会带最近 3 条记录，通常不需要专门调这个。",
    params: {
      accept: { type: "boolean", description: "下一次 confirm 返回 true / prompt 采纳 text" },
      text: { type: "string", description: "下一次 prompt 的应答文本" },
      clear: { type: "boolean", description: "清空已记录的弹窗" },
    },
    run: (p) =>
      request("dialog", {
        params: {
          accept: p?.accept === true || p?.accept === "true" ? true : p?.accept === false ? false : undefined,
          text: p?.text != null ? String(p.text) : undefined,
          clear: p?.clear === true || p?.clear === "true",
        },
      }),
  });
}
