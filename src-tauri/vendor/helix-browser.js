/**
 * helix-browser — Helix 内置扩展：让 pi 模型驱动 Helix 侧边栏的嵌入浏览器。
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const REQ_DIR = join(homedir(), ".pi", "agent", "browser-requests");
const MAX_KEEP = 50;
const RESULT_TIMEOUT_MS = 60_000;
/** handoff(wait=true) 的等待上限。必须大于前端接管超时
 *  （browser_webview.rs 的 HANDOFF_TIMEOUT_MAX_MIN，30 分钟 */
const HANDOFF_WAIT_CEILING_MS = 35 * 60_000;
const RESULT_POLL_MS = 120;
/** 未消费请求的 TTL：前端只消费新鲜请求，过期的是 Helix 不在线时留下的垃圾。 */
const STALE_AFTER_MS = 5 * 60_000;

function ensureDir() {
  mkdirSync(REQ_DIR, { recursive: true });
}

/** 按 MAX_KEEP 淘汰最旧的活跃请求（.consumed 不计入，由 dropStale 回收）。 */
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

/** 删除 .consumed 死标记和过期未消费的请求（文件名前缀是写入时的 Date.now()）。 */
function dropStale() {
  try {
    const now = Date.now();
    for (const f of readdirSync(REQ_DIR)) {
      if (f === "latest.json") continue;
      let stale = f.endsWith(".json.consumed");
      if (!stale && f.endsWith(".json")) {
        const m = f.match(/^(\d+)-/);
        stale = !!m && now - Number(m[1]) > STALE_AFTER_MS;
      }
      if (!stale) continue;
      try { unlinkSync(join(REQ_DIR, f)); } catch { /* best-effort */ }
    }
  } catch {
    /* best-effort */
  }
}

/** 写请求文件并轮询 <reqId>.result.json 等前端回写结果。 */
async function request(op, opts = {}) {
  const url = (opts.url ?? "").trim();
  if (op === "navigate" && !url.startsWith("http://") && !url.startsWith("https://")) {
    return { ok: false, error: `navigate 的 url 必须是有效的 http(s) URL，收到: "${url}"` };
  }
  ensureDir();
  pruneOld();
  dropStale();
  const reqId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  writeFileSync(
    join(REQ_DIR, `${reqId}.json`),
    JSON.stringify({ op, url: url || undefined, reqId, ts: Date.now(), params: opts.params ?? {} }),
    "utf-8",
  );
  const resultPath = join(REQ_DIR, `${reqId}.result.json`);
  const timeoutMs = opts.timeoutMs ?? RESULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RESULT_POLL_MS));
    if (!existsSync(resultPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(resultPath, "utf-8"));
      return parsed?.result ?? parsed;
    } finally {
      try { unlinkSync(resultPath); } catch { /* already gone */ }
    }
  }
  return { ok: false, error: `浏览器请求超时（${op}）：前端 ${timeoutMs / 1000}s 内未回写结果，可能没有运行。重试无用，请改用其他工具。` };
}

/** 工具描述前缀。 */
const SNAPNOTE =
  "操作侧栏当前浏览器页；先用 open_browser 打开页面。操作实时 DOM；登录/验证码用 browser_handoff。\n";

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

/** 构造只含已填字段的 params 对象（ref/selector 等字符串字段）。 */
const str = (v) => (v ? String(v) : undefined);

