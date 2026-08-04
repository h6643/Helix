const path = require('path')
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage, safeStorage } = require('electron')
const fsPromises = require('fs').promises
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { spawn, exec } = require('child_process')
const { promisify } = require('util')

const execAsync = promisify(exec)

// ── IPC registration helpers (hot-reload safe) ───────────────────────────────
// Electron throws if a handler is registered twice. Vite dev rebuilds can reload
// this module, so every registration must first clear the previous one.
function safeHandle(channel, handler) {
  try { ipcMain.removeHandler(channel) } catch {}
  return ipcMain.handle(channel, handler)
}
function safeOn(channel, listener) {
  try { ipcMain.removeAllListeners(channel) } catch {}
  return ipcMain.on(channel, listener)
}

// ── IPC Handler Modules ─────────────────────────────────────────────────────
const registerGitHandlers = require('./ipc/git')
const registerScheduledTasksHandlers = require('./ipc/scheduled-tasks')
const securityModule = require('./ipc/security')
const registerTerminalHandlers = require('./ipc/terminal')
const registerSecurityHandlers = securityModule
const { isBadConfig, APIHUB_DEFAULT } = securityModule
const registerFsHandlers = require('./ipc/fs')
const registerWindowHandlers = require('./ipc/window')
const registerEmailHandlers = require('./ipc/email')
const hooksModule = require('./ipc/hooks')
const configModule = require('./lib/config')
const {
  setYamlKey,
  setDelegationIdentities,
  setCustomProviderModel,
  setCustomProviderField,
  customProviderApiKey,
  resolveProvider,
  disambiguateCustomProvider,
  parseHermesPersonalities,
  BUILTIN_PROVIDER_ENV,
} = configModule
const kernelModule = require('./lib/kernel')
const {
  resolveHermesCandidates,
  resolveHermesCmd,
  verifyKernel,
} = kernelModule
const memoryModule = require('./lib/memory')
const {
  hermesMemoriesDir,
  readMemFile,
  writeMemFile,
  readManualMarkers,
  addManualMarker,
  removeManualMarker,
  incrementSkillCallCount,
  collectSkillsFromDir,
} = memoryModule

// ── Diagnostics & runtime status (exposed to renderer) ───────────────────────
const diagState = {
  gatewayRunning: false,
  gatewayStartedAt: 0,
  runtimeVersion: (function () { try { return app.getVersion() } catch (e) { return 'unknown' } })(),
  signatureStatus: 'unverified', // 'verified' | 'unverified' | 'unknown'
  signatureDetail: '内核签名校验尚未执行',
  platform: process.platform,
  electronVersion: process.versions.electron || 'unknown',
  nodeVersion: process.versions.node || 'unknown',
}

function getDiagnostics() {
  return {
    ...diagState,
    uptime: diagState.gatewayStartedAt ? Date.now() - diagState.gatewayStartedAt : 0,
  }
}

// ── Hermes TUI Gateway JSON-RPC Bridge ──────────────────────────────────────

let hermesProcess = null
let hermesRequestId = 0

// ── serve gateway auto-respawn bookkeeping ──────────────────────────────────
// If the serve gateway (a python subprocess) dies on its own, we respawn it so
// the UI never stays stuck on the "connecting to Hermes" splash. See
// scheduleServeRespawn() below for the full mechanism + rate limiting.
let appIsQuitting = false
let serveRespawnCount = 0
let serveRespawnWindowStart = 0
const MAX_SERVE_RESPAWN_PER_WINDOW = 6
const SERVE_RESPAWN_WINDOW_MS = 60_000
const SERVE_RESPAWN_BASE_DELAY_MS = 800

// ── Gateway mode (Phase 1 of serve migration, see docs/serve-migration.md) ──
// 'acp'  (default): stdio JSON-RPC via `hermes acp` — current stable path.
// 'serve'         : official HTTP/WS gateway via `hermes serve` — renderer
//                   connects DIRECTLY to http://127.0.0.1:<port> (REST) and
//                   ws://127.0.0.1:<port>/api/ws?token=... (JSON-RPC), same
//                   architecture as the official desktop app.
// Default to serve mode on this build: the entire Helix integration (clarify,
// run.completed, tui_gateway bridge) is built around `hermes serve`. acp mode
// requires `pip install -e '.[acp]'` extras which are not present in this
// environment, so acp is non-functional here. Opt out via HELIX_GATEWAY_MODE=acp.
const GATEWAY_MODE = (process.env.HELIX_GATEWAY_MODE || 'serve').toLowerCase() === 'serve' ? 'serve' : 'acp'
// Populated after the serve handshake line (HERMES_BACKEND_READY port=N).
// Shape: { mode:'serve', port, token, baseUrl, wsUrl }
let serveGatewayInfo = null
// Session token pinned for the serve gateway (loopback WS auth requires
// ?token=<HERMES_DASHBOARD_SESSION_TOKEN>). Generated once per app run so
// restarts of the backend keep the same token and the renderer can reconnect.
let serveSessionToken = null
// Gateway topology: 'local' spawns the bundled Hermes runtime (hermes serve);
// 'remote' connects to an external Hermes gateway WebSocket URL without spawning
// any local subprocess. Controlled at runtime via hermes:setGatewayMode.
let currentGatewayMode = 'local'
let remoteGatewayUrl = ''

const _notifTiming = {}
const hermesPending = new Map()
let hermesStdoutBuffer = ''
let hermesStderrBuffer = ''
let hermesConnError = false

// Restart rate-limiter: if Hermes keeps crashing we must NOT restart it in a
// tight loop (every send/status call would re-spawn). Allow at most
// MAX_RESTARTS restarts within RESTART_WINDOW ms; after that, refuse to
// restart until the window cools down.
const RESTART_MAX = 5
const RESTART_WINDOW = 30000
const hermesRestartTimes = []
function hermesCanRestart() {
  const now = Date.now()
  // Drop timestamps outside the window
  while (hermesRestartTimes.length && now - hermesRestartTimes[0] > RESTART_WINDOW) {
    hermesRestartTimes.shift()
  }
  return hermesRestartTimes.length < RESTART_MAX
}
function hermesRecordRestart() {
  hermesRestartTimes.push(Date.now())
}

function sendHermesRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!hermesProcess) {
      return reject(new Error('Hermes not connected'))
    }
    const id = ++hermesRequestId
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    hermesPending.set(id, { resolve, reject })
    hermesProcess.stdin.write(request)
    const timeout = method === 'session/prompt' ? 1800000 : 120000
    setTimeout(() => {
      if (hermesPending.has(id)) {
        hermesPending.delete(id)
        reject(new Error(`Hermes request ${method} timed out`))
      }
    }, timeout)
  })
}

// Send a JSON-RPC *notification* (no id, fire-and-forget). Some Hermes ACP
// methods (e.g. session/cancel) are registered as notifications only, so
// sending them as a request returns "Method not found" (-32601).
function sendHermesNotification(method, params) {
  if (!hermesProcess) {
    console.warn('[Hermes] notify dropped (not connected):', method)
    return
  }
  const notif = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'
  hermesProcess.stdin.write(notif)
}

function processHermesBuffer() {  const lines = hermesStdoutBuffer.split('\n')
  hermesStdoutBuffer = lines.pop() || ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const msg = JSON.parse(trimmed)
      const su = msg.params?.update?.sessionUpdate || msg.params?.update?.type || ''
      const now = Date.now()
      if (msg.id !== undefined && msg.jsonrpc === '2.0') {
        const pending = hermesPending.get(msg.id)
        if (pending) {
          hermesPending.delete(msg.id)
          if (msg.error) {
            // -32601 "Method not found" is an expected, harmless response when
            // the frontend probes an optional ACP method the running Hermes
            // build doesn't implement (e.g. session.context_breakdown on older
            // installs). The renderer already degrades gracefully, so we must
            // NOT spam console.error for it — only surface real failures.
            if (msg.error.code === -32601) {
              console.debug('[Hermes] optional method not supported (ignored):', msg.error.data?.method || msg.error.message)
            } else {
              console.error('[Hermes] gateway error:', msg.error)
            }
            pending.reject(new Error(msg.error.message))
          } else {
            pending.resolve(msg.result)
          }
        }
      } else if (msg.jsonrpc === '2.0' && msg.method) {
        // Notification (event) → forward to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('hermes:event', msg.method, msg.params)
        }
      }
    } catch {
      // Non-JSON output (e.g. OpenAI/HTTPX debug logs from OPENAI_LOG=debug).
      // Surface HTTP/auth lines so a provider-switch 401 can be diagnosed:
      // we can see the exact request URL, the (redacted) auth and the upstream
      // 401 reason instead of it being silently dropped.
      if (/401|unauthorized|HTTP\/|Bearer|openai|api[_-]?key|request|response|auth|token|ant-?ling|stepfun/i.test(trimmed)) {
        console.log('[Hermes stdout]', trimmed)
      }
    }
  }
}

// ── Shared disk writer for Hermes model config ─────────────────────────────
// Writes the model/provider/baseUrl/apiKey into Hermes config.yaml (model block
// + named custom_providers entry) and the .env (OPENAI_API_KEY / OPENAI_BASE_URL).
// Used both by the hermes:setConfig IPC (which also restarts the gateway) and by
// the startup profile re-assert (applyActiveProfileCache) which runs BEFORE the
// gateway is spawned. No hardcoded defaults — every value comes from `cfg`.
function writeHermesConfig({ model, provider, baseUrl, apiKey }) {
  _lastHermesConfigWriteTime = Date.now()
  const hermesDir = path.join(os.homedir(), 'AppData', 'Local', 'hermes')
  const yamlPath = path.join(hermesDir, 'config.yaml')
  const incomingKey = (apiKey && String(apiKey).trim()) ? String(apiKey).trim() : ''
  let diskKey = ''
  try {
    const envPath = path.join(hermesDir, '.env')
    let envContent = ''
    try { envContent = fs.readFileSync(envPath, 'utf-8') } catch {}
    for (const l of envContent.split('\n')) {
      if (l.startsWith('OPENAI_API_KEY=')) { diskKey = l.slice('OPENAI_API_KEY='.length).trim(); break }
    }
  } catch {}
  // Read the current config.yaml once so we can look up the TARGET provider's
  // already-stored key when the frontend supplies none (see effectiveKey below).
  let yamlContent = ''
  try { yamlContent = fs.readFileSync(yamlPath, 'utf-8') } catch {}
  const reqProvider = (provider && provider !== '__custom__' && provider !== 'custom') ? provider : 'custom'
  // Prefer the incoming key; only fall back to an on-disk key when the caller
  // supplied nothing. An empty incoming key must NEVER wipe an existing valid
  // credential — that would leave a newly-switched base_url with no key and
  // produce a guaranteed HTTP 401. (The frontend is responsible for supplying
  // the correct key on a provider switch; this is defense-in-depth.)
  //
  // Fallback order when incomingKey is empty (provider switch with a lost
  // in-memory key — e.g. after a broken safeStorage persist):
  //   1) the TARGET provider's own api_key already stored in custom_providers
  //      (this is the correct key for the model we are switching TO), then
  //   2) the legacy OPENAI_API_KEY on disk (which may belong to a DIFFERENT
  //      provider — only used as a last resort).
  // Using the target provider's stored key here is what prevents the classic
  // "switched URL but kept the previous provider's key" 401.
  const targetCpKey = customProviderApiKey(yamlContent, resolveProvider(yamlContent, reqProvider, baseUrl))
  const effectiveKey = incomingKey || targetCpKey || diskKey
  // Resolve the named provider ONCE — used both for the .env provider-specific
  // env-var mirror (below) and for the config.yaml model.provider write.
  const resolved = resolveProvider(yamlContent, reqProvider, baseUrl)
  // Keep .env in sync with the chosen endpoint/key. OPENAI_BASE_URL MUST track
  // baseUrl too, otherwise the custom provider would silently hit a stale
  // gateway (-> 401).
  try {
    const envPath = path.join(hermesDir, '.env')
    let envContent = ''
    try { envContent = fs.readFileSync(envPath, 'utf-8') } catch {}
    // Only strip the existing OPENAI_API_KEY when we actually have a key to
    // write back. If effectiveKey is empty we keep the on-disk key intact so a
    // switch never strands the endpoint without credentials (→ 401).
    const stripKey = !!effectiveKey
    const lines = envContent.split('\n').filter(l => !l.startsWith('OPENAI_BASE_URL=') && !/^\w+_API_KEY=/.test(l) && !(stripKey && l.startsWith('OPENAI_API_KEY=')))
    if (baseUrl) lines.push(`OPENAI_BASE_URL=${baseUrl}`)
    if (effectiveKey) lines.push(`OPENAI_API_KEY=${effectiveKey}`)
    // Some provider names are Hermes BUILT-IN providers (registered in
    // hermes_cli.auth.PROVIDER_REGISTRY) — e.g. "stepfun". A built-in provider
    // resolves its API key from a provider-specific env var (STEPFUN_API_KEY),
    // NOT from OPENAI_API_KEY and NOT from custom_providers[].api_key. The
    // runtime_provider._get_named_custom_provider() short-circuits to None for
    // any name that resolve_provider() maps to a canonical built-in, so a
    // custom_providers entry named "stepfun" is silently ignored — leaving the
    // gateway with "No LLM provider configured" / "Set STEPFUN_API_KEY".
    // Fix: mirror the key into the built-in provider's expected env var.
    const providerEnvVar = BUILTIN_PROVIDER_ENV[resolved]
    if (providerEnvVar && effectiveKey) lines.push(`${providerEnvVar}=${effectiveKey}`)
    fs.writeFileSync(envPath, lines.join('\n'), 'utf-8')
  } catch {}

  if (model || provider || baseUrl) {
    if (model) yamlContent = setYamlKey(yamlContent, 'model.default', model)
    // model.provider MUST be the resolved NAMED provider (e.g. 'ant-ling',
    // 'stepfun', 'agnes-ai') — NOT the literal 'custom'. Hermes selects the
    // active provider by model.provider, and a named custom_providers entry
    // OVERRIDES model.default (hermes runtime_provider.resolve_runtime_provider,
    // see setCustomProviderModel above). Writing 'custom' leaves no matching
    // entry, so the gateway falls back to custom_providers[0] (whichever was
    // written first) — which is exactly the "switched the model but the gateway
    // keeps using the previous provider's credentials" 401.
    const effectiveProvider = resolved
    // Disambiguate names that collide with Hermes built-in providers (e.g.
    // 'deepseek') by prefixing with 'custom:' so Hermes selects the named
    // custom_providers entry instead of the built-in resolver (which would
    // ignore the entry's api_key/base_url and demand a provider-specific env var).
    const yamlProvider = disambiguateCustomProvider(yamlContent, effectiveProvider)
    yamlContent = setYamlKey(yamlContent, 'model.provider', yamlProvider)
    if (baseUrl) yamlContent = setYamlKey(yamlContent, 'model.base_url', baseUrl)
    // Keep the named custom provider entry consistent with the model block
    if (model) yamlContent = setCustomProviderField(yamlContent, resolved, 'model', model)
    if (baseUrl) yamlContent = setCustomProviderField(yamlContent, resolved, 'base_url', baseUrl)
    if (effectiveKey) yamlContent = setCustomProviderField(yamlContent, resolved, 'api_key', effectiveKey)
    // API key into model block when provided; otherwise drop a dead model.api_key.
    // Uses effectiveKey (preserves a good on-disk key when the incoming is empty/bad).
    // Only write model.api_key when we have a key. Never clear it on an empty
    // incoming key — that would leave the endpoint unauthenticated (401).
    if (effectiveKey) {
      yamlContent = setYamlKey(yamlContent, 'model.api_key', effectiveKey)
    }
    fs.writeFileSync(yamlPath, yamlContent, 'utf-8')
  }
  markOwnConfigWrite()
}

