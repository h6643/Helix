/**
 * Compression records slice — 把压缩完成提示持久化，跨重启恢复对话流里的
 * 压缩 divider。
 *
 * 背景：`compressionNotices` 只做内存 map，切会话时由 agent-flow-panel 的
 * 切换 effect 显式清空，冷启动也必然为空。结果是压缩完那条「213k → 16k ·
 * 减少 208k」的分隔线在重启后直接消失，用户看不出历史里曾经压缩过一次。
 *
 * 这份持久化是**压缩事件的模型侧记录**：它写的是压缩前后的 token 对比和
 * 压缩点所在的本地消息 id（anchorMessageId），不是消息内容本身，所以不
 * 与后端 jsonl 的 compaction 行重复。渲染侧的 `compressionNotice` 是每会话
 * 的「最新一条」视图，由本 slice 在启动 / 切会话时按会话回填；live 压缩
 * （context-usage 的自动压缩、slash-commands 的 /compact）在写完内存 notice
 * 后顺手调 `appendCompressionRecord` 落盘。
 */
import type { StateCreator } from "zustand";

/** 压缩事件的持久化记录。锚点是**本地**消息 id（generateId），后端
 *  session.compress 回包里拿不到；anchorMessageId 缺失时渲染侧退化为把
 * 分隔线 append 到对话末尾。 */
export interface PersistedCompressionRecord {
  /** 压缩完成时刻（ms）。同一会话内单调递增，用于取最新一条。 */
  ts: number;
  /** 归属的 UI 会话 id（draft 期为 "__draft__"）。 */
  sessionId: string;
  source: "auto" | "manual";
  anchorMessageId?: string;
  removed?: number;
  beforeTokens?: number;
  afterTokens?: number;
  messageCount?: number;
}

export interface CompressionRecordsSlice {
  /** 按会话持久化的压缩记录列表，按 ts 升序追加，最新一条永远在尾部。
   *  与 `compressionNotices` 的区别：那个是内存里的「当前会话最新一条」，
   *  这个是跨重启的完整历史。 */
  compressionRecordsBySession: Record<string, PersistedCompressionRecord[]>;
  /** 追加一条压缩记录并立即落盘。sessionId 与内存 notice 的键保持一致
   *  （draft 期用 "__draft__"），保证回填时能对上号。 */
  appendCompressionRecord: (record: PersistedCompressionRecord) => void;
  /** 取某会话最新一条压缩记录；无记录返回 null。 */
  getLatestCompressionRecord: (sessionId: string) => PersistedCompressionRecord | null;
}

/** 存储键。与 `contextUsage` / `sessionUsageStats` 同族——都是持久化的
 *  per-conversation 状态，重启后要重建 UI 视图。 */
const COMPRESSION_RECORDS_KEY = "compressionRecords";

export const createCompressionRecordsSlice: StateCreator<
  CompressionRecordsSlice,
  [],
  [],
  CompressionRecordsSlice
> = (set, get) => ({
  compressionRecordsBySession: {},

  appendCompressionRecord: (record) => {
    if (!record.sessionId || !record.ts) return;
    const list = get().compressionRecordsBySession[record.sessionId] ?? [];
    // 幂等：同一 ts 的记录不重复追加（压缩事件本身是幂等的，重试不会产生
    // 第二条；用 ts 判重即可，不依赖 ts 严格单调递增）。
    if (list.some((r) => r.ts === record.ts)) return;
    const nextList = [...list, record];
    set((s) => ({
      compressionRecordsBySession: {
        ...s.compressionRecordsBySession,
        [record.sessionId]: nextList,
      },
    }));
    // 与 setContextUsage 同口径：即时落盘，不等 persistToStorage 的整批写。
    // 失败静默——压缩记录只是 UI 提示，失败不阻断压缩本身。
    import("@/lib/persist")
      .then(({ persistence }) =>
        persistence
          .saveSetting(COMPRESSION_RECORDS_KEY, get().compressionRecordsBySession)
          .catch(() => {}),
      )
      .catch(() => {});
  },

  getLatestCompressionRecord: (sessionId) => {
    if (!sessionId) return null;
    const list = get().compressionRecordsBySession[sessionId];
    if (!list || list.length === 0) return null;
    return list[list.length - 1] ?? null;
  },
});

/** 启动 / 切会话时按会话回填 `compressionNotices`。
 *
 *  - 只填 `compressionNotices` 里**没有**的会话：live 压缩写内存 notice 后
 *    立刻调 `appendCompressionRecord`，两者同刻、同 sessionId，所以内存里
 *    有 entry 时它必然是最新的，不需要被持久化覆盖。
 *  - 清空后回填（切会话 effect 先 clear 再 load）：清空的是当前会话 key，
 *    回填的也是当前会话 key，不会把别的会话的记录串过来。
 *  - loadSetting 抛错或返回空时不写：避免用坏数据覆盖已有的正确内存值。
 *
 * 返回的形状就是 `compact-notice-slice` 里未导出的 `CompressionNotice`
 *  interface——这里不复用那个类型（它是 slice 内部实现），就地展开一份，
 *  避免为了一处调用把 slice 的内部类型公开。
 */
export async function loadCompressionNoticesFromPersistence(): Promise<
  Record<
    string,
    {
      ts: number;
      sessionId: string;
      source: "auto" | "manual";
      anchorMessageId?: string;
      removed?: number;
      beforeTokens?: number;
      afterTokens?: number;
      messageCount?: number;
    }
  >
> {
  try {
    const { persistence } = await import("@/lib/persist");
    const records = await persistence.loadSetting<
      Record<string, PersistedCompressionRecord[]>
    >(COMPRESSION_RECORDS_KEY);
    if (!records || typeof records !== "object" || Array.isArray(records))
      return {};

    // 只保留 shape 合法的最新一条；老数据（缺 ts/sessionId 的早期写入）跳过。
    const latestBySession: Record<
      string,
      {
        ts: number;
        sessionId: string;
        source: "auto" | "manual";
        anchorMessageId?: string;
        removed?: number;
        beforeTokens?: number;
        afterTokens?: number;
        messageCount?: number;
      }
    > = {};
    for (const [sessionId, list] of Object.entries(records)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const latest = list[list.length - 1];
      if (!latest || typeof latest.ts !== "number" || !latest.sessionId) continue;
      latestBySession[sessionId] = {
        ts: latest.ts,
        sessionId: latest.sessionId,
        source: latest.source === "manual" ? "manual" : "auto",
        anchorMessageId: latest.anchorMessageId,
        removed: latest.removed,
        beforeTokens: latest.beforeTokens,
        afterTokens: latest.afterTokens,
        messageCount: latest.messageCount,
      };
    }
    return latestBySession;
  } catch {
    // 持久化读取失败时保持现状——内存里的 notice 仍然有效。
    return {};
  }
}
