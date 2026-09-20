import { helixApi } from "@/lib/electron-bridge";
import { debug } from "@/lib/logger";
import { buildAcpMcpServers } from "@/lib/mcp";
import {
  SESSION_MAP_KEY,
  resolveBackendSid,
  type SessionMapEntry,
} from "@/lib/session-map";
import {
  resyncCurrentSessionFromBackend,
  isCurrentSessionRenderBroken,
} from "@/lib/session-resync";
import { normalizeAcpContent } from "@/lib/text-utils";
import {
  classifyResumeError,
  isSessionGone,
  resumeFailureDescription,
  resumeFailureTitle,
  resumeSession,
  sessionFileGone,
} from "@/lib/session-resume";
import { useGatewayStore } from "@/stores/gateway-store";
import { useHelixStore } from "@/stores/helix-store";

// ── 客户端内置 / 命令（主对话与旁路面板共用）────────────────────────────────
// 这两条都是「纯客户端动作」：/ 前缀绝不发给模型。放在独立模块里是因为
// 主对话（agent-flow-panel）与右侧「旁路问答」面板（byline-panel）都要提供
// 同样的快捷命令，命令名/description/执行逻辑必须一字不差——注册表和执行器
// 各一份，两处直接 import，谁都不再复制粘贴。

export interface BuiltinCommand {
  name: string;
  description: string;
  action: "compact" | "btw";
}

export const BUILTIN_SLASH_COMMANDS: BuiltinCommand[] = [
  {
    name: "compact",
    description: "压缩上下文",
    action: "compact",
  },
  {
    // 旁路提问：打开右侧边栏的「旁路问答」面板
    name: "btw",
    description: "旁路提问：打开右侧面板",
    action: "btw",
  },
];

export const DRAFT_SESSION_KEY = "__draft__";

async function persistSessionMap(map: Map<string, SessionMapEntry>) {
  try {
    const { persistence } = await import("@/lib/persist");
    const obj: Record<string, SessionMapEntry> = {};
    map.forEach((v, k) => {
      obj[k] = v;
    });
    await persistence.saveSetting(SESSION_MAP_KEY, obj);
  } catch {
    /* best-effort persistence — never block the UI on it */
  }
}

/** Update a conversation's mapping to a (possibly new) backend sid, keeping
 *  every sid it previously used in `sids`. Disk delegation manifests stay
 *  filed under the sid that was live when the child ran — without the
 *  history, /clear or a restart-rebuild switches the conversation to a fresh
 *  sid and its sub-agent records become unreachable. */
function rebindSessionSid(
  map: Map<string, SessionMapEntry>,
  cid: string,
  next: Omit<SessionMapEntry, "sids">,
) {
  const prev = map.get(cid);
  const sids = new Set([
    ...(prev?.sids || []),
    ...(prev ? [prev.sid] : []),
    next.sid,
  ]);
  map.set(cid, { ...next, sids: [...sids] });
}

export interface CompactContext {
  /** 组件里的 live 映射（ref.current），按 cid 查 sid 的主来源。 */
  sessionMap: Map<string, SessionMapEntry>;
  /** live 映射缺失时的全局兜底 sid（组件 ref / gateway store）。 */
  fallbackSid?: string | null;
}

export type CompactResult = "ok" | "busy" | "no-session" | "error";

/**
 * /compact 的完整执行体：调后端 session.compress、处理「会话不在内存」的
 * 透明 resume、把压缩后的消息写回**当前会话**的 chatMessages（跨会话全局
 * 数组，只替换本会话段）、挂压缩提示卡、必要时自动 resync 自愈。
 *
 * 主对话与旁路面板都调它（传各自 currentSessionId）——同一套行为，保证
 * 「在哪发 /compact 都作用于当前主线」。纯客户端动作，/ 前缀不进模型。
 */
