/**
 * Kanban IPC handlers — powers the desktop Kanban board view.
 * Runs `hermes kanban <verb> [args...]` in the main process and returns
 * parsed JSON (when the verb supports `--json`) or raw stdout/stderr.
 *
 * IMPORTANT: arguments are always passed as an array to spawn (no shell), so
 * user-supplied titles / bodies / comments can never inject commands. Mirror
 * of the git.js contract.
 */
const { ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const { resolveHermesCmd } = require('../lib/kernel')

function buildCleanEnv(hermesCmd) {
  const env = { ...process.env }
  // Strip npm/Electron-launch pollution so the venv python starts clean,
  // exactly like a plain terminal `hermes kanban ...` (mirrors main.js).
  for (const k of Object.keys(env)) {
    if (k === 'PATH' || k === 'Path' || k === 'path') continue
    if (k.startsWith('npm_') || k === 'INIT_CWD' || k === 'NODE' || k === 'NODE_EXE'
      || k === 'NPM_CLI_JS' || k === 'NPM_PREFIX_JS' || k === 'NPM_PREFIX_NPM_CLI_JS'
      || k === 'npm_command' || k === 'npm_execpath' || k === 'npm_node_execpath'
      || k === 'npm_lifecycle_event' || k === 'npm_lifecycle_script'
      || k === 'COLOR' || k === 'FORCE_COLOR' || k === 'EFC_8920') {
      delete env[k]
    }
  }
  const hermesBinDir = path.dirname(hermesCmd)
  const cleanPath = (process.env.PATH || '')
    .split(';')
    .filter(p => !/node_modules[\\/]\.bin/i.test(p) && !/npm[\\/]node_modules/i.test(p))
  if (!cleanPath.includes(hermesBinDir)) cleanPath.unshift(hermesBinDir)
  env.PATH = cleanPath.join(';')
  env.Path = cleanPath.join(';')
  return env
}

function runCli(hermesCmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(hermesCmd, args, {
      windowsHide: true,
      env: buildCleanEnv(hermesCmd),
    })
    child.stdout.on('data', d => { stdout += d.toString('utf-8') })
    child.stderr.on('data', d => { stderr += d.toString('utf-8') })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, timeoutMs)
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr, error: err && err.message || String(err) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

module.exports = function registerKanbanHandlers() {
  // Idempotent registration — dev reloads may re-execute this module.
  try { ipcMain.removeHandler('kanban:invoke') } catch { /* ignore */ }

  ipcMain.handle('kanban:invoke', async (event, params) => {
    try {
      const { verb, args, json, board } = params || {}
      if (typeof verb !== 'string' || !verb) return { ok: false, error: '缺少 kanban 子命令' }
      if (!/^[a-z][a-z0-9-]*$/.test(verb)) return { ok: false, error: '非法 kanban 子命令: ' + verb }
      const argList = Array.isArray(args) ? args.map(a => String(a)) : []
      const hermesCmd = resolveHermesCmd()
      if (!hermesCmd) return { ok: false, error: '找不到 hermes 可执行文件' }
      // `--board <slug>` must come BEFORE the subcommand verb
      // (`hermes kanban --board <slug> list ...`), so it is placed between
      // the `kanban` token and the verb. The rest of the args follow the verb.
      const fullArgs = ['kanban']
      if (board && typeof board === 'string') fullArgs.push('--board', board)
      fullArgs.push(verb, ...argList)
      if (json) fullArgs.push('--json')
      const result = await runCli(hermesCmd, fullArgs, 30000)
      if (result.error) return { ok: false, error: result.error }
      if (result.code !== 0) {
        const errText = (result.stderr || result.stdout || '').trim() || `hermes kanban ${verb} 执行失败`
        return { ok: false, code: result.code, stdout: result.stdout, stderr: result.stderr, error: errText }
      }
      let data = null
      if (json) {
        const trimmed = result.stdout.trim()
        // A straight parse is the norm; fall back to the last JSON block in
        // case the CLI printed progress noise before the payload.
        try {
          data = JSON.parse(trimmed)
        } catch {
          const start = trimmed.lastIndexOf('[')
          const brace = trimmed.lastIndexOf('{')
          const from = Math.max(start, brace)
          if (from >= 0) {
            try { data = JSON.parse(trimmed.slice(from)) } catch { data = null }
          }
        }
        if (data === null) data = result.stdout
      }
      return { ok: true, data, stdout: result.stdout, stderr: result.stderr }
    } catch (e) {
      console.error('[kanban:invoke] error:', e)
      return { ok: false, error: String(e && e.message || e) }
    }
  })
}
