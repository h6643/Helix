'use client'

import { useEffect } from 'react'
import { useHelixStore } from '@/stores/helix-store'

const GITHUB_REPO = 'NousResearch/hermes-agent'

// Module-level flag ensures the check runs at most ONCE per page load,
// even if the component unmounts and remounts.
let checked = false

function parseVersion(ver: string): number[] {
  return ver.replace(/^v/i, '').split('.').map(Number)
}

function isNewer(current: string, latest: string): boolean {
  const cur = parseVersion(current)
  const lat = parseVersion(latest)
  for (let i = 0; i < Math.max(cur.length, lat.length); i++) {
    const a = cur[i] || 0
    const b = lat[i] || 0
    if (b > a) return true
    if (b < a) return false
  }
  return false
}

export function useCheckUpdate() {
  useEffect(() => {
    if (checked) return
    checked = true

    const check = async () => {
      try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) return
        const data = await res.json()
        const latestTag = (data.tag_name || data.name || '').replace(/^v/i, '')
        const currentVer = '0.2.0'

        if (latestTag && isNewer(currentVer, latestTag)) {
          const state = useHelixStore.getState()
          state.showToast({
            type: 'info',
            title: '有新版本可用',
            description: `v${latestTag} 已发布，点击查看`,
            duration: 8000,
            onClick: () => window.open(`https://github.com/${GITHUB_REPO}/releases/latest`, '_blank'),
          })
          state.setPendingUpdate?.(latestTag)
        }
      } catch {
        // Silent fail
      }
    }

    const timer = setTimeout(check, 5000)
    return () => clearTimeout(timer)
  }, [])
}