export async function runCompactCommand(
  currentSessionId: string | null,
  ctx: CompactContext,
): Promise<CompactResult> {
  // 忙标记键：当前会话或 __draft__（新对话尚未分配 id）。提升到 try 外，
  // finally 也要按它清标记，不能包在 try 里。
  const busySessionKey = currentSessionId ?? DRAFT_SESSION_KEY;
  // 解析出的后端 sid 提升到 try 外：catch 要用它做一次权威 resume 检查，
  // 判定 "session not found" 是持久化文件没了还是只是没 attach。
  let compressSid = "";
  try {
    // 并发保护：忙标记按会话隔离（compressionBusyBySession），切换对话后
    // 其他会话的压缩状态不再跟着当前 UI 走。
    if (useHelixStore.getState().compressionBusyBySession[busySessionKey]) {
      useHelixStore.getState().showToast({
        type: "warning",
        title: "压缩进行中",
        description: "上一次压缩还没结束，请稍后再试",
      });
      return "busy";
    }
    useHelixStore.getState().setCompressionBusyForSession(busySessionKey, true);
    // session.compress 的 session_id 必须是后端 sid，不能直接传前端对话 id
    // （currentSessionId）——后端会话表里没有这个 id，必报 4001 "session not
    // found"。与 context-usage 的自动压缩路径保持一致：先解析映射拿 sid。
    // 2026-08-31 对齐官方语义：resolveBackendSid 不再按 epoch 丢弃持久化
    // sid——网关重启后后端会从 state.db 透明恢复该会话（get_session→_restore）。
    let sid =
      (await resolveBackendSid(currentSessionId)) ||
      ctx.fallbackSid ||
      useGatewayStore.getState().helixSessionId;
    compressSid = sid ?? "";
    if (!sid) {
      useHelixStore.getState().showToast({
        type: "warning",
        title: "当前会话还没有后端会话",
        description: "先发送一条消息建立会话后再压缩",
      });
      return "no-session";
    }
    // 统一 Resume 状态机（与 handleRun / resync / gateway.ready 同一套）：
    //   成功 → attached，继续压缩
    //   SESSION_NOT_FOUND → markSessionBroken + 明确提示，结束
    //   其他错误 → 保留真实错误提示，**不**标 broken（可重试）
    // 不自行 session/new + seedHistory 重建，也**不再**用 storedId 再 resume
    // 一次找替代会话——那会让 compact 拥有独立于 Resume 的第二套恢复语义。
    const resumed = await resumeSession(sid);
    if (!resumed.ok) {
      const hstore = useHelixStore.getState();
      if (isSessionGone(resumed) && currentSessionId) {
        hstore.markSessionBroken(currentSessionId, resumed.error);
      }
      hstore.showToast({
        type: "warning",
        title: resumeFailureTitle(resumed),
        description: resumeFailureDescription(resumed),
      });
      return "no-session";
    }
    sid = resumed.sessionId;
    const result = await helixApi()?.send("session.compress", {
      session_id: sid,
    });
    // 压缩成功说明 sid 在后端活着（可能刚被透明恢复）：刷新映射 epoch 并
    // 恢复全局绑定，让 handleRun / context-usage 后续都命中同一会话。
    if (currentSessionId) {
      rebindSessionSid(ctx.sessionMap, currentSessionId, {
        sid,
        epoch: useGatewayStore.getState().gatewayEpoch,
      });
      void persistSessionMap(ctx.sessionMap);
      try {
        useGatewayStore.getState().setHelixSessionId(sid);
      } catch {
        /* empty */
      }
    }
    if (result && typeof result === "object") {
      const r = result as any;
      if (r.status === "compressed" && Array.isArray(r.messages)) {
        // 压缩只改**模型侧上下文**，不动用户看得见的历史。
        //
        // 旧实现用后端压缩后的列表（pi 的 get_messages = 摘要 + 保留的消息）
        // 整体替换当前会话的转录，于是所有被摘要掉的早期消息——包括用户自己发
        // 过的输入——从界面上消失，与"用户发消息后，之前用户的输入就会自动消失"
        // 完全没法区分。本地转录是完整历史（IndexedDB / pi jsonl 都在），没有理由
        // 因为压缩而收缩；压缩的可见反馈交给下面的 compressionNotice 分隔线
        // （带前后 token 对比）。
        // 这里只把锚点定到当前会话（含 draft）最后一条本地消息，让分隔线落在其后。
        // Draft 会话（currentSessionId 为 null）的消息不挂 sessionId（见
        // helix-store addChatMessage 的 `|| undefined` 兜底），统一用空串作标记。
        const targetKey = currentSessionId || "";
        const local = useHelixStore
          .getState()
          .chatMessages.filter((m) => (m.sessionId || "") === targetKey);
        // 压缩提示卡片：transcript 顶部可关闭，8s 自动消失（不做 toast，
        // 与 WorkBuddy 的"过程卡片"风格一致）
        const anchorMessageId =
          local.length > 0 ? local[local.length - 1].id : undefined;
        const afterTokens = Number(r.after_tokens) || undefined;
        const ctxKey = currentSessionId || DRAFT_SESSION_KEY;
        useHelixStore.getState().setCompressionNotice({
          ts: Date.now(),
          sessionId: ctxKey,
          anchorMessageId,
          source: "manual",
          removed: Number(r.removed) || undefined,
          beforeTokens: Number(r.before_tokens) || undefined,
          afterTokens,
          messageCount: Number(r.after_messages) || undefined,
        });
        // 权威写回环：after_tokens 是压缩后「下一条 prompt 实际重放」的大小
        // （estimate_messages_tokens，见 pi_gateway session.compress）。压缩是
        // 唯一确定性的下降事件，走默认 max 合并会让 after_tokens 被压缩前的旧
        // 高位抬回去，环就永远停在压缩前的读数上。这里必须 authoritative。
        if (afterTokens) {
          const prev = useHelixStore.getState().contextUsage[ctxKey];
          useHelixStore.getState().setContextUsage(
            ctxKey,
            prev?.size || 0,
            afterTokens,
            undefined,
            undefined,
            true,
          );
        }
        // 自动自愈：极端情况下压缩回包异常/映射失败会让当前会话仍为空。
        // 直接异步从后端拉权威历史覆盖，无需用户手动输入 /resync。
        if (isCurrentSessionRenderBroken(currentSessionId)) {
          await resyncCurrentSessionFromBackend({
            sessionId: currentSessionId || "",
            showToast: true,
            toastMessage: "压缩后消息异常，已自动从后端恢复",
          });
        }
        return "ok";
      } else if (r.status === "aborted") {
        useHelixStore.getState().showToast({
          type: "warning",
          title: "压缩已中止",
        });
        return "ok";
      } else if (r.lock_held) {
        // 后端压缩锁被占用：这次调用没有执行压缩，绝不能报成功
        useHelixStore.getState().showToast({
          type: "warning",
          title: "压缩进行中",
          description: r.message || "另一个压缩任务正在运行，请稍后再试",
        });
        return "busy";
      } else {
        // 未知响应形状：不做 toast，仅静默（避免误报"已压缩"）
        debug("[Helix] /compact: unrecognized compress response", r);
        return "ok";
      }
    }
    return "ok";
  } catch (e) {
    // compress 抛错（区别于上面结构化的 error 响应）：按统一规则判定。
    // 不能只凭 "session not found" 清映射或标 broken——serve 模式下它指
    // 内存 ui_session 丢失，磁盘文件可能还在。做一次权威 resume 检查，
    // 只有文件确实没了才标 broken；其余保留 sid 让用户重试。
    if (
      currentSessionId &&
      classifyResumeError(e).code === "SESSION_NOT_FOUND"
    ) {
      const gone = await sessionFileGone(compressSid);
      if (gone) {
        useHelixStore.getState().markSessionBroken(currentSessionId, String(e));
      }
    }
    useHelixStore.getState().showToast({
      type: "error",
      title: "压缩失败",
      description: String(e),
    });
    return "error";
  } finally {
    useHelixStore.getState().clearCompressionBusyForSession(busySessionKey);
  }
}
