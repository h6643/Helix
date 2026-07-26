'use client'

import React from 'react'
import { Loader2, WifiOff, AlertTriangle, RefreshCw } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'

/**
 * BootOverlay — shown over the app while the Hermes gateway is connecting or
 * when it fails/disconnects, mirroring the official app's boot/connecting
 * surface with clear recovery semantics.
 */
export function BootOverlay() {
  const status = useHelixStore((s) => s.gatewayStatus)
  const setGatewayStatus = useHelixStore((s) => s.setGatewayStatus)

  if (status === 'ready') return null

  const isConnecting = status === 'connecting'

  const retry = () => {
    setGatewayStatus('connecting')
    const hermes = (window as any).electron?.hermes
    const probe = async (n = 0) => {
      try {
        const st = await hermes?.status?.()
        if (st?.connected) {
          useHelixStore.getState().setGatewayStatus('ready')
          return
        }
      } catch {}
      if (n < 12) setTimeout(() => probe(n + 1), 1500)
    }
    probe()
  }

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="w-full max-w-sm text-center px-6">
        <div className="mx-auto mb-5 w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
          {isConnecting ? (
            <Loader2 className="size-7 text-primary animate-spin" />
          ) : (
            <WifiOff className="size-7 text-destructive" />
          )}
        </div>

        <h1 className="text-base font-semibold mb-1.5">
          {isConnecting ? '正在连接 Hermes 网关…' : '无法连接到 Hermes 网关'}
        </h1>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {isConnecting
            ? 'Helix 正在启动本地 Hermes Agent 运行时，请稍候。'
            : '网关未运行或已断开。请确认 Hermes 服务已启动，然后重试。'}
        </p>

        {!isConnecting && (
          <button
            onClick={retry}
            className="mt-5 mx-auto inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            <RefreshCw className="size-3.5" />
            重试连接
          </button>
        )}

        <div className="mt-6 flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground/50">
          <AlertTriangle className="size-3" />
          {isConnecting ? '首次启动可能需要几秒钟' : '检查 %LOCALAPPDATA%\\hermes 下的日志'}
        </div>
      </div>
    </div>
  )
}
