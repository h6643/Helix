/**
 * Rate limiting for Agent API endpoints.
 * Sliding window counter per IP address.
 */

interface RateLimitEntry {
  count: number
  resetAt: number
}

const requests = new Map<string, RateLimitEntry>()
const WINDOW_MS = 60 * 1000 // 1 minute
const MAX_REQUESTS = 30

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of requests.entries()) {
    if (entry.resetAt < now) requests.delete(key)
  }
}, 5 * 60 * 1000)

export function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const entry = requests.get(ip)
  
  if (!entry || entry.resetAt < now) {
    requests.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return { allowed: true }
  }
  
  if (entry.count >= MAX_REQUESTS) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) }
  }
  
  entry.count++
  return { allowed: true }
}