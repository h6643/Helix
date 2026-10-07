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
 *   3. 前端对活动浏览器页执行（navigate 走 webview；read/click/type 等
 *      通过 page_fetch 拉同源 HTML → srcdoc iframe → 注入脚本执行）
 *   4. 前端调 Rust `browser_write_result` 写 `<reqId>.result.json`
 *   5. 本扩展轮询等结果文件 → 删除 → 把结果返回给模型
 *
 * 注意：read/click/type 执行在 page_fetch 拉取的同源快照上——它是静态
 * HTML（无页面 JS 状态），适合读结构/文本和触发原生跳转类交互；SPA
 * 动态渲染的内容可能取不到。navigate 是在真实 webview 上执行的。
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
  "在 Helix 侧边栏嵌入浏览器上执行操作（通过请求-响应文件协议）。\n" +
  "前提：当前必须有一个已打开的浏览器页面（先 open_browser / browser_navigate）；" +
  "没有打开页面时 read/click/type 会直接报错。\n" +
  "注意：read/click/type/press 作用于由 page_fetch 拉取的静态 HTML 快照（srcdoc 同源 iframe）——" +
  "适合读取结构/文本、点击链接/按钮、填写表单并回车跳转；SPA 动态渲染的内容可能取不到。" +
  "navigate/back/forward/refresh 直接作用于真实 webview。";

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
      "返回的元素带 ref 序号（如 e12），可紧接其后用于 browser_click / browser_type 定位；" +
      "但 ref 仅限当次 read——中间若穿插 navigate 或另一次 read，ref 即失效，跨请求请改用稳定 selector。",
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
      "\n点击页面上的元素。定位优先级：selector（稳定，推荐）> ref（仅当次 read 有效）。" +
      "⚠ ref（如 e12）只在「产生它的 browser_read」里有效——click 是独立请求，" +
      "会重新抓一份静态快照，上一轮的 data-helix-ref 没有落到这份 DOM 上，所以" +
      "「先 read、再 click 用 ref」经常定位不到。跨请求定位请改用稳定 CSS selector；" +
      "确需 ref 时要在刚 read 之后立刻 click（中间不要 navigate/其它 read）。" +
      "点击链接/提交按钮会触发导航——导航后的新页面需再 browser_read 确认。",
    params: {
      ref: {
        type: "string",
        description:
          "刚由 browser_read 返回的元素 ref（如 e12）。仅紧接其后、未经其它操作时有效；跨请求不保证",
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
      "\n向输入框填入文本。定位同 browser_click：优先稳定 selector；ref 仅当次 read 有效。" +
      "submit=true 时填完回车提交（触发导航，新页面需再 read 确认）。",
    params: {
      ref: {
        type: "string",
        description:
          "刚由 browser_read 返回的输入框 ref。仅紧接其后、未经其它操作时有效；跨请求不保证",
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
    description: SNAPNOTE + "\n对当前焦点元素按一个键（如 Enter、Escape、Tab）。",
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
      "截取当前页面的渲染快照（PNG，base64）。适合需要\"看\"页面布局、视觉元素、" +
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
}
