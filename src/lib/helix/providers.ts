/**
 * Provider configurations for Helix
 * Supports 75+ LLM providers through a unified interface
 */

export type RequestFormat = 'openai' | 'openai-compatible' | 'anthropic' | 'google' | 'ollama'

export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  requestFormat: RequestFormat
  models: string[]
  envKey?: string
  website?: string
}

export type ProviderID = string

const PROVIDERS: ProviderConfig[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', requestFormat: 'openai', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1', 'o1-mini', 'o3-mini'], envKey: 'OPENAI_API_KEY', website: 'https://platform.openai.com' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', requestFormat: 'anthropic', models: ['claude-sonnet-4-20250514', 'claude-sonnet-4', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022', 'claude-opus-4-20250514'], envKey: 'ANTHROPIC_API_KEY', website: 'https://console.anthropic.com' },
  { id: 'google', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', requestFormat: 'google', models: ['gemini-2.5-pro-0325', 'gemini-2.5-flash-0325', 'gemini-2.0-flash-001', 'gemini-1.5-pro-002', 'gemini-1.5-flash-002'], envKey: 'GEMINI_API_KEY', website: 'https://aistudio.google.com' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', requestFormat: 'openai', models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'], envKey: 'DEEPSEEK_API_KEY', website: 'https://platform.deepseek.com' },
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', requestFormat: 'ollama', models: ['llama3.3-70b', 'llama3.2-90b', 'llama3.2-11b', 'llama3.2-3b', 'qwen2.5-coder-32b', 'qwen2.5-72b', 'mixtral-8x22b', 'codestral-2501', 'phi-4', 'deepseek-r1', 'mistral-small-24b'], website: 'https://ollama.ai' },
  { id: 'github', name: 'GitHub Models', baseUrl: 'https://models.inference.ai.azure.com', requestFormat: 'openai', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'Phi-3.5-mini-instruct', 'Phi-3.5-vision-instruct', 'Phi-3-medium-128k-instruct', 'Cohere-command-r-plus-08-2024', 'Cohere-command-r-08-2024', 'AI21-Jamba-1.5-Mini', 'AI21-Jamba-1.5-Large', 'meta-llama-3.2-90b-vision-instruct', 'meta-llama-3.2-11b-vision-instruct', 'meta-llama-3.2-3b-instruct', 'meta-llama-3.1-405b-instruct', 'meta-llama-3.1-70b-instruct', 'meta-llama-3.1-8b-instruct', 'mistral-large-2407', 'mistral-small', 'Mistral-served-through-NVIDIA-NIMs'], envKey: 'GITHUB_TOKEN', website: 'https://github.com/marketplace/models' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requestFormat: 'openai', models: ['llama3-70b-8192', 'llama3-8b-8192', 'mixtral-8x7b-32768', 'gemma2-9b-it', 'deepseek-r1-distill-llama-70b'], envKey: 'GROQ_API_KEY', website: 'https://console.groq.com' },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', requestFormat: 'openai', models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/QwQ-32B-Preview', 'mistralai/Mixtral-8x22B-Instruct-v0.1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo'], envKey: 'TOGETHER_API_KEY', website: 'https://api.together.xyz' },
  { id: 'fireworks', name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', requestFormat: 'openai', models: ['accounts/fireworks/models/deepseek-v3', 'accounts/fireworks/models/deepseek-r1', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/qwen2p5-coder-32b-instruct', 'accounts/fireworks/models/mixtral-8x22b-instruct'], envKey: 'FIREWORKS_API_KEY', website: 'https://fireworks.ai' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', requestFormat: 'openai', models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001', 'meta-llama/llama-3.2-90b-vision-instruct', 'deepseek/deepseek-r1', 'qwen/qwen-2.5-coder-32b-instruct'], envKey: 'OPENROUTER_API_KEY', website: 'https://openrouter.ai' },
  { id: 'azure', name: 'Azure OpenAI', baseUrl: 'https://YOUR_RESOURCE.openai.azure.com', requestFormat: 'openai', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-35-turbo'], envKey: 'AZURE_OPENAI_API_KEY', website: 'https://azure.microsoft.com/products/ai-services/openai-service' },
  { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', requestFormat: 'openai', models: ['grok-2-1212', 'grok-beta'], envKey: 'XAI_API_KEY', website: 'https://x.ai' },
  { id: 'cohere', name: 'Cohere', baseUrl: 'https://api.cohere.com/v2', requestFormat: 'openai', models: ['command-r-plus-08-2024', 'command-r-08-2024'], envKey: 'COHERE_API_KEY', website: 'https://dashboard.cohere.com' },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', requestFormat: 'openai', models: ['mistral-large-2411', 'mistral-small-2501', 'codestral-2501', 'pixtral-large-2411'], envKey: 'MISTRAL_API_KEY', website: 'https://console.mistral.ai' },
  { id: 'perplexity', name: 'Perplexity', baseUrl: 'https://api.perplexity.ai', requestFormat: 'openai', models: ['sonar-pro', 'sonar', 'sonar-reasoning-pro', 'sonar-reasoning'], envKey: 'PERPLEXITY_API_KEY', website: 'https://www.perplexity.ai' },
  { id: 'mimo', name: 'MiMo', baseUrl: 'https://api.mimo.ai/v1', requestFormat: 'openai', models: ['mimo-auto', 'mimo-v2-pro'], envKey: 'MIMO_API_KEY' },
  { id: 'sambanova', name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', requestFormat: 'openai', models: ['DeepSeek-R1', 'DeepSeek-V3-0324', 'Qwen2.5-Coder-32B-Instruct', 'QwQ-32B-Preview', 'Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-8B-Instruct'], envKey: 'SAMBANOVA_API_KEY', website: 'https://sambanova.ai' },
  { id: 'deepinfra', name: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', requestFormat: 'openai', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3', 'Qwen/QwQ-32B-Preview', 'Qwen/Qwen2.5-Coder-32B-Instruct', 'mistralai/Mixtral-8x22B-Instruct-v0.1'], envKey: 'DEEPINFRA_API_KEY', website: 'https://deepinfra.com' },
]

const providerMap = new Map<string, ProviderConfig>()
for (const p of PROVIDERS) {
  providerMap.set(p.id, p)
}

export function getProvider(id: string): ProviderConfig | undefined {
  return providerMap.get(id)
}

export function getAllProviders(): ProviderConfig[] {
  return PROVIDERS
}

export function getEnvApiKey(providerID: string): string | undefined {
  const provider = getProvider(providerID)
  if (!provider?.envKey) return
  return process.env[provider.envKey] || undefined
}

export function getRequestFormat(providerID: string): RequestFormat {
  return getProvider(providerID)?.requestFormat ?? 'openai'
}

export function getBaseUrl(providerID: string): string | undefined {
  return getProvider(providerID)?.baseUrl
}

export function getModels(providerID: string): string[] {
  return getProvider(providerID)?.models ?? []
}

export function addProvider(config: ProviderConfig): void {
  providerMap.set(config.id, config)
  PROVIDERS.push(config)
}
