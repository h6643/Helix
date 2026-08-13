/**
 * 自动归档旧任务 — 定时扫描最近打开过的工作区，把「已完成、超过保留时长」的
 * 看板任务自动归档，让看板不会被完成的老任务堆满。
 *
 * 候选判定（对齐设置项文案「已完成、无未读、未置顶且超过保留期」）：
 * - 已完成：`status === 'done'`。
 * - 无未读 / 未置顶：看板任务没有 unread/pinned 字段，这两个条件退化为
 *   「保留时长内没有被任何人碰过」——即最后活动时间早于保留时长。
 * - 超过保留期：最后活动时间 = max(created_at, started_at, completed_at)，
 *   早于 (now - retentionHours) 才进入归档候选。
 *
 * 工作区范围：只扫描绑定到「最近打开过的工作区」（projectFolders + 会话
 * workDir）的看板；未绑定目录的默认看板也扫。归档通过 `hermes kanban
 * archive` 完成，失败的任务计入 skipped 不会重试到报错。
 */

import { getElectronAPI } from '@/lib/electron-bridge'
import { kanbanArchive, kanbanListBoards, kanbanListTasks, type KanbanTask } from '@/lib/kanban'
import { persistence } from '@/lib/persist'

/** 扫描节奏：至少间隔 6 小时才扫一次（应用重启后由上次扫描时间兜底去重）。 */
export const AUTO_ARCHIVE_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000

const LAST_SCAN_KEY = 'autoArchiveLastScanAt'

export interface AutoArchiveResult {
  scannedBoards: number
  archived: string[]
  skipped: number
  error?: string
}

/** 任务最后一次活动时间（秒）。看板没有 updated_at，用生命周期时间戳取最大。 */
export function lastActivityOfTask(t: KanbanTask): number | null {
  const times = [t.created_at, t.started_at, t.completed_at].filter(
    (v): v is number => typeof v === 'number' && v > 0
  )
  return times.length > 0 ? Math.max(...times) : null
}

/** 最近打开过的工作区：持久化的项目文件夹 + 已有会话的 workDir。 */
export async function recentWorkspaceDirs(): Promise<string[]> {
  const dirs = new Set<string>()
  for (const d of await persistence.getProjectFolders()) {
    if (d && d !== '/' && d !== '\\') dirs.add(d)
  }
  try {
    const sessions = await persistence.loadSessions()
    for (const s of sessions) {
      if (s.workDir && s.workDir !== '/' && s.workDir !== '\\') dirs.add(s.workDir)
    }
  } catch {
    // 会话读取失败不影响项目文件夹部分
  }
  return [...dirs]
}

/** 跑一次自动归档扫描。任何看板 IPC 不可用 / 单次归档失败都降级为跳过。 */
export async function runAutoArchiveScan(retentionHours: number): Promise<AutoArchiveResult> {
  const api = getElectronAPI()
  if (!api?.kanban) {
    return { scannedBoards: 0, archived: [], skipped: 0, error: '看板功能仅在桌面版可用' }
  }

  const recent = new Set(await recentWorkspaceDirs())
  const cutoff = Date.now() / 1000 - Math.max(1, retentionHours) * 3600
  const boards = (await kanbanListBoards()).data ?? []

  const archived: string[] = []
  let scannedBoards = 0
  let skipped = 0

  for (const board of boards) {
    if (board.archived) continue
    // 只扫描「最近打开过的工作区」：板绑定目录时要求命中最近目录；未绑定目录的板（默认板）照扫。
    const wd = board.default_workdir
    if (wd && !recent.has(wd)) continue
    scannedBoards++
    const tasks = (await kanbanListTasks(board.slug)).data ?? []
    for (const t of tasks) {
      if (t.status !== 'done') {
        skipped++
        continue
      }
      const last = lastActivityOfTask(t)
      if (last == null || last >= cutoff) {
        // 无时间戳或保留时长内仍被更新 → 不是归档候选
        skipped++
        continue
      }
      const res = await kanbanArchive(t.id, board.slug)
      if (res.ok) {
        archived.push(t.id)
      } else {
        skipped++
      }
    }
  }

  return { scannedBoards, archived, skipped }
}

/** 是否该执行一次扫描（按 6h 节奏去重，跨重启生效）。 */
export async function shouldScanNow(now: number = Date.now()): Promise<boolean> {
  const last = await persistence.loadSetting<number>(LAST_SCAN_KEY).catch(() => null)
  return last == null || now - last >= AUTO_ARCHIVE_SCAN_INTERVAL_MS
}

export async function markScanDone(now: number = Date.now()): Promise<void> {
  await persistence.saveSetting(LAST_SCAN_KEY, now).catch(() => {})
}
