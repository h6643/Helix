/**
 * Permission system ported from Helix's permission.ts
 * Evaluates tool actions against rulesets with wildcard matching
 * Supports: allow, deny, ask (require user approval)
 */

import { wildcardMatch } from './wildcard'

export interface PermissionRule {
  action: string
  resource: string
  effect: 'allow' | 'deny' | 'ask'
}

export type PermissionRuleset = PermissionRule[]

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  metadata?: Record<string, unknown>
  source?: string
}

export interface PermissionEvaluation {
  effect: 'allow' | 'deny' | 'ask'
  rule?: PermissionRule
}

const DEFAULT_RULESET: PermissionRuleset = [
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'write', resource: '*', effect: 'allow' },
  { action: 'edit', resource: '*', effect: 'allow' },
  { action: 'bash', resource: '*', effect: 'allow' },
  { action: 'glob', resource: '*', effect: 'allow' },
  { action: 'grep', resource: '*', effect: 'allow' },
  { action: 'list_directory', resource: '*', effect: 'allow' },
  { action: 'webfetch', resource: '*', effect: 'allow' },
  { action: 'question', resource: '*', effect: 'ask' },
  { action: 'todowrite', resource: '*', effect: 'allow' },
  { action: 'skill', resource: '*', effect: 'allow' },
]

export function evaluatePermission(
  action: string,
  resource: string,
  ...rulesets: PermissionRuleset[]
): PermissionEvaluation {
  const allRules = rulesets.flat()
  const matchedRule = allRules.findLast(
    rule => wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource),
  )
  if (!matchedRule) {
    return { effect: 'ask' }
  }
  return { effect: matchedRule.effect, rule: matchedRule }
}

export function mergeRulesets(...rulesets: PermissionRuleset[]): PermissionRuleset {
  return rulesets.flat()
}

export function agentPermission(action: string, resource: string, customRules?: PermissionRuleset): PermissionEvaluation {
  return evaluatePermission(action, resource, DEFAULT_RULESET, customRules ?? [])
}
