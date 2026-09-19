/**
 * Minimal provider presets for UI display only.
 * Actual provider resolution is handled by Helix.
 */

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  envKey?: string;
  website?: string;
}

const PROVIDERS: ProviderConfig[] = [
  // ── Major cloud providers ─────────────────────────────────────────────────
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    website: "https://platform.openai.com",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    envKey: "ANTHROPIC_API_KEY",
    website: "https://console.anthropic.com",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    website: "https://aistudio.google.com",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    website: "https://platform.deepseek.com",
  },
  {
    id: "xai",
    name: "xAI / Grok",
    baseUrl: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    website: "https://x.ai/api",
  },
  // ── Aggregators / Routers ────────────────────────────────────────────────
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    website: "https://openrouter.ai",
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    envKey: "OPENCODE_ZEN_API_KEY",
    website: "https://opencode.ai",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    envKey: "OPENCODE_GO_API_KEY",
    website: "https://opencode.ai",
  },
  // ── European / Other ─────────────────────────────────────────────────────
  {
    id: "mistral",
    name: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    website: "https://console.mistral.ai",
  },
  // ── China ────────────────────────────────────────────────────────────────
  {
    id: "qwen",
    name: "Alibaba Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    envKey: "DASHSCOPE_API_KEY",
    website: "https://dashscope.console.aliyun.com",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    envKey: "MINIMAX_API_KEY",
    website: "https://platform.minimax.chat",
  },
  {
    id: "minimax-cn",
    name: "MiniMax (CN)",
    baseUrl: "https://api.minimaxi.com/v1",
    envKey: "MINIMAX_CN_API_KEY",
    website: "https://platform.minimax.chat",
  },
  {
    id: "zai",
    name: "Zhipu AI (z.ai)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    envKey: "GLM_API_KEY",
    website: "https://open.bigmodel.cn",
  },
  {
    id: "kimi-for-coding",
    name: "Kimi (Moonshot)",
    baseUrl: "https://api.kimi.com/coding/v1",
    envKey: "KIMI_API_KEY",
    website: "https://platform.kimi.ai",
  },
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    envKey: "XIAOMI_API_KEY",
    website: "https://platform.xiaomimimo.com",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    website: "https://siliconflow.cn",
  },
  {
    id: "tencent-tokenhub",
    name: "Tencent TokenHub",
    baseUrl: "https://api.tokenhub.cloud/v1",
    envKey: "TOKENHUB_API_KEY",
    website: "https://cloud.tencent.com",
  },
];

export function getAllProviders(): ProviderConfig[] {
  return PROVIDERS;
}

function getProvider(id: string): ProviderConfig | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function getBaseUrl(providerID: string): string | undefined {
  return getProvider(providerID)?.baseUrl;
}