// ── Agent behaviour settings → Hermes config.yaml ──────────────────────────
// Writes reasoning_effort, system_prompt (personality) into the `agent:` block.
// Removed: temperature, maxOutputTokens, customInstructions (backend-managed).
// Removed: Chinese language default injection (Hermes Desktop style).
function writeHermesAgentConfig({ reasoningEffort, personality }) {
  try {
    const yamlPath = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'config.yaml')
    let yaml = ''
    try { yaml = fs.readFileSync(yamlPath, 'utf-8') } catch { return }
    let updated = yaml
    if (reasoningEffort !== undefined && reasoningEffort !== null) {
      updated = setYamlKey(updated, 'agent.reasoning_effort', String(reasoningEffort))
    }
    if (personality !== undefined && personality !== null && String(personality).trim() !== '') {
      const safe = '"' + String(personality).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
      updated = setYamlKey(updated, 'agent.system_prompt', safe)
    }
    // No default Chinese language injection — Hermes Desktop lets SOUL.md / personality decide
    if (updated !== yaml) {
      fs.writeFileSync(yamlPath, updated, 'utf-8')
      markOwnConfigWrite()
      console.log('[Hermes] agent config written to config.yaml')
    }
  } catch (e) {
    console.warn('[Hermes] could not write agent config:', e.message)
  }
}

// Re-assert the user's last-saved model profile into Hermes config.yaml BEFORE
// spawning the gateway. The renderer keeps this profile in a small JSON cache
// (userData/active-profile.json) whenever the user saves or applies a profile,
// so the backend always matches the user's choice — no hardcoded pin, and free
// Profile switching is preserved.
function applyActiveProfileCache() {
  try {
    // Skip if writeHermesConfig was called very recently (e.g. by hermes:setConfig
    // or hermes:setModel just before this restart) — the fresh config on disk is
    // authoritative and must not be overwritten with a potentially stale cache.
    if (Date.now() - _lastHermesConfigWriteTime < 5000) {
      console.log('[Hermes] skipping active-profile cache (fresh config was just written)')
      return
    }
    const cachePath = path.join(app.getPath('userData'), 'active-profile.json')
    if (!fs.existsSync(cachePath)) {
      console.log('[Hermes] no active-profile cache; leaving config.yaml as-is')
      return
    }
    const cfg = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    if (!cfg || !cfg.provider) {
      console.log('[Hermes] active-profile cache missing provider; skipping')
      return
    }
    // Validation gate: if the cached profile has no valid baseUrl,
    // leave disk config untouched to avoid clobbering with garbage.
    if (isBadConfig(cfg)) {
      console.warn('[Hermes] active-profile cache is invalid; leaving disk config untouched')
      return
    }
    writeHermesConfig(cfg)
  } catch (e) {
    console.warn('[Hermes] applyActiveProfileCache failed:', e.message)
  }
}

// Pin `coding_context: off` into Hermes config.yaml so a Windows git subprocess
// deadlock can never hang model output again — even after a Hermes update rewrites
// config.yaml. Uses setYamlKey (no js-yaml dep).
function ensureCodingContextOff() {
  try {
    const yamlPath = path.join(require('os').homedir(), 'AppData', 'Local', 'hermes', 'config.yaml')
    let c = fs.readFileSync(yamlPath, 'utf-8')
    // fix any legacy broken inline-merge (e.g. "max_turns: 150  coding_context: off")
    if (/^\s*max_turns:\s*\d+\s+coding_context/m.test(c)) {
      c = c.replace(/^(\s*max_turns:\s*\d+).*$/m, '$1')
    }
    const updated = setYamlKey(c, 'agent.coding_context', 'off')
    if (updated !== c) {
      fs.writeFileSync(yamlPath, updated, 'utf-8')
      console.log('[Hermes] pinned coding_context: off into config.yaml')
    }
  } catch (e) {
    console.warn('[Hermes] could not pin coding_context:', e.message)
  }
}

// Clear persisted Hermes sessions from state.db so a model switch cannot
// reuse a stale session bound to the PREVIOUS provider. The gateway restart
// reloads the `sessions` table (billing_provider + billing_base_url + model),
// so without this the old session is served with the previous endpoint while
// model.api_key / .env were already rewritten to the new provider's key →
// 401 "授权令牌无效" / ling_auth_not_exist. Sessions are recreated fresh from
// config.yaml on the next session/new, so the new provider takes effect.
// Messages are preserved (only the session index rows are cleared).
const _HERMES_VENV_PY = path.join(
  require('os').homedir(), 'AppData', 'Local', 'hermes',
  'hermes-agent', 'venv', 'Scripts', 'python.exe'
)
function clearHermesSessions() {
  return new Promise((resolve) => {
    const dbPath = path.join(require('os').homedir(), 'AppData', 'Local', 'hermes', 'state.db')
    if (!fs.existsSync(dbPath) || !fs.existsSync(_HERMES_VENV_PY)) { resolve(false); return }
    const script =
      'import sqlite3,sys\n' +
      'db=sys.argv[1]\n' +
      'try:\n' +
      '    c=sqlite3.connect(db)\n' +
      '    for t in ("sessions","session_model_usage"):\n' +
      '        try: c.execute("DELETE FROM "+t)\n' +
      '        except Exception: pass\n' +
      '    c.commit(); c.close()\n' +
      '    print("ok")\n' +
      'except Exception as e:\n' +
      '    print("err",e)'
    let out = ''
    const cp = spawn(_HERMES_VENV_PY, ['-c', script, dbPath], { windowsHide: true })
    cp.stdout.on('data', (d) => { out += d })
    cp.stderr.on('data', (d) => { out += d })
    cp.on('error', () => resolve(false))
    cp.on('close', () => { console.log('[Hermes] clearHermesSessions:', (out || '').trim() || 'no-output'); resolve(/ok/.test(out)) })
    setTimeout(() => resolve(false), 5000)
  })
}

// ── Debounced gateway restart ─────────────────────────────────────────────
// Multiple config writes (setConfig + setModel, or repeated profile switches)
// can each trigger a kill+restart. Without debouncing, a new spawn is killed
// before it finishes plugin discovery (5-8s), so the gateway never reaches
// "ACP client connected" and the UI stays stuck ("思考中但无输出").
// This coalesces restart requests within DEBOUNCE_MS into a single restart.
let _restartTimer = null
let _restartResolveFns = []
const RESTART_DEBOUNCE_MS = 600
function restartGatewayDebounced(label) {
  // serve 模式：网关是常驻 HTTP/WS 服务，config.yaml 的变更在每次
  // session.create 构建 agent 时才被读取（官方桌面版同理），配置写入
  // 不需要也不应该重启网关。重启反而会：杀掉所有活跃会话、WS 1006 断连、
  // 端口漂移、触发渲染层"已同步模型给死实例"竞态。acp 模式行为不变。
  if (GATEWAY_MODE === 'serve') {
    console.log('[Hermes] serve mode: skip gateway restart for', label || '(coalesced)')
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    _restartResolveFns.push(resolve)
    if (_restartTimer) clearTimeout(_restartTimer)
    _restartTimer = setTimeout(async () => {
      _restartTimer = null
      const waiters = _restartResolveFns
      _restartResolveFns = []
      console.log('[Hermes] debounced restart firing:', label || '(coalesced)')
      try {
        await restartHermesGatewayCore({ notifyRenderer: true })
        console.log('[Hermes] debounced restart complete:', label || '(coalesced)')
      } catch (e) {
        console.error('[Hermes] debounced restart failed:', e.message)
      }
      for (const fn of waiters) { try { fn() } catch {} }
    }, RESTART_DEBOUNCE_MS)
  })
}

// ── Shared gateway restart core ────────────────────────────────────────────
// Single implementation for both restart paths (debounced config restarts and
// the hooks-save restart). Kills the current process, waits for it to exit,
// optionally notifies the renderer + clears sessions, then boots a new gateway.
// `restartHermesGatewayCore` is a hoisted function declaration so it can be
// referenced by restartGatewayDebounced above even though it's defined here.
async function restartHermesGatewayCore({ notifyRenderer = false } = {}) {
  // In remote mode there is no local gateway to recycle — config changes apply on
  // the remote side via RPC, not by restarting a (non-existent) local process.
  // Just re-assert the remote info so the renderer stays pointed at it.
  if (currentGatewayMode === 'remote') {
    if (notifyRenderer && mainWindow && !mainWindow.isDestroyed() && serveGatewayInfo) {
      mainWindow.webContents.send('hermes:event', 'gateway.serveInfo', serveGatewayInfo)
    }
    return
  }
  // Tell the renderer the gateway is about to go down so it flips
  // hermesConnected=false. This makes handleRun await gateway.ready before
  // issuing session/new — otherwise it fires session/new into the gap
  // between kill and the new process being ready and the next prompt lands
  // on a dead session (silent no-output after a provider switch).
  if (notifyRenderer && mainWindow && !mainWindow.isDestroyed()) {
    console.log('[Hermes] notifying renderer: gateway going down (disconnected)')
    mainWindow.webContents.send('hermes:event', 'gateway.disconnected', { expected: true })
  }
  const oldP = hermesProcess
  hermesProcess = null
  try { if (oldP) oldP.kill() } catch {}
  await new Promise((r) => {
    if (!oldP || oldP.exitCode !== null || oldP.signalCode !== null) { r(); return }
    const onClose = () => r()
    oldP.once('close', onClose)
    setTimeout(() => { oldP.removeListener('close', onClose); r() }, 3000)
  })
  if (notifyRenderer) await clearHermesSessions()
  await startHermesGateway()
  // Notify the renderer that all prior sessions were destroyed by the
  // restart. The frontend must discard its cached session_id and create a
  // fresh one on the next send — otherwise it replays a stale id and the
  // backend answers "session ... not found" → silent no-output.
  if (notifyRenderer && mainWindow && !mainWindow.isDestroyed()) {
    console.log('[Hermes] notifying renderer: gateway sessions invalidated')
    mainWindow.webContents.send('hermes:event', 'gateway.sessionInvalidated')
  }
}


