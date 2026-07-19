/**
 * Hooks IPC handlers — backend-driven (Hermes config.yaml).
 *
 * Helix's agent loop and tool execution run in the external `hermes`
 * subprocess, which ships its OWN hooks engine (`agent/shell_hooks.py`).
 * That engine registers hooks at GATEWAY STARTUP from the `hooks:` block of
 * Hermes' config.yaml, and (crucially) `pre_tool_call` hooks can BLOCK a tool
 * call — something an Electron-side observer can never do.
 *
 * So this module does NOT execute hooks. It is the persistence + restart
 * layer: it reads/writes the `hooks:` block (and `hooks_auto_accept`) in
 * `%LOCALAPPDATA%/hermes/config.yaml`, and asks the caller to restart the
 * gateway after a save so Hermes re-registers the hooks.
 *
 * Why `hooks_auto_accept: true`? Hermes only registers a hook if it is
 * allowlisted or `accept_hooks` is effective. In a non-TTY launch (Helix
 * spawns `hermes acp` without a terminal) there is no consent prompt, so the
 * hook is silently skipped unless `hooks_auto_accept: true` (or
 * `HERMES_ACCEPT_HOOKS=1` / `--accept-hooks`) is set. Since the user
 * explicitly configures these hooks in Settings, auto-accept is the correct
 * and necessary behavior.
 */
const { ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

// Event names MUST match Hermes' VALID_HOOKS (snake_case). Side-effect events
// only — transform_* / pre_gateway_dispatch are excluded because they expect a
// return value fed back into Hermes' control flow, which a plain command UI
// cannot satisfy.
const HOOK_EVENTS = [
  'pre_tool_call',
  'post_tool_call',
  'pre_verify',
  'on_session_start',
  'on_session_end',
  'on_session_finalize',
  'on_session_reset',
  'subagent_start',
  'subagent_stop',
  'pre_llm_call',
  'post_llm_call',
]

function _configYamlPath() {
  return path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'config.yaml')
}

// ── YAML line editing (no js-yaml dep; preserves the rest of the file) ──────

