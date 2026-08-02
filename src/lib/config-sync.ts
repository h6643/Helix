/**
 * Config sync — live push via config.set IPC (no gateway restart).
 *
 * Unlike the old approach (write config.yaml → restart gateway), this module
 * pushes config changes via the gateway's config.set RPC, which applies
 * changes to the live session without restart.
 *
 * Model/provider changes still go through setModel + session recreation
 * (because the backend snapshots credentials at session creation time).
 */

'use client'

import { isElectron } from '@/lib/electron-bridge'
import { isServeActive, getServeClient, getGatewayMode, initServeGateway } from '@/lib/serve-gateway'

type ConfigValue = string | number | boolean | null | undefined

let pushCooldown: ReturnType<typeof setTimeout> | null = null
let lastPushJson = ''

/**
 * Push a config key/value pair to the Hermes backend in real-time.
 * No gateway restart required — takes effect on the next prompt.
 */
export function pushConfigKeyValue(key: string, value: ConfigValue, sessionId?: string) {
  if (!isElectron()) return
  const serve = isServeActive() ? getServeClient() : null
  const hermes = window.electron?.hermes as any
  if (!serve && !hermes?.setConfigKeyValue) return

  const payload = { key, value, session_id: sessionId }
  const json = JSON.stringify(payload)
  if (json === lastPushJson) return
  lastPushJson = json

  // Debounce rapid changes (e.g. slider drag)
  if (pushCooldown) clearTimeout(pushCooldown)
  pushCooldown = setTimeout(() => {
    pushCooldown = null
    if (serve) {
      // serve 模式：官方 WS config.set，live 生效，无需重启网关
      serve.rpc('config.set', { key, value, session_id: sessionId }).catch(() => {})
    } else {
      hermes.setConfigKeyValue({ key, value, session_id: sessionId }).catch(() => {})
    }
  }, 150)
}

/**
 * Push model/provider config to the backend.
 * This writes config.yaml AND may trigger gateway restart (model switch
 * requires session recreation with new credentials).
 */
export function pushModelConfig(payload: {
  model?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
}) {
  if (!isElectron()) return
  const hasModelPayload = !!(payload.model || payload.baseUrl || payload.apiKey || payload.provider)

  // 按"模式"分流，而不是按"连接状态"（isServeActive）分流。
  // 关键竞态：App 启动时 helix-layout 立即调本函数，此刻 serve 还在冷启动、
  // WS 未连上 → isServeActive()===false → 若据此落 IPC，会触发
  // hermes:setConfig 直写 config.yaml（原样写入私有 provider 名）并
  // restartGatewayDebounced 杀掉 serve → 新实例读坏配置 → agent 构建 30s 超时。
  // getGatewayMode 从第一秒起就能拿到真实模式（pending 也返回 mode），
  // serve 模式下等网关就绪后走 REST，绝不落 IPC。
  void (async () => {
    const mode = await getGatewayMode()
    if (mode === 'serve') {
      if (!hasModelPayload) return
      try {
        const c = isServeActive() ? getServeClient() : await initServeGateway()
        if (!c) {
          console.warn('[config-sync] serve 网关不可用，模型配置推送跳过（将由建会话预同步兜底）')
          return
        }
        await c.setModel({
          model: payload.model || '',
          provider: payload.provider,
          baseUrl: payload.baseUrl,
          apiKey: payload.apiKey,
        })
      } catch (e) {
        console.warn('[config-sync] serve setModel 失败（不回落 IPC）:', e)
      }
      return
    }
    pushModelConfigViaIpc(payload, hasModelPayload)
  })()
}

/** acp 模式的原有链路：冷启动缓存 + IPC setConfig（会写 config.yaml 并重启网关） */
function pushModelConfigViaIpc(
  payload: { model?: string; provider?: string; baseUrl?: string; apiKey?: string },
  hasModelPayload: boolean,
) {
  const hermes = window.electron?.hermes
  const profile = window.electron?.profile
  if (!hasModelPayload) return

  try {
    if (profile?.cacheConfig && (payload.model || payload.baseUrl || payload.apiKey || payload.provider)) {
      profile.cacheConfig({
        model: payload.model,
        provider: payload.provider,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
      })
    }
  } catch {}
  try {
    if (hermes?.setConfig && (payload.model || payload.baseUrl || payload.apiKey || payload.provider)) {
      hermes.setConfig({
        model: payload.model,
        provider: payload.provider,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
      })
    }
  } catch {}
}

/**
 * Push agent config (personality, reasoning effort, etc.) via live config.set.
 * These take effect immediately without gateway restart.
 */
export function pushAgentConfigLive(payload: {
  personality?: string
  reasoningEffort?: string
  fastMode?: boolean
}) {
  if (!isElectron()) return
  const hermes = window.electron?.hermes as any
  if (!isServeActive() && !hermes?.setConfigKeyValue) return

  if (payload.personality !== undefined) {
    pushConfigKeyValue('display.personality', payload.personality)
  }
  if (payload.reasoningEffort !== undefined) {
    pushConfigKeyValue('agent.reasoning_effort', payload.reasoningEffort)
  }
  if (payload.fastMode !== undefined) {
    pushConfigKeyValue('agent.service_tier', payload.fastMode ? 'fast' : 'default')
  }
}
