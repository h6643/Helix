'use client'

import React, { useEffect, useState } from 'react'
import { Check, X, AlertTriangle, Info, XCircle } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'

function ToastIcon({ type }: { type: string }) {
  switch (type) {
    case 'success': return <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0"><Check className="size-3 text-emerald-400" /></div>
    case 'error': return <div className="w-5 h-5 rounded-full bg-red-500/20 flex items-center justify-center shrink-0"><XCircle className="size-3 text-red-400" /></div>
    case 'warning': return <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0"><AlertTriangle className="size-3 text-amber-400" /></div>
    default: return <div className="w-5 h-5 rounded-full bg-blue-500/20 flex items-center justify-center shrink-0"><Info className="size-3 text-blue-400" /></div>
  }
}

export function ToastContainer() {
  const { toasts, dismissToast } = useHelixStore()
  const [exiting, setExiting] = useState<Set<string>>(new Set())

  const handleClose = (id: string) => {
    setExiting(prev => new Set(prev).add(id))
    setTimeout(() => {
      dismissToast(id)
      setExiting(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, 200)
  }

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-10 right-4 z-[60] flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-start gap-3 bg-card border border-border rounded-xl shadow-lg px-4 py-3 backdrop-blur-sm transition-all duration-200 ${
            exiting.has(toast.id) ? 'opacity-0 translate-x-2 scale-95' : 'opacity-100 translate-x-0 scale-100'
          }`}
        >
          <ToastIcon type={toast.type} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{toast.title}</p>
            {toast.description && (
              <p className="text-xs text-muted-foreground mt-0.5">{toast.description}</p>
            )}
          </div>
          <button
            onClick={() => handleClose(toast.id)}
            className="p-0.5 hover:bg-accent rounded shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}