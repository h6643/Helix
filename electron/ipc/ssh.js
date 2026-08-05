/**
 * SSH IPC handlers — real SSH sessions for external services (server / VM).
 *
 * Replaces the old `external:testConnection` TCP-probe-only behavior. `ssh:connect`
 * establishes a REAL ssh2 session using the service's stored credentials. The
 * secret is decrypted HERE in the main process (safeStorage) — plaintext never
 * reaches the renderer (the renderer only holds the encrypted blob).
 *
 * Data flow:
 *   renderer (external-services-manager) → ssh:connect {host,port,username,authType,
 *     secretEncrypted,secret} → ssh2 Client → {ok, banner?, error?}
 *   renderer → ssh:exec {command, cwd?} → {stdout, stderr, code}
 *   renderer → ssh:status → {connected, host?, username?}
 *   renderer → ssh:disconnect → {ok}
 *   main → ssh:list event (remote terminal data) via webContents.send
 *
 * Returns { disconnect() } for main.js to call on app quit.
 */
const { ipcMain, safeStorage } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const configModule = require('../lib/config')

// config.yaml lives in the hermes runtime dir (HERMES_HOME); matches main.js.
function configYamlPath() {
  return path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'config.yaml')
}

// Absolute path to the SSH bridge MCP server (electron/ssh-bridge/mcp-server.js).
function bridgeServerPath() {
  return path.join(__dirname, '..', 'ssh-bridge', 'mcp-server.js')
}

// Write the SSH bridge MCP server (remote_exec) into Hermes config.yaml so the
// agent can run commands on the connected machine. Called with the DECRYPTED
// secret — never echoed to the renderer. Call with null to remove.
function writeSshBridgeToConfig(sshInfo) {
  try {
    const yamlPath = configYamlPath()
    let yaml = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf-8') : ''
    yaml = configModule.setMcpSshBridge(yaml, sshInfo, bridgeServerPath())
    fs.writeFileSync(yamlPath, yaml, 'utf-8')
    console.log('[ssh] bridge MCP ' + (sshInfo ? 'registered' : 'removed') + ' in config.yaml')
  } catch (e) {
    console.error('[ssh] bridge config write failed:', e && e.message)
  }
}

// safeStorage decrypt helper (same API-version shim as security.js:47-56).
function safeDecrypt(b64) {
  try {
    if (typeof b64 !== 'string' || !b64) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    const decrypt = (() => {
      if (typeof safeStorage.decrypt === 'function') return safeStorage.decrypt.bind(safeStorage)
      if (typeof safeStorage.decryptString === 'function') return safeStorage.decryptString.bind(safeStorage)
      return null
    })()
    if (!decrypt) return null
    const buf = Buffer.from(b64, 'base64')
    return decrypt(buf).toString('utf8')
  } catch (e) {
    console.error('[ssh] decrypt failed:', e && e.message)
    return null
  }
}

