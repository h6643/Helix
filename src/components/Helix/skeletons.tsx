/**
 * Skeleton loading components
 */

import React from 'react'

export function ChatSkeleton() {
  return (
    <div className="space-y-4 p-4">
      {[1, 2, 3].map(i => (
        <div key={i} className="flex gap-3 animate-pulse">
          <div className="w-5 h-5 rounded-lg bg-muted shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-16 bg-muted rounded" />
            <div className="h-3 w-3/4 bg-muted rounded" />
            <div className="h-3 w-1/2 bg-muted rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function FileTreeSkeleton() {
  return (
    <div className="p-2 space-y-1">
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="flex items-center gap-2 px-2 py-1 animate-pulse">
          <div className="w-4 h-4 bg-muted rounded" />
          <div className="h-3 bg-muted rounded" style={{ width: `${60 + Math.random() * 40}%` }} />
        </div>
      ))}
    </div>
  )
}

export function SidebarSkeleton() {
  return (
    <div className="p-4 space-y-4">
      <div className="h-8 bg-muted rounded animate-pulse" />
      <div className="space-y-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-10 bg-muted rounded animate-pulse" />
        ))}
      </div>
    </div>
  )
}