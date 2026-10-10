/**
 * 自动归档旧任务 —— 前端定时扫描本地会话（IndexedDB 的 sessions 表）。
 *
 * 为什么不在 Rust 侧跑：会话只存在于 webview 的 IndexedDB，后端读不到；后端的
 * 计划任务引擎（scheduled_tasks.rs）只会往 pi 会话里派提示词，做不了这件事。
 *
 * 候选条件（四条全满足才归档）：
 * - 超过保留期：savedAt（= 最后一条消息的时间）早于 now - 保留天数
 * - 未置顶：全局置顶、工作区置顶都没打
 * - 无未读：lastViewedAt >= savedAt，即跑完的结果被人打开看过
 * - 已完成：不在流式输出、没有挂起的审批卡、也不是当前正打开的会话
 */
import type { PersistedSession } from "@/lib/persist";
import { useHelixStore } from "@/stores/helix-store";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 保留期以「天」为单位，6 小时扫一次已经足够细。 */
const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 启动后延迟首扫：等 restoreFromStorage 把设置和会话状态读回来。 */
const STARTUP_DELAY_MS = 30_000;

type ScanState = Pick<
  ReturnType<typeof useHelixStore.getState>,
  | "autoArchiveOldTasks"
  | "autoArchiveRetentionDays"
  | "currentSessionId"
  | "streamingDrafts"
  | "sessionPendingApproval"
>;

function isArchiveCandidate(
  s: PersistedSession,
  cutoff: number,
  st: ScanState,
): boolean {
  if (s.isArchived || s.isPinned || s.pinnedInProject) return false;
  if (s.id === st.currentSessionId) return false;
  if (st.streamingDrafts[s.id]?.isAgentRunning) return false;
  if (st.sessionPendingApproval[s.id]) return false;
  if (s.savedAt >= cutoff) return false;
  // 缺 lastViewedAt 的是升级前的老数据，没人在它上面盖过「已读」戳。不拦归档：
  // 它能进候选就说明整段保留期里没人动过，正是自动归档要收拾的对象。
  if (s.lastViewedAt !== undefined && s.lastViewedAt < s.savedAt) return false;
  return true;
}

function collectArchiveCandidates(
  sessions: PersistedSession[],
  st: ScanState,
  now = Date.now(),
): string[] {
  // 下限 1 天：配置导入可以塞进任意数字，0 会把所有历史任务一次带走。
  const cutoff = now - Math.max(1, st.autoArchiveRetentionDays) * DAY_MS;
  return sessions
    .filter((s) => isArchiveCandidate(s, cutoff, st))
    .map((s) => s.id);
}

/** 跑一轮扫描，返回本轮归档的会话数（未开启开关时为 0）。 */
export async function runAutoArchiveScan(): Promise<number> {
  const st = useHelixStore.getState();
  if (!st.autoArchiveOldTasks) return 0;
  const { persistence } = await import("@/lib/persist");
  const sessions = await persistence.loadSessions();
  const ids = collectArchiveCandidates(sessions, st);
  if (ids.length === 0) return 0;
  const archived = await persistence.archiveSessionsByIds(ids);
  if (archived === 0) return 0;
  // 侧边栏读的是 IndexedDB，靠这个版本号重取列表。
  st.notifySessionSaved();
  st.showToast({
    type: "info",
    title: `已自动归档 ${archived} 个旧任务`,
    description: "可在 设置 → 任务 中查看或恢复",
    duration: 6000,
  });
  return archived;
}

let _started = false;

export function startAutoArchiveRunner(): void {
  if (_started) return;
  _started = true;
  setTimeout(() => void runAutoArchiveScan(), STARTUP_DELAY_MS);
  setInterval(() => void runAutoArchiveScan(), SCAN_INTERVAL_MS);
}
