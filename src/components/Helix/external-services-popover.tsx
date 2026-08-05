'use client'

import { useState, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Server, Circle, Loader2, Settings2 } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { isElectron } from '@/lib/electron-bridge'

// Slim selector shown from the breadcrumb: pick a configured server to
// connect/disconnect. Full add/edit/delete lives in Settings › 常规.
export function ExternalServicesPopover({
  onClose,
  anchorRef,
}: {
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}) {
  const externalServices = useHelixStore((s) => s.externalServices)
  const [testingId, setTestingId] = useState<string | null>(null)

  // Calculate position relative to the anchor button
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  useLayoutEffect(() => {
    const updatePosition = () => {
      if (anchorRef.current) {
        const rect = anchorRef.current.getBoundingClientRect()
        setPosition({ top: rect.top - 8, left: rect.left })
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

  const handleConnect = async (svc: { id: string; name: string; host: string; port: number }) => {
    if (testingId) return
    setTestingId(svc.id)
    try {
      if (isElectron() && window.electron?.external) {
        const res = await window.electron.external.testConnection(svc.host, svc.port, 4000)
        if (!res.ok) {
          useHelixStore.getState().showToast({ type: 'error', title: `连接 ${svc.name} 失败`, description: res.error })
          return
        }
      }
      useHelixStore.getState().setExternalServiceConnected(svc.id, true)
      useHelixStore.getState().showToast({ type: 'success', title: `已连接 ${svc.name}` })
    } finally {
      setTestingId(null)
    }
  }

  const openManager = () => {
    onClose()
    useHelixStore.getState().toggleSettings('general')
  }

  const content = (
    <div
      data-external-popover
      className="fixed w-72 bg-background/95 backdrop-blur-sm rounded-xl border border-border/30 shadow-lg shadow-black/8 z-[9999] flex flex-col max-h-80"
      style={{ top: position.top, left: position.left, transform: 'translateY(-100%)' }}
    >
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 border-b border-border/20">
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/80">
          <Server className="size-4 text-sky-500" />
          外部服务
        </div>
        <button
          type="button"
          onClick={openManager}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md text-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
          title="在设置中管理服务器"
        >
          <Settings2 className="size-3" />
          管理
        </button>
      </div>

      {externalServices.length === 0 ? (
        <div className="px-3 py-5 text-center text-[12px] text-muted-foreground">
          还没有已配置的服务器
          <div className="mt-2">
            <button
              type="button"
              onClick={openManager}
              className="inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
            >
              去设置中添加
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto py-1 min-h-0">
          {externalServices.map((svc) => (
            <div key={svc.id} className="px-3 py-2 border-b border-border/10 last:border-0 hover:bg-muted/30 transition-colors">
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
                    onClick={() => useHelixStore.getState().setExternalServiceConnected(svc.id, false)}
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
              <div className="pl-4 mt-0.5 text-[11px] text-muted-foreground truncate">
                {svc.username ? `${svc.username}@` : ''}{svc.host}:{svc.port}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(content, document.body) : content
}
