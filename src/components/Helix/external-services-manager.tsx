'use client'

import { useState, useEffect } from 'react'
import {
  Server,
  Plus,
  Trash2,
  Check,
  Loader2,
  Circle,
  Pencil,
  KeyRound,
  User,
} from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { isElectron } from '@/lib/electron-bridge'

// Full management UI for external services (server / VM), rendered inside the
// General settings panel. Add / edit / delete / connect / disconnect all live
// here; the breadcrumb popover only selects & connects.
export function ExternalServiceManager() {
  const externalServices = useHelixStore((s) => s.externalServices)
  const sshConnected = useHelixStore((s) => s.sshConnected)
  const sshServiceId = useHelixStore((s) => s.sshServiceId)
  const [mode, setMode] = useState<'list' | 'add' | 'edit'>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  // If the SSH session dies on the main-process side (remote close, error),
  // reflect that back in the UI immediately.
  useEffect(() => {
    if (!isElectron()) return
    const check = () => {
      if (!useHelixStore.getState().sshConnected) return
      window.electron?.external?.sshStatus().then((st) => {
        if (!st.connected && useHelixStore.getState().sshConnected) {
          useHelixStore.getState().setSshConnected(false)
          useHelixStore.getState().showToast({ type: 'info', title: 'SSH 连接已断开' })
        }
      }).catch(() => {})
    }
    const timer = setInterval(check, 5000)
    return () => clearInterval(timer)
  }, [])

  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [authType, setAuthType] = useState<'password' | 'key'>('password')
  const [secret, setSecret] = useState('')

  const resetForm = () => {
    setName('')
    setHost('')
    setPort('22')
    setUsername('')
    setAuthType('password')
    setSecret('')
    setEditingId(null)
  }

  const openAdd = () => {
    resetForm()
    setMode('add')
  }

  const openEdit = (svc: { id: string; name: string; host: string; port: number; username?: string; authType?: 'password' | 'key' }) => {
    setName(svc.name)
    setHost(svc.host)
    setPort(String(svc.port))
    setUsername(svc.username || '')
    setAuthType(svc.authType || 'password')
    setSecret('')
    setEditingId(svc.id)
    setMode('edit')
  }

  const handleSave = async () => {
    const trimmedHost = host.trim()
    const numPort = Number(port)
    if (!name.trim() || !trimmedHost || !numPort) {
      useHelixStore.getState().showToast({ type: 'error', title: '请填写名称、主机与端口' })
      return
    }
    const payload = {
      name: name.trim(),
      host: trimmedHost,
      port: numPort,
      username: username.trim() || undefined,
      authType,
      secret: secret ? secret : undefined,
    }
    if (mode === 'add') {
      await useHelixStore.getState().addExternalService(payload)
    } else if (editingId) {
      await useHelixStore.getState().updateExternalService(editingId, payload)
    }
    resetForm()
    setMode('list')
  }

  const handleConnect = async (svc: { id: string; name: string; host: string; port: number; username?: string; authType?: 'password' | 'key'; secret?: string; secretEncrypted?: boolean }) => {
    if (testingId) return
    if (useHelixStore.getState().sshConnected) {
      useHelixStore.getState().showToast({ type: 'error', title: '已有 SSH 连接', description: '请先断开当前连接' })
      return
    }
    setTestingId(svc.id)
    try {
      if (isElectron() && window.electron?.external) {
        // Real SSH: pass the (possibly encrypted) secret to the main process,
        // which decrypts it there. Plaintext never enters the renderer.
        const res = await window.electron.external.sshConnect({
          host: svc.host,
          port: svc.port,
          username: svc.username || 'root',
          authType: svc.authType || 'password',
          secret: svc.secret || '',
          secretEncrypted: svc.secretEncrypted,
        })
        if (!res.ok) {
          useHelixStore.getState().showToast({ type: 'error', title: `连接 ${svc.name} 失败`, description: res.error })
          return
        }
      } else {
        useHelixStore.getState().showToast({ type: 'error', title: '仅桌面模式支持 SSH 连接' })
        return
      }
      useHelixStore.getState().setExternalServiceConnected(svc.id, true)
      useHelixStore.getState().setSshConnected(true, svc.id)
      useHelixStore.getState().showToast({ type: 'success', title: `已连接 ${svc.name}`, description: 'agent 已获得远程命令能力（remote_exec）。若当前对话没有该工具，输入 /reload-mcp 或开新对话生效。' })
    } catch (err: any) {
      // sshConnect can throw (e.g. main process not restarted → "No handler
      // registered for 'ssh:connect'"). Surface the real error instead of an
      // unhandled rejection.
      useHelixStore.getState().showToast({ type: 'error', title: `连接 ${svc.name} 失败`, description: err?.message || String(err) })
    } finally {
      setTestingId(null)
    }
  }

  const handleDisconnect = async (svc: { id: string; name: string }) => {
    try {
      if (isElectron() && window.electron?.external) {
        await window.electron.external.sshDisconnect()
      }
    } catch { /* ignore */ }
    useHelixStore.getState().setExternalServiceConnected(svc.id, false)
    useHelixStore.getState().setSshConnected(false)
  }

  const handleDelete = (svc: { id: string; name: string }) => {
    useHelixStore.getState().removeExternalService(svc.id)
  }

  if (mode !== 'list') {
    return (
      <div className="rounded-lg border border-border/30 bg-muted/20 p-3 space-y-2.5">
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：生产服务器"
            className="w-full text-[12px] px-2 py-1.5 rounded-md bg-background border border-border/30 outline-none focus:border-primary/50"
          />
        </div>
        <div className="grid grid-cols-[1fr_64px] gap-2">
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">主机 / IP</label>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.10"
              className="w-full text-[12px] px-2 py-1.5 rounded-md bg-background border border-border/30 outline-none focus:border-primary/50"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">端口</label>
            <input
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="22"
              className="w-full text-[12px] px-2 py-1.5 rounded-md bg-background border border-border/30 outline-none focus:border-primary/50"
            />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground flex items-center gap-1">
            <User className="size-3" /> 用户名
          </label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="root"
            className="w-full text-[12px] px-2 py-1.5 rounded-md bg-background border border-border/30 outline-none focus:border-primary/50"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">认证方式</label>
          <div className="flex gap-1.5">
            {(['password', 'key'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setAuthType(t)}
                className={`flex-1 flex items-center justify-center gap-1 text-[11px] py-1.5 rounded-md border transition-colors ${
                  authType === t
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border/30 text-foreground/60 hover:bg-muted/40'
                }`}
              >
                <KeyRound className="size-3" />
                {t === 'password' ? '密码' : '密钥'}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">
            {authType === 'password' ? '密码' : '私钥'}
            {mode === 'edit' && '（留空表示不修改）'}
          </label>
          <input
            type={authType === 'password' ? 'password' : 'text'}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={authType === 'password' ? '••••••' : '-----BEGIN ...'}
            className="w-full text-[12px] px-2 py-1.5 rounded-md bg-background border border-border/30 outline-none focus:border-primary/50 font-mono"
          />
        </div>
        <div className="flex gap-1.5 pt-1">
          <button
            type="button"
            onClick={handleSave}
            className="flex-1 text-[12px] py-1.5 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors flex items-center justify-center gap-1"
          >
            <Check className="size-3.5" />
            {mode === 'add' ? '添加' : '保存'}
          </button>
          <button
            type="button"
            onClick={() => { resetForm(); setMode('list') }}
            className="flex-1 text-[12px] py-1.5 rounded-md bg-muted/40 text-foreground/70 hover:bg-muted/60 transition-colors"
          >
            取消
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {externalServices.length === 0 ? (
        <div className="text-[12px] text-muted-foreground py-1">
          还没有已配置的服务器 / 虚拟机。
        </div>
      ) : (
        <div className="space-y-1.5">
          {externalServices.map((svc) => (
            <div
              key={svc.id}
              className="rounded-lg border border-border/30 bg-muted/20 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <Circle
                  className={`size-2.5 shrink-0 ${sshConnected && sshServiceId === svc.id ? 'fill-emerald-500 text-emerald-500' : 'fill-foreground/20 text-foreground/20'}`}
                />
                <span className="text-[13px] text-foreground/90 truncate flex-1">{svc.name}</span>
                {testingId === svc.id ? (
                  <Loader2 className="size-3.5 animate-spin text-foreground/40" />
                ) : sshConnected && sshServiceId === svc.id ? (
                  <button
                    type="button"
                    onClick={() => handleDisconnect(svc)}
                    className="text-[11px] px-2 py-0.5 rounded-md text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                  >
                    断开
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleConnect(svc)}
                    className="text-[11px] px-2 py-0.5 rounded-md text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 transition-colors"
                  >
                    连接
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5 pl-4">
                <span className="text-[11px] text-muted-foreground truncate">
                  {svc.username ? `${svc.username}@` : ''}{svc.host}:{svc.port}
                </span>
                <span className="ml-auto flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => openEdit(svc)}
                    className="p-1 rounded text-foreground/40 hover:text-foreground hover:bg-accent/50 transition-colors"
                    title="编辑"
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(svc)}
                    className="p-1 rounded text-foreground/40 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    title="删除"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={openAdd}
        className="flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
      >
        <Plus className="size-3" />
        添加服务器 / 虚拟机
      </button>
    </div>
  )
}
