/**
 * Formatting utility functions
 */

/**
 * Format timestamp to relative time string (Chinese format)
 */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

/**
 * Format timestamp to compact Chinese relative time (matches WorkBuddy sidebar)
 */
export function timeAgoCompact(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  const weeks = Math.floor(days / 7)
  const months = Math.floor(days / 30)
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${minutes}分`
  if (diff < 86400000) return `${hours}小时`
  if (days < 7) return `${days}天`
  if (months < 1) return `${weeks}周`
  return `${months}月`
}

/**
 * Generate a random ID
 */
export function generateId(): string {
  return Math.random().toString(36).substr(2, 9)
}

/**
 * Format token count for display (e.g. 1500 -> "1.5K", 2000000 -> "2.0M")
 */
export function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return n.toLocaleString()
}