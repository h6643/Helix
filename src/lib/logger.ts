/**
 * Debug logger — only outputs in development builds or when HELIX_DEBUG=1.
 * Usage: import { debug, warn } from '@/lib/logger'; debug('msg', data)
 */
const enabled = typeof process !== 'undefined' && (
  process.env.NODE_ENV === 'development' ||
  process.env.HELIX_DEBUG === '1' ||
  process.env.NEXT_PUBLIC_HELIX_DEBUG === '1'
)

export function debug(...args: unknown[]) {
  if (enabled) console.log('[helix]', ...args)
}

export function warn(...args: unknown[]) {
  if (enabled) console.warn('[helix]', ...args)
}

export function error(...args: unknown[]) {
  // Always log errors — even in production
  console.error('[helix]', ...args)
}
