// 模型配置管理 —— 核心类型定义
//
// 设计要点：
// - ProviderConfig 描述「一个供应商 + 它下面的多个模型」。
// - AppConfig 是顶层结构：providers 列表 + 当前选中的模型名（activeModel）。
// - ResolvedModel 是「反向查找」的产物：给定一个模型名，定位到它所属的
//   Provider，拿到 baseUrl / apiKey / model，供一次具体请求使用。
// - FlatModel 是下拉框扁平列表中的一项。

/** 单个 Provider 配置 */
export interface ProviderConfig {
  id: string
  /** 显示名称，例如 "Ling" */
  name: string
  /** 接口地址，例如 "https://api.ant-ling.com/v1" */
  baseUrl: string
  /** 运行时为明文；持久化时由 persistence 层加密 */
  apiKey: string
  /** 该 Provider 下的模型列表，例如 ["Ling-2.6-1T", "Ling-2.6-Pro"] */
  models: string[]
  /** 是否为默认 Provider（无选中模型时的兜底） */
  isDefault?: boolean
}

/** 顶层应用配置 */
export interface AppConfig {
  providers: ProviderConfig[]
  /** 当前选中的模型名称，例如 "Ling-2.6-1T" */
  activeModel: string | null
}

/**
 * 反向查找后得到的结构：模型名 → 所属 Provider 的完整配置 + 模型名本身。
 * 每次请求都重新生成这个对象，绝不缓存。
 */
export interface ResolvedModel {
  providerId: string
  providerName: string
  baseUrl: string
  apiKey: string
  /** 真正发给后端的模型名（等于 activeModel） */
  model: string
}

/** 下拉框扁平列表中的一项 */
export interface FlatModel {
  model: string
  providerId: string
  providerName: string
}

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export type ReasoningEffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/** Named personality presets (Hermes Desktop style) */
export const PERSONALITY_PRESETS: Record<string, string> = {
  helpful: 'You are a helpful, harmless, and honest assistant.',
  concise: 'You are a concise assistant. Give short, direct answers.',
  technical: 'You are a technical assistant. Use precise terminology and provide detailed explanations.',
  creative: 'You are a creative assistant. Think outside the box and provide imaginative solutions.',
  teacher: 'You are a patient teacher. Explain concepts step by step with examples.',
  kawaii: 'You are a cute and friendly assistant. Use a warm, cheerful tone.',
  catgirl: 'Nyaa~ You are a catgirl assistant! Speak with cat-like expressions and be playful.',
  pirate: 'Yarr! You be a pirate assistant. Speak in pirate slang and be adventurous.',
  shakespeare: 'Thou art a Shakespearean assistant. Speak in Elizabethan English with eloquent prose.',
  surfer: 'Dude, you are a surfer assistant! Use surf slang and keep it chill.',
  noir: 'You are a hard-boiled noir detective assistant. Speak in gritty, cynical prose.',
  uwu: 'You are a sweet UwU assistant. Use cute emoticons and speak softly~',
  philosopher: 'You are a philosopher assistant. Explore ideas deeply and reference philosophical traditions.',
  hype: 'You are a hype assistant! Everything is AMAZING and INCREDIBLE! Use lots of exclamation marks!!!',
}
