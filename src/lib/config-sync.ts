/**
 * Centralized config sync with dedup + cooldown.
 *
 * Callers push "desired backend config" into this module. It batches duplicate
 * requests within `cooldownMs` and issues at most one `setConfig` / `setAgentConfig`
 * IPC per cooling window, reducing unnecessary gateway restarts.
 */

'use client'

import { isElectron } from '@/lib/electron-bridge'

type PushPayload = {
  model?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
  temperature?: number
  maxOutputTokens?: number
  customInstructions?: string
  personality?: string
}

let gatewayRestartCooldown: ReturnType<typeof setTimeout> | null = null
let pendingPush: PushPayload | null = null
let lastPushJson = ''

export function scheduleConfigPush(payload: PushPayload, cooldownMs = 1200) {
  const nextJson = JSON.stringify(payload)
  if (nextJson === lastPushJson) {
    return
  }
  lastPushJson = nextJson
  pendingPush = payload
  if (gatewayRestartCooldown) clearTimeout(gatewayRestartCooldown)
  gatewayRestartCooldown = setTimeout(flushConfigPush, cooldownMs)
}

export async function flushConfigPush() {
  if (!pendingPush) return
  const payload = pendingPush
  pendingPush = null
  gatewayRestartCooldown = null
  if (!isElectron()) return
  const hermes = window.electron?.hermes
  const profile = window.electron?.profile
  if (!hermes && !profile) return
  try {
    if (profile?.cacheConfig && (payload.model || payload.baseUrl || payload.apiKey || payload.provider)) {
      await profile.cacheConfig({
        model: payload.model,
        provider: payload.provider,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
      })
    }
  } catch {}
  try {
    if (hermes?.setConfig && (payload.model || payload.baseUrl || payload.apiKey || payload.provider)) {
      await hermes.setConfig({
        model: payload.model,
        provider: payload.provider,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
      })
    }
  } catch {}
  try {
    if (hermes?.setAgentConfig && (payload.temperature !== undefined || payload.maxOutputTokens !== undefined || payload.customInstructions !== undefined || payload.personality !== undefined)) {
      await hermes.setAgentConfig({
        temperature: payload.temperature,
        maxOutputTokens: payload.maxOutputTokens,
        customInstructions: payload.customInstructions,
        personality: payload.personality,
      })
    }
  } catch {}
}

export function resetConfigSync() {
  if (gatewayRestartCooldown) clearTimeout(gatewayRestartCooldown)
  gatewayRestartCooldown = null
  pendingPush = null
  lastPushJson = ''
}
