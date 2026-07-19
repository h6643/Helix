/**
 * Schedule parsing utilities — extracted from agent-flow-panel.tsx.
 * Detects scheduled task definitions in LLM output and syncs them to the backend.
 */
import { useHelixStore } from '@/stores/helix-store'

/**
 * Parse a human schedule description into a next-run timestamp.
 */
export function parseScheduleForTask(text: string): { nextRun: number | null } {
  const lower = text.toLowerCase().trim()
  const minMatch = lower.match(/every\s+(\d+)\s*min(?:ute)?s?/)
  if (minMatch) return { nextRun: Date.now() + parseInt(minMatch[1]) * 60000 }
  const hourMatch = lower.match(/every\s+(\d+)\s*hour(?:s)?/)
  if (hourMatch) return { nextRun: Date.now() + parseInt(hourMatch[1]) * 3600000 }
  const dayMatch = lower.match(/every\s+day\s+at\s+(\d{1,2}):(\d{2})/)
  if (dayMatch) {
    const now = new Date()
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(dayMatch[1]), parseInt(dayMatch[2]))
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
    return { nextRun: target.getTime() }
  }
  if (lower.includes('every hour')) return { nextRun: Date.now() + 3600000 }
  if (lower.includes('every day')) return { nextRun: Date.now() + 86400000 }
  if (lower.includes('every week')) return { nextRun: Date.now() + 604800000 }
  const inMinMatch = lower.match(/in\s+(\d+)\s*min(?:ute)?s?/)
  if (inMinMatch) return { nextRun: Date.now() + parseInt(inMinMatch[1]) * 60000 }
  // Chinese natural-language time (e.g. 今天下午1:30 / 明天上午10点) → delegate.
  if (/[一-鿿]/.test(text)) return { nextRun: parseChineseSchedule(text) }
  return { nextRun: Date.now() + 86400000 }
}

/**
 * Parse Chinese natural-language time expressions like
 * "明天（2026年7月13日）上午 10:00", "今天下午3点", "2026年7月13日 22:00".
 */
export function parseChineseSchedule(text: string): number {
  const now = new Date()
  let base = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let hour = 9
  let minute = 0
  const dateM = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (dateM) {
    base = new Date(parseInt(dateM[1]), parseInt(dateM[2]) - 1, parseInt(dateM[3]))
  } else if (/后天/.test(text)) {
    base.setDate(base.getDate() + 2)
  } else if (/明天/.test(text)) {
    base.setDate(base.getDate() + 1)
  }
  let ampm = 0
  if (/(下午|晚上|傍晚)/.test(text)) ampm = 12
  else if (/(中午)/.test(text)) hour = 12
  const hm = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/)
  const hDot = text.match(/(\d{1,2})\s*点/)
  if (hm) {
    hour = parseInt(hm[1])
    minute = parseInt(hm[2])
  } else if (hDot) {
    hour = parseInt(hDot[1])
    minute = 0
  }
  if (ampm && hour < 12) hour += ampm
  const result = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute)
  if (!dateM && result.getTime() <= now.getTime()) {
    result.setDate(result.getDate() + 1)
  }
  return result.getTime()
}

/**
 * Fire-and-forget sync of a created scheduled task to Hermes backend jobs.json.
 */
function syncTaskToBackend(label: string, prompt: string, scheduleText: string, nextRunAt: number | null) {
  try {
    const electron = (window as any).electron
    if (electron?.scheduledTasks?.create) {
      electron.scheduledTasks.create({
        name: label,
        prompt,
        scheduleText,
        cronExpression: undefined,
        nextRunAt: nextRunAt ?? undefined,
      }).catch((e: any) => console.error('sync scheduled task to backend failed:', e))
    }
  } catch (e) {
    console.error('sync scheduled task to backend error:', e)
  }
}

/**
 * Detect ```scheduled-task JSON blocks in the assistant reply, create the
 * tasks in the store, and return the reply with those blocks stripped.
 */
export function extractScheduledTasks(text: string): { cleaned: string; created: string[] } {
  const created: string[] = []
  let cleaned = text
  // 1) Structured ```scheduled-task JSON blocks (label/prompt/schedule or aliases)
  const re = /```(\w*)\s*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const block = m[0]
    const jsonStr = m[2]
    try {
      const data = JSON.parse(jsonStr)
      const label = String(data.label || data.name || data.title || '').trim()
      const prompt = String(data.prompt || data.task || data.content || data.message || '').trim()
      const schedule = String(data.schedule || data.when || data.time || '').trim()
      if (label && prompt && schedule) {
        const parsed = parseScheduleForTask(schedule)
        useHelixStore.getState().addScheduledTask({
          label,
          prompt,
          scheduleText: schedule,
          cronExpression: undefined,
          enabled: true,
          lastRunAt: null,
          nextRunAt: parsed.nextRun,
        })
        syncTaskToBackend(label, prompt, schedule, parsed.nextRun)
        created.push(label)
        cleaned = cleaned.replace(block, '')
      }
    } catch {
      // not a JSON block, ignore
    }
  }
  // 2) Natural-language fallback: AI confirmed creation with 名称:/时间: lines.
  const confirmRe = /(已成功为你创建|已为你创建|已创建(安排|定时任务|提醒)|已帮你创建|创建成功|已安排)/
  if (confirmRe.test(text)) {
    const nameMatch = text.match(/名称[：:]\s*([^\n]+)/)
    const timeMatch = text.match(/时间[：:]\s*([^\n]+)/)
    if (nameMatch && timeMatch) {
      const label = nameMatch[1].trim().replace(/\s+/g, ' ')
      const timeText = timeMatch[1].trim()
      const nextRun = parseChineseSchedule(timeText)
      if (!created.includes(label)) {
        useHelixStore.getState().addScheduledTask({
          label,
          prompt: label,
          scheduleText: timeText,
          cronExpression: undefined,
          enabled: true,
          lastRunAt: null,
          nextRunAt: nextRun,
        })
        syncTaskToBackend(label, label, timeText, nextRun)
        created.push(label)
      }
    }
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
  return { cleaned, created }
}
