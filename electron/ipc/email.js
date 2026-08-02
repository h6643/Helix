/**
 * Email IPC handlers — read inbox (IMAP), send mail (SMTP), and push
 * notifications. Backend-agnostic but pre-filled with NetEase 163 defaults.
 *
 * Config (IMAP/SMTP hosts, user, the 163 "客户端授权码") is persisted as a JSON
 * file in the app userData dir. The authorization code is encrypted with
 * Electron safeStorage so it does not sit in plaintext on disk.
 */
const { ipcMain, safeStorage, app } = require('electron')
const fs = require('fs')
const path = require('path')
const { ImapFlow } = require('imapflow')
const nodemailer = require('nodemailer')
const { simpleParser } = require('mailparser')

// ── Defaults ────────────────────────────────────────────────────────────────
const PROVIDER_DEFAULTS = {
  '163.com': {
    imapHost: 'imap.163.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: true,
  },
  'qq.com': {
    imapHost: 'imap.qq.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: true,
  },
  'gmail.com': {
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true,
  },
}

function configPath() {
  const dir = app.getPath('userData')
  return path.join(dir, 'email-config.json')
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8')
    const cfg = JSON.parse(raw)
    if (cfg.authCodeEnc && safeStorage.isEncryptionAvailable()) {
      try {
        cfg.authCode = safeStorage.decryptString(Buffer.from(cfg.authCodeEnc, 'base64'))
      } catch {
        cfg.authCode = ''
      }
    }
    return cfg
  } catch {
    return null
  }
}

function saveConfig(cfg) {
  const out = { ...cfg }
  if (cfg.authCode && safeStorage.isEncryptionAvailable()) {
    out.authCodeEnc = safeStorage.encryptString(cfg.authCode).toString('base64')
    delete out.authCode
  }
  fs.writeFileSync(configPath(), JSON.stringify(out, null, 2), 'utf-8')
}

function inferDefaults(email) {
  const domain = (email || '').split('@')[1] || ''
  return PROVIDER_DEFAULTS[domain] || null
}

// Build an ImapFlow client from the stored config.
function makeImap(cfg) {
  return new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: cfg.imapSecure !== false,
    auth: { user: cfg.user, pass: cfg.authCode },
    logger: false,
  })
}

function makeSmtpTransport(cfg) {
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure !== false,
    auth: { user: cfg.user, pass: cfg.authCode },
  })
}

