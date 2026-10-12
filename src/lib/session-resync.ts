import { resolveBackendSid } from "@/lib/session-map";
import {
  brokenReasonFromResume,
  isSessionGone,
  resumeFailureDescription,
  resumeSession,
} from "@/lib/session-resume";
import { useGatewayStore } from "@/stores/gateway-store";
import { useHelixStore } from "@/stores/helix-store";
import type { ChatMessage } from "@/stores/helix-types";

function genId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 网关自己发进 pi 会话的「转达」文本（子 agent 结果回填，前缀与 Rust 侧
 * pi_gateway.rs 的 inject_text 一致——改那边必须同时改这里）。它是以 **user**
 * 角色持久化的，但用户从没发过这句话：实时路径不会为它画用户气泡，重开时后端
 * 历史里却有，于是一条系统转达会被显示成「我说的」。
 *
 * 两个口都用它：`mapBackendMessages`（新数据根本不进 store）与渲染层的
 * `sessionMessages`（把这次修改之前已经落进本地历史/IDB 的旧记录也挡住）。
 * 模型侧照旧看得见——那是 pi 自己的历史，本层只管界面；它紧随其后的那条
 * assistant 汇报照常保留。
 */
const GATEWAY_NOTE_PREFIX = "【系统转达，非用户指令】";

export function isGatewayNoteMessage(m: {
  role?: unknown;
  text?: unknown;
  content?: unknown;
}): boolean {
  if (m.role !== "user") return false;
  // 后端投影给的是 `text` 字符串，本地 ChatMessage 给的是 `content`（长消息会被
  // 拆成 [{type:"text",text:…}] 块）——两种都要认，否则已经落进本地历史的那条
  // 躲得过过滤，照样显示成「我说的」。
  const raw = m.text ?? m.content;
  const block = Array.isArray(raw) ? (raw[0] as { text?: unknown }) : undefined;
  const text = typeof raw === "string" ? raw : block?.text;
  return (
    typeof text === "string" &&
    text.trimStart().startsWith(GATEWAY_NOTE_PREFIX)
  );
}

/**
 * Single source of truth for the backend → frontend message mapping. Every place
 * that ingests a backend message array (session.compress / session.resume / etc.)
 * MUST go through this — do not hand-roll the projection, or the call sites drift.
 *
 * Notes on the backend shape (tui_gateway/server.py::_history_to_messages):
 *  - the body lives in `text`, NOT `content`, so we read `m.text ?? m.content`;
 *  - `tool` roles are collapsed to `assistant` (tool results render as assistant turns);
 *  - `row_id` is preserved so local withdraw/delete can sync to the backend history.
 */
/** 后端 session history 投影过来的原始消息形状
 * （tui_gateway/server.py::_history_to_messages）：正文在 `text` 而非 `content`；
 * `row_id` 透传以便本地撤回/删除能同步回后端历史。标 unknown 的字段是后端
 * 动态 JSON 字段，在校验/收窄前不能盲信其类型。 */
export interface BackendHistoryMessage {
  id?: unknown;
  row_id?: unknown;
  role?: unknown;
  text?: unknown;
  content?: unknown;
  images?: ChatMessage["images"];
  timestamp?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  steps?: ChatMessage["steps"];
  fileChanges?: ChatMessage["fileChanges"];
  blocks?: ChatMessage["blocks"];
}

export function mapBackendMessages(
  msgs: BackendHistoryMessage[] | null | undefined,
  sessionId: string,
): ChatMessage[] {
  if (!Array.isArray(msgs)) return [];
  return msgs
    .filter((m) => !isGatewayNoteMessage(m))
    .map((m) => {
      const id = m.id || m.row_id || genId();
      const timestamp = m.timestamp || Date.now();
      const reasoning = m.reasoning ?? m.reasoning_content;
      return {
        id: typeof id === "string" ? id : String(id),
        role: (m.role === "tool" ? "assistant" : m.role) as
          "user" | "assistant" | "system",
        content: (m.text ?? m.content ?? "") as ChatMessage["content"],
        images: m.images,
        timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
        reasoning:
          typeof reasoning === "string" ? reasoning : undefined,
        steps: m.steps,
        rowId: typeof m.row_id === "number" ? m.row_id : undefined,
        sessionId,
        fileChanges: m.fileChanges,
        blocks: m.blocks,
      };
    });
}

export interface ResyncOptions {
  /** Session to resync; defaults to the active session. */
  sessionId?: string;
  /** Show a toast when done / on error. Default false. */
  showToast?: boolean;
  /** Override the success toast text (default: 已从后端重新同步). */
  toastMessage?: string;
}

