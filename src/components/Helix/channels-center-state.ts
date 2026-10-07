/**
 * 渠道中心共享状态 —— 面板 UI 之外的全部逻辑。
 *
 * 单独成模块（而不是留在面板组件里）是为了让应用启动预热（helix-layout）
 * 也能触发查询，而不必加载整个面板 chunk；面板本身仍是懒加载。
 *
 * 三条策略（面板与预热共同遵守）：
 * - 打开面板优先展示上次结果，只有结果过期（STALE_MS）才在后台静默刷新；
 * - 同一时刻只允许一个查询在途，跨挂载共享（查询没跑完就关掉面板、重开时
 *   接上同一个查询——Rust 侧是串行锁，重复发起会直接报「渠道命令正在执行中」）；
 * - 今日签到状态：领取结果全绿时把本地日期戳（localStorage）记为已领取，
 *   跨启动生效；状态文本也能推导一部分（见各渠道 usage.js 的固定文案）。
 */
import { helixApi, isElectron } from "@/lib/electron-bridge";

type NotifyMessage = { message: string; type: string };
type BridgeResult = {
  prompt: string;
  success: boolean;
  messages: NotifyMessage[];
};

/** 「今日已领取」的本地记录键（值为 YYYY-MM-DD 本地日）。 */
const CHECKIN_STORE_KEY = "helix-channels-last-checkin";

