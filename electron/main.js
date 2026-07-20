const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage, safeStorage } = require('electron')
const path = require('path')
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
const registerTerminalHandlers = require('./ipc/terminal')
const registerScheduledTasksHandlers = require('./ipc/scheduled-tasks')
const securityModule = require('./ipc/security')
const registerSecurityHandlers = securityModule
const { isBadConfig, APIHUB_DEFAULT } = securityModule
const registerFsHandlers = require('./ipc/fs')
const registerWindowHandlers = require('./ipc/window')
const hooksModule = require('./ipc/hooks')

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
            console.error('[Hermes] gateway error:', msg.error)
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

// Resolve the absolute path to the `hermes` executable instead of relying on
// PATH lookup (spawn('hermes') → ENOENT/-4058 when the venv Scripts dir is not
// on the inherited PATH, e.g. inside Electron after env cleaning).
function resolveHermesCmd() {
  const candidates = []
  try {
    const { execSync } = require('child_process')
    const out = execSync('where hermes 2>nul || which hermes 2>/dev/null').toString().trim()
    if (out) out.split(/\r?\n/).forEach(l => l.trim() && candidates.push(l.trim()))
  } catch { /* ignore */ }
  // Fallback candidates (known install locations)
  const localApp = process.env.LOCALAPPDATA || ''
  if (localApp) {
    candidates.push(path.join(localApp, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'))
  }
  candidates.push(path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'))
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* ignore */ }
  }
  return null // not found
}

// ── Kernel verification (source path + Ed25519 signature) ────────────────────

function isTrustedPath(p) {
  // Kernel should live under known managed locations, not arbitrary paths.
  const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const trustedRoots = [
    path.join(localApp, 'hermes'),
    process.resourcesPath,
    path.dirname(process.execPath),
    process.cwd(),
  ]
  const rp = path.resolve(p)
  return trustedRoots.some(root => rp.startsWith(path.resolve(root)))
}

async function sha256File(filePath) {
  const data = await fsPromises.readFile(filePath)
  return crypto.createHash('sha256').update(data).digest('hex')
}

async function listKernelArtifacts(hermesCmdPath) {
  const artifacts = []
  if (!hermesCmdPath || !fs.existsSync(hermesCmdPath)) return artifacts
  artifacts.push({ id: 'entry', path: hermesCmdPath, hash: await sha256File(hermesCmdPath) })
  const baseDir = path.dirname(hermesCmdPath)
  const candidates = [
    path.join(baseDir, 'hermes'),
    path.join(baseDir, 'hermes-cli'),
    path.join(baseDir, 'hermes_cli'),
    path.join(baseDir, 'python.exe'),
    path.join(baseDir, '..', 'Lib', 'site-packages', 'hermes', '__init__.py'),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        artifacts.push({ id: path.relative(baseDir, c), path: c, hash: await sha256File(c) })
      }
    } catch {}
  }
  return artifacts
}

async function loadKernelPublicKey() {
  const candidates = [
    path.join(process.resourcesPath, 'kernel.pub'),
    path.join(process.resourcesPath, 'assets', 'kernel.pub'),
    path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'kernel.pub'),
    path.join(__dirname, '..', 'kernel.pub'),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return await fsPromises.readFile(c)
    } catch {}
  }
  return null
}

async function verifyKernelSignature(hermesCmdPath) {
  const pubKey = await loadKernelPublicKey()
  if (!pubKey) {
    return { ok: false, hasKey: false, message: '未包含官方公钥（开发构建），已跳过 Ed25519 校验' }
  }
  const sigPath = hermesCmdPath + '.sig'
  if (!fs.existsSync(sigPath)) {
    return { ok: false, hasKey: true, hasSig: false, message: '未找到运行时签名文件 ' + sigPath }
  }
  try {
    const data = await fsPromises.readFile(hermesCmdPath)
    const sig = await fsPromises.readFile(sigPath)
    const ok = crypto.verify(null, data, pubKey, sig)
    return { ok, hasKey: true, hasSig: true, message: ok ? 'Ed25519 签名校验通过' : 'Ed25519 签名校验失败' }
  } catch (e) {
    return { ok: false, hasKey: true, hasSig: true, message: '签名校验出错：' + (e && e.message) }
  }
}

