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

"use client";

import { isElectron } from "@/lib/electron-bridge";

type ConfigValue = string | number | boolean | null | undefined;

let pushCooldown: ReturnType<typeof setTimeout> | null = null;
let lastPushJson = "";

/**
 * Push a config key/value pair to the Helix backend in real-time.
 * No gateway restart required — takes effect on the next prompt.
 */
export function pushConfigKeyValue(
  key: string,
  value: ConfigValue,
  sessionId?: string,
) {
  // Tauri mode: use tauri bridge via window.electron.helix
  if (!isElectron()) {
    const helix = window.electron?.helix;
    if (helix?.setConfigKeyValue) {
      const payload = { key, value, session_id: sessionId };
      const json = JSON.stringify(payload);
      if (json === lastPushJson) return;
      lastPushJson = json;

      if (pushCooldown) clearTimeout(pushCooldown);
      pushCooldown = setTimeout(() => {
        pushCooldown = null;
        helix.setConfigKeyValue(payload).catch(() => {});
      }, 150);
    }
    return;
  }

  const helix = window.electron?.helix;
  if (!helix?.setConfigKeyValue) return;

  const payload = { key, value, session_id: sessionId };
  const json = JSON.stringify(payload);
  if (json === lastPushJson) return;
  lastPushJson = json;

  // Debounce rapid changes (e.g. slider drag)
  if (pushCooldown) clearTimeout(pushCooldown);
  pushCooldown = setTimeout(() => {
    pushCooldown = null;
    helix
      .setConfigKeyValue({ key, value, session_id: sessionId })
      .catch(() => {});
  }, 150);
}

/**
 * Push model/provider config to the backend.
 * This writes config.yaml AND may trigger gateway restart (model switch
 * requires session creation with new credentials).
 *
 * The apiKey is deliberately NOT forwarded: pi's own files (models.json /
 * auth.json) are the single source of truth for credentials. Forwarding the
 * cached apiConfig key on every startup re-created provider entries with a
 * STALE key, clobbering keys rotated outside Helix. apply_pi_model_config
 * preserves the existing stored key when none is given. Callers that just
 * saved a FRESH key in the settings page still pass it through `pushApiKey`
 * (one-time), never via this generic path.
 */
export function pushModelConfig(payload: {
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  // Strip the key: credentials live in pi's own files; this generic (startup
  // re-assert / model-switch) path must never carry a cached key.
  const modelPayload: {
    model?: string;
    provider?: string;
    baseUrl?: string;
  } = {
    model: payload.model,
    provider: payload.provider,
    baseUrl: payload.baseUrl,
  };
  const hasModelPayload = !!(
    modelPayload.model ||
    modelPayload.baseUrl ||
    modelPayload.provider
  );
  if (!hasModelPayload) return;

  // Tauri mode: use tauri bridge via window.electron.helix
  if (!isElectron()) {
    const helix = window.electron?.helix;
    if (helix?.setConfig) {
      helix.setConfig(modelPayload).catch((e: unknown) => {
        console.warn("[config-sync] tauri setConfig 失败:", e);
      });
    }
    return;
  }

  pushModelConfigViaIpc(modelPayload, hasModelPayload);
}

/** 冷启动缓存 + IPC setConfig（会写 config.yaml 并重启网关） */
function pushModelConfigViaIpc(
  payload: {
    model?: string;
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
  },
  hasModelPayload: boolean,
) {
  const helix = window.electron?.helix;
  const profile = window.electron?.profile;
  if (!hasModelPayload) return;

  try {
    if (
      profile?.cacheConfig &&
      (payload.model || payload.baseUrl || payload.provider)
    ) {
      profile.cacheConfig({
        model: payload.model,
        provider: payload.provider,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
      });
    }
  } catch { /* empty */}
  try {
    if (
      helix?.setConfig &&
      (payload.model || payload.baseUrl || payload.apiKey || payload.provider)
    ) {
      helix.setConfig({
        model: payload.model,
        provider: payload.provider,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
      });
    }
  } catch { /* empty */}
}

/**
 * Push agent config (reasoning effort) via live config.set.
 * Takes effect immediately without gateway restart.
 */
export function pushAgentConfigLive(payload: {
  reasoningEffort?: string;
}) {
  const helix = window.electron?.helix;
  const isTauri = !isElectron() && !!helix?.setConfigKeyValue;

  if (!isElectron() && !isTauri) return;

  if (payload.reasoningEffort !== undefined) {
    pushConfigKeyValue("agent.reasoning_effort", payload.reasoningEffort);
  }
}