// ── config.yaml / .env external-edit watcher ──────────────────────────────
// If config.yaml or .env is edited OUTSIDE Hermes (a text editor, another tool,
// an external script), the running gateway still holds the old auth snapshot in
// memory and the next request would 401. We watch those files and mark the
// gateway stale; hermes:send lazily recycles it before forwarding, so the fresh
// config is picked up with no manual action and no 401. Our own writes are
// suppressed via _lastOwnConfigWrite (1.5s guard) so they don't double-recycle.
let _hermesConfigStale = false
let _lastOwnConfigWrite = 0
let _hermesConfigWatcher = null

function markOwnConfigWrite() { _lastOwnConfigWrite = Date.now() }

function setupHermesConfigWatcher() {
  if (_hermesConfigWatcher) return
  const hermesDir = path.join(require('os').homedir(), 'AppData', 'Local', 'hermes')
  const targets = [path.join(hermesDir, 'config.yaml'), path.join(hermesDir, '.env')]
  let debounce = null
  const onChange = (file) => {
    if (Date.now() - _lastOwnConfigWrite < 1500) return // suppress our own writes
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      console.log('[Hermes] config changed externally:', file, '→ gateway recycles on next request')
      _hermesConfigStale = true
    }, 400)
  }
  for (const t of targets) {
    try { const w = fs.watch(t, () => onChange(t)); w.on('error', () => {}) } catch {}
  }
  try {
    const dirW = fs.watch(hermesDir, (evt, fn) => {
      if (fn && /^(config\.yaml|\.env)$/.test(String(fn))) onChange(path.join(hermesDir, fn))
    })
    dirW.on('error', () => {})
    _hermesConfigWatcher = dirW
  } catch {}
}

// Tracks whether we've already sent gateway.ready for the current process.
// Reset to false at the start of each startHermesGateway() call so restarts
// re-announce readiness. Set to true either by the "ACP client connected"
// stderr line (preferred — means ACP server is truly listening) or by the
// 8s fallback timer.
let _acpReadySent = false

// ── serve gateway auto-respawn ──────────────────────────────────────────────
// If the serve gateway dies on its own (e.g. after a heavy tool run — the
// 2026-07-31 incident where a python serve subprocess exited and Electron never
// brought it back, leaving the UI stuck on "connecting to Hermes"), respawn it
// automatically so the user never has to manually kill + cold-restart Electron.
// Deliberate restarts (debounced restart / config change) set hermesProcess to
// the replacement BEFORE killing the old one, so the old process's close handler
// hits the stale-guard and never reaches here. Rate-limited: at most
// MAX_SERVE_RESPAWN_PER_WINDOW attempts per SERVE_RESPAWN_WINDOW_MS, with an
// exponential backoff capped at 8s, so an instant-crash loop can't hot-spin.
function scheduleServeRespawn() {
  if (appIsQuitting) return
  if (GATEWAY_MODE !== 'serve') return
  const now = Date.now()
  if (now - serveRespawnWindowStart > SERVE_RESPAWN_WINDOW_MS) {
    serveRespawnWindowStart = now
    serveRespawnCount = 0
  }
  serveRespawnCount++
  if (serveRespawnCount > MAX_SERVE_RESPAWN_PER_WINDOW) {
    console.error('[Hermes] serve gateway died too many times in the last 60s — giving up auto-respawn')
    mainWindow?.webContents.send('hermes:event', 'error', {
      message: 'Hermes 网关反复崩溃，已停止自动重启。请查看 Hermes 日志（%LOCALAPPDATA%\\hermes\\logs）后手动重启 Helix。',
    })
    return
  }
  const delay = Math.min(
    SERVE_RESPAWN_BASE_DELAY_MS * Math.pow(2, serveRespawnCount - 1),
    8000,
  )
  console.log(`[Hermes] serve gateway died — auto-respawning in ${delay}ms (attempt ${serveRespawnCount}/${MAX_SERVE_RESPAWN_PER_WINDOW})`)
  setTimeout(() => {
    if (appIsQuitting) return
    if (hermesProcess) {
      // A gateway is already alive (e.g. a concurrent restart won the race) —
      // don't spawn a second one.
      console.log('[Hermes] respawn skipped: a gateway process is already running')
      return
    }
    startHermesGateway().catch((e) => {
      console.error('[Hermes] auto-respawn failed:', e?.message || e)
    })
  }, delay)
}

