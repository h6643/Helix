// 在应用顶层调用一次，从 localStorage 水合 Provider 配置。
'use client'

import { useEffect } from 'react'
import { useProviderStore } from './provider-store'

export function useProviderHydration() {
  const hydrate = useProviderStore((s) => s.hydrate)
  const hydrated = useProviderStore((s) => s.hydrated)
  useEffect(() => {
    if (!hydrated) void hydrate()
  }, [hydrated, hydrate])
}
