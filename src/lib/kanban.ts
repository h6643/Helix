import { getElectronAPI } from '@/lib/electron-bridge'

/**
 * Renderer-side Kanban API — thin typed wrapper over the main-process
 * `hermes kanban <verb>` bridge (see electron/ipc/kanban.js). All calls are
 * Electron-only; in browser mode they return `{ ok: false }` style results so
 * the UI can degrade gracefully.
 *
 * Arg ordering note: `--board <slug>` must come BEFORE the subcommand
 * (`hermes kanban --board <slug> list ...`). The main process places it
 * between the `kanban` token and the verb, so callers only pass the verb's
 * own arguments via `opts.board`.
 */

export type KanbanStatus = 'triage' | 'todo' | 'scheduled' | 'ready' | 'running' | 'blocked' | 'review' | 'done' | 'archived'

export interface KanbanBoard {
  slug: string
  name: string
  description: string
  icon: string
  color: string
  default_workdir: string | null
  created_at: string | null
  archived: boolean
  db_path: string
  is_current: boolean
  counts: Record<string, number>
  total: number
}

export interface KanbanTask {
  id: string
  title: string
  body: string | null
  assignee: string | null
  status: KanbanStatus
  priority: number
  tenant: string | null
  workspace_kind: string | null
  workspace_path: string | null
  branch_name: string | null
  project_id: string | null
  created_by: string | null
  created_at: number | null
  started_at: number | null
  completed_at: number | null
  result: string | null
  skills: string[]
  max_retries: number | null
  model_override: string | null
  provider_override: string | null
  session_id: string | null
  workflow_template_id: string | null
  current_step_key: string | null
}

export interface KanbanComment {
  id?: string
  body: string
  author: string | null
  created_at: number | null
}

export interface KanbanEvent {
  kind: string
  payload?: Record<string, unknown>
  created_at: number | null
  run_id: string | null
}

export interface KanbanRun {
  id?: string
  profile: string
  outcome: string
  elapsed: number | null
  summary: string | null
}

export interface KanbanTaskDetail {
  task: KanbanTask
  latest_summary: string | null
  parents: string[]
  children: string[]
  comments: KanbanComment[]
  events: KanbanEvent[]
  runs: KanbanRun[]
}

export interface KanbanAssignee {
  name: string
  on_disk: boolean
  counts: Record<string, number>
}

export interface KanbanResult<T = unknown> {
  ok: boolean
  data?: T
  stdout?: string
  stderr?: string
  code?: number
  error?: string
}

interface InvokeOptions {
  board?: string
  json?: boolean
}

async function invoke(verb: string, args: string[] = [], opts: InvokeOptions = {}): Promise<KanbanResult> {
  const api = getElectronAPI()
  if (!api) {
    return { ok: false, error: '看板功能仅在桌面版可用' }
  }
  if (!api.kanban) {
    // Old preload/main: the running app predates the kanban IPC bridge.
    return { ok: false, error: '看板 IPC 未加载：当前运行的仍是旧版应用，请完全重启 Helix（或重新打包）后再试' }
  }
  return api.kanban.invoke(verb, args, opts.json ?? false, opts.board)
}

function cast<T>(res: KanbanResult): KanbanResult<T> {
  return res as KanbanResult<T>
}

export async function kanbanListBoards(): Promise<KanbanResult<KanbanBoard[]>> {
  return cast(await invoke('boards', ['list'], { json: true }))
}

export async function kanbanListTasks(board?: string): Promise<KanbanResult<KanbanTask[]>> {
  return cast(await invoke('list', [], { board, json: true }))
}

export async function kanbanTaskDetail(taskId: string, board?: string): Promise<KanbanResult<KanbanTaskDetail>> {
  return cast(await invoke('show', [taskId], { board, json: true }))
}