function startHermesGateway(candidateIndex = 0) {
  return new Promise((resolve, reject) => {
    _acpReadySent = false
    // In remote mode there is no local subprocess to spawn — serveGatewayInfo is
    // owned by hermes:setGatewayMode, which populates it directly. Bail out so we
    // never try to launch a hermes serve that would shadow the remote connection.
    if (currentGatewayMode === 'remote') {
      return resolve(serveGatewayInfo)
    }
    // Ensure the git-probe workaround is present before launching (survives updates)
    ensureCodingContextOff()
    // Re-assert the user's last-saved model profile (cached by the renderer) into
    // config.yaml BEFORE spawning, so the backend always matches the frontend's
    // choice. No hardcoded pin — the value comes from the user's saved Profile.
    applyActiveProfileCache()

    // Resolve the REAL executable path — do NOT spawn the bare command name,
    // because Electron's cleaned PATH often cannot find the hermes venv binary.
    // Try each existing candidate in turn; on an ENOENT spawn failure, walk to
    // the next one (see the 'error' handler + spawn try/catch below).
    const candidates = resolveHermesCandidates()
    if (candidateIndex >= candidates.length) {
      const errMsg = '找不到可启动的 hermes 可执行文件（已尝试 ' + candidates.length + ' 个候选）。请先安装 Hermes（iex (irm https://hermes-agent.nousresearch.com/install.ps1)），或将其 venv\\Scripts 目录加入 PATH。'
      console.error('[Hermes]', errMsg)
      mainWindow?.webContents.send('hermes:event', 'error', { message: errMsg })
      return reject(new Error(errMsg))
    }
    const hermesCmd = candidates[candidateIndex]
    console.log('[Hermes] resolved executable:', hermesCmd)
    // Build a clean env for the hermes subprocess. Electron's process.env may carry

    // proxy / TLS settings that OpenAI/ httpx picks up from the environment and that
    // cause the *chat completion* request to hang (init probe works, streaming hangs).
    // Strip those so the subprocess behaves like a plain terminal launch.
    const hermesDir = path.join(os.homedir(), 'AppData', 'Local', 'hermes')

    const hermesEnv = { ...process.env }

    // Pin HERMES_HOME so Hermes loads the SAME config.yaml/.env Electron writes.

    // Otherwise a system HERMES_HOME (e.g. ~/.hermes) makes Hermes read a different

    // .env (often missing) -> empty OPENAI_API_KEY -> upstream 401 "授权令牌无效",

    // and it would also ignore the model/personality config we sync from the UI.

    hermesEnv['HERMES_HOME'] = hermesDir
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      delete hermesEnv[k]
    }
    hermesEnv['NO_PROXY'] = '*'
    hermesEnv['no_proxy'] = '*'
    // Strip any inherited OPENAI_* so Hermes's own .env / config.yaml (managed
    // via hermes:setConfig) is authoritative. python-dotenv does NOT override an
    // already-present env var, so a stale OPENAI_BASE_URL in the parent shell would
    // otherwise silently override our configured endpoint (e.g. a leftover
    // http://127.0.0.1:8901 or :4002 gateway) and the model call would 404/hang.
    for (const k of ['OPENAI_BASE_URL', 'openai_base_url', 'OPENAI_API_KEY', 'openai_api_key']) {
      delete hermesEnv[k]
    }
    // Read .env directly and inject OPENAI_API_KEY / OPENAI_BASE_URL so we don't
    // depend on python-dotenv finding the .env from CWD.
    try {
      const envPath = path.join(hermesDir, '.env')
      const envContent = fs.readFileSync(envPath, 'utf-8')
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx <= 0) continue
        const key = trimmed.slice(0, eqIdx).trim()
        const val = trimmed.slice(eqIdx + 1).trim()
        if ((key === 'OPENAI_API_KEY' || key === 'OPENAI_BASE_URL') && val) {
          hermesEnv[key] = val
        }
      }
    } catch (e) {
      console.error('[Hermes] Failed to read .env for OPENAI_* injection:', e.message)
    }
    // Force Python to flush logs and surface httpx/OpenAI network activity
    hermesEnv['PYTHONUNBUFFERED'] = '1'
    hermesEnv['OPENAI_LOG'] = 'debug'
    hermesEnv['HTTPX_LOG_LEVEL'] = 'debug'
    hermesEnv['PYTHONPATH'] = '' // avoid stray site-packages leaking from Electron's env
    // Strip ALL npm/Electron-launch pollution so the venv python starts clean,
    // exactly like a plain terminal `hermes acp` (which works).
    for (const k of Object.keys(hermesEnv)) {
      if (k === 'PATH' || k === 'Path' || k === 'path') continue // handled below
      if (k.startsWith('npm_') || k === 'INIT_CWD' || k === 'NODE' || k === 'NODE_EXE'
        || k === 'NPM_CLI_JS' || k === 'NPM_PREFIX_JS' || k === 'NPM_PREFIX_NPM_CLI_JS'
        || k === 'npm_command' || k === 'npm_execpath' || k === 'npm_node_execpath'
        || k === 'npm_lifecycle_event' || k === 'npm_lifecycle_script'
        || k === 'COLOR' || k === 'FORCE_COLOR' || k === 'EFC_8920') {
        delete hermesEnv[k]
      }
    }
    // Rebuild PATH: keep system dirs + hermes venv, drop node_modules/.bin entries
    // that may shadow python tooling / inject Electron context.
    // IMPORTANT: always prepend the hermes venv Scripts dir so the resolved
    // executable can find its bundled python/deps regardless of inherited PATH.
    const hermesBinDir = path.dirname(hermesCmd)
    const cleanPath = (process.env.PATH || '')
      .split(';')
      .filter(p => !/node_modules[\\/]\.bin/i.test(p) && !/npm[\\/]node_modules/i.test(p))
    if (!cleanPath.includes(hermesBinDir)) cleanPath.unshift(hermesBinDir)
    hermesEnv['PATH'] = cleanPath.join(';')
    hermesEnv['Path'] = cleanPath.join(';')

    // ── serve-mode branch: same cleaned env, different protocol ──
    // Official desktop spawns `hermes serve --host 127.0.0.1 --port 0` with
    // HERMES_SERVE_HEADLESS=1 (API/WS only, no SPA) and announces readiness
    // on stdout: `HERMES_BACKEND_READY port=<N>` (backend-ready.ts:6).
    const isServe = GATEWAY_MODE === 'serve'
    if (isServe) {
      hermesEnv['HERMES_SERVE_HEADLESS'] = '1'
      if (!serveSessionToken) serveSessionToken = crypto.randomBytes(24).toString('hex')
      hermesEnv['HERMES_DASHBOARD_SESSION_TOKEN'] = serveSessionToken
      serveGatewayInfo = null // reset until the new handshake arrives
    }
    const hermesArgs = isServe
      ? ['serve', '--host', '127.0.0.1', '--port', '0']
      : ['acp']
    console.log('[Hermes] gateway mode:', GATEWAY_MODE, '| args:', hermesArgs.join(' '))

    // Pin the gateway's working directory to the user's selected project dir so
    // the agent (and its tools/terminal) actually runs there instead of inside
    // the Hermes install dir. TERMINAL_CWD is what Hermes's runtime_cwd reads as
    // the fallback after the per-session cwd context, so setting it guarantees
    // the agent lands in the right place even if a session cwd is not propagated.
    // IMPORTANT: the spawn `cwd` must exist on disk or CreateProcess fails with
    // ENOENT (-4058) even though the executable exists. A deleted/renamed
    // project folder was the classic cause — fall back to HOME so the gateway
    // can still boot, and the renderer's setWorkDir fixes the path later.
    let spawnCwd = workDir
    try {
      if (!fs.existsSync(spawnCwd)) {
        console.warn('[Hermes] workDir missing, falling back to HOME for spawn cwd:', workDir)
        spawnCwd = app.getPath('home')
      }
    } catch {
      spawnCwd = app.getPath('home')
    }
    hermesEnv['TERMINAL_CWD'] = spawnCwd
    let spawnedProcess
    try {
      spawnedProcess = spawn(hermesCmd, hermesArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: hermesEnv,
        cwd: spawnCwd,
      })
    } catch (err) {
      // Synchronous spawn failure (e.g. ENOENT) — retry the next candidate.
      if ((err.code === 'ENOENT' || err.errno === -4058) && candidateIndex + 1 < candidates.length) {
        console.log('[Hermes] spawn threw (ENOENT) — retrying with next candidate:', candidates[candidateIndex + 1])
        resolve(startHermesGateway(candidateIndex + 1))
        return
      }
      return reject(err)
    }
    hermesProcess = spawnedProcess
    // Activate the config.yaml/.env watcher (guarded — runs once even across restarts).
    setupHermesConfigWatcher()

    spawnedProcess.on('error', (err) => {
      console.error('[Hermes] Process error:', err.message, '| cmd:', hermesCmd)
      if (hermesProcess === spawnedProcess) hermesProcess = null
      // ENOENT / -4058 = the OS couldn't launch this executable (e.g. a broken or
      // partial venv — common after a failed `hermes update` leaves a `.venv` that
      // exists on disk but won't start). Walk to the next candidate rather than
      // giving up, so the gateway still boots from a working venv.
      if ((err.code === 'ENOENT' || err.errno === -4058) && candidateIndex + 1 < candidates.length) {
        console.log('[Hermes] spawn failed (ENOENT) — retrying with next candidate:', candidates[candidateIndex + 1])
        resolve(startHermesGateway(candidateIndex + 1))
        return
      }
      const detail = err.code === 'ENOENT'
        ? `找不到可执行文件: ${hermesCmd}\n请确认 Hermes 已安装，或将其 venv\\Scripts 目录加入 PATH。`
        : `Hermes 启动失败: ${err.message}`
      mainWindow?.webContents.send('hermes:event', 'error', {
        message: detail + '\n\n安装:\niex (irm https://hermes-agent.nousresearch.com/install.ps1)\n\n文档: https://hermes-agent.nousresearch.com/docs/getting-started/quickstart'
      })
      reject(err)
    })

    spawnedProcess.on('close', (code, signal) => {
      console.log('[Hermes] Process closed with code:', code, 'signal:', signal, '| was cmd:', hermesCmd)
      // A stale close event from a process that was replaced during a restart
      // must not overwrite the new process's state. Without this, the delayed
      // 'gateway.disconnected' overwrites the new 'gateway.ready' and the UI
      // stays stuck in "网关进程已退出".
      if (hermesProcess !== spawnedProcess) {
        console.log('[Hermes] Ignoring stale close event from replaced process')
        return
      }
      diagState.gatewayRunning = false
      hermesProcess = null
      serveGatewayInfo = null
      mainWindow?.webContents.send('hermes:event', 'gateway.disconnected', { code, signal })
      // Unexpected exit (NOT a deliberate restart — those leave hermesProcess
      // pointing at the replacement and hit the stale-guard above): auto-respawn
      // the serve gateway so the UI never stays stuck on the "connecting" splash.
      if (isServe && !appIsQuitting) {
        scheduleServeRespawn()
      }
    })

    hermesProcess.stdout?.on('data', (data) => {
      if (isServe) {
        // serve mode: stdout carries logs + the readiness handshake, NOT JSON-RPC.
        hermesStdoutBuffer += data.toString()
        let nl
        while ((nl = hermesStdoutBuffer.indexOf('\n')) >= 0) {
          const line = hermesStdoutBuffer.slice(0, nl).trim()
          hermesStdoutBuffer = hermesStdoutBuffer.slice(nl + 1)
          if (!line) continue
          // Official regex: /^HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/
          const m = line.match(/^HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/)
          // NOTE: do NOT guard with `!serveGatewayInfo` here. On a gateway
          // restart (setWorkDir / hooks / respawn) the old process's `close`
          // event may be skipped (hermesProcess already points at the new
          // process), so serveGatewayInfo is NOT reset to null — and the new
          // port's ready line would then be silently dropped, leaving the
          // renderer pointing at the dead port forever → every RPC hangs →
          // "点发送就卡死". Always update + re-push on every handshake.
          if (m) {
            const port = parseInt(m[1], 10)
            const prevPort = serveGatewayInfo?.port
            serveGatewayInfo = {
              mode: 'serve',
              port,
              token: serveSessionToken,
              baseUrl: `http://127.0.0.1:${port}`,
              wsUrl: `ws://127.0.0.1:${port}/api/ws?token=${serveSessionToken}`,
            }
            console.log('[Hermes] serve gateway ready on port', port, prevPort && prevPort !== port ? `(port changed ${prevPort} → ${port})` : '')
            if (mainWindow && !mainWindow.isDestroyed()) {
              // `gateway.ready` only flips the connected flag once...
              if (!_acpReadySent) {
                _acpReadySent = true
                mainWindow.webContents.send('hermes:event', 'gateway.ready')
              }
              // ...but `gateway.serveInfo` MUST be re-sent on EVERY handshake
              // (serve runs --port 0 → fresh port each start). Always push it.
              mainWindow.webContents.send('hermes:event', 'gateway.serveInfo', serveGatewayInfo)
              // A successful (re)connect clears the auto-respawn backoff window so
              // a recovered gateway isn't penalized by the previous crash count.
              serveRespawnCount = 0
              serveRespawnWindowStart = 0
            }
          } else if (/error|fail|traceback/i.test(line)) {
            console.log('[Hermes serve stdout]', line)
          }
        }
        return
      }
      hermesStdoutBuffer += data.toString()
      processHermesBuffer()
    })

    hermesProcess.stderr?.on('data', (data) => {
      const text = data.toString()
      // ── Surface gateway connection errors / retries to the renderer ──
      // Hermes logs transient upstream connection drops (apihub latency/flakiness)
      // as stderr lines; the renderer would otherwise only see a long "thinking"
      // pause with no clue. Forward a structured 'gateway.retry' event so the UI
      // can show "connection lost / reconnecting" and clear it on recovery.
      hermesStderrBuffer += text
      let nl
      while ((nl = hermesStderrBuffer.indexOf('\n')) >= 0) {
        const line = hermesStderrBuffer.slice(0, nl).trim()
        hermesStderrBuffer = hermesStderrBuffer.slice(nl + 1)
        if (!line) continue
        // Detect ACP server readiness. Hermes logs "ACP client connected" to
        // stderr after plugin discovery + asyncio.run(acp.run_agent) starts
        // listening on stdio. This is the true "gateway ready" signal — far
        // more reliable than a fixed timer, and prevents the UI from sending
        // session/new before ACP can consume it.
        if (!_acpReadySent && /ACP client connected/i.test(line)) {
          _acpReadySent = true
          console.log('[Hermes] ACP client connected detected — gateway truly ready')
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('hermes:event', 'gateway.ready')
          }
        }
        // Surface raw HTTP/auth debug from the gateway (OPENAI_LOG/HTTPX_LOG) so
        // a 401 isn't silently dropped — shows the real upstream rejection.
        if (/401|unauthorized|HTTP\/|Bearer|openai|api[_-]?key|auth|token|ant-?ling|stepfun/i.test(line)) {
          console.log('[Hermes stderr]', line)
        }
        try {
          if (/Connection error\.|Streaming failed before delivery|APIConnectionError/.test(line)) {
            hermesConnError = true
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('hermes:event', 'gateway.retry', {
                phase: 'error',
                message: '网关连接中断（上游无响应），正在准备重试…',
              })
            }
          } else if (/Retrying API call in [\d.]+s \(attempt (\d+)\/(\d+)\)/.test(line)) {
            hermesConnError = true
            const m = line.match(/Retrying API call in [\d.]+s \(attempt (\d+)\/(\d+)\)/)
            const attempt = m ? parseInt(m[1], 10) : undefined
            const total = m ? parseInt(m[2], 10) : undefined
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('hermes:event', 'gateway.retry', {
                phase: 'retrying',
                attempt,
                total,
                message: `网关连接不稳定，正在重连（第 ${attempt}/${total} 次）…`,
              })
            }
          } else if (/HTTP\/1\.1 200 OK/.test(line) && hermesConnError) {
            // A successful request arrived after a connection error → recovered.
            hermesConnError = false
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('hermes:event', 'gateway.retry', {
                phase: 'recovered',
                message: '已恢复连接',
              })
            }
          }
        } catch (e) {
          // never let stderr parsing break the gateway process
        }
      }
    })

    // Resolve immediately when process spawns successfully
    // ACP server readiness is detected via stderr ("ACP client connected"),
    // which fires after plugin discovery + asyncio.run(acp.run_agent) starts.
    // The old 500ms timer fired too early — the UI would send session/new
    // before ACP was listening, and a concurrent setModel/setConfig would
    // kill the process mid-discovery → "思考中但无输出".
    hermesProcess.on('spawn', () => {
      console.log('[Hermes] ACP process spawned')
      diagState.gatewayRunning = true
      diagState.gatewayStartedAt = Date.now()
      // Fallback: if "ACP client connected" never appears (older Hermes or
      // log format change), still send ready after a generous delay so the
      // UI doesn't hang forever. serve mode: handshake is authoritative and
      // Python cold start can take 40-90s (official desktop uses 90s timeout),
      // so the fallback only logs a warning instead of faking readiness.
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        if (_acpReadySent) return
        if (isServe) {
          if (!serveGatewayInfo) console.warn('[Hermes] serve handshake not seen yet (still waiting, up to 90s is normal)')
          return
        }
        _acpReadySent = true
        console.log('[Hermes] Sending gateway.ready to renderer (fallback timer)')
        mainWindow.webContents.send('hermes:event', 'gateway.ready')
      }, 8000)
      resolve()
    })
  })
}

// Load app icon from Helix.ico
const iconPath = path.join(__dirname, '..', 'public', 'Helix.ico')
let appIcon = null
if (fs.existsSync(iconPath)) {
  appIcon = nativeImage.createFromPath(iconPath)
  console.log('Icon loaded from:', iconPath, 'size:', appIcon.getSize())
} else {
  console.log('Icon not found at:', iconPath)
}

let mainWindow = null
const PORT = process.env.PORT || 3000
let nextServer = null

// ── Port acquisition ────────────────────────────────────────────────────────

async function acquirePort(port) {
  const net = require('net')
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(null))
    server.once('listening', () => resolve(server))
    server.listen(port)
  })
}

// ── Next.js frontend servers (UI only, no API routes) ───────────────────────

async function startNextDev() {
  let nextPath = path.join(__dirname, '..', 'node_modules', '.bin', 'next')
  if (process.platform === 'win32') {
    const cmdPath = nextPath + '.cmd'
    try { await fsPromises.access(cmdPath); nextPath = cmdPath } catch {}
  }

  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: PORT.toString() }
    const cmd = process.platform === 'win32' ? `"${nextPath}"` : nextPath
    let resolved = false

    // NOTE: must use `--webpack`, NOT Turbopack. Turbopack on Windows panics on
    // a reserved device-name (`nul`) during CSS compilation (vercel/next.js#90860),
    // which crashes the whole dev server and leaves the UI blank / unresponsive.
    // This must stay in sync with the `dev` / `electron:dev` scripts in package.json.
    nextServer = exec(`${cmd} dev --webpack -p ${PORT}`, { env, cwd: path.join(__dirname, '..') })

    const onData = (data) => {
      console.log(`[Next.js] ${data}`)
      if (!resolved && (data.includes('Ready') || data.includes('ready'))) {
        resolved = true
        resolve()
      }
    }

    nextServer.stdout?.on('data', onData)
    nextServer.stderr?.on('data', onData)
    nextServer.on('error', (err) => { if (!resolved) { resolved = true; reject(err) } })
    setTimeout(() => { if (!resolved) { resolved = true; resolve() } }, 60000)
  })
}

async function startNextStandalone() {
  const serverPath = path.join(process.resourcesPath, '.next', 'standalone', 'server.js')
  return new Promise((resolve, reject) => {
    let resolved = false
    const env = { ...process.env, PORT: PORT.toString(), NODE_ENV: 'production' }
    nextServer = exec(`node "${serverPath}"`, { env, cwd: path.join(process.resourcesPath, '.next', 'standalone') })

    const onData = (data) => {
      console.log(`[Next.js] ${data}`)
      if (!resolved && (data.includes('Ready') || data.includes('ready') || data.includes('started'))) {
        resolved = true
        resolve()
      }
    }

    nextServer.stdout?.on('data', onData)
    nextServer.stderr?.on('data', onData)
    nextServer.on('error', (err) => { if (!resolved) { resolved = true; reject(err) } })
    setTimeout(() => { if (!resolved) { resolved = true; resolve() } }, 5000)
  })
}

// Security: restrict file access to working directory
// In packaged Electron apps, process.cwd() often points to an internal
// directory (e.g. hermes install dir) rather than a meaningful project path.
// Use the user's home directory as the safe default; the renderer will
// override it with the last-used project from IndexedDB on startup.
let workDir = app.isReady() ? app.getPath('home') : process.cwd()