async function verifyKernel() {
  const hermesCmdPath = resolveHermesCmd()
  if (!hermesCmdPath) {
    return { ok: false, status: 'unknown', message: '未找到 Hermes 运行时可执行文件', artifacts: [], combinedHash: '' }
  }
  if (!isTrustedPath(hermesCmdPath)) {
    return { ok: false, status: 'untrusted', message: '运行时路径不在受信任安装目录中：' + hermesCmdPath, artifacts: [], combinedHash: '' }
  }
  const artifacts = await listKernelArtifacts(hermesCmdPath)
  const sigResult = await verifyKernelSignature(hermesCmdPath)
  const integrityInput = artifacts.map(a => a.hash).join('')
  const combinedHash = crypto.createHash('sha256').update(integrityInput).digest('hex').slice(0, 32)
  const status = sigResult.ok ? 'verified' : 'unverified'
  const message = sigResult.ok
    ? `内核来源已校验，完整性哈希 ${combinedHash}`
    : `${sigResult.message}；完整性哈希 ${combinedHash}`
  return { ok: sigResult.ok, status, message, artifacts, combinedHash, sig: sigResult }
}

// Lightweight YAML helper — sets a nested key (up to 2 levels, 2-space indent)
// without a js-yaml dependency. Preserves the rest of the file. Returns the new
// YAML string (unchanged if the value was already identical).
function setYamlKey(yaml, dottedKey, value) {
  const parts = dottedKey.split('.')
  if (parts.length !== 2) return yaml
  const [top, sub] = parts
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  const valueStr = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
  let topIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].startsWith(top + ':')) { topIdx = i; break }
  }
  if (topIdx === -1) {
    lines.push(`${top}:`)
    lines.push(`  ${sub}: ${valueStr}`)
    return lines.join('\n')
  }
  let subIdx = -1
  for (let i = topIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break
    if (new RegExp(`^\\s+${sub}:`).test(lines[i])) { subIdx = i; break }
  }
  if (subIdx !== -1) {
    const oldVal = lines[subIdx]
    lines[subIdx] = lines[subIdx].replace(new RegExp(`^(\\s+${sub}:\\s*).*$`), `$1${valueStr}`)
    if (sub === 'provider') {
      console.log('[setYamlKey] provider: old=' + JSON.stringify(oldVal) + ' new=' + JSON.stringify(lines[subIdx]))
      console.trace('[setYamlKey] provider write stack')
    }
    // Remove any duplicate `sub:` lines within the same parent block so a
    // previously-inserted/stray key can't survive and shadow the value.
    for (let i = subIdx + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break
      if (new RegExp(`^\\s+${sub}:`).test(lines[i])) { lines.splice(i, 1); i-- }
    }
  } else {
    lines.splice(topIdx + 1, 0, `  ${sub}: ${valueStr}`)
  }
  return lines.join('\n')
}

// Update the `model:` field of a named custom_providers entry so Hermes
// actually uses the model the user picked. A named custom provider
// OVERRIDES model.default (see hermes runtime_provider.resolve_runtime_provider),
// so without this the UI model selection would never take effect.
function setCustomProviderModel(yaml, providerName, model) {
  if (!providerName || !model) return yaml
  const name = String(providerName).trim()
  const modelStr = String(model).trim()
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  let inProviders = false
  let entryActive = false
  for (let i = 0; i < lines.length; i++) {
    const lp = lines[i]
    if (/^custom_providers:/.test(lp)) { inProviders = true; continue }
    if (!inProviders) continue
    if (/^\S/.test(lp) && !lp.startsWith(' ')) { inProviders = false; entryActive = false; continue }
    const mName = lp.match(/^\s+-\s+name:\s*(.+?)\s*$/)
    if (mName) { entryActive = (mName[1] === name); continue }
    if (entryActive) {
      const mModel = lp.match(/^(\s+)model:\s*(.+?)\s*$/)
      if (mModel) {
        lines[i] = mModel[1] + 'model: ' + modelStr
        return lines.join('\n')
      }
    }
  }
  return yaml
}

