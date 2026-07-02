/**
 * Resource limits for Agent execution.
 * Semaphore for concurrent request control.
 */

const semaphore = {
  current: 0,
  max: 5, // Maximum concurrent requests
  queue: [] as Array<() => void>,
}

export async function acquire(): Promise<void> {
  if (semaphore.current < semaphore.max) {
    semaphore.current++
    return
  }
  
  return new Promise((resolve) => {
    semaphore.queue.push(() => {
      semaphore.current++
      resolve()
    })
  })
}

export function release(): void {
  semaphore.current--
  if (semaphore.queue.length > 0) {
    const next = semaphore.queue.shift()
    next?.()
  }
}