// Persist/restore the user's selected project directory so the Hermes gateway
// (spawned at app start) boots into the right cwd instead of reverting to HOME.
function getPersistedWorkDir() {
  try {
    const p = path.join(app.getPath('userData'), 'workdir.json')
    const raw = fs.readFileSync(p, 'utf-8')
    const obj = JSON.parse(raw)
    if (obj && typeof obj.workDir === 'string' && obj.workDir.trim()) return obj.workDir.trim()
  } catch {}
  return null
}
function persistWorkDir(dir) {
  try {
    const p = path.join(app.getPath('userData'), 'workdir.json')
    fs.writeFileSync(p, JSON.stringify({ workDir: dir }), 'utf-8')
  } catch {}
}

function safePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null
  if (typeof workDir !== 'string' || !workDir) return null
  const root = path.resolve(workDir)
  const resolved = path.resolve(root, filePath)
  // Lexical containment: must be inside root (or root itself). The `+ sep`
  // guard prevents `/workdir2`-style sibling escapes, and path.resolve()
  // already normalized `..` and drive-relative segments.
  const within = resolved === root || resolved.startsWith(root + path.sep)
  if (!within) return null
  // Symlink escape check: resolve the real path on disk and verify it still
  // lands inside root. A link pointing outside the workspace is rejected.
  try {
    const realResolved = fs.realpathSync(resolved)
    const realRoot = fs.realpathSync(root)
    const realWithin = realResolved === realRoot || realResolved.startsWith(realRoot + path.sep)
    return realWithin ? realResolved : null
  } catch {
    // Path does not exist yet (e.g. a file about to be created) — lexical
    // containment above is the best we can do, and it already passed.
    return resolved
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Helix',
    icon: appIcon,
    frame: false,
    show: false,
    roundedCorners: 'off',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
    backgroundColor: '#FCFBF9',
  })

  // Load the Next.js frontend (dev or production)
  const isDev = !app.isPackaged
  const url = `http://localhost:${PORT}`

  if (isDev) {
    // Dev: start next dev if not already running
    const lock = await acquirePort(PORT)
    if (lock) {
      lock.close()
      await startNextDev()
    }
  } else {
    // Production: load from standalone server
    const lock = await acquirePort(PORT)
    if (lock) {
      lock.close()
      await startNextStandalone()
    }
  }

  // Wait for Next.js to be ready
  const maxRetries = 30
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url)
      if (response.ok) break
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  mainWindow.loadURL(url)
  mainWindow.setMenuBarVisibility(false)

  // Ensure the window starts centered and never maximized. Some displays cause
  // Electron to open a 1400x900 window in a maximized-looking state; explicitly
  // unmaximize before show so the titlebar shows the maximize (not restore) icon.
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
    mainWindow.focus()
  })

  // Force set window icon after creation
  if (process.platform === 'win32') {
    try {
      const winIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'public', 'Helix.ico'))
      if (!winIcon.isEmpty()) {
        mainWindow.setIcon(winIcon)
      }
    } catch (e) {
      console.log('Failed to set window icon:', e)
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('maximize', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('window:maximized-changed', true)
      }
    } catch {}
  })
  mainWindow.on('unmaximize', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('window:maximized-changed', false)
      }
    } catch {}
  })

  // Block Electron's default Ctrl+R / Ctrl+Shift+R / F5 page refresh so the
  // React keyboard-shortcuts handler controls reload behavior instead.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isMod = input.control || input.meta
    if (input.type === 'keyDown') {
      if ((isMod && !input.shift && input.key.toLowerCase() === 'r') || input.key === 'F5') {
        event.preventDefault()
      }
    }
  })
}



// ── Hermes IPC Bridge ───────────────────────────────────────────────────────

safeHandle('hermes:send', async (event, method, params) => {
  // If the gateway process died (hermesProcess === null), try to bring it back up
  // before forwarding the request, so a transient crash doesn't permanently break the UI.
  if (!hermesProcess) {
    if (!hermesCanRestart()) {
      console.warn('[Hermes] restart suppressed — too many recent crashes')
      return { error: 'Hermes 反复崩溃，已暂停自动重启，请稍后重试或检查配置' }
    }
    console.warn('[Hermes] no live process on send — attempting restart')
    try {
      hermesRecordRestart()
      await startHermesGateway()
    } catch (e) {
      return { error: `Hermes 未运行且重启失败: ${e.message}` }
    }
  }
  // If config.yaml/.env was edited externally since the gateway started, recycle
  // it now (lazily, before forwarding) so the next request reads fresh auth —
  // no manual invalidation, no session rebuild, no 401.
  if (_hermesConfigStale && hermesProcess && GATEWAY_MODE !== 'serve') {
    // serve 模式跳过：REST /api/model/set 本身就会写 config.yaml，触发本监视器；
    // serve 在每次 session.create 时重读配置，无需回收进程（回收反而 WS 1006 断连）。
    console.log('[Hermes] config stale → recycling gateway before request')
    const oldP = hermesProcess
    hermesProcess = null
    try { oldP.kill() } catch {}
    await new Promise((r) => setTimeout(r, 300))
    try { await startHermesGateway() } catch (e) { console.error('[Hermes] stale recycle failed:', e.message) }
    _hermesConfigStale = false
  }
  // The current Hermes gateway build does not implement `tools/list` (it
  // returns -32601 Method not found). api-settings.tsx calls it to detect which
  // MCP servers are connected. Instead of round-tripping to a method that 404s
  // (and surfacing a spurious "Error occurred in handler" IPC rejection), answer
  // locally with an empty list so MCP status cleanly shows "disconnected".
  if (method === 'tools/list') {
    return { tools: [] }
  }
  // The current Hermes gateway build does not implement `hermes:getTasks`
  // (it returns -32601 Method not found). It's used as a capability probe on
  // startup (helix-layout) and to populate the Task List panel; answer locally
  // with an empty list so neither path 404s or surfaces a spurious error.
  if (method === 'hermes:getTasks') {
    return { tasks: [] }
  }
  // `session.context_breakdown` is implemented by the serve gateway
  // (tui_gateway/methods_session.py). Forward it through instead of answering
  // null, so the context-usage ring/breakdown can show real category data in
  // ACP mode as well. If the backend still 404s, the renderer catches it and
  // shows the empty state.
  if (method === 'session/prompt') {
    // Send, but if the backend reports the session was not found (stale id from
    // a gateway restart the frontend hasn't caught up with), auto-create a new
    // session and replay the prompt — so the user never sees a silent no-output.
    sendHermesRequest(method, params)
      .then((result) => {
        // Forward usage data to the renderer so token stats update.
        const usage = result?.usage
        if (usage && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('hermes:event', 'usage:prompt-complete', { usage })
        }
        return result
      })
      .catch(async (err) => {
        const msg = (err?.message || '') + ' ' + (err?.stack || '')
        if (/not found|session_not_found|no such session|unknown session/i.test(msg) && params?.session_id) {
          console.warn('[Hermes] session not found on prompt — creating fresh session and retrying')
          try {
            const newSession = await sendHermesRequest('session/new', {})
            const newId = newSession?.result?.session_id
              || newSession?.session_id
              || newSession?.result?._meta?.hermes?.sessionProvenance?.acpSessionId
            if (newId) {
              console.log('[Hermes] recreated session for retry:', newId)
              // Tell the renderer the new session id so it stops using the stale one
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('hermes:event', 'gateway.sessionReplaced', { oldId: params.session_id, newId })
              }
              await sendHermesRequest('session/prompt', { ...params, session_id: newId })
              return
            }
          } catch (retryErr) {
            console.error('[Hermes] session/prompt retry failed:', retryErr?.message || retryErr)
          }
          // Re-throw so the frontend still sees a failure if recovery failed
          throw err
        }
      })
    return
  }
  return sendHermesRequest(method, params)
})

safeHandle('hermes:interrupt', async (event, sessionId) => {
  // session/cancel is registered by Hermes as a *notification* (no response),
  // so it must be sent without an id. Sending it as a request returns
  // "Method not found" (-32601).
  sendHermesNotification('session/cancel', { session_id: sessionId })
  return { ok: true }
})

// Fire-and-forget JSON-RPC notification to Hermes (e.g. session/cancel).
safeOn('hermes:notify', (event, method, params) => {
  sendHermesNotification(method, params)
})

safeHandle('hermes:status', async () => {
  if (!hermesProcess) {
    if (!hermesCanRestart()) {
      console.log('[Hermes] Status check: restart suppressed (crash loop)')
      return { connected: false, error: 'crash-loop' }
    }
    // Lazily probe / restart so the UI's periodic health check can self-heal.
    try {
      hermesRecordRestart()
      await startHermesGateway()
    } catch (e) {
      console.log('[Hermes] Status check: false (restart failed:', e.message + ')')
      return { connected: false, error: e.message }
    }
  }
  const connected = !!hermesProcess
  console.log('[Hermes] Status check:', connected)
  return { connected }
})

// ── Gateway connection info (serve-migration Phase 1) ──────────────────────
// Renderer calls this to learn which protocol is active and, in serve mode,
// where to connect directly (REST baseUrl + WS url with token). In acp mode
// it returns { mode:'acp' } and the renderer keeps using the IPC bridge.
safeHandle('hermes:getGatewayInfo', async () => {
  if (GATEWAY_MODE === 'serve') {
    return serveGatewayInfo || { mode: 'serve', pending: true }
  }
  return { mode: 'acp' }
})

// ── Gateway topology switch (local spawned runtime <-> remote external WS) ──
// The renderer's breadcrumb toggle calls this. In 'remote' mode we tear down the
// local `hermes serve` subprocess and point the frontend at an external gateway
// WebSocket URL; in 'local' mode we respawn the bundled runtime.
function buildRemoteGatewayInfo(rawUrl) {
  if (!rawUrl) return null
  let wsUrl = rawUrl.trim()
  // Accept a plain http(s) base and derive the Hermes WS path.
  if (/^https?:\/\//i.test(wsUrl)) {
    const base = wsUrl.replace(/\/+$/, '')
    wsUrl = base.replace(/^http/i, 'ws') + '/api/ws'
  }
  let baseUrl = wsUrl.split('?')[0].replace(/\/api\/ws$/, '')
  baseUrl = baseUrl.replace(/^wss?:\/\//i, (m) => (m.toLowerCase().startsWith('wss') ? 'https://' : 'http://'))
  return { mode: 'serve', pending: false, wsUrl, baseUrl, port: 0, remote: true }
}

safeHandle('hermes:setGatewayMode', async (event, params = {}) => {
  const mode = params.mode === 'remote' ? 'remote' : 'local'
  const url = (params.url || '').trim()
  currentGatewayMode = mode
  remoteGatewayUrl = url
  if (mode === 'remote') {
    if (!url) {
      return { ok: false, error: 'remote 模式需要提供网关地址（WebSocket URL）' }
    }
    const info = buildRemoteGatewayInfo(url)
    if (!info) {
      return { ok: false, error: '无效的远程网关地址' }
    }
    // Kill the local subprocess if one is running.
    const oldP = hermesProcess
    hermesProcess = null
    try { if (oldP) oldP.kill() } catch {}
    serveGatewayInfo = info
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hermes:event', 'gateway.serveInfo', serveGatewayInfo)
    }
    console.log('[Hermes] gateway mode → remote:', info.wsUrl)
    return { ok: true, mode: 'remote', info: serveGatewayInfo }
  }
  // Back to local: respawn the bundled runtime (handshake will push serveInfo).
  console.log('[Hermes] gateway mode → local (respawning bundled runtime)')
  startHermesGateway().catch((e) => console.error('[Hermes] local gateway respawn failed:', e?.message || e))
  return { ok: true, mode: 'local' }
})

// ── Fetch models from custom API endpoint ──────────────────────────────────

safeHandle('hermes:fetchModels', async (event, { baseUrl, apiKey }) => {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    const models = (data.data || data.models || []).map((m) => m.id || m.name || m)
    return { models }
  } catch (err) {
    return { models: [], error: err.message }
  }
})

// ── Hermes backend config.yaml read/write (Memory settings panel) ──────
// The serve gateway exposes GET/PUT /api/config on the SAME uvicorn port as
// /api/ws. A *browser* fetch from http://localhost:3000 → 127.0.0.1:<port>
// fails with "Failed to fetch": we send the `X-Hermes-Session-Token` custom
// header, so the browser issues a CORS preflight (OPTIONS) which carries NO
// token; the dashboard auth gate 401s that preflight *before* the CORS
// middleware can answer, so the real request is blocked. Routing the call
// through the main process (Node fetch, token attached, no browser preflight)
// sidesteps the entire problem. Verified: OPTIONS w/o token → 401, GET w/ token
// → 200 + full config JSON.
function _serveConfigUrl() {
  if (GATEWAY_MODE !== 'serve' || !serveGatewayInfo || !serveGatewayInfo.port) return null
  return `http://127.0.0.1:${serveGatewayInfo.port}/api/config`
}

