/**
 * Scheduled tasks IPC handlers — extracted from main.js.
 * Reads/writes Hermes backend cron jobs.json.
 */
const { ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

function _cronJobsPath() {
  return path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'cron', 'jobs.json')
}

function _atomicWriteJobs(jobsData) {
  const jobsPath = _cronJobsPath()
  const tmp = jobsPath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(jobsData, null, 2), 'utf-8')
  fs.renameSync(tmp, jobsPath)
}

function _genJobId() {
  return Date.now().toString(16) + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
}

module.exports = function registerScheduledTasksHandlers() {
  // Idempotent registration — dev reloads may re-execute this module.
  const handles = ['scheduled-tasks:list', 'scheduled-tasks:create', 'scheduled-tasks:update', 'scheduled-tasks:remove']
  for (const channel of handles) {
    try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
  }

  ipcMain.handle('scheduled-tasks:list', async () => {
    try {
      const jobsPath = _cronJobsPath()
      if (!fs.existsSync(jobsPath)) return { ok: true, tasks: [] }
      const raw = await fs.promises.readFile(jobsPath, 'utf-8')
      const data = JSON.parse(raw)
      const jobs = Array.isArray(data.jobs) ? data.jobs : []
      const tasks = jobs.map(job => {
        let nextRunAt = null
        let lastRunAt = null
        try { if (job.next_run_at) nextRunAt = new Date(job.next_run_at).getTime() } catch {}
        try { if (job.last_run_at) lastRunAt = new Date(job.last_run_at).getTime() } catch {}
        const schedule = job.schedule || {}
        let scheduleText = schedule.display || job.schedule_display || ''
        if (!scheduleText) {
          if (schedule.kind === 'once' && schedule.run_at) {
            scheduleText = `once at ${schedule.run_at}`
          } else if (schedule.kind === 'cron' && schedule.expr) {
            scheduleText = `cron: ${schedule.expr}`
          } else {
            scheduleText = 'unknown'
          }
        }
        return {
          id: job.id,
          label: job.name || '未命名任务',
          prompt: job.prompt || '',
          scheduleText,
          cronExpression: schedule.kind === 'cron' ? schedule.expr : undefined,
          enabled: !!job.enabled,
          lastRunAt,
          nextRunAt,
          createdAt: (() => { try { return job.created_at ? new Date(job.created_at).getTime() : Date.now() } catch { return Date.now() } })(),
          updatedAt: (() => { try { return data.updated_at ? new Date(data.updated_at).getTime() : Date.now() } catch { return Date.now() } })(),
        }
      })
      return { ok: true, tasks }
    } catch (e) {
      console.error('[scheduled-tasks:list] error:', e)
      return { ok: false, error: String(e && e.message || e) }
    }
  })

  ipcMain.handle('scheduled-tasks:create', async (event, params) => {
    try {
      const { name, prompt, scheduleText, cronExpression, nextRunAt } = params || {}
      const jobsPath = _cronJobsPath()
      let jobsData = { jobs: [] }
      if (fs.existsSync(jobsPath)) {
        jobsData = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'))
      }
      if (!Array.isArray(jobsData.jobs)) jobsData.jobs = []

      const id = _genJobId()
      let schedule, schedule_display, next_run_at = null
      if (cronExpression) {
        schedule = { kind: 'cron', expr: cronExpression, display: cronExpression }
        schedule_display = cronExpression
      } else if (nextRunAt) {
        const iso = new Date(nextRunAt).toISOString()
        const disp = 'once at ' + iso.replace('T', ' ').slice(0, 16)
        schedule = { kind: 'once', run_at: iso, display: disp }
        schedule_display = disp
        next_run_at = iso
      } else {
        const fallback = new Date(Date.now() + 86400000).toISOString()
        schedule = { kind: 'once', run_at: fallback, display: 'once (fallback)' }
        schedule_display = 'unknown'
        next_run_at = fallback
      }

      const job = {
        id,
        name: name || '未命名任务',
        prompt: prompt || '',
        skills: [], skill: null, model: null, provider: null,
        provider_snapshot: 'custom', model_snapshot: 'agnes-2.0-flash',
        base_url: null, script: null, no_agent: false, context_from: null,
        schedule, schedule_display,
        repeat: { times: schedule.kind === 'once' ? 1 : null, completed: 0 },
        enabled: true, state: 'scheduled',
        paused_at: null, paused_reason: null,
        created_at: new Date().toISOString(),
        next_run_at, last_run_at: null,
        last_status: null, last_error: null, last_delivery_error: null,
        deliver: 'local', origin: null,
        enabled_toolsets: null, workdir: null,
      }
      jobsData.jobs.push(job)
      jobsData.updated_at = new Date().toISOString()
      _atomicWriteJobs(jobsData)
      return { ok: true, id, nextRunAt: next_run_at ? new Date(next_run_at).getTime() : null }
    } catch (e) {
      console.error('[scheduled-tasks:create] error:', e)
      return { ok: false, error: String(e && e.message || e) }
    }
  })

  ipcMain.handle('scheduled-tasks:update', async (event, params) => {
    try {
      const { id, enabled } = params || {}
      const jobsPath = _cronJobsPath()
      if (!fs.existsSync(jobsPath)) return { ok: false, error: 'jobs.json not found' }
      const jobsData = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'))
      if (!Array.isArray(jobsData.jobs)) return { ok: false, error: 'no jobs array' }
      let found = false
      for (const job of jobsData.jobs) {
        if (job.id === id) {
          job.enabled = !!enabled
          if (enabled) {
            job.paused_at = null; job.paused_reason = null
            if (job.state === 'paused') job.state = 'scheduled'
          } else {
            job.paused_at = new Date().toISOString()
            job.paused_reason = 'paused from Helix UI'
            job.state = 'paused'
          }
          found = true; break
        }
      }
      if (!found) return { ok: false, error: 'job not found' }
      jobsData.updated_at = new Date().toISOString()
      _atomicWriteJobs(jobsData)
      return { ok: true }
    } catch (e) {
      console.error('[scheduled-tasks:update] error:', e)
      return { ok: false, error: String(e && e.message || e) }
    }
  })

  ipcMain.handle('scheduled-tasks:remove', async (event, params) => {
    try {
      const { id } = params || {}
      const jobsPath = _cronJobsPath()
      if (!fs.existsSync(jobsPath)) return { ok: false, error: 'jobs.json not found' }
      const jobsData = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'))
      if (!Array.isArray(jobsData.jobs)) return { ok: false, error: 'no jobs array' }
      const before = jobsData.jobs.length
      jobsData.jobs = jobsData.jobs.filter(j => j.id !== id)
      if (jobsData.jobs.length === before) return { ok: false, error: 'job not found' }
      jobsData.updated_at = new Date().toISOString()
      _atomicWriteJobs(jobsData)
      return { ok: true }
    } catch (e) {
      console.error('[scheduled-tasks:remove] error:', e)
      return { ok: false, error: String(e && e.message || e) }
    }
  })
}
