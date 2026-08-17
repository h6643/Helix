'use client'

import { Loader2, WifiOff, RefreshCw, Package, X, CheckCircle2 } from 'lucide-react'
import React, { useEffect, useState, useRef } from 'react'
import { useHelixStore } from '@/stores/helix-store'

/** Bootstrap stage reported by the Rust backend. */
type BootstrapStage = 'preparing' | 'done' | null

const STAGE_LABELS: Record<string, string> = {
  preparing: '正在准备 Hermes 运行环境...',
}

/**
 * BootOverlay — shown over the app while the Hermes gateway is connecting or
 * when it fails/disconnects, mirroring the official app's boot/connecting
 * surface with clear recovery semantics.
 *
 * Also handles first-run bootstrap progress (extracting bundled hermes-agent).
 */
export function BootOverlay() {
  const status = useHelixStore((s) => s.gatewayStatus)
  const setGatewayStatus = useHelixStore((s) => s.setGatewayStatus)
  const [bootstrapStage, setBootstrapStage] = useState<BootstrapStage>(null)
  const [bootstrapMessage, setBootstrapMessage] = useState('')
  const [isReady, setIsReady] = useState(false)
  const [isFadingOut, setIsFadingOut] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)

  // Handle fade-out animation when ready
  useEffect(() => {
    if (status === 'ready' && !isFadingOut) {
      setShowSuccess(true)
      setIsFadingOut(true)
      const timer = setTimeout(() => {
        setIsReady(true)
      }, 800) // Fade out duration
      return () => clearTimeout(timer)
    }
  }, [status, isFadingOut])

  // Listen for bootstrap progress events from the Rust backend.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    const setup = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen<{ method: string; params: { stage: string; message: string } }>(
          'hermes:event',
          (event) => {
            if (event.payload.method === 'bootstrap:progress') {
              const { stage, message } = event.payload.params
              if (stage === 'done') {
                setBootstrapStage('done')
                setBootstrapMessage('')
              } else {
                setBootstrapStage(stage as BootstrapStage)
                setBootstrapMessage(message)
              }
            }
          },
        )
      } catch {
        // Non-Tauri environment (dev server without backend) — silently ignore.
      }
    }
    void setup()
    return () => {
      unlisten?.()
    }
  }, [])

  const [dismissed, setDismissed] = useState(false)

  if (isReady || dismissed) return null

  const isConnecting = status === 'connecting'
  const isBootstrapping = bootstrapStage !== null && bootstrapStage !== 'done' && isConnecting

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
      if (n < 20) setTimeout(() => probe(n + 1), 1500)
    }
    probe()
  }

  return (
    <div
      className={`fixed bottom-4 right-4 z-[10000] w-80 rounded-xl border bg-card shadow-lg transition-all duration-500 ${
        isFadingOut ? 'opacity-0 translate-y-2 pointer-events-none' : 'opacity-100'
      }`}
    >
      <div className="p-4 text-center relative">
        {/* Close button */}
        <button
          onClick={() => setDismissed(true)}
          className="absolute top-2 right-2 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          data-tip="关闭"
        >
          <X className="size-3.5" />
        </button>

        <div className="mx-auto mb-3 w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          {isBootstrapping ? (
            <Package className="size-5 text-primary animate-pulse" />
          ) : isConnecting ? (
            <Loader2 className="size-5 text-primary animate-spin" />
          ) : (
            <WifiOff className="size-5 text-destructive" />
          )}
        </div>

        <h1 className="text-[length:var(--helix-transcript-size)] font-semibold mb-1">
          {isBootstrapping
            ? (STAGE_LABELS[bootstrapStage!] ?? bootstrapMessage)
            : isConnecting
              ? '正在连接 Hermes 网关…'
              : '无法连接到 Hermes 网关'}
        </h1>
        <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground leading-relaxed">
          {isBootstrapping
            ? '首次启动需要安装运行环境，请耐心等待。'
            : isConnecting
              ? '正在启动 Hermes Agent，请稍候。'
              : '网关未运行或已断开。'}
        </p>

        {!isConnecting && (
          <button
            onClick={retry}
            className="mt-3 mx-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[calc(var(--helix-transcript-size)*0.8571)] font-medium hover:bg-primary/90 transition-colors"
          >
            <RefreshCw className="size-3" />
            重试连接
          </button>
        )}

        {/* Bootstrap progress bar */}
        {isBootstrapping && bootstrapStage && (
          <div className="mt-3 w-full bg-muted rounded-full h-1 overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-700"
              style={{
                width: bootstrapStage === 'preparing' ? '50%' : '100%',
              }}
            />
          </div>
        )}

        {/* Success animation */}
        {showSuccess && (
          <div className="mt-3 flex items-center justify-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-green-500">
            <CheckCircle2 className="size-3.5" />
            启动成功
          </div>
        )}
      </div>
    </div>
  )
}
