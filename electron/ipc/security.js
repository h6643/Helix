/**
 * Security IPC handlers — extracted from main.js.
 * OS-backed secret storage (Electron safeStorage) and related security checks.
 */
const { ipcMain, safeStorage, app } = require('electron')
const fs = require('fs')
const path = require('path')

// ── Config validation gate ──────────────────────────────────────────────
// Detect a stale/bad model profile so it can never poison the real Hermes
// config on disk.
function isBadConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return true
  const baseUrl = String(cfg.baseUrl || '').trim().toLowerCase()
  if (!baseUrl) return true
  return false
}
const APIHUB_DEFAULT = { provider: 'agnes-ai', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash', apiKey: '' }

module.exports = function registerSecurityHandlers(getMainWindow, getDiagnostics) {
  // Idempotent registration — dev reloads may re-execute this module.
  const handles = ['secure:available', 'secure:encrypt', 'secure:decrypt', 'shell:exec', 'profile:cacheConfig', 'diagnostics:getStatus']
  for (const channel of handles) {
    try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
  }

  // ── safeStorage (DPAPI/Keychain/libsecret) ─────────────────────────────
  ipcMain.handle('secure:available', () => {
    try { return typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable() } catch { return false }
  })

  // Electron < 26 exposes encryptString/decryptString; >= 26 uses
  // encrypt/decrypt. Pick whichever actually exists so keys are stored with
  // OS-backed encryption instead of silently falling back to the weak legacy
  // scheme (or worse, returning null and losing the key from the store).
  const safeEncrypt = (() => {
    if (typeof safeStorage.encrypt === 'function') return safeStorage.encrypt.bind(safeStorage)
    if (typeof safeStorage.encryptString === 'function') return safeStorage.encryptString.bind(safeStorage)
    return null
  })()
  const safeDecrypt = (() => {
    if (typeof safeStorage.decrypt === 'function') return safeStorage.decrypt.bind(safeStorage)
    if (typeof safeStorage.decryptString === 'function') return safeStorage.decryptString.bind(safeStorage)
    return null
  })()

  ipcMain.handle('secure:encrypt', async (event, plaintext) => {
    if (typeof plaintext !== 'string' || !plaintext) return ''
    try {
      if (!safeStorage.isEncryptionAvailable()) return null
      if (!safeEncrypt) return null
      const buf = safeEncrypt(plaintext)
      return Buffer.isBuffer(buf) ? buf.toString('base64') : String(buf)
    } catch (e) {
      console.error('[safeStorage] encrypt failed:', e && e.message)
      return null
    }
  })

  ipcMain.handle('secure:decrypt', async (event, b64) => {
    if (typeof b64 !== 'string' || !b64) return ''
    try {
      if (!safeStorage.isEncryptionAvailable()) return null
      if (!safeDecrypt) return null
      const buf = Buffer.from(b64, 'base64')
      return safeDecrypt(buf).toString('utf8')
    } catch (e) {
      console.error('[safeStorage] decrypt failed:', e && e.message)
      return null
    }
  })

  // ── Shell security (exec disabled) ─────────────────────────────────────
  ipcMain.handle('shell:exec', async () => {
    throw new Error('shell:exec is disabled for security')
  })

  // ── Profile cache ──────────────────────────────────────────────────────
  ipcMain.handle('profile:cacheConfig', async (event, cfg) => {
    try {
      // Validation gate: a stale/bad profile must never be cached as the active
      // one (it would re-assert into Hermes config.yaml on next launch and cause
      // 401s). Fall back to the known-good apihub default instead.
      if (isBadConfig(cfg)) cfg = { ...APIHUB_DEFAULT }
      const cachePath = path.join(app.getPath('userData'), 'active-profile.json')
      fs.writeFileSync(cachePath, JSON.stringify(cfg || {}), 'utf-8')
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // ── Diagnostics ────────────────────────────────────────────────────────
  ipcMain.handle('diagnostics:getStatus', async () => {
    return getDiagnostics ? getDiagnostics() : (getMainWindow() ? { ok: true } : { ok: false })
  })
}

module.exports.isBadConfig = isBadConfig
module.exports.APIHUB_DEFAULT = APIHUB_DEFAULT
