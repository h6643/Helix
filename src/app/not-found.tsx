'use client'

import React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

export default function NotFound() {
  const router = useRouter()

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-background">
      <div className="text-center">
        <p className="text-6xl font-bold text-foreground/20 mb-4">404</p>
        <h1 className="text-xl font-semibold text-foreground mb-2">页面未找到</h1>
        <p className="text-sm text-muted-foreground mb-6">你访问的页面不存在</p>
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors text-sm font-medium"
        >
          <ArrowLeft className="size-4" />
          返回
        </button>
      </div>
    </div>
  )
}
