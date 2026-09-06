'use client'

import { useEffect } from 'react'
import { useHelixStore } from '@/stores/helix-store'

const GITHUB_REPO = 'h6643/Helix'
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

export async function getCurrentVersion(): Promise<string | null> {
  // 对比 Helix 应用自身版本（来自 get_info），而非 helix 后端版本
  try {
    const info = await (window as any).electron?.app?.getInfo?.()
    const v = info?.version
    if (v) return String(v)
  } catch {}
  return null // 无法获取应用版本 — 跳过更新检查
}

export function useCheckUpdate() {
  useEffect(() => {
    if (checked) return
    checked = true

    const check = async () => {
      try {
        const [currentVer, res] = await Promise.all([
          getCurrentVersion(),
          fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
            signal: AbortSignal.timeout(8000),
          }),
        ])
        if (!res.ok) return
        const data = await res.json()
        const latestTag = (data.tag_name || data.name || '').replace(/^v/i, '')

        if (currentVer && latestTag && isNewer(currentVer, latestTag)) {
          const state = useHelixStore.getState()
          state.showToast({
            type: 'info',
            title: '有新版本可用',
            description: `v${latestTag} 已发布`,
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
