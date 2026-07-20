'use client'

import { useEffect, useRef } from 'react'
import { useHelixStore } from '@/stores/helix-store'

const GITHUB_REPO = 'NousResearch/hermes-agent'
const CHECK_KEY = 'update-checked-v1'

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
  const checkedRef = useRef(false)

  useEffect(() => {
    if (checkedRef.current) return
    checkedRef.current = true

    // Avoid re-checking in the same session
    if (sessionStorage.getItem(CHECK_KEY)) return

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
          sessionStorage.setItem(CHECK_KEY, '1')
          const state = useHelixStore.getState()
          state.showToast({
            type: 'info',
            title: '有新版本可用',
            description: `v${latestTag} 已发布，点击查看`,
            duration: 8000,
            onClick: () => window.open(`https://github.com/${GITHUB_REPO}/releases/latest`, '_blank'),
          })
          // Store in state so user can see it later
          state.setPendingUpdate?.(latestTag)
        }
      } catch {
        // Silent fail — network errors should not disrupt the user
      }
    }
    // Delay check to not block startup
    const timer = setTimeout(check, 5000)
    return () => clearTimeout(timer)
  }, [])
}
