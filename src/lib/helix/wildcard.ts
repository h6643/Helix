export function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === '*') return true
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  )
  return regex.test(value)
}
