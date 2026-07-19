// 持久化层 —— 配置存到 localStorage，apiKey 落盘时加密。
//
// 复用项目已有的 @/lib/crypto（Electron safeStorage 优先，浏览器回退到
// Web Crypto）。运行时 ProviderConfig.apiKey 保持明文，只有写盘/读盘时
// 才做加解密，调用方无感知。
import type { ProviderConfig } from './types'
import { encryptApiKey, decryptApiKey } from '@/lib/crypto'

const KEY_PROVIDERS = 'hermes-ui:providers'
const KEY_ACTIVE = 'hermes-ui:activeModel'

/** 从 localStorage 读取并解密所有 Provider（apiKey 还原为明文）。 */
export async function loadProviders(): Promise<ProviderConfig[]> {
  if (typeof localStorage === 'undefined') return []
  const raw = localStorage.getItem(KEY_PROVIDERS)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as ProviderConfig[]
    return await Promise.all(
      arr.map(async (p) => ({ ...p, apiKey: await decryptApiKey(p.apiKey || '') })),
    )
  } catch {
    return []
  }
}

/** 加密每个 Provider 的 apiKey 后写入 localStorage。 */
export async function saveProviders(providers: ProviderConfig[]): Promise<void> {
  if (typeof localStorage === 'undefined') return
  const enc = await Promise.all(
    providers.map(async (p) => ({ ...p, apiKey: await encryptApiKey(p.apiKey || '') })),
  )
  localStorage.setItem(KEY_PROVIDERS, JSON.stringify(enc))
}

export function loadActiveModel(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(KEY_ACTIVE)
}

export function saveActiveModel(model: string | null): void {
  if (typeof localStorage === 'undefined') return
  if (model) localStorage.setItem(KEY_ACTIVE, model)
  else localStorage.removeItem(KEY_ACTIVE)
}