module.exports = function registerSshHandlers(getMainWindow) {
  // Idempotent registration — dev reloads may re-execute this module.
  ipcMain.removeHandler('ssh:connect')
  ipcMain.removeHandler('ssh:exec')
  ipcMain.removeHandler('ssh:status')
  ipcMain.removeHandler('ssh:disconnect')

  let client = null // ssh2 Client
  let connInfo = null // { host, port, username } for status
  let connecting = false

  function sendChunk(data) {
    const win = getMainWindow()
    if (win && !win.isDestroyed() && data) win.webContents.send('ssh:list', data)
  }

  function disconnect() {
    if (client) {
      try { client.end() } catch { /* ignore */ }
      client = null
    }
    connInfo = null
    connecting = false
    // Remove the SSH bridge MCP server from Hermes config so the agent can't
    // run remote commands on a disconnected machine.
    writeSshBridgeToConfig(null)
  }

  ipcMain.handle('ssh:connect', async (event, params = {}) => {
    if (connecting) return { ok: false, error: '正在连接中' }
    const host = String(params.host || '').trim()
    const port = Number(params.port) || 22
    const username = String(params.username || '').trim()
    const authType = params.authType === 'key' ? 'key' : 'password'
    if (!host || !username) return { ok: false, error: '缺少主机或用户名' }

    // Resolve the secret: if the renderer passed an encrypted blob, decrypt in
    // MAIN process. If it's already plaintext (safeStorage unavailable at save
    // time), accept it — but never echo it back to the renderer.
    let secret = String(params.secret || '')
    if (params.secretEncrypted && secret) {
      const decrypted = safeDecrypt(secret)
      if (decrypted === null) return { ok: false, error: '无法解密凭据（safeStorage 不可用？）' }
      secret = decrypted
    }
    if (!secret) return { ok: false, error: '缺少密码或私钥' }

    console.log('[ssh:connect]', host + ':' + port, username, 'auth=' + authType, 'secretLen=' + secret.length)

    // Close any stale session first.
    disconnect()

    const { Client } = require('ssh2')
    const c = new Client()
    const auth = authType === 'key'
      ? { privateKey: secret }
      : { password: secret }
    connecting = true

    return await new Promise((resolve) => {
      let settled = false
      const finish = (ok, extra) => {
        if (settled) return
        settled = true
        connecting = false
        resolve(ok ? { ok: true, ...extra } : { ok: false, error: (extra && extra.error) || '连接失败' })
      }

      c.on('ready', () => {
        client = c
        connInfo = { host, port, username }
        const banner = (c && c._banner) || ''
        finish(true, { banner })
        // Register the SSH bridge MCP server so the Hermes agent can run
        // commands on this machine (remote_exec tool). Secret is decrypted in
        // main and written to config.yaml's mcp_servers env block — the renderer
        // never sees plaintext.
        writeSshBridgeToConfig({ host, port, username, secret })
        // Notify renderer listeners.
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('ssh:connected', { host, username })
        }
      })
      c.on('error', (err) => {
        console.log('[ssh:connect] error:', err && err.message, '| level:', err && err.level, '| code:', err && err.code)
        finish(false, { error: (err && err.message) || String(err) })
      })
      c.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, kiFinish) => {
        // Some servers (e.g. Windows OpenSSH) use keyboard-interactive even
        // for password auth. Answer with the same password.
        if (authType === 'password') {
          kiFinish([secret])
        } else {
          kiFinish([])
        }
      })
      c.on('close', () => {
        console.log('[ssh:connect] closed')
        if (client === c) { client = null; connInfo = null }
      })

      c.connect({
        host,
        port,
        username,
        readyTimeout: 15000,
        // host key verification: accept known hosts only on first connect is
        // complex; for MVP accept the server's host key (MITM risk on shared
        // networks is acceptable for a desktop dev tool — revisit if needed).
        hostVerifier: () => true,
        ...auth,
      })
    })
  })

  ipcMain.handle('ssh:exec', async (event, params = {}) => {
    if (!client) return { ok: false, error: '未连接到服务器' }
    const command = String(params.command || '').trim()
    if (!command) return { ok: false, error: '命令为空' }
    return await new Promise((resolve) => {
      client.exec(command, (err, stream) => {
        if (err) return resolve({ ok: false, error: err.message })
        let stdout = ''
        let stderr = ''
        stream.on('close', (code) => resolve({ ok: true, stdout, stderr, code: code == null ? 0 : code }))
        stream.on('data', (d) => { stdout += d.toString('utf8') })
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8') })
        stream.on('error', (e) => resolve({ ok: false, error: e.message }))
      })
    })
  })

  ipcMain.handle('ssh:status', async () => {
    if (!client) return { connected: false }
    return { connected: true, host: connInfo?.host, username: connInfo?.username }
  })

  ipcMain.handle('ssh:disconnect', async () => {
    disconnect()
    return { ok: true }
  })

  return {
    disconnect,
  }
}