function setCustomProviderField(yaml, name, field, value) {
  if (!name || !field || value === undefined || value === null) return yaml
  const n = String(name).trim()
  const v = String(value).trim()
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  let inProviders = false, entryActive = false, entryEnd = -1, entryFound = false
  for (let i = 0; i < lines.length; i++) {
    const lp = lines[i]
    if (/^custom_providers:/.test(lp)) { inProviders = true; continue }
    if (!inProviders) continue
    if (/^\S/.test(lp) && !lp.startsWith(' ')) { inProviders = false; entryActive = false; continue }
    const mName = lp.match(/^\s+-\s+name:\s*(.+?)\s*$/)
    if (mName) {
      entryActive = (mName[1] === n)
      if (entryActive) { entryFound = true; entryEnd = i }
      continue
    }
    if (entryActive) {
      const mF = lp.match(new RegExp('^(\\s+)' + field + ':\\s*(.+?)\\s*$'))
      if (mF) { lines[i] = mF[1] + field + ': ' + v; return lines.join('\n') }
      entryEnd = i
    }
  }
  if (!entryFound) {
    // Auto-create a new custom_providers entry for any provider name
    const defaultBaseUrl = 'https://api.openai.com/v1'
    const defaultModel = 'gpt-4o'
    const fld = (field === 'base_url') ? v : defaultBaseUrl
    const mdl = (field === 'model') ? v : defaultModel
    const entryLines = [
      '  - name: ' + n,
      '    base_url: ' + fld,
      '    api_key_env: OPENAI_API_KEY',
      '    model: ' + mdl,
    ]
    if (/^custom_providers:/m.test(yaml)) {
      const yl = yaml.replace(/\r\n/g, '\n').split('\n')
      let inProv = false, lastIdx = -1
      for (let i = 0; i < yl.length; i++) {
        if (/^custom_providers:/.test(yl[i])) { inProv = true; continue }
        if (inProv) {
          if (/^\S/.test(yl[i]) && !yl[i].startsWith(' ')) { inProv = false; continue }
          lastIdx = i
        }
      }
      if (lastIdx >= 0) {
        yl.splice(lastIdx + 1, 0, ...entryLines)
        return yl.join('\n')
      }
      return yaml.replace(/\r\n/g, '\n') + '\n' + entryLines.join('\n') + '\n'
    }
    const block = [
      'custom_providers:',
      ...entryLines,
      '',
    ].join('\n')
    return block + yaml
  }
  // Entry exists but lacks the field - append it at entry end
  lines.splice(entryEnd + 1, 0, '    ' + field + ': ' + v)
  return lines.join('\n')
}

// Resolve a valid named custom provider for model writes. Hermes uses a named
// custom provider's own `model:` field and OVERRIDES model.default, so the UI
// model selection must be written there. 'custom'/empty/invalid falls back to
// the named provider whose base_url matches the configured model.base_url.
const KNOWN_BASE_PROVIDERS = ['openai','anthropic','openrouter','agnes-ai','nous','moa','ollama','vllm','llamacpp','zai','kimi-coding','kimi-coding-cn','minimax','minimax-cn','bedrock','gemini','deepseek','qwen','grok','xai','antling']
function customProviderApiKey(yaml, name) {
  if (!name) return ''
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  let entryActive = false
  for (const lp of lines) {
    const mName = lp.match(/^\s+-\s+name:\s*(.+?)\s*$/)
    if (mName) { entryActive = (mName[1] === name); continue }
    if (entryActive) {
      const mK = lp.match(/^\s+api_key:\s*(.+?)\s*$/)
      if (mK) return mK[1].trim()
    }
  }
  return ''
}
function customProviderBaseUrl(yaml, name) {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  let entryActive = false
  for (const lp of lines) {
    const mName = lp.match(/^\s+-\s+name:\s*(.+?)\s*$/)
    if (mName) { entryActive = (mName[1] === name); continue }
    if (entryActive) {
      const mB = lp.match(/^\s+base_url:\s*(.+?)\s*$/)
      if (mB) return mB[1].trim().replace(/\/+$/, '')
    }
  }
  return ''
}
function providerNameFromUrl(baseUrl) {
  if (!baseUrl) return null
  try {
    const hostname = new URL(baseUrl).hostname
    // Strip common prefixes: api., apihub., gateway.
    return hostname.replace(/^(api|apihub|gateway)\./, '').split('.')[0]
  } catch { return null }
}
function resolveProvider(yaml, requestedProvider, newBaseUrl) {
  const customNames = [...yaml.matchAll(/^\s+-\s+name:\s*(.+?)\s*$/gm)].map(m => m[1])
  const validNamed = (p) => p && customNames.includes(p)
  const validBase = (p) => p && KNOWN_BASE_PROVIDERS.includes(p)
  // If a new baseUrl is provided, find a custom provider entry that matches it.
  // This takes priority over the requested name to avoid reusing a stale provider.
  if (newBaseUrl) {
    const normNew = newBaseUrl.replace(/\/+$/, '')
    for (const n of customNames) {
      if (customProviderBaseUrl(yaml, n).replace(/\/+$/, '') === normNew) return n
    }
    // No matching entry — derive a new name from the hostname
    const derived = providerNameFromUrl(newBaseUrl)
    if (derived) return derived
  }
  if (validNamed(requestedProvider)) return requestedProvider
  if (validBase(requestedProvider)) return requestedProvider
  if (customNames.length) {
    return customNames[0]
  }
  return 'custom'
}

