/**
 * Minimal provider presets for UI display only.
 * Actual provider resolution is handled by Hermes.
 */

export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  models: string[]
  envKey?: string
  website?: string
}

const PROVIDERS: ProviderConfig[] = [
  // ── Major cloud providers ─────────────────────────────────────────────────
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o3-mini'], envKey: 'OPENAI_API_KEY', website: 'https://platform.openai.com' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022'], envKey: 'ANTHROPIC_API_KEY', website: 'https://console.anthropic.com' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-pro-0325', 'gemini-2.5-flash-0325', 'gemini-2.0-flash-001'], envKey: 'GEMINI_API_KEY', website: 'https://aistudio.google.com' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'], envKey: 'DEEPSEEK_API_KEY', website: 'https://platform.deepseek.com' },
  { id: 'xai', name: 'xAI / Grok', baseUrl: 'https://api.x.ai/v1', models: ['grok-3', 'grok-3-mini', 'grok-2-1212'], envKey: 'XAI_API_KEY', website: 'https://x.ai/api' },
  // ── Aggregators / Routers ────────────────────────────────────────────────
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'meta-llama/llama-3.2-90b-vision-instruct'], envKey: 'OPENROUTER_API_KEY', website: 'https://openrouter.ai' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama3-70b-8192', 'mixtral-8x7b-32768'], envKey: 'GROQ_API_KEY', website: 'https://console.groq.com' },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3'], envKey: 'TOGETHER_API_KEY', website: 'https://api.together.xyz' },
  { id: 'fireworks', name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', models: ['accounts/fireworks/models/llama-v3p1-405b-instruct', 'accounts/fireworks/models/deepseek-r1'], envKey: 'FIREWORKS_API_KEY', website: 'https://fireworks.ai' },
  { id: 'novita', name: 'NovitaAI', baseUrl: 'https://api.novita.ai/openai/v1', models: ['meta-llama/llama-3.1-405b-instruct', 'deepseek/deepseek-r1'], envKey: 'NOVITA_API_KEY', website: 'https://novita.ai' },
  { id: 'huggingface', name: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', models: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'], envKey: 'HF_TOKEN', website: 'https://huggingface.co' },
  { id: 'perplexity', name: 'Perplexity', baseUrl: 'https://api.perplexity.ai', models: ['sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'], envKey: 'PERPLEXITY_API_KEY', website: 'https://www.perplexity.ai/settings/api' },
  { id: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', models: ['gpt-4o', 'claude-sonnet-4', 'gemini-2.5-pro'], envKey: 'OPENCODE_ZEN_API_KEY', website: 'https://opencode.ai' },
  { id: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', models: ['glm-5', 'kimi-k2.5', 'minimax-m2.5'], envKey: 'OPENCODE_GO_API_KEY', website: 'https://opencode.ai' },
  { id: 'kilo', name: 'KiloCode', baseUrl: 'https://api.kilocode.ai/v1', models: ['claude-sonnet-4', 'gpt-4o', 'gemini-2.5-pro'], envKey: 'KILOCODE_API_KEY', website: 'https://kilocode.ai' },
  // ── European / Other ─────────────────────────────────────────────────────
  { id: 'mistral', name: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'], envKey: 'MISTRAL_API_KEY', website: 'https://console.mistral.ai' },
  { id: 'cohere', name: 'Cohere', baseUrl: 'https://api.cohere.ai/v1', models: ['command-a-03-2025', 'command-r-plus', 'command-r'], envKey: 'COHERE_API_KEY', website: 'https://dashboard.cohere.com' },
  { id: 'ai21', name: 'AI21 Labs', baseUrl: 'https://api.ai21.com/v1', models: ['jamba-1.5-large', 'jamba-1.5-mini', 'jamba-mini'], envKey: 'AI21_API_KEY', website: 'https://studio.ai21.com' },
  { id: 'arcee', name: 'Arcee AI', baseUrl: 'https://api.arcee.ai/api/v1', models: ['trinity-mini', 'trinity-large'], envKey: 'ARCEEAI_API_KEY', website: 'https://chat.arcee.ai' },
  // ── Cloud platforms ──────────────────────────────────────────────────────
  { id: 'azure', name: 'Azure OpenAI', baseUrl: 'https://YOUR_RESOURCE.openai.azure.com/openai', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4'], envKey: 'AZURE_OPENAI_API_KEY', website: 'https://azure.microsoft.com/en-us/products/ai-services/openai-service' },
  { id: 'bedrock', name: 'AWS Bedrock', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', models: ['anthropic.claude-3-sonnet-20240229-v1:0', 'meta.llama3-70b-instruct-v1:0'], envKey: 'AWS_BEDROCK_API_KEY', website: 'https://aws.amazon.com/bedrock' },
  { id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', models: ['nvidia/llama-3.1-405b-instruct', 'nvidia/nemotron-4-340b-instruct'], envKey: 'NVIDIA_API_KEY', website: 'https://build.nvidia.com' },
  { id: 'gmi', name: 'GMI Cloud', baseUrl: 'https://api.gmi-serving.com/v1', models: ['gmi-default'], envKey: 'GMI_API_KEY', website: 'https://gmi.cloud' },
  { id: 'azure-foundry', name: 'Azure Foundry', baseUrl: 'https://YOUR_RESOURCE.services.ai.azure.com/models', models: ['gpt-4o', 'Phi-4'], envKey: 'AZURE_FOUNDRY_API_KEY', website: 'https://azure.microsoft.com/en-us/products/ai-services' },
  // ── Agnes / Hermes ───────────────────────────────────────────────────────
  { id: 'agnes-ai', name: 'Agnes AI', baseUrl: 'https://apihub.agnes-ai.com/v1', models: ['agnes-2.0-flash', 'agnes-2.0-pro'], envKey: 'AGNES_API_KEY', website: 'https://agnes-ai.com' },
  { id: 'nous', name: 'Nous Research', baseUrl: 'https://inference-api.nousresearch.com/v1', models: ['hermes-3-llama-3.1-405b', 'hermes-3-llama-3.1-70b'], envKey: 'NOUS_API_KEY', website: 'https://nousresearch.com' },
  // ── China ────────────────────────────────────────────────────────────────
  { id: 'qwen', name: 'Alibaba Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3-235b-a22b', 'qwen-max', 'qwen2.5-72b-instruct', 'qwen-plus'], envKey: 'DASHSCOPE_API_KEY', website: 'https://dashscope.console.aliyun.com' },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', models: ['MiniMax-Text-01', 'abab6.5s-chat', 'abab6.5t-chat'], envKey: 'MINIMAX_API_KEY', website: 'https://platform.minimax.chat' },
  { id: 'minimax-cn', name: 'MiniMax (CN)', baseUrl: 'https://api.minimaxi.com/v1', models: ['MiniMax-Text-01', 'abab6.5s-chat'], envKey: 'MINIMAX_CN_API_KEY', website: 'https://platform.minimax.chat' },
  { id: 'zai', name: 'Zhipu AI (z.ai)', baseUrl: 'https://api.z.ai/api/paas/v4', models: ['glm-4-0520', 'glm-4-plus', 'glm-4-flash', 'glm-4-air'], envKey: 'GLM_API_KEY', website: 'https://open.bigmodel.cn' },
  { id: 'kimi-for-coding', name: 'Kimi (Moonshot)', baseUrl: 'https://api.kimi.com/coding/v1', models: ['kimi-k2.5', 'kimi-k1.5'], envKey: 'KIMI_API_KEY', website: 'https://platform.kimi.ai' },
  { id: 'stepfun', name: 'StepFun', baseUrl: 'https://api.stepfun.ai/step_plan/v1', models: ['step-2-16k', 'step-1.5-32k', 'step-1-flash'], envKey: 'STEPFUN_API_KEY', website: 'https://platform.stepfun.com' },
  { id: 'xiaomi', name: 'Xiaomi MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2.5-flash'], envKey: 'XIAOMI_API_KEY', website: 'https://platform.xiaomimimo.com' },
  { id: 'siliconflow', name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'], envKey: 'SILICONFLOW_API_KEY', website: 'https://siliconflow.cn' },
  { id: 'baichuan', name: 'Baichuan', baseUrl: 'https://api.baichuan-ai.com/v1', models: ['baichuan4', 'baichuan3-turbo', 'baichuan2-53b'], envKey: 'BAICHUAN_API_KEY', website: 'https://platform.baichuan-ai.com' },
  { id: 'moonshot', name: 'Moonshot AI', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-0711-preview', 'moonshot-v1-8k', 'moonshot-v1-32k'], envKey: 'MOONSHOT_API_KEY', website: 'https://platform.moonshot.cn' },
  { id: 'tencent-tokenhub', name: 'Tencent TokenHub', baseUrl: 'https://api.tokenhub.cloud/v1', models: ['hunyuan-pro', 'hunyuan-standard'], envKey: 'TOKENHUB_API_KEY', website: 'https://cloud.tencent.com' },
]

export function getAllProviders(): ProviderConfig[] {
  return PROVIDERS
}

export function getProvider(id: string): ProviderConfig | undefined {
  return PROVIDERS.find(p => p.id === id)
}

export function getModels(providerID: string): string[] {
  return getProvider(providerID)?.models ?? []
}

export function getBaseUrl(providerID: string): string | undefined {
  return getProvider(providerID)?.baseUrl
}

export function getEnvApiKey(providerID: string): string | undefined {
  const provider = getProvider(providerID)
  if (!provider?.envKey) return
  return process.env[provider.envKey] || undefined
}
