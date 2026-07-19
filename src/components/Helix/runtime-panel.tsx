'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { X, ShieldCheck, Server, RefreshCw, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { isElectron } from '@/lib/electron-bridge'

interface DiagStatus {
  gatewayRunning: boolean
  gatewayStartedAt: number
  runtimeVersion: string
  signatureStatus: string
  signatureDetail: string
  platform: string
  electronVersion: string
  nodeVersion: string
  uptime: number
}

export function RuntimePanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<DiagStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!isElectron() || !(window as any).electron?.diagnostics) return
    try {
      const s = await (window as any).electron.diagnostics.getStatus()
      setStatus(s)
    } catch (e) {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 2000)
    return () => clearInterval(id)
  }, [refresh])

  const fmtUptime = (ms: number) => {
    if (!ms || ms < 0) return '—'
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`
  }

  return (
    <div className="h-full w-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" />
          <h1 className="text-xl font-semibold text-foreground">运行时与安全</h1>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
          title="关闭"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
          {loading && !status ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            <>
              {/* Status cards */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border/50 bg-card/50 p-4">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <Server className="size-3.5" /> Gateway 状态
                  </div>
                  <div className="flex items-center gap-2">
                    {status?.gatewayRunning ? (
                      <CheckCircle2 className="size-4 text-emerald-500" />
                    ) : (
                      <XCircle className="size-4 text-muted-foreground" />
                    )}
                    <span className="text-sm font-medium text-foreground">
                      {status?.gatewayRunning ? '运行中' : '未连接'}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground/70 mt-1">运行时长 {fmtUptime(status?.uptime || 0)}</p>
                </div>

                <div className="rounded-xl border border-border/50 bg-card/50 p-4">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <ShieldCheck className="size-3.5" /> 内核签名校验
                  </div>
                  <div className="flex items-center gap-2">
                    {status?.signatureStatus === 'verified' ? (
                      <CheckCircle2 className="size-4 text-emerald-500" />
                    ) : (
                      <XCircle className="size-4 text-amber-500" />
                    )}
                    <span className="text-sm font-medium text-foreground">
                      {status?.signatureStatus === 'verified' ? '已校验' : '未校验'}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground/70 mt-1 truncate">{status?.signatureDetail}</p>
                </div>

                <div className="rounded-xl border border-border/50 bg-card/50 p-4">
                  <div className="text-xs text-muted-foreground mb-1">运行时版本</div>
                  <p className="text-sm font-medium text-foreground">{status?.runtimeVersion || '—'}</p>
                  <p className="text-[11px] text-muted-foreground/70 mt-1">Electron {status?.electronVersion} · Node {status?.nodeVersion}</p>
                </div>

                <div className="rounded-xl border border-border/50 bg-card/50 p-4">
                  <div className="text-xs text-muted-foreground mb-1">平台</div>
                  <p className="text-sm font-medium text-foreground capitalize">{status?.platform || '—'}</p>
                  <p className="text-[11px] text-muted-foreground/70 mt-1">托管运行时通道</p>
                </div>
              </div>

              {/* Refresh button */}
              <div className="flex items-center gap-2">
                <button
                  onClick={refresh}
                  className="px-3 py-1.5 text-xs rounded-lg border border-border/50 hover:bg-muted/50 transition-colors flex items-center gap-1.5"
                >
                  <RefreshCw className="size-3.5" /> 刷新状态
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