// ── Shared disk writer for Hermes model config ─────────────────────────────
// Writes the model/provider/baseUrl/apiKey into Hermes config.yaml (model block
// + named custom_providers entry) and the .env (OPENAI_API_KEY / OPENAI_BASE_URL).
// Used both by the hermes:setConfig IPC (which also restarts the gateway) and by
// the startup profile re-assert (applyActiveProfileCache) which runs BEFORE the
// gateway is spawned. No hardcoded defaults — every value comes from `cfg`.

// Hermes built-in providers (registered in hermes_cli.auth.PROVIDER_REGISTRY)
// that read their API key from a provider-specific env var instead of
// OPENAI_API_KEY / custom_providers[].api_key. When model.provider matches one
// of these names, the custom_providers entry is IGNORED by the resolver, so we
// MUST also mirror the key into the env var the built-in expects — otherwise
// the gateway starts with "No LLM provider configured" / "Set <PROVIDER>_API_KEY".
// Keep this table in sync with the provider names in PROVIDER_REGISTRY.
const BUILTIN_PROVIDER_ENV = {
  stepfun: 'STEPFUN_API_KEY',
  // add more built-in providers here as needed (e.g. glm, minimax, ...)
}
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
    let lines = envContent.split('\n').filter(l => !l.startsWith('OPENAI_BASE_URL=') && !/^\w+_API_KEY=/.test(l) && !(stripKey && l.startsWith('OPENAI_API_KEY=')))
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
    yamlContent = setYamlKey(yamlContent, 'model.provider', effectiveProvider)
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
// Writes temperature, max_output_tokens, reasoning_effort, custom_instructions,
// and system_prompt (personality) into the `agent:` block of config.yaml so the
// Hermes backend actually uses the user's configured values.
function writeHermesAgentConfig({ temperature, maxOutputTokens, reasoningEffort, customInstructions, personality }) {
  try {
    const yamlPath = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'config.yaml')
    let yaml = ''
    try { yaml = fs.readFileSync(yamlPath, 'utf-8') } catch { return }
    let updated = yaml
    if (temperature !== undefined && temperature !== null) {
      updated = setYamlKey(updated, 'agent.temperature', String(Number(temperature)))
    }
    if (maxOutputTokens !== undefined && maxOutputTokens !== null) {
      updated = setYamlKey(updated, 'agent.max_output_tokens', String(Number(maxOutputTokens)))
    }
    if (reasoningEffort !== undefined && reasoningEffort !== null) {
      updated = setYamlKey(updated, 'agent.reasoning_effort', String(reasoningEffort))
    }
    if (customInstructions !== undefined) {
      const safe = '"' + String(customInstructions).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
      updated = setYamlKey(updated, 'agent.custom_instructions', safe)
    }
    if (personality !== undefined) {
      const safe = '"' + String(personality).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
      updated = setYamlKey(updated, 'agent.system_prompt', safe)
    } else {
      // Default: add language matching instruction when no personality is set
      const defaultPrompt = '"请始终使用与用户相同的语言回复。"'
      updated = setYamlKey(updated, 'agent.system_prompt', defaultPrompt)
    }
    if (updated !== yaml) {
      fs.writeFileSync(yamlPath, updated, 'utf-8')
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
  return new Promise((resolve) => {
    _restartResolveFns.push(resolve)
    if (_restartTimer) clearTimeout(_restartTimer)
    _restartTimer = setTimeout(async () => {
      _restartTimer = null
      const waiters = _restartResolveFns
      _restartResolveFns = []
      console.log('[Hermes] debounced restart firing:', label || '(coalesced)')
      // Tell the renderer the gateway is about to go down so it flips
      // hermesConnected=false. This makes handleRun await gateway.ready before
      // issuing session/new — otherwise it fires session/new into the gap
      // between kill and the new process being ready and the next prompt lands
      // on a dead session (silent no-output after a provider switch).
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[Hermes] notifying renderer: gateway going down (disconnected)')
        mainWindow.webContents.send('hermes:event', 'gateway.disconnected', { expected: true })
      }
      const oldP = hermesProcess
      hermesProcess = null
      if (oldP) {
        try { oldP.kill() } catch {}
        await new Promise((r) => {
          if (oldP.exitCode !== null || oldP.signalCode !== null) { r(); return }
          const onClose = () => r()
          oldP.once('close', onClose)
          setTimeout(() => { oldP.removeListener('close', onClose); r() }, 3000)
        })
      }
      await clearHermesSessions()
      try {
        await startHermesGateway()
        console.log('[Hermes] debounced restart complete:', label || '(coalesced)')
      } catch (e) {
        console.error('[Hermes] debounced restart failed:', e.message)
      }
      // Notify the renderer that all prior sessions were destroyed by the
      // restart. The frontend must discard its cached session_id and create a
      // fresh one on the next send — otherwise it replays a stale id and the
      // backend answers "session ... not found" → silent no-output.
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[Hermes] notifying renderer: gateway sessions invalidated')
        mainWindow.webContents.send('hermes:event', 'gateway.sessionInvalidated')
      }
      for (const fn of waiters) { try { fn() } catch {} }
    }, RESTART_DEBOUNCE_MS)
  })
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

