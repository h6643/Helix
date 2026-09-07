/**
 * Compact notice slice — 压缩完成提示（transcript 内的 inline divider）。
 * 手动 /compact 与自动压缩（context-usage）成功后写入；agent-flow-panel
 * 渲染为消息流中的横线提示，持久化显示直到切换会话或下次压缩覆盖。
 */
import type { StateCreator } from "zustand";

export interface CompressionNotice {
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
  /** 压缩进行中标记：手动 /compact 与自动压缩共用，防止并发触发
   *  （后端压缩锁冲突会让第二次调用返回 lock_held，看起来像"没压缩"）。 */
  compressionBusy: boolean;
  setCompressionBusy: (busy: boolean) => void;
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
  setCompressionNotice: (notice) =>
    set((state) => ({
      compressionNotices: {
        ...state.compressionNotices,
        [notice.sessionId || "__draft__"]: notice,
      },
    })),
  clearCompressionNotice: (sessionId) =>
    set((state) => {
      if (!sessionId) return { compressionNotices: {} };
      const { [sessionId]: _, ...rest } = state.compressionNotices;
      return { compressionNotices: rest };
    }),
  compressionBusy: false,
  setCompressionBusy: (busy) => set({ compressionBusy: busy }),
  backendCompressionCounts: {},
  setBackendCompressionCount: (sessionId, count) =>
    set((state) => ({
      backendCompressionCounts: {
        ...state.backendCompressionCounts,
        [sessionId]: count,
      },
    })),
});
