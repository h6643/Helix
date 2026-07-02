/**
 * Working directory isolation for Agent operations.
 * Uses AsyncLocalStorage for request-scoped isolation.
 */

import path from 'path'
import fs from 'fs'
import { AsyncLocalStorage } from 'async_hooks'

interface RequestContext {
  workDir: string
  requestId: string
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>()

/**
 * Create a request context (returns requestId for cleanup)
 */
export function createRequestContext(workDir: string): string {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return requestId
}

/**
 * Run a function within a request context
 */
export function runWithContext<T>(requestId: string, workDir: string, fn: () => T): T {
  return asyncLocalStorage.run({ workDir: path.resolve(workDir), requestId }, fn)
}

/**
 * Get the working directory for the current request
 */
export function getWorkDir(): string {
  const ctx = asyncLocalStorage.getStore()
  return ctx?.workDir ?? process.cwd()
}

/**
 * Resolve a path relative to the working directory.
 * Returns null if the resolved path escapes the working directory.
 * Also checks for symlink escapes.
 */
export function safePath(filePath: string): string | null {
  const workDir = getWorkDir()
  const resolved = path.resolve(workDir, filePath)
  if (!resolved.startsWith(workDir)) {
    return null
  }
  
  // Check for symlink escapes
  try {
    const realResolved = fs.realpathSync(resolved)
    const realWorkDir = fs.realpathSync(workDir)
    return realResolved.startsWith(realWorkDir) ? realResolved : null
  } catch {
    // Path doesn't exist yet - prefix check is sufficient
    return resolved
  }
}

/**
 * Check if a path is within the working directory.
 */
export function isWithinWorkDir(filePath: string): boolean {
  return safePath(filePath) !== null
}

/**
 * Get relative path from work directory.
 */
export function relativePath(filePath: string): string {
  const workDir = getWorkDir()
  return path.relative(workDir, filePath)
}