function startHermesGateway() {
  return new Promise((resolve, reject) => {
    _acpReadySent = false
    // Ensure the git-probe workaround is present before launching (survives updates)
    ensureCodingContextOff()
    // Re-assert the user's last-saved model profile (cached by the renderer) into
    // config.yaml BEFORE spawning, so the backend always matches the frontend's
    // choice. No hardcoded pin — the value comes from the user's saved Profile.
    applyActiveProfileCache()

    // Use ACP protocol (JSON-RPC over stdio) for programmatic integration.
    // Resolve the REAL executable path — do NOT spawn the bare command name,
    // because Electron's cleaned PATH often cannot find the hermes venv binary.
    const hermesCmd = resolveHermesCmd()
    if (!hermesCmd) {
      const errMsg = '找不到 hermes 可执行文件。请先安装 Hermes（iex (irm https://hermes-agent.nousresearch.com/install.ps1)），或将其 venv\\Scripts 目录加入 PATH。'
      console.error('[Hermes]', errMsg)
      mainWindow?.webContents.send('hermes:event', 'error', { message: errMsg })
      return reject(new Error(errMsg))
    }
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

    const spawnedProcess = spawn(hermesCmd, ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: hermesEnv,
      cwd: path.join(require('os').homedir(), 'AppData', 'Local', 'hermes'),
    })
    hermesProcess = spawnedProcess
    // Activate the config.yaml/.env watcher (guarded — runs once even across restarts).
    setupHermesConfigWatcher()

    spawnedProcess.on('error', (err) => {
      console.error('[Hermes] Process error:', err.message, '| cmd:', hermesCmd)
      if (hermesProcess === spawnedProcess) hermesProcess = null
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
      mainWindow?.webContents.send('hermes:event', 'gateway.disconnected', { code, signal })
    })

    hermesProcess.stdout?.on('data', (data) => {
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
      // UI doesn't hang forever.
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        if (_acpReadySent) return
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

function safePath(filePath) {
  const resolved = path.resolve(workDir, filePath)
  if (!resolved.startsWith(workDir)) return null
  // Check for symlink escapes
  try {
    const realResolved = fs.realpathSync(resolved)
    const realWorkDir = fs.realpathSync(workDir)
    return realResolved.startsWith(realWorkDir) ? realResolved : null
  } catch {
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
    },
    backgroundColor: '#FCFBF9',
  })

  // Load the Next.js frontend (dev or production)
  const isDev = !app.isPackaged
  let url = `http://localhost:${PORT}`

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
    mainWindow?.webContents.send('window:maximized-changed', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', false)
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
  if (_hermesConfigStale && hermesProcess) {
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
        if (/^\S/.test(lp) && !lp.startsWith(' ')) { inProviders = false; entryActive = false; continue }
        const mN = lp.match(/^\s+-\s+name:\s*(.+?)\s*$/)
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
  try {
    const yamlPath = path.join(require('os').homedir(), 'AppData', 'Local', 'hermes', 'config.yaml')
    let c = fs.readFileSync(yamlPath, 'utf-8')
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

// ── Hermes agent config (temperature, maxTokens, reasoningEffort, etc.) ────
// Writes all agent behaviour settings to config.yaml and restarts the gateway.
safeHandle('hermes:setAgentConfig', async (event, params = {}) => {
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

// Parse agent.personalities from config.yaml (shared by list + set).
function parseHermesPersonalities(yaml) {
  const lines = yaml.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^agent:/.test(lines[i])) { start = i; break }
  }
  if (start === -1) return {}
  const out = {}
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && !lines[i].startsWith(' ')) break
    const m = lines[i].match(/^\s{4}([A-Za-z0-9_\u4e00-\u9fff]+):\s?(.*)$/)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

// Apply a personality by writing agent.system_prompt into Hermes config.yaml.
// Mirrors the CLI `/personality <name>` command: resolves the prompt from
// config.yaml's agent.personalities, or uses the prompt passed from the UI.
safeHandle('hermes:setPersonality', async (event, { name, prompt } = {}) => {
  try {
    const localApp = process.env.LOCALAPPDATA || ''
    if (!localApp) return { success: false, error: 'LOCALAPPDATA not set' }
    const yamlPath = path.join(localApp, 'hermes', 'config.yaml')
    let yaml = fs.readFileSync(yamlPath, 'utf-8')
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
      // model.provider MUST be the resolved NAMED provider (not 'custom') so the
      // gateway selects the correct custom_providers entry. A named entry also
      // reads api_key_env (OPENAI_API_KEY) from .env, so this stays compatible
      // with env-based key injection. Forcing 'custom' made the gateway fall
      // back to custom_providers[0] and reuse the previous provider's creds.
      const effectiveProvider = effProvider
      updated = setYamlKey(updated, 'model.provider', effectiveProvider)
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
            let envLines = envContent.split('\n').filter(l => !l.startsWith('OPENAI_BASE_URL=') && !/^\w+_API_KEY=/.test(l) && !(stripKey && l.startsWith('OPENAI_API_KEY=')))
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
// Helix's manual memories are synchronized with Hermes's backend memory_manager
// so the two systems stop keeping separate copies. Single source of truth:
// <hermes_home>/memories/MEMORY.md (agent notes) and USER.md (user profile).
// Entry format matches Hermes memory_tool: entries joined by "\n◊\n".
function hermesMemoriesDir() {
  const home = process.env.HERMES_HOME
    ? require('path').resolve(process.env.HERMES_HOME)
    : require('path').join(require('os').homedir(), 'AppData', 'Local', 'hermes')
  return require('path').join(home, 'memories')
}

const MEM_DELIM = '\n◊\n'

async function readMemFile(file) {
  try {
    const raw = await fsPromises.readFile(file, 'utf-8')
    if (!raw || !raw.trim()) return []
    return raw.split(MEM_DELIM).map(e => e.trim()).filter(Boolean)
  } catch {
    return []
  }
}

async function writeMemFile(file, entries) {
  const dir = require('path').dirname(file)
  await fsPromises.mkdir(dir, { recursive: true })
  const content = entries.join(MEM_DELIM)
  // Atomic write (temp + rename) to match Hermes memory_tool's contract and
  // avoid the truncation race window. Windows rename needs the target gone first.
  const tmp = require('path').join(dir, '.mem_' + Date.now() + '.tmp')
  await fsPromises.writeFile(tmp, content, 'utf-8')
  try { await fsPromises.unlink(file) } catch {}
  await fsPromises.rename(tmp, file)
}

// Manual-memory origin markers. Helix records which MEMORY.md entries it added
// manually so the UI can distinguish them from entries Hermes's self-evolution
// appended automatically. Stored as a separate dotfile (NOT an entry inside
// MEMORY.md) so it never pollutes agent-visible memory content or trips Hermes's
// drift detection (which only inspects MEMORY.md / USER.md entry bodies).
const MANUAL_MARKERS_FILE = '.helix_manual.json'

async function readManualMarkers(dir) {
  try {
    const raw = await fsPromises.readFile(
      require('path').join(dir, MANUAL_MARKERS_FILE),
      'utf-8',
    )
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

async function addManualMarker(dir, text) {
  const cur = await readManualMarkers(dir)
  if (cur.includes(text)) return
  cur.push(text)
  await fsPromises.mkdir(dir, { recursive: true })
  await fsPromises.writeFile(
    require('path').join(dir, MANUAL_MARKERS_FILE),
    JSON.stringify(cur, null, 2),
    'utf-8',
  )
}

async function removeManualMarker(dir, text) {
  const cur = await readManualMarkers(dir)
  const next = cur.filter((x) => x !== text)
  if (next.length === cur.length) return
  const file = require('path').join(dir, MANUAL_MARKERS_FILE)
  if (next.length === 0) {
    try { await fsPromises.unlink(file) } catch {}
    return
  }
  await fsPromises.writeFile(file, JSON.stringify(next, null, 2), 'utf-8')
}

safeHandle('hermes:listMemories', async () => {
  const dir = hermesMemoriesDir()
  return {
    memory: await readMemFile(require('path').join(dir, 'MEMORY.md')),
    user: await readMemFile(require('path').join(dir, 'USER.md')),
    manual: await readManualMarkers(dir),
  }
})

safeHandle('hermes:addMemoryEntry', async (event, { target, text }) => {
  const dir = hermesMemoriesDir()
  const file = require('path').join(dir, target === 'user' ? 'USER.md' : 'MEMORY.md')
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
  const file = require('path').join(dir, target === 'user' ? 'USER.md' : 'MEMORY.md')
  const entries = await readMemFile(file)
  const t = (text || '').trim()
  const next = entries.filter((e) => e !== t)
  await writeMemFile(file, next)
  if (target !== 'user') {
    await removeManualMarker(dir, t)
  }
  return { ok: true, entries: next }
})

// Skill call count tracking
const skillCallCounts = {}
const SKILL_CALL_COUNTS_FILE = 'skill-call-counts.json'

async function loadSkillCallCounts() {
  try {
    // First try to read from Hermes .usage.json (authoritative source)
    const usageFilePath = path.join(require('os').homedir(), 'AppData', 'Local', 'hermes', 'skills', '.usage.json')
    const data = await fsPromises.readFile(usageFilePath, 'utf-8')
    const usageData = JSON.parse(data)
    // Map from .usage.json format: { skillName: { use_count: N } }
    for (const [name, info] of Object.entries(usageData)) {
      if (info && typeof info === 'object' && typeof info.use_count === 'number') {
        skillCallCounts[name] = info.use_count
      }
    }
  } catch {
    // Fallback to skill-call-counts.json
    try {
      const filePath = path.join(require('os').homedir(), 'AppData', 'Local', 'hermes', SKILL_CALL_COUNTS_FILE)
      const data = await fsPromises.readFile(filePath, 'utf-8')
      Object.assign(skillCallCounts, JSON.parse(data))
    } catch { /* file doesn't exist yet, use empty object */ }
  }
}

async function saveSkillCallCounts() {
  try {
    const dir = path.join(require('os').homedir(), 'AppData', 'Local', 'hermes')
    await fsPromises.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, SKILL_CALL_COUNTS_FILE)
    await fsPromises.writeFile(filePath, JSON.stringify(skillCallCounts, null, 2), 'utf-8')
  } catch (err) {
    console.error('[Skills] Failed to save call counts:', err.message)
  }
}

function incrementSkillCallCount(skillName) {
  skillCallCounts[skillName] = (skillCallCounts[skillName] || 0) + 1
  saveSkillCallCounts()
  return skillCallCounts[skillName]
}

// Load call counts on startup
loadSkillCallCounts()

// List all Hermes skills (user + builtin) with parsed frontmatter metadata.
function parseSkillFrontmatter(content, fallbackName) {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)
  let name = fallbackName
  let description = ''
  if (fm) {
    const block = fm[1]
    const nameM = block.match(/name:\s*(.+)/)
    const descM = block.match(/description:\s*(.+)/)
    if (nameM) name = nameM[1].trim()
    if (descM) description = descM[1].trim()
  }
  return { name, description }
}

async function collectSkillsFromDir(rootDir, isBuiltin, out) {
  // If rootDir itself is a skill (has SKILL.md), add it directly
  const selfSkillMd = path.join(rootDir, 'SKILL.md')
  try {
    await fsPromises.access(selfSkillMd)
    const content = await fsPromises.readFile(selfSkillMd, 'utf-8')
    const { name, description } = parseSkillFrontmatter(content, path.basename(rootDir))
    out.push({ id: selfSkillMd, name, description, isBuiltin, path: selfSkillMd, callCount: skillCallCounts[name] || 0 })
    return
  } catch { /* not a skill dir itself — scan subdirectories */ }

  let entries
  try {
    entries = await fsPromises.readdir(rootDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === 'tests' || e.name.startsWith('.')) continue
    const full = path.join(rootDir, e.name)
    const skillMd = path.join(full, 'SKILL.md')
    try {
      await fsPromises.access(skillMd)
    } catch {
      await collectSkillsFromDir(full, isBuiltin, out)
      continue
    }
    const content = await fsPromises.readFile(skillMd, 'utf-8')
    const { name, description } = parseSkillFrontmatter(content, e.name)
    out.push({ id: skillMd, name, description, isBuiltin, path: skillMd, callCount: skillCallCounts[name] || 0 })
  }
}

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
  if (!hermesProcess) {
    try { await startHermesGateway() } catch (e) { console.error('[hooks] restart failed:', e.message) }
    return
  }
  const old = hermesProcess
  hermesProcess = null
  try { old.kill() } catch {}
  await new Promise((resolve) => {
    if (old.exitCode !== null || old.signalCode !== null) { resolve(); return }
    const onClose = () => resolve()
    old.once('close', onClose)
    setTimeout(() => { old.removeListener('close', onClose); resolve() }, 3000)
  })
  try { await startHermesGateway() } catch (e) { console.error('[hooks] restart failed:', e.message) }
}

hooksModule.registerHooksHandlers(restartHermesGateway)

// ── Security / safeStorage ──────────────────────────────────────────────────
registerSecurityHandlers(() => mainWindow, getDiagnostics)

// ── Filesystem operations ───────────────────────────────────────────────────
registerFsHandlers(() => workDir)

// ── Window management ───────────────────────────────────────────────────────
const windowModule = registerWindowHandlers(() => mainWindow, PORT, appIcon)

// Shell operations (not extracted — small and standalone)
safeHandle('shell:open', async (event, target) => {
  await shell.openExternal(target)
})

safeHandle('shell:showItemInFolder', async (event, relativePath) => {
  const resolved = safePath(relativePath)
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
safeHandle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
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

safeHandle('app:setWorkDir', (event, dir) => {
  const isDriveRoot = typeof dir === 'string' && /^[a-zA-Z]:[\/]?$/.test(dir)
  if (dir === '/' || dir === '\\' || isDriveRoot) dir = process.cwd()
  workDir = path.resolve(workDir, dir || workDir)
  return { success: true, workDir }
})

// ── App lifecycle ───────────────────────────────────────────────────────────
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



app.on('before-quit', async () => {
  terminalModule.kill()
  if (hermesProcess) {
    try { hermesProcess.kill() } catch {}
    hermesProcess = null
  }
  if (nextServer) {
    const pid = nextServer.pid
    try {
      if (process.platform === 'win32') {
        await execAsync(`taskkill /F /T /PID ${pid}`)
      } else {
        process.kill(-pid, 'SIGTERM')
      }
    } catch {}
    nextServer = null
  }
})
