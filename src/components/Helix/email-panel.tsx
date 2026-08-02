'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Mail, Send, Settings, Inbox, RefreshCw, ArrowLeft, AlertCircle, CheckCircle2,
} from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'

type MailSummary = {
  uid: number
  from: string
  fromAddress: string
  subject: string
  date: number
  seen: boolean
}
type MailDetail = {
  uid: number
  subject: string
  from: string
  to: string
  date: number
  text: string
  html: string
  attachments: Array<{ filename: string; size: number; contentType: string }>
}
type EmailConfig = {
  user?: string
  fromName?: string
  imapHost?: string
  imapPort?: number
  imapSecure?: boolean
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
}

type SubTab = 'inbox' | 'compose' | 'settings'

export function EmailPanel({ onClose }: { onClose: () => void }) {
  const emailConfigured = useHelixStore((s) => s.emailConfigured)
  const emailAccount = useHelixStore((s) => s.emailAccount)
  const emailNotifyEnabled = useHelixStore((s) => s.emailNotifyEnabled)
  const setEmailConfigured = useHelixStore((s) => s.setEmailConfigured)
  const setEmailNotifyEnabled = useHelixStore((s) => s.setEmailNotifyEnabled)

  const [subTab, setSubTab] = useState<SubTab>(emailConfigured ? 'inbox' : 'settings')
  const [messages, setMessages] = useState<MailSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openMail, setOpenMail] = useState<MailDetail | null>(null)

  const [composeTo, setComposeTo] = useState('')
  const [composeSubject, setComposeSubject] = useState('')
  const [composeBody, setComposeBody] = useState('')
  const [sending, setSending] = useState(false)

  const [cfg, setCfg] = useState<EmailConfig>({})
  const [authCode, setAuthCode] = useState('')
  const [savingCfg, setSavingCfg] = useState(false)
  const [notifyTested, setNotifyTested] = useState<null | boolean>(null)

  const loadInbox = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.electron.email.list({ limit: 30 })
      setMessages(list)
    } catch (e: any) {
      setError(e?.message || '读取收件箱失败')
    } finally {
      setLoading(false)
    }
  }, [])

  // On mount, sync config from the main process.
  useEffect(() => {
    let active = true
    window.electron.email.getConfig().then((c) => {
      if (!active) return
      if (c.configured) {
        setEmailConfigured(true, c.user)
        setCfg({
          user: c.user, fromName: c.fromName,
          imapHost: c.imapHost, imapPort: c.imapPort, imapSecure: c.imapSecure,
          smtpHost: c.smtpHost, smtpPort: c.smtpPort, smtpSecure: c.smtpSecure,
        })
        setSubTab('inbox')
      }
    }).catch(() => {})
    return () => { active = false }
  }, [setEmailConfigured])

  useEffect(() => {
    if (subTab === 'inbox' && emailConfigured) loadInbox()
  }, [subTab, emailConfigured, loadInbox])

  const openMessage = async (uid: number) => {
    setError(null)
    try {
      const detail = await window.electron.email.get(uid)
      setOpenMail(detail)
    } catch (e: any) {
      setError(e?.message || '读取邮件失败')
    }
  }

  const handleSaveConfig = async () => {
    if (!cfg.user || !authCode) {
      setError('账号和授权码不能为空')
      return
    }
    setSavingCfg(true)
    setError(null)
    try {
      const res = await window.electron.email.configure({
        user: cfg.user!,
        authCode,
        fromName: cfg.fromName,
        imapHost: cfg.imapHost,
        imapPort: cfg.imapPort,
        imapSecure: cfg.imapSecure,
        smtpHost: cfg.smtpHost,
        smtpPort: cfg.smtpPort,
        smtpSecure: cfg.smtpSecure,
      })
      setEmailConfigured(true, res.user || cfg.user)
      setSubTab('inbox')
    } catch (e: any) {
      setError(e?.message || '保存失败')
    } finally {
      setSavingCfg(false)
    }
  }

  const handleSend = async () => {
    if (!composeTo) { setError('收件人不能为空'); return }
    setSending(true)
    setError(null)
    try {
      await window.electron.email.send({
        to: composeTo,
        subject: composeSubject,
        text: composeBody,
      })
      setComposeTo(''); setComposeSubject(''); setComposeBody('')
      setSubTab('inbox')
    } catch (e: any) {
      setError(e?.message || '发送失败')
    } finally {
      setSending(false)
    }
  }

  const handleTestNotify = async () => {
    setNotifyTested(null)
    setError(null)
    try {
      await window.electron.email.notify({
        subject: 'Helix 邮件通知测试',
        text: '如果你收到这封邮件，说明 Helix 的邮件通知已正确配置。',
      })
      setNotifyTested(true)
    } catch (e: any) {
      setNotifyTested(false)
      setError(e?.message || '发送通知失败')
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-1 px-2 h-9 shrink-0 border-b border-border/30 bg-sidebar">
        <button
          onClick={() => setSubTab('inbox')}
          className={`flex items-center gap-1 px-2 py-1 rounded text-[12px] transition-colors ${subTab === 'inbox' ? 'bg-accent text-foreground' : 'text-foreground/60 hover:bg-accent/50'}`}
        >
          <Inbox className="size-3.5" /> 收件箱
        </button>
        <button
          onClick={() => setSubTab('compose')}
          className={`flex items-center gap-1 px-2 py-1 rounded text-[12px] transition-colors ${subTab === 'compose' ? 'bg-accent text-foreground' : 'text-foreground/60 hover:bg-accent/50'}`}
        >
          <Send className="size-3.5" /> 写邮件
        </button>
        <button
          onClick={() => setSubTab('settings')}
          className={`flex items-center gap-1 px-2 py-1 rounded text-[12px] transition-colors ${subTab === 'settings' ? 'bg-accent text-foreground' : 'text-foreground/60 hover:bg-accent/50'}`}
        >
          <Settings className="size-3.5" /> 设置
        </button>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-accent/60 transition-colors"
          title="关闭"
        >
          <Mail className="size-3.5" />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-destructive bg-destructive/10 shrink-0">
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      {/* Inbox */}
      {subTab === 'inbox' && (
        <div className="flex-1 min-h-0 flex flex-col">
          {openMail ? (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30 shrink-0">
                <button onClick={() => setOpenMail(null)} className="p-1 rounded hover:bg-accent/60">
                  <ArrowLeft className="size-4" />
                </button>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{openMail.subject}</div>
                  <div className="text-[11px] text-muted-foreground truncate">{openMail.from} → {openMail.to}</div>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-auto p-3 text-sm whitespace-pre-wrap">
                {openMail.html
                  ? <iframe title="mail" className="w-full h-full border-0" srcDoc={openMail.html} />
                  : (openMail.text || '(无内容)')}
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between px-3 py-1.5 shrink-0">
                <span className="text-[11px] text-muted-foreground">
                  {emailAccount ? `账号：${emailAccount}` : '未配置'}
                </span>
                <button
                  onClick={loadInbox}
                  disabled={loading}
                  className="flex items-center gap-1 text-[11px] text-foreground/60 hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} /> 刷新
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-auto">
                {messages.length === 0 && !loading && (
                  <div className="p-6 text-center text-sm text-muted-foreground">收件箱为空</div>
                )}
                {messages.map((m) => (
                  <button
                    key={m.uid}
                    onClick={() => openMessage(m.uid)}
                    className="w-full text-left px-3 py-2 border-b border-border/20 hover:bg-accent/40 flex flex-col gap-0.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-[13px] truncate ${m.seen ? 'text-foreground/70' : 'text-foreground font-medium'}`}>
                        {m.from || m.fromAddress}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {m.date ? new Date(m.date).toLocaleString() : ''}
                      </span>
                    </div>
                    <span className="text-[12px] text-muted-foreground truncate">{m.subject}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Compose */}
      {subTab === 'compose' && (
        <div className="flex-1 min-h-0 flex flex-col gap-2 p-3">
          <input
            value={composeTo}
            onChange={(e) => setComposeTo(e.target.value)}
            placeholder="收件人"
            className="w-full px-2 py-1.5 text-sm rounded-md border border-border/50 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            value={composeSubject}
            onChange={(e) => setComposeSubject(e.target.value)}
            placeholder="主题"
            className="w-full px-2 py-1.5 text-sm rounded-md border border-border/50 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <textarea
            value={composeBody}
            onChange={(e) => setComposeBody(e.target.value)}
            placeholder="正文"
            className="flex-1 min-h-[120px] w-full px-2 py-1.5 text-sm rounded-md border border-border/50 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleSend}
            disabled={sending}
            className="self-start flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Send className="size-3.5" /> {sending ? '发送中…' : '发送'}
          </button>
        </div>
      )}

      {/* Settings */}
      {subTab === 'settings' && (
        <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-2.5">
          <Field label="邮箱账号">
            <input
              value={cfg.user || ''}
              onChange={(e) => setCfg({ ...cfg, user: e.target.value })}
              placeholder="yourname@163.com"
              className={inputCls}
            />
          </Field>
          <Field label="客户端授权码（非登录密码）">
            <input
              type="password"
              value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
              placeholder="163 邮箱设置里生成的授权码"
              className={inputCls}
            />
          </Field>
          <Field label="发件人名称（可选）">
            <input
              value={cfg.fromName || ''}
              onChange={(e) => setCfg({ ...cfg, fromName: e.target.value })}
              placeholder="Helix"
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="IMAP 服务器">
              <input value={cfg.imapHost || ''} onChange={(e) => setCfg({ ...cfg, imapHost: e.target.value })} placeholder="imap.163.com" className={inputCls} />
            </Field>
            <Field label="IMAP 端口">
              <input type="number" value={cfg.imapPort ?? ''} onChange={(e) => setCfg({ ...cfg, imapPort: e.target.value ? Number(e.target.value) : undefined })} placeholder="993" className={inputCls} />
            </Field>
            <Field label="SMTP 服务器">
              <input value={cfg.smtpHost || ''} onChange={(e) => setCfg({ ...cfg, smtpHost: e.target.value })} placeholder="smtp.163.com" className={inputCls} />
            </Field>
            <Field label="SMTP 端口">
              <input type="number" value={cfg.smtpPort ?? ''} onChange={(e) => setCfg({ ...cfg, smtpPort: e.target.value ? Number(e.target.value) : undefined })} placeholder="465" className={inputCls} />
            </Field>
          </div>
          <p className="text-[11px] text-muted-foreground">
            163 邮箱默认 IMAP <code>imap.163.com:993</code>、SMTP <code>smtp.163.com:465</code>（SSL）。留空将自动按域名填充。
          </p>
          <button
            onClick={handleSaveConfig}
            disabled={savingCfg}
            className="self-start flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {savingCfg ? '保存中…' : '保存配置'}
          </button>

          <div className="mt-2 pt-3 border-t border-border/30 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm">Agent 完成后邮件通知</span>
              <button
                onClick={() => setEmailNotifyEnabled(!emailNotifyEnabled)}
                className={`relative w-10 h-5 rounded-full transition-colors ${emailNotifyEnabled ? 'bg-primary' : 'bg-border/60'}`}
              >
                <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${emailNotifyEnabled ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
            <button
              onClick={handleTestNotify}
              className="self-start flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border/60 hover:bg-accent/50"
            >
              {notifyTested === true ? <CheckCircle2 className="size-3.5 text-green-500" /> : null}
              {notifyTested === false ? <AlertCircle className="size-3.5 text-destructive" /> : null}
              发送测试通知
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const inputCls =
  'w-full px-2 py-1.5 text-sm rounded-md border border-border/50 bg-background focus:outline-none focus:ring-1 focus:ring-primary'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
