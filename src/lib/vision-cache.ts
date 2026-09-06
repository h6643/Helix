// 视觉模型（独立配置）的运行时缓存 + 调用助手。
// 配了视觉模型时，图片先由它转成文字描述再交给主模型（helix 时代行为），
// 省主模型的多模态 token；没配或调用失败则回退为原始 image_url 直传。
// 缓存单独放这里，避免 agent-flow-panel 与设置页互相 import 造成循环依赖。
const VISION_PROMPT =
  '详细描述这张图片的内容，尤其是其中的文字、代码、表格和关键数据。输出供无法看到图片的助手阅读。'

type VisionConfig = { model?: string; baseUrl?: string; apiKey?: string } | null

let cache: VisionConfig | undefined

async function getVisionConfig(): Promise<VisionConfig> {
  if (cache === undefined) {
    try {
      const api = (window as any).electron?.vision
      const r = api?.getConfig ? await api.getConfig() : null
      const c = r?.ok ? r.config : null
      cache = c?.model && c?.baseUrl ? (c as VisionConfig) : null
    } catch {
      cache = null
    }
  }
  return cache ?? null
}

/** 设置页保存后调用，让新配置立刻生效 */
export function invalidateVisionConfigCache() {
  cache = undefined
}

/** 返回图片的文字描述；未配置视觉模型或调用失败时返回 null */
export async function describeImageWithVisionModel(dataUrl: string): Promise<string | null> {
  const cfg = await getVisionConfig()
  if (!cfg) return null
  try {
    const api = (window as any).electron?.vision
    if (!api?.describe) return null
    const text = await api.describe(dataUrl, VISION_PROMPT)
    return (text || '').trim() || null
  } catch {
    return null
  }
}