safeHandle('hermes:getRawConfig', async () => {
  const url = _serveConfigUrl()
  if (!url) return { ok: false, error: 'gateway-not-ready' }
  try {
    const res = await fetch(url, {
      headers: { 'X-Hermes-Session-Token': serveGatewayInfo.token || '' },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, config: await res.json() }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

safeHandle('hermes:setRawConfig', async (event, patch) => {
  const url = _serveConfigUrl()
  if (!url) return { ok: false, error: 'gateway-not-ready' }
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Hermes-Session-Token': serveGatewayInfo.token || '',
      },
      body: JSON.stringify({ config: patch }),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ── Hermes Settings Sync ────────────────────────────────────────────────────

// ── Hermes config read (frontend mirrors backend) ───────────────────────
safeHandle('hermes:getConfig', async () => {
  try {
    const hermesDir = path.join(require('os').homedir(), 'AppData', 'Local', 'hermes')
    const yamlPath = path.join(hermesDir, 'config.yaml')
    const envPath = path.join(hermesDir, '.env')
    const yaml = fs.readFileSync(yamlPath, 'utf-8').replace(/\r\n/g, '\n')
    const res = { provider: '', model: '', baseUrl: '', hasApiKey: false }
    let inModel = false, inProviders = false, entryActive = false
    let cpBaseUrl = '', cpModel = ''
    for (const lp of yaml.split('\n')) {
      const mProv = lp.match(/^\s*provider:\s*(.+?)\s*$/)
      if (mProv && !inModel && !inProviders) { res.provider = mProv[1]; continue }
      if (/^model:/.test(lp)) { inModel = true; continue }
      if (/^custom_providers:/.test(lp)) { inModel = false; inProviders = true; continue }
      if (inModel) {
        if (/^\S/.test(lp) && !lp.startsWith(' ')) { inModel = false }
        else {
          const mP = lp.match(/^\s+provider:\s*(.+?)\s*$/)
          const mD = lp.match(/^\s+default:\s*(.+?)\s*$/)
          const mB = lp.match(/^\s+base_url:\s*(.+?)\s*$/)
          if (mP) res.provider = mP[1]
          if (mD) res.model = mD[1]
          if (mB) res.baseUrl = mB[1]
          continue
        }
      }
      if (inProviders) {
        if (/^\S/.test(lp) && !lp.startsWith(' ') && !lp.startsWith('-')) { inProviders = false; entryActive = false; continue }
        const mN = lp.match(/^\s*-\s+name:\s*(.+?)\s*$/)
        if (mN) { entryActive = (mN[1] === res.provider); continue }
        if (entryActive) {
          const mB = lp.match(/^\s+base_url:\s*(.+?)\s*$/)
          const mM = lp.match(/^\s+model:\s*(.+?)\s*$/)
          if (mB) cpBaseUrl = mB[1]
          if (mM) cpModel = mM[1]
        }
      }
    }
    // Named custom provider overrides model.default / model.base_url
    if (cpBaseUrl) res.baseUrl = cpBaseUrl
    if (cpModel) res.model = cpModel
    // Parse the top-level `delegation:` block so the Agents/子智能体 settings
    // panel can show the actual subagent routing config (delegation.provider,
    // delegation.model, delegation.base_url, max_iterations, reasoning_effort,
    // subagent_auto_approve). Absent → empty object (inherit parent model).
    res.delegation = {}
    {
      let inDelegation = false
      for (const lp of yaml.split('\n')) {
        if (/^delegation:/.test(lp)) { inDelegation = true; continue }
        if (inDelegation) {
          if (/^\S/.test(lp) && !lp.startsWith(' ')) { inDelegation = false; break }
          const m = lp.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/)
          if (m) res.delegation[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim()
        }
      }
    }
    let envKey = ''
    try {
      const env = fs.readFileSync(envPath, 'utf-8')
      for (const l of env.split(String.fromCharCode(10))) {
        if (l.startsWith('OPENAI_API_KEY=')) { envKey = l.slice('OPENAI_API_KEY='.length).trim(); break }
      }
    } catch {}
    res.hasApiKey = !!envKey
    return res
  } catch (err) {
    return { provider: '', model: '', baseUrl: '', hasApiKey: false, error: err.message }
  }
})

let _lastHermesConfig = null
let _lastHermesConfigWriteTime = 0

safeHandle('hermes:setConfig', async (event, config) => {
  // serve 模式：同样写入 config.yaml（serve 在每次 session.create 时才读取），
  // 不重启网关——restartGatewayDebounced 在 serve 下已自动 no-op。模型配置的
  // 首选路径仍是 serve-gateway.setModel（pushModelConfig），setConfig 只是把
  // 设置页 handleSave / 历史记录点击的直写调用也落到磁盘，二者写入相同值。
  const { model, provider, baseUrl, apiKey } = config
  // Defense-in-depth: validate the incoming config so a stale/malformed profile
  // never poisons Hermes config.yaml and produces 401s.
  // that to the gateway flips OPENAI_BASE_URL/OPENAI_API_KEY and produces a
  // 401 "无效的令牌". If the incoming config is bad, keep the requested model
  // name but force the known-good apihub endpoint + key so the gateway never
  // authenticates against a foreign/dead endpoint.
  const safe = isBadConfig(config)
    ? { model: model || APIHUB_DEFAULT.model, provider: APIHUB_DEFAULT.provider, baseUrl: APIHUB_DEFAULT.baseUrl, apiKey: APIHUB_DEFAULT.apiKey }
    : { model, provider, baseUrl, apiKey }
  try {
    writeHermesConfig({ model: safe.model, provider: safe.provider, baseUrl: safe.baseUrl, apiKey: safe.apiKey })

    // Restart if provider, baseUrl, or apiKey actually changed
    const prev = _lastHermesConfig
    const needsRestart = !prev || (
      (prev.provider && prev.provider !== safe.provider) ||
      (prev.baseUrl && prev.baseUrl !== safe.baseUrl) ||
      (prev.apiKey !== undefined && prev.apiKey !== (safe.apiKey || ''))
    )
    _lastHermesConfig = { model: safe.model || '', provider: safe.provider || '', baseUrl: safe.baseUrl || '', apiKey: safe.apiKey || '' }

    if (needsRestart && hermesProcess) {
      await restartGatewayDebounced('setConfig')
    }

    return { success: true }
  } catch (err) {
    console.error('[Hermes] Config update failed:', err)
    return { success: false, error: err.message }
  }
})

// ── Active Profile cache ──────────────────────────────────────────────────
// Registered by registerSecurityHandlers (electron/ipc/security.js)


// ── Hermes config.yaml key setter ────────────────────────────────────────
// Sets a single nested key (e.g. 'compression.enabled') in config.yaml and
// restarts Hermes so the change takes effect. Used by the Helix settings UI.
safeHandle('hermes:setYamlKey', async (event, { key, value }) => {
  // serve 模式：直接写入 config.yaml（每次 session.create 会重新读取），
  // 不重启网关——restartGatewayDebounced 在 serve 下自动 no-op。
  // 修复 serve 下设置页 setYamlKey 曾为 no-op 导致 delegation.* 等配置
  // 永远不落地的问题。
  try {
    const yamlPath = path.join(require('os').homedir(), 'AppData', 'Local', 'hermes', 'config.yaml')
    const c = fs.readFileSync(yamlPath, 'utf-8')
    const updated = setYamlKey(c, key, value)
    if (updated === c) return { success: true, changed: false }
    fs.writeFileSync(yamlPath, updated, 'utf-8')
    console.log('[Hermes] setYamlKey', key, '=', value)
    if (hermesProcess) {
      await restartGatewayDebounced('setYamlKey:' + key)
    }
    return { success: true, changed: true }
  } catch (err) {
    console.error('[Hermes] setYamlKey failed:', err)
    return { success: false, error: err.message }
  }
})

// Persist `delegation.identities` (named subagent personas) as a JSON-on-one-
// line YAML flow value. Serve mode: direct config.yaml write, no restart (the
// next session.create re-reads it). Used by the Subagent settings UI.
safeHandle('hermes:setDelegationIdentities', async (event, identities) => {
  try {
    const yamlPath = path.join(require('os').homedir(), 'AppData', 'Local', 'hermes', 'config.yaml')
    const c = fs.readFileSync(yamlPath, 'utf-8')
    const updated = setDelegationIdentities(c, identities)
    if (updated === c) return { success: true, changed: false }
    fs.writeFileSync(yamlPath, updated, 'utf-8')
    console.log('[Hermes] setDelegationIdentities:', Array.isArray(identities) ? identities.length : 0, 'identities')
    if (hermesProcess) {
      await restartGatewayDebounced('setDelegationIdentities')
    }
    return { success: true, changed: true }
  } catch (err) {
    console.error('[Hermes] setDelegationIdentities failed:', err)
    return { success: false, error: err.message }
  }
})

// ── Hermes agent config (temperature, maxTokens, reasoningEffort, etc.) ────
// Writes all agent behaviour settings to config.yaml and restarts the gateway.
safeHandle('hermes:setAgentConfig', async (event, params = {}) => {
  // serve 模式：直接写入 config.yaml，不重启网关（restart 自动 no-op）。
  try {
    writeHermesAgentConfig(params)
    if (hermesProcess) {
      await restartGatewayDebounced('setAgentConfig')
    }
    return { success: true }
  } catch (err) {
    console.error('[Hermes] setAgentConfig failed:', err)
    return { success: false, error: err.message }
  }
})

// ── Reasoning fast path ──────────────────────────────────────────────────
// Writes ONLY agent.reasoning_effort to config.yaml (persist for future
// sessions / restarts) and deliberately does NOT restart the gateway. The
// renderer follows up with a sentinel prompt that updates the live agent's
// reasoning_config in place, so the slider takes effect on the very next
// message with no 2–3s restart. We cannot reuse writeHermesAgentConfig here:
// it clobbers agent.system_prompt with a default whenever `personality` is
// absent, which would wipe the user's configured personality.
safeHandle('hermes:setReasoningEffort', async (event, params = {}) => {
  try {
    const { reasoningEffort } = params
    if (reasoningEffort === undefined || reasoningEffort === null) return { success: false }
    const yamlPath = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'config.yaml')
    let yaml = ''
    try { yaml = fs.readFileSync(yamlPath, 'utf-8') } catch { return { success: false } }
    const updated = setYamlKey(yaml, 'agent.reasoning_effort', String(reasoningEffort))
    if (updated !== yaml) {
      fs.writeFileSync(yamlPath, updated, 'utf-8')
      markOwnConfigWrite()
    }
    return { success: true }
  } catch (err) {
    console.error('[Hermes] setReasoningEffort failed:', err)
    return { success: false, error: err.message }
  }
})

// ── Live config push (no gateway restart) ────────────────────────────────
// Sets a single key/value pair in config.yaml. Used for real-time config
// changes that take effect on the next prompt without restart.
safeHandle('hermes:setConfigKeyValue', async (event, params = {}) => {
  try {
    const { key, value, session_id } = params
    if (!key) return { success: false }
    const yamlPath = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'config.yaml')
    let yaml = ''
    try { yaml = fs.readFileSync(yamlPath, 'utf-8') } catch { return { success: false } }
    const updated = setYamlKey(yaml, key, String(value ?? ''))
    if (updated !== yaml) {
      fs.writeFileSync(yamlPath, updated, 'utf-8')
      markOwnConfigWrite()
    }
    // Also try to push to the running session via config.set RPC if session_id is provided
    if (session_id && hermesProcess) {
      try {
        await sendHermesRequest('config.set', { key, value, session_id })
      } catch {
        // Config was persisted to yaml; live push is best-effort
      }
    }
    return { success: true }
  } catch (err) {
    console.error('[Hermes] setConfigKeyValue failed:', err)
    return { success: false, error: err.message }
  }
})

// ── Approval response ────────────────────────────────────────────────────
// Forwards the user's approval decision to the backend.
safeHandle('hermes:approvalRespond', async (event, params = {}) => {
  try {
    const { session_id, tool_call_id, choice } = params
    if (hermesProcess) {
      await sendHermesRequest('approval.respond', { session_id, tool_call_id, choice })
    }
    return { success: true }
  } catch (err) {
    console.error('[Hermes] approvalRespond failed:', err)
    return { success: false, error: err.message }
  }
})

// ── Hermes personality list ──────────────────────────────────────────────
// Returns the predefined personalities from config.yaml (agent.personalities).
safeHandle('hermes:listPersonalities', async () => {
  try {
    const yamlPath = path.join(require('os').homedir(), 'AppData', 'Local', 'hermes', 'config.yaml')
    const lines = fs.readFileSync(yamlPath, 'utf-8').split('\n')
    let start = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^agent:/.test(lines[i])) { start = i; break }
    }
    if (start === -1) return { success: true, personalities: {} }
    const out = {}
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i]) && !lines[i].startsWith(' ')) break
      const m = lines[i].match(/^\s{4}([A-Za-z0-9_\u4e00-\u9fff]+):\s?(.*)$/)
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
    return { success: true, personalities: out }
  } catch (e) {
    return { success: false, error: e.message }
  }
})


