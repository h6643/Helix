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

/**
 * 一个 entry 里**所有还能用的**后端 sid，新→旧。
 *
 * `sid` 是"当前 live 的那个"，`sids[]` 是历史（`rebindSessionSid` 按
 * `Set([...prev.sids, prev.sid, next.sid])` 追加 → 末尾最新）。sid 被清空后
 * 历史仍然留着，它就是恢复这个对话的唯一凭据，所以两者合并去重后整体返回。
 */
export function sidCandidates(entry: SessionMapEntry | undefined): string[] {
  if (!entry) return [];
  const all = [...(entry.sids || []), ...(entry.sid ? [entry.sid] : [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sid of all.reverse()) {
    if (sid && !seen.has(sid)) {
      seen.add(sid);
      out.push(sid);
    }
  }
  return out;
}

/**
 * 磁盘条目的**单调合并**（写盘护栏）。
 *
 * 唯一的不变量：**一个对话的 sid 不允许从"有"变成"空"**。
 *
 * 清空 sid 只会发生在某条代码路径误判"这个对话的后端会话该作废"的时候——
 * 例如 `selectedWorkDir` 变化的 effect：从历史里点开另一项目的对话会让
 * selectedWorkDir 跟着变，于是它把**当前**对话的 sid 清掉（2026-09-21 用户报
 * "该对话已失效"的元凶）。而清空的代价是对话永久失效：本地历史在、后端 jsonl
 * 也在，前端却再也找不到它。
 *
 * 把不变量下沉到写盘这一层，就是为了让它不再依赖"每一处写入方都写对"——
 * 将来（或被并行编辑的另一个会话）再引入一处清空代码，磁盘上的绑定也丢不了。
 * 送进来的空 sid 会被保留为磁盘现值，其余字段（epoch/storedId/sids）照常合并，
 * 所以 `epoch` 变新会让下一次 handleRun 走 resume 重新验证这个 sid——这正是
 * "想作废这个 live 会话"时唯一正确的做法。
 */
export function mergeSessionMapEntry(
  disk: SessionMapEntry | undefined,
  incoming: SessionMapEntry,
  cid?: string,
): SessionMapEntry {
  const diskSid = disk?.sid ?? "";
  const rejectBlank = !incoming.sid && !!diskSid;
  if (rejectBlank) {
    console.warn(
      "[Helix] 拒绝把 sid 写空：磁盘上是活的绑定，保留它（epoch 用新值以强制 resume）",
      { cid: cid ?? "(unknown)", keptSid: diskSid },
    );
  }
  const merged: SessionMapEntry = {
    ...(disk ?? {}),
    ...incoming,
    sid: rejectBlank ? diskSid : incoming.sid,
    storedId: incoming.storedId ?? disk?.storedId,
  };
  const all = new Set<string>();
  // 并集里必须带上**磁盘上的 live sid**：换新 sid（重建/rekey）时它就是"上一个
  // live sid"，也就是历史的一部分——旧 sid 名下的子 Agent 磁盘清单还要靠它归位。
  for (const s of [
    ...(disk?.sids ?? []),
    ...(disk?.sid ? [disk.sid] : []),
    ...(incoming.sids ?? []),
  ]) {
    if (s) all.add(s);
  }
  if (merged.sid) all.add(merged.sid);
  if (all.size > 0) merged.sids = [...all];
  else delete merged.sids;
  return merged;
}

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
        if (!v || typeof v.sid !== "string" || typeof v.epoch !== "number")
          continue;
        // 自愈：live sid 是空的，但历史里还有 sid → 用最新的那个当 live sid，
        // 并把 epoch 置 -1（≠ liveEpoch ⇒ 下一次 handleRun 走 resume）。不这样
        // 做的话，历史里明明有凭据、界面却显示"该对话已失效"。
        const sids = v.sids ?? [];
        const newest = sids[sids.length - 1];
        if (!v.sid && newest) {
          map.set(k, { ...v, sid: newest, epoch: -1 });
        } else {
          map.set(k, v);
        }
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
 *
 * 每个 key 的合并还走 `mergeSessionMapEntry`：**sid 不允许从"有"变成"空"**。
 * 于是"某处代码想把 live sid 作废"最坏只会变成"保留 sid + epoch 变新"，
 * 也就是下一次 handleRun 重新 resume 验证它 —— 而不是让对话永久失效。
 */
export async function persistSessionMapEntries(
  patch: Iterable<readonly [string, SessionMapEntry | null]>,
): Promise<void> {
  const db = await loadSessionMap();
  for (const [key, value] of patch) {
    if (value === null) db.delete(key);
    else db.set(key, mergeSessionMapEntry(db.get(key), value, key));
  }
  const obj: Record<string, SessionMapEntry> = {};
  db.forEach((value, key) => {
    obj[key] = value;
  });
  const { persistence } = await import("@/lib/persist");
  await persistence.saveSetting(SESSION_MAP_KEY, obj);
  invalidateSessionMapCache();
  // 反向索引（sid → conversation）在**这里**统一刷新，而不是交给各个调用方：
  // 它是磁盘上唯一能反查"这个 cid 原本绑的是哪个 sid"的东西，只要有一次 sid
  // 绑定没同步过去，那条对话在"映射丢了"之后就只剩余重建一条路。放在这里 =
  // 只要走的是本函数落盘，索引必然同步。
  await pushConversationIndex(db);
}

/**
 * 把整张映射冗余写进 `~/.pi/agent/conversation-index.json`（Rust 侧的
 * `session/index_put` 按 sid 反查 conversation）。尽力而为：失败只是让兜底少
 * 一层，绝不影响主流程。
 */
async function pushConversationIndex(
  map: Map<string, SessionMapEntry>,
): Promise<void> {
  const entries: Array<{ conversation_id: string; session_id: string }> = [];
  map.forEach((entry, cid) => {
    if (entry.sid) entries.push({ conversation_id: cid, session_id: entry.sid });
  });
  if (entries.length === 0) return;
  try {
    const { electronHelix } = await import("@/lib/electron-bridge");
    await electronHelix.send("session/index_put", { entries });
  } catch {
    /* best-effort */
  }
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
