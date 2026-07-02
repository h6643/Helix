/**
 * Command policy engine for Agent bash execution.
 * Configurable allowlist/blocklist and command constraints.
 */

export interface CommandPolicy {
  blockedPatterns: RegExp[]
  maxPipes: number
  maxCommandLength: number
  allowCommandSubstitution: boolean
}

const DEFAULT_POLICY: CommandPolicy = {
  blockedPatterns: [
    /\brm\s+(-[rRf]+\s+|--recursive)/,
    /\bmkfs\b/,
    /\bdd\s+if=/,
    /\bcurl\b.*\|\s*(ba)?sh/,
    /\bwget\b.*\|\s*(ba)?sh/,
    /\bchmod\s+777\b/,
    /\bsudo\b/,
    /\bkill\s+-9/,
    />\s*\/dev\/sd/,
    /\bmount\b/,
    /\bnc\s+-l/,
    /\bbash\s+-i/,
  ],
  maxPipes: 2,
  maxCommandLength: 1000,
  allowCommandSubstitution: false,
}

export function validateCommand(cmd: string, policy: CommandPolicy = DEFAULT_POLICY): { ok: boolean; reason?: string } {
  const trimmed = cmd.trim()
  
  // Check command length
  if (trimmed.length > policy.maxCommandLength) {
    return { ok: false, reason: 'command too long' }
  }
  
  // Check blocked patterns
  for (const pattern of policy.blockedPatterns) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: `blocked: ${pattern.source}` }
    }
  }
  
  // Check command substitution
  if (!policy.allowCommandSubstitution) {
    if (/\$\(.*\)/.test(trimmed) || /`[^`]+`/.test(trimmed)) {
      return { ok: false, reason: 'command substitution forbidden' }
    }
  }
  
  // Check pipe count
  if ((trimmed.match(/\|/g) || []).length > policy.maxPipes) {
    return { ok: false, reason: 'too many pipes' }
  }
  
  return { ok: true }
}