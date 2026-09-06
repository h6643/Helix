/**
 * Global scheduled task runner — runs independently of any component mount.
 * Checks every 30 seconds for due tasks and dispatches them to a DEDICATED
 * Helix session so they never interrupt or pollute the active conversation.
 */
import { helixApi } from '@/lib/electron-bridge'
import { parseScheduleForTask } from '@/lib/schedule-utils'
import { useHelixStore } from '@/stores/helix-store'

let _started = false
// Cached Helix session ID for scheduled tasks (separate from any conversation).
let _taskSessionId: string | null = null

async function getOrCreateTaskSession(): Promise<string | null> {
  if (_taskSessionId) return _taskSessionId
  try {
    const res = await helixApi()!.send('session/new', {
      cwd: useHelixStore.getState().selectedWorkDir || '',
      mcpServers: [],
    }) as any
    const sid = res?._meta?.helix?.sessionProvenance?.acpSessionId
      || res?.session_id
      || res?.sessionID
      || (typeof res === 'string' ? res : null)
    if (sid) {
      _taskSessionId = sid
      return sid
    }
  } catch (e) {
    console.error('[ScheduledTask] Failed to create task session:', e)
  }
  return null
}

async function runTask(task: { id: string; label: string; prompt: string; scheduleText?: string }) {
  const { updateScheduledTask, showToast } = useHelixStore.getState()

  // Create / reuse a DEDICATED Helix session for background tasks — NEVER the
  // active conversation's session.  This prevents the task from polluting the
  // user's current conversation context or interrupting a running agent.
  const taskSid = await getOrCreateTaskSession()
  if (!taskSid) {
    showToast({ type: 'error', title: `定时任务 "${task.label}" 失败`, description: '无法创建后台会话' })
    updateScheduledTask(task.id, { lastRunAt: Date.now() })
    return
  }

  // Send the prompt to the DEDICATED session — NOT the active conversation.
  // The response events arrive with this session_id, which no active conversation's
  // onEvent handler claims (they filter by their own session_id), so the UI stays
  // untouched.  The task runs silently in the background.
  try {
    await helixApi()!.send('session/prompt', {
      session_id: taskSid,
      prompt: [{ type: 'text', text: task.prompt }],
    })
  } catch (e) {
    console.error('[ScheduledTask] Failed to dispatch:', e)
    // Session may have been invalidated (gateway restart) — reset and retry next cycle.
    _taskSessionId = null
  }

  updateScheduledTask(task.id, { lastRunAt: Date.now() })

  // Advance nextRunAt using the task's REAL schedule text (e.g. "明天上午10点"),
  // NOT the label (a human name like "工作提醒" that the old parseSchedule never
  // matched). The old code read task.label here, so nextRunAt never advanced and
  // the task re-fired every 30s forever — spamming the "已在后台执行" toast.
  const parsed = parseScheduleForTask(task.scheduleText || task.label || '')
  if (parsed.nextRun) {
    updateScheduledTask(task.id, { nextRunAt: parsed.nextRun })
  }

  // NOTE: intentionally NO per-run info toast. It fired every 30s and was pure
  // noise. Failures still surface via the error toast in the session branch above.
}

export function startScheduledTaskRunner() {
  if (_started) return
  _started = true

  setInterval(() => {
    const state = useHelixStore.getState()
    const now = Date.now()
    for (const task of state.scheduledTasks) {
      if (task.enabled && task.nextRunAt && task.nextRunAt <= now) {
        runTask(task)
      }
    }
  }, 30_000) // Check every 30 seconds
}