export async function kanbanCreateTask(
  params: { title: string; body?: string; assignee?: string; priority?: number; initialStatus?: 'blocked' | 'running' },
  board?: string,
): Promise<KanbanResult<KanbanTask>> {
  const args: string[] = []
  if (params.body) args.push('--body', params.body)
  if (params.assignee) args.push('--assignee', params.assignee)
  if (typeof params.priority === 'number') args.push('--priority', String(params.priority))
  if (params.initialStatus) args.push('--initial-status', params.initialStatus)
  args.push(params.title)
  return cast(await invoke('create', args, { board, json: true }))
}

export async function kanbanAssign(taskId: string, profile: string | null, board?: string): Promise<KanbanResult> {
  return invoke('assign', [taskId, profile || 'none'], { board })
}

export async function kanbanAddComment(taskId: string, text: string, author?: string, board?: string): Promise<KanbanResult> {
  const args: string[] = []
  if (author) args.push('--author', author)
  args.push(taskId, text)
  return invoke('comment', args, { board })
}

export async function kanbanBlock(taskId: string, reason?: string, board?: string): Promise<KanbanResult> {
  const args = reason ? [taskId, reason] : [taskId]
  return invoke('block', args, { board })
}

export async function kanbanUnblock(taskId: string, board?: string): Promise<KanbanResult> {
  return invoke('unblock', [taskId], { board })
}

export async function kanbanPromote(taskId: string, board?: string): Promise<KanbanResult> {
  return invoke('promote', [taskId], { board })
}

export async function kanbanComplete(taskId: string, board?: string): Promise<KanbanResult> {
  return invoke('complete', [taskId], { board })
}

export async function kanbanArchive(taskId: string, board?: string): Promise<KanbanResult> {
  return invoke('archive', [taskId], { board })
}

export async function kanbanBoardCreate(
  slug: string,
  opts: { name?: string; description?: string; icon?: string; color?: string; switchTo?: boolean } = {},
): Promise<KanbanResult> {
  const args: string[] = []
  if (opts.name) args.push('--name', opts.name)
  if (opts.description) args.push('--description', opts.description)
  if (opts.icon) args.push('--icon', opts.icon)
  if (opts.color) args.push('--color', opts.color)
  if (opts.switchTo) args.push('--switch')
  args.push(slug)
  return invoke('boards', ['create', ...args])
}

export async function kanbanBoardSwitch(slug: string): Promise<KanbanResult> {
  return invoke('boards', ['switch', slug])
}

export async function kanbanBoardDelete(slug: string): Promise<KanbanResult> {
  return invoke('boards', ['delete', slug])
}

export async function kanbanAssignees(board?: string): Promise<KanbanResult<KanbanAssignee[]>> {
  return cast(await invoke('assignees', [], { board, json: true }))
}

/** Statuses shown as columns on the board. Other statuses land in a catch-all column. */
export const KANBAN_COLUMNS: KanbanStatus[] = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done']

export const STATUS_ICONS: Record<KanbanStatus, string> = {
  triage: '?',
  todo: '◻',
  scheduled: '⏱',
  ready: '▶',
  running: '●',
  blocked: '⊘',
  review: '☑',
  done: '✓',
  archived: '—',
}

export const STATUS_LABELS: Record<KanbanStatus, string> = {
  triage: '待分类',
  todo: '待办',
  scheduled: '已调度',
  ready: '就绪',
  running: '进行中',
  blocked: '阻塞',
  review: 'Review',
  done: '已完成',
  archived: '已归档',
}

/** Statuses a card may be moved TO directly (column view drag & drop). */
export const STATUS_TRANSITIONS: Partial<Record<KanbanStatus, KanbanStatus[]>> = {
  triage: ['todo', 'scheduled', 'ready'],
  todo: ['scheduled', 'ready', 'blocked', 'done'],
  scheduled: ['ready', 'running'],
  ready: ['running', 'blocked'],
  running: ['blocked', 'review', 'done'],
  blocked: ['ready', 'running'],
  review: ['done', 'running'],
  done: [],
  archived: [],
}
