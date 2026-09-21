/**
 * session-map.ts — conversation → 后端 Helix 会话映射的读写。
 *
 * 从 agent-flow-panel.tsx 拆出（该文件导出非组件成员会破坏 React Fast
 * Refresh，导致 Vite 每次 HMR 全量刷新页面）。会话恢复逻辑（/resync、
 * 压缩自愈）通过 resolveBackendSid 读取映射。
 */

export type SessionMapEntry = {
  sid: string;
  epoch: number;
  storedId?: string;
  /** 本对话历史上用过的全部后端 sid（含当前 sid）。/clear、重启重建会让
   *  对话换新 sid，但旧 sid 名下的磁盘委托记录仍属于这个对话——rehydrate
   *  按整个列表查询，子 Agent 历史才不会随会话重置消失。 */
  sids?: string[];
};

export const SESSION_MAP_KEY = "conversationSessions";

export async function loadSessionMap(): Promise<Map<string, SessionMapEntry>> {
  try {
    const { persistence } = await import("@/lib/persist");
    const raw =
      await persistence.loadSetting<Record<string, SessionMapEntry>>(
        SESSION_MAP_KEY,
      );
    const map = new Map<string, SessionMapEntry>();
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.sid === "string" && typeof v.epoch === "number")
          map.set(k, v);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Resolve every backend sid a conversation has ever used (oldest first,
 *  current sid included) — delegations_list matches disk manifests against
 *  this whole set. */
export async function resolveBackendSids(
  conversationId: string | null | undefined,
): Promise<string[]> {
  if (!conversationId) return [];
  const map = await loadSessionMap();
  const entry = map.get(conversationId);
  if (!entry) return [];
  const all = new Set([...(entry.sids || []), entry.sid]);
  return [...all].filter(Boolean);
}

/** 供会话恢复逻辑（/resync、压缩自愈）读取 conversation→后端会话映射：
 *  返回某对话 id 对应的后端 sid。
 *  2026-08-31 对齐官方桌面版语义：后端 SessionManager 把会话持久化到
 *  state.db，内存未命中时 get_session() 会透明恢复（_restore 重建 AIAgent
 *  + 历史）。因此 epoch 不匹配（网关重启）不再视为会话死亡——直接把
 *  持久化 sid 交给调用方，由后端判定死活（恢复成功 or 真正 not found），
 *  调用方各自兜底。 */
export async function resolveBackendSid(
  conversationId: string | null | undefined,
): Promise<string | null> {
  if (!conversationId) return null;
  const map = await loadSessionMap();
  return map.get(conversationId)?.sid ?? null;
}

let loadPromise: Promise<Map<string, SessionMapEntry>> | null = null;

/**
 * Memoized 加载：同一进程内所有调用方共享同一个 promise。
 *
 * handleRun 靠 `await ensureSessionMapLoaded()` 作为**硬门槛**——在此之前
 * sessionMap 不是可信事实源。冷启动时内存 Map 还是空的，若在门槛之前提前捕获
 * `existing`，会拿到 `undefined` 并被判成"全新对话"，`session/new` 铸造一个空
 * 会话覆盖映射，旧历史从此对不上（2026-09-20 `01a0bce1` → `01a0befe` 那次
 * 丢失就是这条路径：重启后 3 分 17 秒发的第一条消息，`msgs=0 seed_len=0`）。
 *
 * 语义是「加载未完成 → 暂停等待」，不是「没加载好就 fallback 成空」。
 */
export function ensureSessionMapLoaded(): Promise<Map<string, SessionMapEntry>> {
  if (!loadPromise) {
    loadPromise = loadSessionMap();
  }
  return loadPromise;
}

/** 磁盘写入后调用：memoized 结果作废，下一次 await 重新读盘。 */
export function invalidateSessionMapCache(): void {
  loadPromise = null;
}

/**
 * 按 key 合并写，**绝不用内存 Map 整表覆盖**。
 *
 * 冷启动阶段内存 Map 可能还是空的；整表覆盖会把其它对话的 sid 一起抹掉，造成
 * "明明之前有 SID，为什么 map 后来没了"——那是 handleRun 之外第二个独立的 SID
 * 丢失制造器。这里以磁盘现值为准，只落本次改动的 key（`null` = 删除该 key），
 * 未提及的 key 原样保留。
 */
export async function persistSessionMapEntries(
  patch: Iterable<readonly [string, SessionMapEntry | null]>,
): Promise<void> {
  const db = await loadSessionMap();
  for (const [key, value] of patch) {
    if (value === null) db.delete(key);
    else db.set(key, value);
  }
  const obj: Record<string, SessionMapEntry> = {};
  db.forEach((value, key) => {
    obj[key] = value;
  });
  const { persistence } = await import("@/lib/persist");
  await persistence.saveSetting(SESSION_MAP_KEY, obj);
  invalidateSessionMapCache();
}

/**
 * 删除对话后同步清理磁盘反向索引（~/.pi/agent/conversation-index.json）里
 * 的对应条目。conversation-index.json 是 sid → conversation 的只增不减兜底
 * 索引，删除对话不清理的话条目会永久残留（该文件唯一的收敛点是这里）。
 * 尽力而为：索引清理失败绝不影响对话删除。
 */
export async function removeConversationIndex(
  conversationIds: string | string[],
): Promise<void> {
  const ids = Array.isArray(conversationIds)
    ? conversationIds.filter(Boolean)
    : conversationIds
      ? [conversationIds]
      : [];
  if (ids.length === 0) return;
  try {
    const { electronHelix } = await import("@/lib/electron-bridge");
    await electronHelix.send("session/index_del", {
      conversation_ids: ids,
    });
  } catch {
    /* best-effort */
  }
}