/**
 * Pull the authoritative message history for a session straight from the backend
 * (session.resume → state.db, the same source the compressor writes to) and replace
 * ONLY that session's messages in the global `chatMessages` array. Other sessions are
 * untouched (chatMessages is a cross-session array keyed by `sessionId`).
 *
 * Used in three places:
 *  - the manual `/resync` slash command
 *  - an automatic self-heal right after compaction (so a finished compression can
 *    never leave the view empty without the user typing anything)
 *  - the anomaly guard that fires when a compress returns a broken/empty payload
 */
export async function resyncCurrentSessionFromBackend(
  opts: ResyncOptions = {},
): Promise<number> {
  const store = useHelixStore.getState();
  const currentSessionId = opts.sessionId ?? store.currentSessionId;
  if (!currentSessionId) {
    if (opts.showToast)
      store.showToast({ type: "warning", title: "当前没有活跃会话" });
    return 0;
  }
  if (store.isChatLoading) {
    if (opts.showToast)
      store.showToast({
        type: "warning",
        title: "对话进行中",
        description: "请等待当前回复完成后再同步",
      });
    return 0;
  }
  try {
    const sid =
      (await resolveBackendSid(currentSessionId)) ||
      useGatewayStore.getState().helixSessionId;
    if (!sid) {
      if (opts.showToast)
        store.showToast({
          type: "warning",
          title: "当前会话还没有后端会话",
          description: "先发送一条消息建立会话后再同步",
        });
      return 0;
    }
    // 统一 Resume 状态机（与 handleRun / gateway.ready / compact 同一套）：
    // 只按本对话保存的 SID 恢复原会话——不换 storedId、不查最近，那是"换
    // 一个 SID"。SESSION_NOT_FOUND → 标 broken + 明确提示；其他错误保留
    // 真实错误、**不**标 broken（可重试）。resync 自己不做任何 fallback。
    const resumed = await resumeSession(sid);
    if (!resumed.ok) {
      if (isSessionGone(resumed)) {
        store.markSessionBroken(
          currentSessionId,
          brokenReasonFromResume(resumed),
        );
      }
      if (opts.showToast)
        store.showToast({
          type: "error",
          title: "同步失败",
          description: resumeFailureDescription(resumed),
        });
      return 0;
    }
    if (!Array.isArray(resumed.messages)) {
      if (opts.showToast)
        store.showToast({
          type: "error",
          title: "同步失败",
          description: "后端未返回该会话的消息",
        });
      return 0;
    }
    const msgs = mapBackendMessages(
      resumed.messages as BackendHistoryMessage[],
      currentSessionId,
    );
    // 不让视图**变小**：后端快照比本地可见历史更短 = 后端滞后（刚提交的消息
    // 还没落 state.db）或已被压缩摘要掉。无条件整段替换会把用户看得见的内容
    // 删掉（"之前用户的输入自动消失"），而 /resync 的诉求是"把丢掉的找回来"，
    // 不是"以后端为准做减法"。真需要强制以后端为准时，走 /compact 或重开会话。
    const local = useHelixStore
      .getState()
      .chatMessages.filter((m) => m.sessionId === currentSessionId);
    if (msgs.length < local.length) {
      if (opts.showToast)
        store.showToast({
          type: "warning",
          title: "后端历史比本地更短，已保留本地",
          description: `后端 ${msgs.length} 条 / 本地 ${local.length} 条`,
        });
      return 0;
    }
    useHelixStore.setState((state) => ({
      chatMessages: [
        // ⚠️ 不能写成 `m.sessionId && m.sessionId !== …`：那会顺手删掉所有
        // sessionId 为 undefined 的消息，而它们**是可见的**（渲染层的过滤条件是
        // `!m.sessionId || m.sessionId === currentSessionId`，与 helix-store
        // addChatMessage 的 `|| undefined` 兜底配对）。无 sessionId 的消息在
        // hidden 之前一直是用户能看到的内容，删掉就是"消息凭空消失"。
        ...state.chatMessages.filter(
          (m) => m.sessionId !== currentSessionId,
        ),
        ...msgs,
      ],
    }));
    if (opts.showToast) {
      store.showToast({
        type: "success",
        title: opts.toastMessage || "已从后端重新同步",
        description: `恢复 ${msgs.length} 条消息`,
      });
    }
    return msgs.length;
  } catch (e) {
    if (opts.showToast)
      store.showToast({
        type: "error",
        title: "同步失败",
        description: String((e as Error)?.message || e),
      });
    return 0;
  }
}

/**
 * Heuristic guard: did the current session end up with non-empty-but-broken content?
 * Returns true when the session has messages but every one of them is blank — the
 * signature of the old "compression wiped the view" bug. Used to decide whether an
 * automatic resync is warranted.
 */
export function isCurrentSessionRenderBroken(
  sessionId: string | null,
): boolean {
  if (!sessionId) return false;
  const msgs = useHelixStore
    .getState()
    .chatMessages.filter((m) => m.sessionId === sessionId);
  if (msgs.length === 0) return false;
  return msgs.every((m) => !m.content || !m.content.trim());
}
