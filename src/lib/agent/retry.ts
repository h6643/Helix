export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  retryOn?: (error: unknown) => boolean
}

export function defaultRetryPolicy(): RetryPolicy {
  return {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
  }
}

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const ms = parseInt(header, 10)
  if (!isNaN(ms)) return ms
  // HTTP-date format: try parsing as seconds-until
  const seconds = parseInt(header, 10)
  return isNaN(seconds) ? null : seconds * 1000
}

export function extractRetryDelayFromError(err: unknown): number | null {
  if (err instanceof Error) {
    const match = err.message.match(/retry-after:\s*(\d+)/i)
    if (match) return parseInt(match[1], 10)
  }
  return null
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let lastError: unknown
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    try {
      return { ok: true, value: await fn() }
    } catch (err) {
      lastError = err
      if (policy.retryOn && !policy.retryOn(err)) break
      if (attempt < policy.maxAttempts - 1) {
        const retryAfter = extractRetryDelayFromError(err)
        const delay = retryAfter ?? Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  return { ok: false, error: lastError }
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryPolicy>,
): Promise<T> {
  const policy = { ...defaultRetryPolicy(), ...options }
  const result = await withRetry(fn, policy)
  if (!result.ok) throw result.error
  return result.value
}