// Remove a top-level `key:` block (and its indented children) from raw yaml.
function _stripTopLevel(yamlText, key) {
  const lines = yamlText.split('\n')
  const out = []
  let skip = false
  const re = new RegExp('^' + key + '(:\\s*|\\s)')
  for (const line of lines) {
    if (!skip && re.test(line)) { skip = true; continue }
    if (skip) {
      if (/^\S/.test(line)) { skip = false; out.push(line) } // next top-level key ends the block
      // else still inside the stripped block → drop
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

// Quote a scalar the way Hermes/YAML expects; JSON.stringify yields a valid
// YAML double-quoted scalar whose JSON escaping round-trips via JSON.parse.
function _yamlString(v) {
  return JSON.stringify(String(v))
}

function _unyamlScalar(s) {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try { return JSON.parse(s) } catch { return s.slice(1, -1) }
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'")
  }
  return s
}

function _serializeHooks(hooksMap, autoAccept) {
  const lines = []
  lines.push(`hooks_auto_accept: ${autoAccept ? 'true' : 'false'}`)
  lines.push('hooks:')
  const events = Object.keys(hooksMap || {})
    .filter((e) => HOOK_EVENTS.includes(e) && Array.isArray(hooksMap[e]) && hooksMap[e].length)
  if (events.length === 0) {
    lines.push('  {}')
    return lines.join('\n') + '\n'
  }
  for (const ev of events) {
    lines.push(`  ${ev}:`)
    for (const h of hooksMap[ev]) {
      if (!h || typeof h.command !== 'string' || !h.command.trim()) continue
      lines.push(`    - command: ${_yamlString(h.command)}`)
      if (h.matcher && String(h.matcher).trim()) {
        lines.push(`      matcher: ${_yamlString(h.matcher)}`)
      }
      if (h.timeout != null && Number(h.timeout) > 0) {
        lines.push(`      timeout: ${Number(h.timeout)}`)
      }
    }
  }
  return lines.join('\n') + '\n'
}

function _parseHooks(text) {
  const lines = text.split('\n')
  let inHooks = false
  const hooks = {}
  let curEvent = null
  let curItem = null
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (!inHooks) {
      if (/^hooks:\s*\{\}\s*$/.test(line)) return {}
      if (/^hooks:\s*$/.test(line)) { inHooks = true; continue }
      continue
    }
    if (/^\S/.test(line)) break // next top-level key ends the hooks block
    const ev = line.match(/^  ([a-z_][a-z0-9_]*):\s*$/)
    if (ev) { curEvent = ev[1]; if (!hooks[curEvent]) hooks[curEvent] = []; curItem = null; continue }
    const item = line.match(/^    -\s*command:\s*(.*)$/)
    if (item && curEvent) {
      curItem = { command: _unyamlScalar(item[1].trim()), matcher: undefined, timeout: undefined }
      hooks[curEvent].push(curItem)
      continue
    }
    const mat = line.match(/^      matcher:\s*(.*)$/)
    if (mat && curItem) { curItem.matcher = _unyamlScalar(mat[1].trim()); continue }
    const to = line.match(/^      timeout:\s*(\d+)\s*$/)
    if (to && curItem) { curItem.timeout = Number(to[1]); continue }
  }
  return hooks
}

function loadHooks() {
  const yamlPath = _configYamlPath()
  let text = ''
  try { text = fs.readFileSync(yamlPath, 'utf-8') } catch {
    return { enabled: false, autoAccept: false, hooks: {} }
  }
  const hooks = _parseHooks(text)
  const enabled = Object.keys(hooks).length > 0
  let autoAccept = false
  const m = text.match(/^hooks_auto_accept:\s*(true|false)\s*$/m)
  if (m) autoAccept = m[1] === 'true'
  return { enabled, autoAccept, hooks }
}

function saveHooks(hooksMap, autoAccept) {
  const yamlPath = _configYamlPath()
  let text = ''
  try { text = fs.readFileSync(yamlPath, 'utf-8') } catch { text = '' }
  let stripped = _stripTopLevel(text, 'hooks')
  stripped = _stripTopLevel(stripped, 'hooks_auto_accept')
  const block = _serializeHooks(hooksMap, autoAccept)
  const merged = stripped.replace(/\s+$/, '') + '\n' + block
  const tmp = yamlPath + '.tmp'
  fs.writeFileSync(tmp, merged, 'utf-8')
  fs.renameSync(tmp, yamlPath)
  return { hooks: hooksMap, autoAccept }
}

// Restart callback is injected by main.js (it owns hermesProcess / startHermesGateway).
let _restartGateway = null

module.exports = {
  loadHooks,
  saveHooks,
  registerHooksHandlers(restartGateway) {
    if (typeof restartGateway === 'function') _restartGateway = restartGateway
    const channels = ['hooks:getConfig', 'hooks:setConfig']
    for (const ch of channels) {
      try { ipcMain.removeHandler(ch) } catch {}
    }
    ipcMain.handle('hooks:getConfig', async () => {
      try {
        return { ok: true, config: loadHooks() }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    })
    ipcMain.handle('hooks:setConfig', async (_event, config) => {
      try {
        if (!config || typeof config !== 'object' || typeof config.hooks !== 'object') {
          return { ok: false, error: 'invalid hooks config' }
        }
        const enabled = config.enabled !== false
        const hooksMap = enabled ? (config.hooks || {}) : {}
        saveHooks(hooksMap, enabled)
        // Hermes registers hooks at GATEWAY STARTUP (register_from_config).
        // A restart is required for the new hooks to take effect.
        if (typeof _restartGateway === 'function') {
          try { await _restartGateway() } catch (e) {
            console.error('[hooks] gateway restart after save failed:', e.message)
          }
        }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    })
  },
}
