/**
 * External service (server / VM) IPC handlers — extracted from main.js.
 *
 * Provides a lightweight TCP reachability probe so the renderer can verify a
 * host:port is reachable before "connecting" an external service (server or
 * virtual machine) from the chat breadcrumb. This is a connectivity check
 * only — it does NOT open a shell or transmit credentials. Actual SSH/remote
 * execution can be layered on top later via a purpose-specific handler.
 */
const net = require('net')
const { ipcMain } = require('electron')

/**
 * Attempt a TCP connection to host:port within `timeoutMs`.
 * Resolves to { ok, error?, latencyMs? }.
 */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now()
    let settled = false
    const socket = new net.Socket()
    socket.setTimeout(timeoutMs)

    const finish = (ok, error) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve(ok ? { ok: true, latencyMs: Date.now() - start } : { ok: false, error })
    }

    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false, '连接超时'))
    socket.once('error', (err) => finish(false, err && err.code ? `${err.code}` : '连接失败'))

    try {
      socket.connect(Number(port), String(host))
    } catch (err) {
      finish(false, err && err.message ? err.message : '无效的主机或端口')
    }
  })
}

module.exports = function registerExternalHandlers() {
  // Idempotent registration — dev reloads may re-execute this module.
  const channels = ['external:testConnection']
  for (const channel of channels) {
    try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
  }

  ipcMain.handle('external:testConnection', async (_event, host, port, timeoutMs = 4000) => {
    if (!host || !port) return { ok: false, error: '缺少主机或端口' }
    try {
      const result = await tcpProbe(host, port, Math.max(500, Math.min(15000, Number(timeoutMs) || 4000)))
      return result
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : '探测失败' }
    }
  })
}