module.exports = function registerEmailHandlers() {
  // Idempotent registration — dev reloads may re-execute this module.
  const channels = [
    'email:configure', 'email:getConfig', 'email:list',
    'email:get', 'email:send', 'email:notify', 'email:test',
  ]
  for (const c of channels) {
    try { ipcMain.removeHandler(c) } catch { /* ignore */ }
  }

  // Save connection settings. Auto-fills host/port from the email domain when
  // the caller omits them.
  ipcMain.handle('email:configure', async (event, partial) => {
    const existing = loadConfig() || {}
    const merged = { ...existing, ...partial }
    if (!merged.user) throw new Error('邮箱账号不能为空')
    if (!merged.authCode) throw new Error('授权码不能为空')
    const d = inferDefaults(merged.user)
    if (d) {
      merged.imapHost = merged.imapHost || d.imapHost
      merged.imapPort = merged.imapPort || d.imapPort
      merged.imapSecure = merged.imapSecure ?? d.imapSecure
      merged.smtpHost = merged.smtpHost || d.smtpHost
      merged.smtpPort = merged.smtpPort || d.smtpPort
      merged.smtpSecure = merged.smtpSecure ?? d.smtpSecure
    }
    saveConfig(merged)
    // Return a safe (no-secret) view to the renderer.
    const { authCode, authCodeEnc, ...safe } = merged
    return { ...safe, configured: true }
  })

  // Returns config WITHOUT the secret, plus a `configured` flag.
  ipcMain.handle('email:getConfig', async () => {
    const cfg = loadConfig()
    if (!cfg) return { configured: false }
    const { authCode, authCodeEnc, ...safe } = cfg
    return { ...safe, configured: true, hasAuthCode: !!authCode || !!authCodeEnc }
  })

  // List recent messages from INBOX.
  ipcMain.handle('email:list', async (event, opts = {}) => {
    const cfg = loadConfig()
    if (!cfg) throw new Error('邮箱未配置')
    const limit = Math.min(opts.limit || 30, 100)
    const client = makeImap(cfg)
    const messages = []
    try {
      await client.connect()
      const lock = await client.getMailboxLock('INBOX')
      try {
        const uids = (await client.search({ all: true }, { uid: true })) || []
        const seq = uids.slice(-limit).reverse()
        for (const uid of seq) {
          const msg = await client.fetchOne(String(uid), {
            envelope: true,
            flags: true,
            internalDate: true,
          }, { uid: true })
          if (!msg) continue
          const env = msg.envelope || {}
          messages.push({
            uid: msg.uid,
            from: (env.from && env.from[0] && (env.from[0].name || env.from[0].address)) || '',
            fromAddress: (env.from && env.from[0] && env.from[0].address) || '',
            subject: env.subject || '(无主题)',
            date: env.date ? new Date(env.date).getTime() : (msg.internalDate ? new Date(msg.internalDate).getTime() : 0),
            seen: (msg.flags || []).includes('\\Seen'),
          })
        }
      } finally {
        lock.release()
      }
    } finally {
      await client.logout()
    }
    return messages
  })

  // Fetch a single message's full body.
  ipcMain.handle('email:get', async (event, uid) => {
    const cfg = loadConfig()
    if (!cfg) throw new Error('邮箱未配置')
    const client = makeImap(cfg)
    try {
      await client.connect()
      const lock = await client.getMailboxLock('INBOX')
      try {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true })
        if (!msg || !msg.source) throw new Error('邮件不存在')
        const parsed = await simpleParser(msg.source)
        return {
          uid: Number(uid),
          subject: parsed.subject || '(无主题)',
          from: parsed.from?.text || '',
          to: parsed.to?.text || '',
          date: parsed.date ? new Date(parsed.date).getTime() : 0,
          text: parsed.text || '',
          html: parsed.html || '',
          attachments: (parsed.attachments || []).map(a => ({
            filename: a.filename, size: a.size, contentType: a.contentType,
          })),
        }
      } finally {
        lock.release()
      }
    } finally {
      await client.logout()
    }
  })

  // Send a message via SMTP.
  ipcMain.handle('email:send', async (event, { to, subject, text, html }) => {
    const cfg = loadConfig()
    if (!cfg) throw new Error('邮箱未配置')
    if (!to) throw new Error('收件人不能为空')
    const transport = makeSmtpTransport(cfg)
    const info = await transport.sendMail({
      from: cfg.fromName ? `"${cfg.fromName}" <${cfg.user}>` : cfg.user,
      to,
      subject: subject || '',
      text: text || '',
      html: html || undefined,
    })
    return { accepted: info.accepted, messageId: info.messageId }
  })

  // Notification helper: send a short summary to the configured account itself
  // (or a provided recipient). Used for "agent run finished" alerts.
  ipcMain.handle('email:notify', async (event, { to, subject, text }) => {
    const cfg = loadConfig()
    if (!cfg) throw new Error('邮箱未配置')
    const recipient = to || cfg.user
    const transport = makeSmtpTransport(cfg)
    const info = await transport.sendMail({
      from: cfg.fromName ? `"${cfg.fromName}" <${cfg.user}>` : cfg.user,
      to: recipient,
      subject: subject || 'Helix 通知',
      text: text || '',
    })
    return { accepted: info.accepted, messageId: info.messageId }
  })

  // Test IMAP + SMTP with the stored config; return a per-service verdict with
  // the raw error so the user can diagnose bad credentials / wrong host / etc.
  ipcMain.handle('email:test', async () => {
    const cfg = loadConfig()
    if (!cfg) throw new Error('邮箱未配置')

    let imapOk = false
    let imapMsg = ''
    const client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: cfg.imapSecure !== false,
      auth: { user: cfg.user, pass: cfg.authCode },
      // Log the IMAP conversation to the main console so the server's exact
      // auth-failure text (e.g. 163's reason) is visible when debugging.
      logger: (log) => { try { console.log('[email IMAP]', log?.msg ?? '', log?.err ?? '') } catch {} },
    })
    try {
      await client.connect()
      imapOk = true
      imapMsg = 'IMAP 连接成功'
      await client.logout()
    } catch (e) {
      imapMsg = (e && (e.message || e.responseText || e.text)) || String(e)
    }

    let smtpOk = false
    let smtpMsg = ''
    try {
      const transport = makeSmtpTransport(cfg)
      await transport.verify()
      smtpOk = true
      smtpMsg = 'SMTP 连接成功'
    } catch (e) {
      smtpMsg = (e && (e.message || e.responseText)) || String(e)
    }

    return {
      ok: imapOk && smtpOk,
      imap: { ok: imapOk, message: imapMsg },
      smtp: { ok: smtpOk, message: smtpMsg },
    }
  })
}