// Trigger a Hermes backend self-update (`hermes update`). Fire-and-forget:
// spawn the update command and return immediately so the UI can show
// "updating…" without blocking on the (potentially long) download.
safeHandle('hermes:update', async () => {
  try {
    const hermesCmd = resolveHermesCmd()
    if (!hermesCmd) return { ok: false, message: '找不到 hermes 可执行文件' }
    // Spawn detached so it survives; stdout/stderr go to the gateway logs.
    const child = spawn(hermesCmd, ['update'], {
      cwd: path.join(require('os').homedir(), 'AppData', 'Local', 'hermes'),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return { ok: true, message: '已启动 Hermes 更新，完成后请重启 Helix' }
  } catch (e) {
    return { ok: false, message: String(e?.message || e) }
  }
})

// Apply a personality by writing agent.system_prompt into Hermes config.yaml.
// Mirrors the CLI `/personality <name>` command: resolves the prompt from
// config.yaml's agent.personalities, or uses the prompt passed from the UI.
safeHandle('hermes:setPersonality', async (event, { name, prompt } = {}) => {
  // serve 模式：直接写入 config.yaml 的 agent.system_prompt，不重启网关。
  try {
    const localApp = process.env.LOCALAPPDATA || ''
    if (!localApp) return { success: false, error: 'LOCALAPPDATA not set' }
    const yamlPath = path.join(localApp, 'hermes', 'config.yaml')
    const yaml = fs.readFileSync(yamlPath, 'utf-8')
    const clearNames = ['', 'none', 'default', 'neutral', 'clear']
    const nameStr = String(name || '').trim()
    let resolved
    if (clearNames.includes(nameStr.toLowerCase())) {
      resolved = ''
    } else {
      const personas = parseHermesPersonalities(yaml)
      if (prompt) resolved = String(prompt)
      else if (personas[nameStr]) resolved = personas[nameStr]
      else return { success: false, error: `Unknown personality: ${nameStr}` }
    }
    // Quote so the value is safe as a YAML scalar.
    const safe = '"' + String(resolved).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    const updated = setYamlKey(yaml, 'agent.system_prompt', safe)
    fs.writeFileSync(yamlPath, updated, 'utf-8')
    console.log('[Hermes] personality set:', nameStr || '(cleared)')
    if (hermesProcess) {
      await restartGatewayDebounced('setPersonality')
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

safeHandle('hermes:setModel', async (event, { model, baseUrl, apiKey, provider } = {}) => {
  try {
    if (!model || !String(model).trim()) {
      return { success: true, applied: false, reason: 'no model' }
    }
    // Note: the rest of setModel writes config.yaml + .env directly below.
    // If the requested endpoint is bad, keep the model name but force the
    // known-good apihub endpoint + key.
    if (isBadConfig({ provider, baseUrl, apiKey })) {
      baseUrl = APIHUB_DEFAULT.baseUrl
      apiKey = APIHUB_DEFAULT.apiKey
      provider = APIHUB_DEFAULT.provider
    }
    const localApp = process.env.LOCALAPPDATA || ''
    if (!localApp) return { success: false, error: 'LOCALAPPDATA not set' }
    const hermesDir = path.join(localApp, 'hermes')
    const requested = provider && String(provider).trim() && String(provider).trim() !== 'custom' ? String(provider).trim() : ''
    let hermesKey = (apiKey && String(apiKey).trim()) ? String(apiKey).trim() : ''
    // Only fall back to the on-disk key when no baseUrl is supplied (model-only
    // update on the current endpoint).  When a new baseUrl is given the caller
    // is switching providers — reusing the OLD key would cause HTTP 401.
    if (!hermesKey && !baseUrl) {
      try {
        const envc = fs.readFileSync(path.join(hermesDir, '.env'), 'utf-8')
        for (const l of envc.split(String.fromCharCode(10))) {
          if (l.startsWith('OPENAI_API_KEY=')) { hermesKey = l.slice('OPENAI_API_KEY='.length).trim(); break }
        }
      } catch {}
    }

    // Read old .env API key before we overwrite it, so we can detect apiKey-only changes
    let oldEnvKey = ''
    try {
      const envContent = fs.readFileSync(path.join(hermesDir, '.env'), 'utf-8')
      for (const l of envContent.split(String.fromCharCode(10))) {
        if (l.startsWith('OPENAI_API_KEY=')) { oldEnvKey = l.slice('OPENAI_API_KEY='.length).trim(); break }
      }
    } catch {}
    // Write to BOTH config.yaml locations
    let prevYaml = ''
    for (const configDir of [hermesDir, path.join(require('os').homedir(), '.hermes')]) {
      const yamlPath = path.join(configDir, 'config.yaml')
      let yaml
      try { yaml = fs.readFileSync(yamlPath, 'utf-8') } catch { continue }
      if (configDir === hermesDir) {
        prevYaml = yaml
        const existingApiKey = yaml.match(/model\.api_key:\s*(.+)/m)?.[1]?.trim() || ''
      }
      const effProvider = resolveProvider(yaml, requested, String(baseUrl || '').trim() || undefined)
      let updated = setYamlKey(yaml, 'model.default', String(model).trim())
      updated = setYamlKey(updated, 'model.base_url', String(baseUrl || '').trim())
      // model.provider MUST be the resolved NAMED provider (not literal 'custom')
      // so the gateway selects the correct custom_providers entry. A named entry
      // also reads api_key_env (OPENAI_API_KEY) from .env, so this stays
      // compatible with env-based key injection. For names that collide with a
      // Hermes built-in (e.g. 'deepseek'), prefix with 'custom:' to defeat the
      // built-in resolver which would otherwise ignore the entry's base_url/api_key.
      const effectiveProvider = effProvider
      const yamlProvider = disambiguateCustomProvider(yaml, effProvider)
      updated = setYamlKey(updated, 'model.provider', yamlProvider)
      // Only write model.api_key when we have a key. An empty incoming key
      // during a provider switch must NOT wipe the existing credential
      // (which would strand the new base_url with no auth → 401).
      if (hermesKey) {
        updated = setYamlKey(updated, 'model.api_key', hermesKey)
      }
      updated = setCustomProviderModel(updated, effProvider, String(model).trim())
      // Also write api_key into the custom_providers entry so Hermes can resolve
      // the key from the named provider block (not just from model.api_key / env).
      if (hermesKey && effProvider) updated = setCustomProviderField(updated, effProvider, 'api_key', hermesKey)
      fs.writeFileSync(yamlPath, updated, 'utf-8')
      if (configDir === hermesDir) {
        const writtenApiKey = updated.match(/model\.api_key:\s*(.+)/m)?.[1]?.trim() || ''
        // Always sync .env when we have a baseUrl (provider switch).
        // The filter strips stale lines; the pushes below only add
        // back non-empty values.  A provider switch without a key
        // correctly leaves OPENAI_API_KEY absent from .env.
        // For model-only changes (no baseUrl), leave .env untouched
        // to preserve the existing key.
        if (baseUrl || hermesKey) {
          try {
            const envPath = path.join(hermesDir, '.env')
            let envContent = ''
            try { envContent = fs.readFileSync(envPath, 'utf-8') } catch {}
            // Only strip the existing OPENAI_API_KEY when we have a key to
            // write back; otherwise keep it so a switch never strands the
            // endpoint without credentials (→ 401).
            const stripKey = !!hermesKey
            const envLines = envContent.split('\n').filter(l => !l.startsWith('OPENAI_BASE_URL=') && !/^\w+_API_KEY=/.test(l) && !(stripKey && l.startsWith('OPENAI_API_KEY=')))
            if (baseUrl) envLines.push(`OPENAI_BASE_URL=${String(baseUrl).trim()}`)
            if (hermesKey) envLines.push(`OPENAI_API_KEY=${hermesKey}`)
            // Mirror the key into a built-in provider's expected env var (e.g.
            // STEPFUN_API_KEY) — see BUILTIN_PROVIDER_ENV docs in writeHermesConfig.
            // Without this, switching to a built-in provider name leaves the
            // gateway with "No LLM provider configured" because the built-in
            // resolver ignores custom_providers and OPENAI_API_KEY.
            const _providerEnvVar = BUILTIN_PROVIDER_ENV[effProvider]
            if (_providerEnvVar && hermesKey) envLines.push(`${_providerEnvVar}=${hermesKey}`)
            fs.writeFileSync(envPath, envLines.join('\n'), 'utf-8')
          } catch {}
        }
      }
    }
    markOwnConfigWrite()

    const prevDefault = prevYaml.match(/model\.default:\s*(.+)/m)?.[1]?.trim() || ''
    const modelChanged = prevDefault !== String(model).trim()
    const changed = prevYaml.includes('model.provider') && (
      prevYaml.match(/model\.provider:\s*(.+)/)?.[1]?.trim() !== requested ||
      prevYaml.match(/model\.base_url:\s*(.+)/)?.[1]?.trim() !== String(baseUrl || '').trim() ||
      // Switching between two models of the SAME provider (e.g. agnes-2.0-flash →
      // agnes-2.0-pro) keeps provider/baseUrl/apiKey identical, so without this
      // the gateway wouldn't restart and would keep serving the model it loaded
      // at startup — making the selector look "fake". A model-name change must
      // also force a gateway restart so config.yaml's model.default is re-read.
      modelChanged
    )
    const keyChanged = oldEnvKey !== hermesKey
    if ((changed || keyChanged) && hermesProcess) {
      await restartGatewayDebounced('setModel')
    }

    return { success: true, applied: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// Hermes skills directory access (bypasses safePath restriction)
safeHandle('hermes:getSkillsDir', async () => {
  const localApp = process.env.LOCALAPPDATA || ''
  return localApp ? path.join(localApp, 'hermes', 'skills') : null
})

safeHandle('hermes:readDir', async (event, dirPath) => {
  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
    return entries.map(e => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }))
  } catch (err) {
    return []
  }
})

safeHandle('hermes:readFile', async (event, filePath) => {
  try {
    return await fsPromises.readFile(filePath, 'utf-8')
  } catch (err) {
    return null
  }
})

// ── Hermes Memory sync (MEMORY.md / USER.md) ──────────────────────────────
// Implementation lives in lib/memory.js (pure fs helpers); these IPC channels
// stay here as thin wrappers. Single source of truth:
// <hermes_home>/memories/MEMORY.md (agent notes) and USER.md (user profile).
safeHandle('hermes:listMemories', async () => {
  const dir = hermesMemoriesDir()
  return {
    memory: await readMemFile(path.join(dir, 'MEMORY.md')),
    user: await readMemFile(path.join(dir, 'USER.md')),
    manual: await readManualMarkers(dir),
  }
})

safeHandle('hermes:addMemoryEntry', async (event, { target, text }) => {
  const dir = hermesMemoriesDir()
  const file = path.join(dir, target === 'user' ? 'USER.md' : 'MEMORY.md')
  const entries = await readMemFile(file)
  const t = (text || '').trim()
  if (!t) return { ok: false, error: 'empty' }
  const isNew = !entries.includes(t)
  if (isNew) {
    entries.push(t)
    await writeMemFile(file, entries)
  }
  // Memory-target entries added through Helix are by definition "manual"; record
  // them so the UI can tag origin. User-profile entries (USER.md) are never
  // source-tagged, so we skip the marker for target === 'user'.
  if (target !== 'user') {
    await addManualMarker(dir, t)
  }
  return { ok: true, entries: isNew ? entries : await readMemFile(file) }
})

safeHandle('hermes:removeMemoryEntry', async (event, { target, text }) => {
  const dir = hermesMemoriesDir()
  const file = path.join(dir, target === 'user' ? 'USER.md' : 'MEMORY.md')
  const entries = await readMemFile(file)
  const t = (text || '').trim()
  const next = entries.filter((e) => e !== t)
  await writeMemFile(file, next)
  if (target !== 'user') {
    await removeManualMarker(dir, t)
  }
  return { ok: true, entries: next }
})

safeHandle('hermes:listSkills', async () => {
  const localApp = process.env.LOCALAPPDATA || ''
  const skillsDir = path.join(localApp, 'hermes', 'skills')
  const skills = []

  // Custom first (so custom wins over built-in on name collision)
  await collectSkillsFromDir(path.join(skillsDir, 'helix-custom'), false, skills)

  // Built-in: skip helix-custom since already scanned as custom
  let entries
  try {
    entries = await fsPromises.readdir(skillsDir, { withFileTypes: true })
  } catch {
    return skills
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === 'helix-custom' || e.name === 'tests' || e.name.startsWith('.')) continue
    await collectSkillsFromDir(path.join(skillsDir, e.name), true, skills)
  }

  // Deduplicate by name
  const deduped = []
  const names = new Set()
  for (const s of skills) {
    if (names.has(s.name)) continue
    names.add(s.name)
    deduped.push(s)
  }
  return deduped
})

// Track skill invocation
safeHandle('hermes:trackSkillCall', async (event, skillName) => {
  return incrementSkillCallCount(skillName)
})

// Delete a user skill directory (custom skills only). Accepts either the
// SKILL.md file path or its parent directory.
safeHandle('hermes:deleteDir', async (event, dirPath) => {
  try {
    // Security: confine deletion to the Hermes skills directory. The renderer
    // should only ever delete custom skills, and a malicious/compromised
    // renderer must not be able to `rm -rf` an arbitrary path.
    const skillsRoot = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'hermes', 'skills')
      : null
    const target = dirPath && dirPath.endsWith('SKILL.md') ? path.dirname(dirPath) : dirPath
    if (!target || !skillsRoot) {
      return { success: false, error: 'invalid target' }
    }
    const resolved = path.resolve(target)
    const resolvedRoot = path.resolve(skillsRoot)
    // Must be the skills root itself or a descendant of it.
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      return { success: false, error: 'refused: target outside skills directory' }
    }
    await fsPromises.rm(resolved, { recursive: true, force: true })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// File system operations, shell:exec, terminal, diagnostics, and profile:cacheConfig
// are now registered by the extracted ipc/*.js modules below (registerXHandlers calls).
// Only channels NOT covered by extracted modules stay here.

// ── Git operations ──────────────────────────────────────────────────────────
// IMPORTANT: always pass arguments as an array to execFile (no shell). The
// previous implementation built a `git <args>` string and ran it through
// powershell.exe, which let a crafted commit message / branch name / file path
// (e.g. `$(...)` or backticks) break out of the quoted argument → command
// injection. execFile with an arg array passes each token verbatim to git,
// so no shell metacharacter can ever be interpreted.
registerGitHandlers(() => workDir)

// ── Interactive PowerShell terminal (true PTY via node-pty) ─────────────────
const terminalModule = registerTerminalHandlers(() => mainWindow, () => workDir)

// ── Scheduled tasks ─────────────────────────────────────────────────────────
registerScheduledTasksHandlers()

// Restart the Hermes gateway so it re-registers hooks from config.yaml.
// Hermes reads hooks at GATEWAY STARTUP (register_from_config), so a save to
// the hooks: block must be followed by a restart for them to take effect.
async function restartHermesGateway() {
  try {
    await restartHermesGatewayCore({ notifyRenderer: false })
  } catch (e) {
    console.error('[hooks] restart failed:', e.message)
  }
}

// hooks 保存后需要重启网关才能重新注册 hooks。serve 模式下重启会杀掉
// 常驻 HTTP/WS 网关（活跃会话断开、端口漂移），且 hermes serve 只在启动时
// 注册 hooks——保存只落地 config.yaml，等用户下次启动 Helix 才生效。
hooksModule.registerHooksHandlers(() => {
  if (GATEWAY_MODE === 'serve') return Promise.resolve()
  return restartHermesGateway()
})

// ── Security / safeStorage ──────────────────────────────────────────────────
registerSecurityHandlers(() => mainWindow, getDiagnostics)

// ── Filesystem operations ───────────────────────────────────────────────────
const fsModule = registerFsHandlers(() => workDir)

// ── Window management ───────────────────────────────────────────────────────
const windowModule = registerWindowHandlers(() => mainWindow, PORT, appIcon)

// ── Email (IMAP inbox / SMTP send / notifications) ─────────────────────────
registerEmailHandlers()

// Shell operations (not extracted — small and standalone)
safeHandle('shell:open', async (event, target) => {
  await shell.openExternal(target)
})

safeHandle('shell:showItemInFolder', async (event, relativePath) => {
  let resolved = safePath(relativePath)
  // Also allow the Hermes memory directory (learning view "reveal in folder").
  if (!resolved) {
    const memDir = path.join(process.env.LOCALAPPDATA || '', 'hermes', 'memories')
    const candidate = path.resolve(relativePath || '')
    if (candidate.startsWith(memDir)) resolved = candidate
  }
  if (!resolved) {
    return { ok: false, error: '路径不安全或超出工作目录范围' }
  }
  shell.showItemInFolder(resolved)
  return { ok: true }
})

safeHandle('shell:openPath', async (event, dir) => {
  await shell.openPath(dir)
})

// App-specific IPC (dialog, app info, runtime — stays in main.js)
safeHandle('dialog:openDirectory', async (event, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: typeof defaultPath === 'string' && defaultPath.trim() ? defaultPath : undefined,
  })
  if (result.canceled) return null
  // Only return the path — let app:setWorkDir handle the actual switch
  // (which does path normalization and session flush). Directly setting
  // workDir here caused the main-process workDir and the renderer's
  // selectedWorkDir to desync.
  return result.filePaths[0]
})

safeHandle('dialog:openFile', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: options?.filters || [] })
  if (result.canceled) return null
  return result.filePaths[0]
})

safeHandle('dialog:saveFile', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, { filters: options?.filters || [] })
  if (result.canceled) return null
  return result.filePath
})

