'use client'

import React from 'react'
import { useHelixStore } from '@/stores/helix-store'

export function ConnectionNotice() {
  const connectionNotice = useHelixStore(s => s.connectionNotice)

  if (!connectionNotice) return null

  return (
    <div
      className="fixed top-10 left-1/2 -translate-x-1/2 z-[55] max-w-lg w-[calc(100%-2rem)] px-3 py-2.5 rounded-xl text-[calc(var(--helix-transcript-size)*0.8571)] flex items-center gap-2 border cursor-pointer hover:opacity-80 transition-all duration-200 shadow-sm"
      style={{
        backgroundColor: connectionNotice.phase === 'recovered'
          ? 'oklch(0.65 0.15 145 / 0.1)'
          : 'oklch(0.70 0.15 65 / 0.1)',
        borderColor: connectionNotice.phase === 'recovered'
          ? 'oklch(0.65 0.15 145 / 0.25)'
          : 'oklch(0.70 0.15 65 / 0.25)',
        color: connectionNotice.phase === 'recovered'
          ? 'oklch(0.65 0.15 145)'
          : 'oklch(0.70 0.15 65)',
      }}
      onClick={() => useHelixStore.getState().setConnectionNotice(null)}
    >
      {connectionNotice.phase !== 'recovered' && (
        <div className="animate-spin size-3 border-2 border-current border-t-transparent rounded-full shrink-0" />
      )}
      <span className="flex-1 truncate">{connectionNotice.message}</span>
      <span className="text-[calc(var(--helix-transcript-size)*0.7143)] opacity-60 shrink-0">点击关闭</span>
    </div>
  )
}
