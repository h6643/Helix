'use client'

import { useState, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  Server,
  Plus,
  Trash2,
  Check,
  X,
  Loader2,
  Circle,
  Pencil,
  KeyRound,
  User,
} from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { isElectron } from '@/lib/electron-bridge'

type FormMode = 'list' | 'add' | 'edit'

export function ExternalServicesPopover({
  onClose,
  anchorRef,
}: {
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}) {
  const externalServices = useHelixStore((s) => s.externalServices)
  const [mode, setMode] = useState<FormMode>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  // Form fields
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

  const openEdit = (svc: {
    id: string
    name: string
    host: string
    port: number
    username?: string
    authType?: 'password' | 'key'
  }) => {
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
      useHelixStore.getState().showToast({
        type: 'error',
        title: '请填写名称、主机与端口',
      })
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

  const handleConnect = async (svc: {
    id: string
    name: string
    host: string
    port: number
  }) => {
    if (testingId) return
    setTestingId(svc.id)
    try {
      if (isElectron() && window.electron?.external) {
        const res = await window.electron.external.testConnection(svc.host, svc.port, 4000)
        if (!res.ok) {
          useHelixStore.getState().showToast({
            type: 'error',
            title: `连接 ${svc.name} 失败`,
            description: res.error,
          })
          return
        }
      }
      useHelixStore.getState().setExternalServiceConnected(svc.id, true)
      useHelixStore.getState().showToast({
        type: 'success',
        title: `已连接 ${svc.name}`,
      })
    } finally {
      setTestingId(null)
    }
  }

  const handleDisconnect = (svc: { id: string; name: string }) => {
    useHelixStore.getState().setExternalServiceConnected(svc.id, false)
  }

  const handleDelete = (svc: { id: string; name: string }) => {
    useHelixStore.getState().removeExternalService(svc.id)
  }

  // Calculate position relative to the anchor button
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  useLayoutEffect(() => {
    const updatePosition = () => {
      if (anchorRef.current) {
        const rect = anchorRef.current.getBoundingClientRect()
        setPosition({
          top: rect.top - 8, // 8px gap above button
          left: rect.left,
        })
      }
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRef])

  const content = (
    <div
      data-external-popover
      className="fixed w-80 bg-background/95 backdrop-blur-sm rounded-xl border border-border/30 shadow-lg shadow-black/8 z-[9999] flex flex-col max-h-96"
      style={{ top: position.top, left: position.left, transform: 'translateY(-100%)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 border-b border-border/20">
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/80">
          <Server className="size-4 text-sky-500" />
          外部服务
        </div>
        {mode === 'list' ? (
          <button
            type="button"
            onClick={openAdd}
            className="flex items-center gap-1 text-[12px] px-2 py-1 rounded-md text-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
            title="添加服务器 / 虚拟机"
          >
            <Plus className="size-3" />
            添加
          </button>
        ) : (
          <button
            type="button"
            onClick={() => { resetForm(); setMode('list') }}
            className="p-1 rounded-md text-foreground/50 hover:text-foreground hover:bg-accent/50 transition-colors"
            title="返回"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {mode === 'list' ? (
        <div className="flex-1 overflow-y-auto py-1 min-h-0">
          {externalServices.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
              还没有已连接的服务器 / 虚拟机
              <div className="mt-2">
                <button
                  type="button"
                  onClick={openAdd}
                  className="inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
                >
                  <Plus className="size-3" />
                  添加第一个
                </button>
              </div>
            </div>
          ) : (
            externalServices.map((svc) => (
              <div
                key={svc.id}
                className="px-3 py-2 border-b border-border/10 last:border-0 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Circle
                    className={`size-2.5 shrink-0 ${svc.connected ? 'fill-emerald-500 text-emerald-500' : 'fill-foreground/20 text-foreground/20'}`}
                  />
                  <span className="text-[13px] text-foreground/90 truncate flex-1">{svc.name}</span>
                  {testingId === svc.id ? (
                    <Loader2 className="size-3.5 animate-spin text-foreground/40" />
                  ) : svc.connected ? (
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
            ))
          )}
        </div>
      ) : (
        <div className="px-3 py-2.5 space-y-2.5">
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：生产服务器"
              className="w-full text-[12px] px-2 py-1.5 rounded-md bg-muted/40 border border-border/30 outline-none focus:border-primary/50"
            />
          </div>
          <div className="grid grid-cols-[1fr_64px] gap-2">
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">主机 / IP</label>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.10"
                className="w-full text-[12px] px-2 py-1.5 rounded-md bg-muted/40 border border-border/30 outline-none focus:border-primary/50"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">端口</label>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="22"
                className="w-full text-[12px] px-2 py-1.5 rounded-md bg-muted/40 border border-border/30 outline-none focus:border-primary/50"
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
              className="w-full text-[12px] px-2 py-1.5 rounded-md bg-muted/40 border border-border/30 outline-none focus:border-primary/50"
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
              className="w-full text-[12px] px-2 py-1.5 rounded-md bg-muted/40 border border-border/30 outline-none focus:border-primary/50 font-mono"
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
      )}
    </div>
  )

  // Use typeof check for SSR safety
  return typeof document !== 'undefined'
    ? createPortal(content, document.body)
    : content
}