/** 本地日戳：跨天自动失效。 */
function todayStamp(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function readCheckinStamp(): string | null {
  try {
    return localStorage.getItem(CHECKIN_STORE_KEY);
  } catch {
    return null;
  }
}

function writeCheckinStamp(date: string) {
  try {
    localStorage.setItem(CHECKIN_STORE_KEY, date);
  } catch {
    /* localStorage 不可用时只失去跨启动记忆，不影响本次会话 */
  }
}

export type ChannelsState = {
  blocks: string[] | null;
  checkinResults: NotifyMessage[] | null;
  updatedAt: Date | null;
  busy: "status" | "checkin" | null;
  error: string | null;
  /** 记录「今日已领取」的本地日期（YYYY-MM-DD）；非今天不算数。 */
  checkinDoneDate: string | null;
};

let state: ChannelsState = {
  blocks: null,
  checkinResults: null,
  updatedAt: null,
  busy: null,
  error: null,
  checkinDoneDate: readCheckinStamp(),
};

const listeners = new Set<() => void>();

/** 在途查询（含面板已关闭的情况）——重开时接上它，绝不起第二个进程。 */
let inflight: Promise<void> | null = null;

/** 打开面板时，结果超过该时长才在后台静默刷新。 */
export const STALE_MS = 10 * 60 * 1000;

function setState(patch: Partial<ChannelsState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot() {
  return state;
}

/** 概览 notify 的头（commands.js 拼的），解析时剥掉。 */
function splitOverview(message: string): string[] {
  const nl = message.indexOf("\n\n");
  const body =
    nl >= 0 && message.slice(0, nl).includes("渠道概览")
      ? message.slice(nl + 2)
      : message;
  return body
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
}

function applyStatus(msgs: NotifyMessage[]) {
  const blocks: string[] = [];
  for (const m of msgs) {
    const text = m.message?.trim();
    if (!text) continue;
    if (text.includes("渠道概览")) blocks.push(...splitOverview(text));
    else blocks.push(text);
  }
  setState({ blocks, updatedAt: new Date(), error: null });
}

// ─── 今日签到状态判定 ────────────────────────────────────────────────────
// 数据源与文案见 pi-connect 各渠道 usage.js：
// - qoder/trae 状态直接给「今日已领取 / 今日可领取」；
// - workbuddy 状态只报「活动进行中 / 无进行中的活动」，其 today_checked_in
//   字段不可信，「今天领没领」只能以领取动作的应答为准 —— 所以领取结果
//   全绿时写本地日期戳，跨启动记住。

/** 状态块里「还能领」的标志。 */
const CLAIMABLE_RE = /今日可领取|活动进行中/;
/**
 * 「已了结、没有可领的东西」的标志：已领取 / 今日无活动 / 企业号不支持 /
 * 未登录（无法领取）/ trae 国际版（只有订阅计费，无签到概念）。
 */
const SETTLED_RE = /今日已领取|无进行中的活动|不支持每日签到|未登录|订阅计费/;

/** 领取应答里「动作已完成」的标志。 */
const CHECKIN_DONE_RE = /签到成功|今日已领取|无进行中的签到活动|不支持每日签到/;
/** 领取应答里「没成事/需人工处理」的文案兜底（warning/error 类型另有兜底）。 */
const CHECKIN_TROUBLE_RE = /已取消|失败|未成功|未登录|凭据/;

/** 领取结果是否全绿（每个渠道都完成、无人失败）。 */
function checkinRunCompleted(msgs: NotifyMessage[]): boolean {
  let sawDone = false;
  for (const m of msgs) {
    if (m.type === "error" || m.type === "warning") return false;
    const text = m.message ?? "";
    if (CHECKIN_TROUBLE_RE.test(text)) return false;
    if (CHECKIN_DONE_RE.test(text)) sawDone = true;
  }
  return sawDone;
}

/** 签到按钮视角的今日状态。 */
export type CheckinToday = "done" | "none" | "ready";

/**
 * 判定签到按钮该显示什么：
 * - done：今日已领取（本地日期戳，或状态明确「已领取」且没有可领的渠道）；
 * - none：今日无可签（各渠道都已了结：无活动/不支持/未登录）；
 * - ready：有渠道可领取，或状态未知（读不到就允许试一次）。
 */
export function checkinToday(s: ChannelsState): CheckinToday {
  if (s.checkinDoneDate === todayStamp()) return "done";
  const blocks = s.blocks;
  if (!blocks || blocks.length === 0) return "ready";
  if (blocks.some((b) => CLAIMABLE_RE.test(b))) return "ready";
  if (!blocks.every((b) => SETTLED_RE.test(b))) return "ready";
  return blocks.some((b) => /今日已领取/.test(b)) ? "done" : "none";
}

export function query(action: "status" | "checkin", opts?: { silent?: boolean }) {
  if (inflight) return inflight;
  if (!isElectron() || !helixApi()?.piConnectQuery) {
    setState({ error: "渠道中心仅在桌面应用中可用" });
    return Promise.resolve();
  }
  // 静默刷新不清 error：旧数据/旧错误先照常展示，完成后再整体替换，
  // 避免「打开面板先闪一下错误再消失」。
  setState({
    busy: action,
    ...(opts?.silent ? {} : { error: null }),
    ...(action === "checkin" ? { checkinResults: null } : {}),
  });
  inflight = (async () => {
    try {
      const r = await helixApi()!.piConnectQuery(action);
      const results = (r?.results ?? []) as BridgeResult[];
      const first = results[0];
      if (!first || !first.success) {
        const detail = first?.messages?.map((m) => m.message).join("\n");
        throw new Error(detail || "渠道命令执行失败");
      }
      if (action === "status") {
        applyStatus(first.messages);
      } else {
        setState({ checkinResults: first.messages, error: null });
        if (checkinRunCompleted(first.messages)) {
          const today = todayStamp();
          writeCheckinStamp(today);
          setState({ checkinDoneDate: today });
        }
        // checkin 后紧跟一段 status（复用同一进程）—— 直接刷新卡片。
        const second = results[1];
        if (second?.success) applyStatus(second.messages);
      }
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      inflight = null;
      setState({ busy: null });
    }
  })();
  return inflight;
}

/** 只跑一次（ErrorBoundary 恢复等导致的重复挂载不重跑）。 */
let preheated = false;

/**
 * 应用启动预热：后台先查一次渠道状态，打开面板时直接有数据。
 * 非桌面（web 预览）静默跳过，避免给从不打开面板的会话留下错误态。
 */
export function preheatChannelsCenter(): void {
  if (preheated) return;
  preheated = true;
  if (!isElectron() || !helixApi()?.piConnectQuery) return;
  void query("status", { silent: true });
}
