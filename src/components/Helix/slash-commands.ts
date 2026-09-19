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
 * /compact 的自愈：会话映射缺失（网关重启后持久化写入丢失 / 对话从未建立
 * 后端会话）时，不再要求用户先发一条消息——发送路径（handleRun）在映射丢失
 * 时本来就自动走 session/new + seedHistory 重建，这里做同样的事，让 /compact
 * 就地可用。先用内存映射里残留的 storedId / sids 试透明 resume，全部失败再
 * 用本地 transcript 重建。返回可用 sid；失败返回 null（由调用方提示）。
 */
async function healMissingSession(
  currentSessionId: string,
  ctx: CompactContext,
): Promise<string | null> {
  const map = ctx.sessionMap;
  const entry = map.get(currentSessionId);

  // ① 内存映射还留着线索（比如 persistSessionMap 静默写失败、只有内存有值）：
  //    按 storedId / sid / sids 依次尝试透明 resume。
  const resumeCandidates = [
    entry?.storedId,
    entry?.sid,
    ...(entry?.sids ?? []),
  ].filter((v): v is string => Boolean(v));
  for (const resumeId of resumeCandidates) {
    try {
      const res = (await helixApi()?.send("session.resume", {
        session_id: resumeId,
      })) as any;
      if (res) {
        const restoredId = res?.session_id || res?.sessionID || resumeId;
        rebindSessionSid(map, currentSessionId, {
          sid: restoredId,
          epoch: useGatewayStore.getState().gatewayEpoch,
          storedId: entry?.storedId,
        });
        void persistSessionMap(map);
        debug("[Helix] /compact: healed via resume →", restoredId);
        return restoredId;
      }
    } catch {
      // 尝试下一个候选
    }
  }

  // ② 无线索 / resume 全失败：session/new 重建 + seedHistory 重放本地历史。
  const allMessages = useHelixStore.getState().chatMessages;
  const ownMessages = allMessages.filter(
    (m) => (m.sessionId || "") === currentSessionId,
  );
  // 对话本身没有本地历史，确实无可压缩：返回 null 走「先发一条消息」提示。
  if (ownMessages.length === 0) return null;
  // 与 handleRun 的 seedHistory 过滤一致：剔除上一次重建留下的「系统注入」种子
  // 块及其确认语，避免重放时逐次叠加。
  const seedHistory: Array<{ role: string; content: unknown }> = [];
  const isSeedMessage = (t: string) =>
    t.includes("（系统注入：以下是本次会话恢复的先前对话记录");
  let prevWasSeed = false;
  for (const m of ownMessages) {
    const text = normalizeAcpContent(m.content);
    if (isSeedMessage(text)) {
      prevWasSeed = true;
      continue;
    }
    if (prevWasSeed && m.role === "assistant") {
      prevWasSeed = false;
      continue;
    }
    prevWasSeed = false;
    seedHistory.push({ role: m.role, content: m.content });
  }
  try {
    const st0 = useHelixStore.getState();
    const res = (await helixApi()?.send("session/new", {
      mcpServers: buildAcpMcpServers(st0.mcpServers),
      messages: seedHistory,
      mode_id:
        st0.approvalModeBySession?.[currentSessionId] ?? st0.approvalMode,
      cwd: st0.activeSessionWorkDir ?? st0.selectedWorkDir ?? undefined,
    })) as any;
    const newSid =
      res?.session_id ||
      res?.sessionID ||
      res?.threadId ||
      (typeof res === "string" ? res : null);
    if (!newSid) return null;
    const storedId =
      (typeof res === "object" && res
        ? (res as any)?.stored_session_id
        : null) || undefined;
    rebindSessionSid(map, currentSessionId, {
      sid: newSid,
      epoch: useGatewayStore.getState().gatewayEpoch,
      storedId: storedId ?? entry?.storedId,
    });
    void persistSessionMap(map);
    useHelixStore.getState().showToast({
      type: "warning",
      title: "未能找回原后端会话，已新建并注入历史",
      description: "已用本地历史重建后端会话，压缩将基于重建后的会话执行",
    });
    debug("[Helix] /compact: healed via session/new →", newSid);
    return newSid;
  } catch (e) {
    debug("[Helix] /compact: heal via session/new failed", e);
    return null;
  }
}

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
    // 自愈：重启后映射缺失（持久化写入失败 / profile 变更 / 对话从未映射）时，
    // 不再要求用户「先发送一条消息建立会话」——发送路径本来就会走
    // session/new + seedHistory 重建，这里做同样的事，让 /compact 就地可用。
    if (!sid && currentSessionId) {
      sid = await healMissingSession(currentSessionId, ctx);
    }
    if (!sid) {
      useHelixStore.getState().showToast({
        type: "warning",
        title: "当前会话还没有后端会话",
        description: "先发送一条消息建立会话后再压缩",
      });
      return "no-session";
    }
    let result = await helixApi()?.send("session.compress", {
      session_id: sid,
    });
    // 会话不在内存（网关重启/空闲回收后）：与 prompt 路径一致，先
    // session.resume 从 state.db 捞回原会话再重试压缩，避免"压缩失败"。
    // resume 用 storedId（DB 主键）才能跨重启恢复；ui_session 查不到 DB 行。
    if (
      !result ||
      (typeof result === "object" && (result as any).error)
    ) {
      const errText = String((result as any)?.error || "");
      if (
        /session.*not.*found|not found|no such session|unknown session/i.test(
          errText,
        )
      ) {
        const entry = currentSessionId
          ? ctx.sessionMap.get(currentSessionId)
          : null;
        const resumeId = entry?.storedId || sid;
        debug("[Helix] /compact: session not in memory, trying resume →", resumeId);
        const resumeRes = await helixApi()
          ?.send("session.resume", { session_id: resumeId })
          .catch(() => null);
        if (resumeRes) {
          const restoredId = (resumeRes as any)?.session_id || resumeId;
          debug("[Helix] /compact: resumed, retrying compress");
          result = await helixApi()?.send("session.compress", {
            session_id: restoredId,
          });
        }
      }
    }
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
        useHelixStore.getState().setCompressionNotice({
          ts: Date.now(),
          sessionId: currentSessionId || DRAFT_SESSION_KEY,
          anchorMessageId,
          source: "manual",
          removed: Number(r.removed) || undefined,
          beforeTokens: Number(r.before_tokens) || undefined,
          afterTokens: Number(r.after_tokens) || undefined,
          messageCount: Number(r.after_messages) || undefined,
        });
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
    // 后端明确说会话不存在（从未跑过/已被删）：只清 live sid、保留
    // storedId/sids 历史——整条删除会把后续 resume 的最后线索烧掉（与
    // 会话恢复链的降级语义一致）。
    if (String(e).includes("session not found") && currentSessionId) {
      const entry = ctx.sessionMap.get(currentSessionId);
      if (entry) entry.sid = "";
      void persistSessionMap(ctx.sessionMap);
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