// diagnostics:getStatus is registered by registerSecurityHandlers (electron/ipc/security.js)

safeHandle('runtime:action', async (event, action) => {
  if (action === 'verify') {
    const result = await verifyKernel()
    diagState.signatureStatus = result.status
    diagState.signatureDetail = result.message
    return { ok: result.ok, action, status: result.status, message: result.message, combinedHash: result.combinedHash }
  }
  if (action === 'check' || action === 'update' || action === 'rollback') {
    return { ok: false, action, message: '运行时分发服务未配置（待接入下载/更新/回滚通道）' }
  }
  return { ok: false, action, message: '未知操作' }
})

safeHandle('app:getInfo', () => ({
  version: app.getVersion(), platform: process.platform,
  // In packaged Electron apps, process.cwd() often resolves to an
  // internal location (e.g. hermes install dir). Use app.getPath('home')
  // as the sensible default so the renderer never shows an irrelevant path.
  workDir: workDir || app.getPath('home'),
}))

// 轻量同步：只把主进程 workDir 对齐到前端选中的项目，不做 app:setWorkDir 的
// 任何副作用（不重启网关、不持久化、不 mkdir）。点历史对话等路径只改前端
// selectedWorkDir，主进程 workDir 会残留在旧项目 → 相对路径的 fs IPC（fs:read
// 等）被拼到旧目录 → ENOENT "no such file"。这里只做对齐。
safeHandle('app:syncWorkDir', (event, dir) => {
  if (typeof dir !== 'string' || !dir.trim()) return { success: false, workDir }
  const resolved = path.resolve(dir.trim())
  workDir = resolved
  try { fsModule && fsModule.addAllowedRoot && fsModule.addAllowedRoot(resolved) } catch { /* ignore */ }
  return { success: true, workDir }
})


// Get installed Hermes backend version by running 'hermes --version'
safeHandle('app:getHermesVersion', async () => {
  try {
    const hermesCmd = resolveHermesCmd()
    if (!hermesCmd) return null
    const { execSync } = require('child_process')
    const out = execSync('"' + hermesCmd + '" --version', { encoding: 'utf-8', timeout: 5000 })
    const match = out.match(/\((\d+\.\d+\.\d+(?:\.\d+)?)\)/)
    return match ? match[1] : null
  } catch {
    return null
  }
})
safeHandle('app:setWorkDir', (event, dir) => {
  const isDriveRoot = typeof dir === 'string' && /^[a-zA-Z]:[\/]?$/.test(dir)
  if (dir === '/' || dir === '\\' || isDriveRoot) dir = process.cwd()
  workDir = path.resolve(workDir, dir || workDir)
  // 登记为合法访问根：右侧目录面板按绝对路径扫描任意已选项目时，
  // safePath 不会因主进程 workDir 时序问题判越界（"Path is outside working directory"）。
  try { fsModule && fsModule.addAllowedRoot && fsModule.addAllowedRoot(workDir) } catch { /* ignore */ }
  // Ensure the selected directory actually exists on disk. Without this, a path
  // that looks valid but isn't created yet gets silently ignored by Hermes's
  // session.create (explicit_cwd requires os.path.isdir(...) to be true) and
  // the agent falls back to the gateway's HOME (C:\Users\hyt\...\hermes), with
  // no error surfaced. Creating it here guarantees explicit_cwd is honored.
  try {
    fs.mkdirSync(workDir, { recursive: true })
  } catch (e) {
    console.warn('[setWorkDir] failed to create directory:', workDir, e?.message)
  }
  // Persist so the next cold start boots the gateway into this directory.
  persistWorkDir(workDir)
  // The Hermes process's cwd + TERMINAL_CWD are fixed at spawn time. Changing
  // `workDir` alone does NOT move the already-running process, so the agent would
  // keep working in the old directory. Restart the gateway to apply the new cwd.
  //
  // serve 模式：cwd 是每次 session.create 用 explicit_cwd 传的（serve-gateway.ts
  // → session.create { cwd }），跟网关进程自己的 cwd 无关，所以切换工作目录
  // 完全不需要重启网关。重启只会杀掉所有活跃会话、让端口漂移、WS 断连重连——
  // 这正是"对话中点另一个项目就重连/模型停止"的根因。acp 模式仍需重启。
  if (hermesProcess && GATEWAY_MODE !== 'serve') {
    console.log('[setWorkDir] restarting Hermes gateway to apply new cwd:', workDir)
    restartHermesGateway()
  } else if (hermesProcess) {
    console.log('[setWorkDir] serve mode: cwd applied per-session via explicit_cwd, no restart:', workDir)
  }
  return { success: true, workDir }
})

// ── App lifecycle ───────────────────────────────────────────────────────────
// 渲染进程 V8 老生代堆上限默认约 3GB，长会话（大量工具输出/超长回复）会把
// 历史消息与流式缓冲顶到上限导致 "JavaScript heap out of memory"。提高上限，
// 为超长会话留出空间（64 位下有效，32 位安装包会被 Electron 自动忽略）。
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192')

app.whenReady().then(async () => {
  // Remove default menu bar
  Menu.setApplicationMenu(null)

  // Set app icon for Windows
  if (process.platform === 'win32') {
    try {
      const winIconPath = path.join(__dirname, '..', 'public', 'Helix.ico')
      if (fs.existsSync(winIconPath)) {
        const winIcon = nativeImage.createFromPath(winIconPath)
        if (!winIcon.isEmpty()) {
          app.setAppUserModelId('com.helix.desktop')
        }
      }
    } catch (e) {
      console.log('Failed to set Windows icon:', e)
    }
  }

  await createWindow()

  // Restore the user's last-selected project directory BEFORE spawning the
  // gateway, so the Hermes process boots with the correct cwd + TERMINAL_CWD
  // (otherwise it would revert to HOME and the agent would work in the wrong dir).
  try {
    const saved = getPersistedWorkDir()
    if (saved) {
      // Recreate the directory if it was deleted/renamed while the app was
      // closed — otherwise spawn(exe, { cwd }) fails with ENOENT (-4058) and
      // the gateway never starts. Matches setWorkDir's mkdir behavior.
      fs.mkdirSync(saved, { recursive: true })
      workDir = saved
      console.log('[workDir] restored from disk:', workDir)
    }
  } catch (e) {
    console.warn('[workDir] restore failed:', e?.message)
  }

  // Start Hermes gateway (non-blocking, UI loads immediately)
  // The 'spawn' handler inside startHermesGateway() sends 'gateway.ready' to the frontend
  startHermesGateway()
    .then(() => {
      console.log('[Hermes] Gateway ready')
    })
    .catch((err) => {
      console.error('[Hermes] Failed to start:', err.message)
      mainWindow?.webContents.send('hermes:event', 'error', { 
        message: `Hermes 未安装或启动失败。请先安装 Hermes:\niex (irm https://hermes-agent.nousresearch.com/install.ps1)` 
      })
    })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})



app.on('before-quit', (event) => {
  // Electron does NOT await async before-quit handlers, so the old async
  // handler could exit before the gateway / next-server children were torn
  // down. Reliable shutdown: preventDefault on the first quit, run the
  // teardown, then app.exit(0) (which bypasses before-quit — no re-entry).
  if (appIsQuitting) return
  event.preventDefault()
  appIsQuitting = true
  terminalModule.kill()
  const teardown = []
  if (hermesProcess) {
    const proc = hermesProcess
    hermesProcess = null
    teardown.push(new Promise((resolve) => {
      try { proc.kill() } catch {}
      const done = () => resolve()
      proc.once('close', done)
      setTimeout(() => { proc.removeListener('close', done); resolve() }, 2000)
    }))
  }
  if (nextServer) {
    const pid = nextServer.pid
    nextServer = null
    teardown.push(Promise.resolve().then(async () => {
      try {
        if (process.platform === 'win32') {
          await execAsync(`taskkill /F /T /PID ${pid}`)
        } else {
          process.kill(-pid, 'SIGTERM')
        }
      } catch {}
    }))
  }
  Promise.all(teardown).finally(() => {
    app.exit(0)
  })
})
