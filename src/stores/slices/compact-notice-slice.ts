/**
 * Compact notice slice — 压缩完成提示（transcript 内的 inline divider）。
 * 手动 /compact 与自动压缩（context-usage）成功后写入；agent-flow-panel
 * 渲染为消息流中的横线提示，持久化显示直到切换会话或下次压缩覆盖。
 */
import type { StateCreator } from "zustand";
import { useHelixStore } from "@/stores/helix-store";

interface CompressionNotice {
  ts: number;
  sessionId?: string;
  source: "auto" | "manual";
  anchorMessageId?: string;
  removed?: number;
  beforeTokens?: number;
  afterTokens?: number;
  messageCount?: number;
}

export interface CompactNoticeSlice {
  compressionNotices: Record<string, CompressionNotice>;
  setCompressionNotice: (notice: CompressionNotice) => void;
  clearCompressionNotice: (sessionId?: string) => void;
  /** 压缩进行中标记：按会话 key（后端 sid，缺失时用前端会话 id）记录。手动
   *  /compact 与自动压缩共用，防止同一会话并发触发（后端压缩锁冲突会让第二次
   *  调用返回 lock_held，看起来像"没压缩"）。后端压缩锁本身是每会话的，所以
   *  这里也必须按会话——原先的全局单值会让 spinner 在切换对话后仍跟着显示，
   *  并且 A 会话压缩时误挡 B 会话的发送。 */
  compressionBusyBySession: Record<string, boolean>;
  setCompressionBusyForSession: (sessionId: string, busy: boolean) => void;
  clearCompressionBusyForSession: (sessionId: string) => void;
  isSessionCompressionBusy: (sessionId?: string) => boolean;
  /** 每对话的后端 compressions 累计计数快照（usage 载荷透传）。计数器增长
   *  = 后端在工具循环中途自发压缩（前端不可见），agent-flow-panel 据此显示
   *  divider 提示（"上下文数量无故变小"的可见化）。网关重启后后端计数从 0
   *  重新累计，`compressions > prev` 守卫下旧快照只导致漏报，不会误报。 */
  backendCompressionCounts: Record<string, number>;
  setBackendCompressionCount: (sessionId: string, count: number) => void;
}

export const createCompactNoticeSlice: StateCreator<
  CompactNoticeSlice,
  [],
  [],
  CompactNoticeSlice
> = (set) => ({
  compressionNotices: {},
  setCompressionNotice: (notice) => {
    set((state) => ({
      compressionNotices: {
        ...state.compressionNotices,
        [notice.sessionId || "__draft__"]: notice,
      },
    }));
    // 顺手落盘压缩记录：内存 notice 只在这一次 UI 会话存活，重启后 divider
    // 就没了。这里把 notice 转成持久化记录（键与上面的内存 map 一致——
    // draft 期两边都是 "__draft__"），下次启动 / 切会话按会话回填。
    // setCompressionNotice 是压缩提示的**唯一**写入点（手动 /compact、
    // 自动压缩、后端 in-turn 压缩三处都走它），所以集中在这里持久化，
    // 不用每个调用方重复一遍。
    const key = notice.sessionId || "__draft__";
    useHelixStore.getState().appendCompressionRecord({
      ts: notice.ts,
      sessionId: key,
      source: notice.source,
      anchorMessageId: notice.anchorMessageId,
      removed: notice.removed,
      beforeTokens: notice.beforeTokens,
      afterTokens: notice.afterTokens,
      messageCount: notice.messageCount,
    });
  },
  clearCompressionNotice: (sessionId) =>
    set((state) => {
      if (!sessionId) return { compressionNotices: {} };
      const { [sessionId]: _, ...rest } = state.compressionNotices;
      return { compressionNotices: rest };
    }),
  compressionBusyBySession: {},
  setCompressionBusyForSession: (sessionId, busy) =>
    set((state) => ({
      compressionBusyBySession: {
        ...state.compressionBusyBySession,
        [sessionId]: busy,
      },
    })),
  clearCompressionBusyForSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.compressionBusyBySession)) return {};
      const { [sessionId]: _, ...rest } = state.compressionBusyBySession;
      return { compressionBusyBySession: rest };
    }),
  isSessionCompressionBusy: (sessionId) => {
    const s = useHelixStore.getState();
    return !!s.compressionBusyBySession[sessionId ?? "__draft__"];
  },
  backendCompressionCounts: {},
  setBackendCompressionCount: (sessionId, count) =>
    set((state) => ({
      backendCompressionCounts: {
        ...state.backendCompressionCounts,
        [sessionId]: count,
      },
    })),
});