export default function register(pi) {
  registerTool(pi, {
    name: "open_browser",
    label: "Open Browser",
    description: "在 Helix 侧边栏的嵌入浏览器中打开 URL。用户要求查看网页时使用。",
    params: { url: { type: "string", description: "完整 URL（http/https）" } },
    required: ["url"],
    run: (p) => request("navigate", { url: String(p?.url ?? "") }),
  });

  registerTool(pi, {
    name: "browser_read",
    label: "Browser Read",
    description:
      SNAPNOTE +
      "读取标题、URL、可见文本、交互元素和最近弹窗。支持 shadow DOM/同源 iframe；跨域 iframe 不可读。" +
      "元素 ref 可用于其他操作，但导航、重渲染或再次 read 后可能失效；不确定时重新 read，优先用 selector。" +
      "元素过多时返回 truncated，用 selector 筛选。",
    params: {
      selector: { type: "string", description: "可选：只返回匹配该 CSS 选择器的元素" },
    },
    run: (p) => request("read", { params: p?.selector ? { selector: String(p.selector) } : {} }),
  });

  registerTool(pi, {
    name: "browser_click",
    label: "Browser Click",
    description: SNAPNOTE + "点击元素，优先 selector，其次 ref。操作后验证；发生导航需重新 read。",
    params: {
      ref: { type: "string", description: "browser_read 返回的元素 ref（如 e12）" },
      selector: { type: "string", description: "首选：稳定 CSS 选择器" },
    },
    run: (p) => request("click", { params: { ref: str(p?.ref), selector: str(p?.selector) } }),
  });

  registerTool(pi, {
    name: "browser_type",
    label: "Browser Type",
    description: SNAPNOTE + "填写 input、textarea、contenteditable 或 select。优先 selector；submit=true 会按 Enter，之后重新 read。",
    params: {
      ref: { type: "string", description: "输入框 ref" },
      selector: { type: "string", description: "首选：稳定 CSS 选择器（如 input[name=q]）" },
      text: { type: "string", description: "要输入的文本" },
      submit: { type: "boolean", description: "填完后按 Enter 提交（默认 false）" },
    },
    required: ["text"],
    run: (p) =>
      request("type", {
        params: {
          ref: str(p?.ref),
          selector: str(p?.selector),
          text: String(p?.text ?? ""),
          submit: p?.submit === true || p?.submit === "true",
        },
      }),
  });

  registerTool(pi, {
    name: "browser_press",
    label: "Browser Press",
    description: SNAPNOTE + "对当前焦点发送按键或组合键，如 Enter、Escape、Tab、Ctrl+A。",
    params: { key: { type: "string", description: "键名，如 Enter / Escape / Tab" } },
    required: ["key"],
    run: (p) => request("press", { params: { key: String(p?.key ?? "Enter") } }),
  });

  registerTool(pi, {
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: SNAPNOTE + "截取当前页 PNG 快照，用于检查布局和渲染结果。",
    params: {},
    run: () => request("screenshot", {}),
  });

  registerTool(pi, {
    name: "browser_history",
    label: "Browser History",
    description: SNAPNOTE + "后退、前进或刷新当前页。",
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
      "把当前页交给人工完成登录/验证码/授权；接管期间写操作锁定，只读工具可用。\\n" +
      "wait=false（默认）立即返回，先做其他工作，稍后用 browser_check_login 检查。\\n" +
      "wait=true 阻塞等待结果：completed=判据命中并解锁；done=用户确认完成；timeout=未完成且页面已解锁，停止该任务线、查看页面并告知用户。done/timeout 后不要轮询或重发 handoff。\\n" +
      "仅当后续步骤必须依赖登录时才用 wait=true，并传 selector 或 urlIncludes 作为完成判据；判据会被 browser_check_login 沿用。",
    params: {
      reason: { type: "string", description: "人工介入的原因，原样显示在横幅上（如「需要 GitHub 登录并输验证码」）" },
      wait: { type: "boolean", description: "默认 false；true=阻塞等人工结论，仅在下一步必须依赖该页时使用" },
      selector: { type: "string", description: "可选判据：登录成功后页面上必然存在的 CSS 选择器" },
      urlIncludes: { type: "string", description: "可选判据：登录成功后 URL 必然包含的片段" },
    },
    required: ["reason"],
    run: (p) => {
      const wait = p?.wait === true;
      return request("handoff", {
        timeoutMs: wait ? HANDOFF_WAIT_CEILING_MS : undefined,
        params: {
          reason: String(p?.reason ?? ""),
          wait,
          selector: str(p?.selector),
          urlIncludes: str(p?.urlIncludes),
        },
      });
    },
  });

  registerTool(pi, {
    name: "browser_check_login",
    label: "检查人工验证",
    description:
      "查询人工验证是否完成（只读）。status：cleared=判据命中、已解锁，可继续；" +
      "still_waiting=未完成，页面仍锁着，去做别的，别在这里轮询。\n" +
      "判据缺省沿用 browser_handoff 登记的；都没有则只能靠用户点「我已完成」。" +
      "没有接管时也可用判据查询页面状态。",
    params: {
      selector: { type: "string", description: "登录成功后页面上存在的 CSS 选择器" },
      urlIncludes: { type: "string", description: "登录成功后 URL 必然包含的片段" },
    },
    run: (p) =>
      request("check_login", { params: { selector: str(p?.selector), urlIncludes: str(p?.urlIncludes) } }),
  });

  registerTool(pi, {
    name: "browser_hover",
    label: "悬停元素",
    description: SNAPNOTE + "悬停元素以显示菜单或提示；操作后需验证，部分控件不响应合成事件。",
    params: {
      ref: { type: "string", description: "元素 ref" },
      selector: { type: "string", description: "首选：稳定 CSS 选择器" },
    },
    run: (p) => request("hover", { params: { ref: str(p?.ref), selector: str(p?.selector) } }),
  });

  registerTool(pi, {
    name: "browser_scroll",
    label: "滚动页面",
    description: SNAPNOTE + "滚动页面或将指定元素滚入视野；懒加载内容请分段滚动并 read。",
    params: {
      direction: { type: "string", description: "down | up | left | right | top | bottom（缺省 down）" },
      amount: { type: "number", description: "滚动像素，缺省约 0.8 屏高" },
      ref: { type: "string", description: "可选：滚到该元素" },
      selector: { type: "string", description: "可选：滚到该 CSS 选择器的元素" },
    },
    run: (p) =>
      request("scroll", {
        params: {
          direction: str(p?.direction),
          amount: p?.amount != null ? Number(p.amount) : undefined,
          ref: str(p?.ref),
          selector: str(p?.selector),
        },
      }),
  });

  registerTool(pi, {
    name: "browser_drag",
    label: "拖拽元素",
    description: SNAPNOTE + "将元素拖到目标元素。合成事件可能不被部分控件接受，拖完需验证结果。",
    params: {
      ref: { type: "string", description: "起点元素 ref" },
      selector: { type: "string", description: "起点元素 CSS 选择器" },
      toRef: { type: "string", description: "终点元素 ref" },
      toSelector: { type: "string", description: "终点元素 CSS 选择器" },
    },
    run: (p) =>
      request("drag", {
        params: {
          ref: str(p?.ref),
          selector: str(p?.selector),
          toRef: str(p?.toRef),
          toSelector: str(p?.toSelector),
        },
      }),
  });

  registerTool(pi, {
    name: "browser_wait",
    label: "等待页面内容",
    description: SNAPNOTE + "等待指定文本或 selector 出现（默认 8 秒，最多 25 秒）；适用于 SPA 和异步内容，避免反复 read。",
    params: {
      text: { type: "string", description: "等待出现在页面可见文字里的文本" },
      selector: { type: "string", description: "等待命中的 CSS 选择器（优先于 text）" },
      seconds: { type: "number", description: "最长等待秒数，缺省 8、上限 25" },
    },
    run: (p) =>
      request("wait", {
        params: {
          text: str(p?.text),
          selector: str(p?.selector),
          seconds: p?.seconds != null ? Number(p.seconds) : undefined,
        },
      }),
  });

  registerTool(pi, {
    name: "browser_eval",
    label: "页面执行脚本",
    description:
      SNAPNOTE +
      "执行页面 JS，供其他工具无法完成的操作。必须同步 return 可 JSON 序列化的值，不能 await/返回 Promise；" +
      "可修改页面，属于写操作，人工接管期间会被拒。",
    params: {
      js: {
        type: "string",
        description: "函数体源码（无需包 function），必须 return 可序列化值，如：JSON.stringify([...document.querySelectorAll('h2')].map(h=>h.innerText))",
      },
    },
    required: ["js"],
    run: (p) => request("eval", { params: { js: String(p?.js ?? "") } }),
  });

  registerTool(pi, {
    name: "browser_dialog",
    label: "页面弹窗",
    description:
      SNAPNOTE +
      "查看弹窗记录。页面的 alert/confirm/prompt 不会弹原生框，而会被记录并默认取消。" +
      "accept:true 影响下一次 confirm；prompt 可传 text；clear:true 清空记录。browser_read 也含最近记录。",
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