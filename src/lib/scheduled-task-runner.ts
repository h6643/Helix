/**
 * Global scheduled task runner — runs independently of any component mount.
 * Checks every 30 seconds for due tasks and dispatches them via Hermes.
 */
import { useHelixStore } from '@/stores/helix-store'
import { useHermesStore } from '@/stores/hermes-store'

let _started = false

function parseSchedule(text: string): { nextRun: number | null; error?: string } {
  const now = Date.now()
  const t = text.trim().toLowerCase()
  if (t === 'every minute') return { nextRun: now + 60_000 }
  if (t === 'every hour') return { nextRun: now + 3_600_000 }
  if (t === 'every day') return { nextRun: now + 86_400_000 }
  // Try parsing as ms duration
  const ms = Number(t)
  if (!isNaN(ms) && ms > 0) return { nextRun: now + ms }
  return { nextRun: null, error: `无法解析计划: ${text}` }
}

async function runTask(task: { id: string; label: string; prompt: string }) {
  const { addChatMessage, updateScheduledTask, showToast } = useHelixStore.getState()
  const sessionId = useHermesStore.getState().hermesSessionId

  // Add system message to chat
  addChatMessage({ role: 'system', content: `[定时任务] ${task.label}: ${task.prompt}` })

  if (sessionId) {
    // Actually send to Hermes
    try {
      await window.electron.hermes.send('session/prompt', {
        session_id: sessionId,
        prompt: [{ type: 'text', text: task.prompt }],
      })
    } catch (e) {
      console.error('[ScheduledTask] Failed to dispatch to Hermes:', e)
    }
  }

  // Update last/next run
  updateScheduledTask(task.id, { lastRunAt: Date.now() })
  const parsed = parseSchedule(task.label) // Use scheduleText from task
  if (parsed.nextRun) {
    updateScheduledTask(task.id, { nextRunAt: parsed.nextRun })
  }

  showToast({ type: 'info', title: `定时任务 "${task.label}" 已触发` })
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
