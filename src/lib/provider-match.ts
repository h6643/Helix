/**
 * Provider↔model affinity classifier.
 *
 * Used to detect "dirty" API history entries — a config where the model name
 * clearly belongs to a *different* supplier than the endpoint it's saved
 * against (e.g. `k3` (Kimi) saved under a DeepSeek base URL). Such entries
 * send the wrong model to the backend and pollute the provider selector.
 *
 * Design rule: only flag when BOTH the model name and the base URL can be
 * confidently attributed to a known supplier AND they disagree. If either side
 * is unrecognized (custom endpoint, custom model name), we stay silent and keep
 * the entry — this avoids deleting legitimate self-hosted / OpenAI-compatible
 * configs that use arbitrary model names.
 */

type ProviderKey =
  | "ling"
  | "deepseek"
  | "kimi"
  | "zhipu"
  | "qwen"
  | "openai"
  | "anthropic"
  | "google"
  | null;

/** Infer the supplier a model name most likely belongs to. */
function modelProviderKey(model: string): ProviderKey {
  const m = (model || "").toLowerCase().trim();
  if (!m) return null;
  if (/^k3|kimi|moonshot/.test(m)) return "kimi";
  if (m.includes("deepseek")) return "deepseek";
  if (/glm|zhipu|chatglm/.test(m)) return "zhipu";
  if (/qwen|tongyi|dashscope/.test(m)) return "qwen";
  if (m.includes("claude") || m.includes("anthropic")) return "anthropic";
  if (/gpt|^o[1-9][-_]?|^text-|^ft-|^davinci/.test(m)) return "openai";
  if (/gemini|palm/.test(m)) return "google";
  if (/ling|ant-/.test(m)) return "ling";
  return null;
}

/** Infer the supplier a base URL most likely belongs to. */
function urlProviderKey(baseUrl: string): ProviderKey {
  const u = (baseUrl || "").toLowerCase().trim();
  if (!u) return null;
  // Try parsing as URL first (hostname is the most reliable signal).
  let host = "";
  try {
    host = new URL(u).hostname.toLowerCase();
  } catch {
    host = u;
  }
  if (/ant-ling|agnes|ant-/.test(host)) return "ling";
  if (host.includes("deepseek")) return "deepseek";
  if (/kimi|moonshot/.test(host)) return "kimi";
  if (/zhipu|bigmodel|glm/.test(host)) return "zhipu";
  if (/qwen|dashscope/.test(host)) return "qwen";
  if (host.includes("anthropic")) return "anthropic";
  if (host.includes("openai")) return "openai";
  if (/googleapis|generativelanguage/.test(host)) return "google";
  return null;
}

/**
 * True only when the model and the endpoint URL each clearly belong to a known
 * supplier, and those suppliers differ. Returns false when either side is
 * unrecognized (so custom endpoints / custom model names are never flagged).
 */
export function isModelProviderMismatch(
  model: string,
  baseUrl?: string,
): boolean {
  const pModel = modelProviderKey(model);
  const pUrl = urlProviderKey(baseUrl || "");
  if (!pModel || !pUrl) return false;
  return pModel !== pUrl;
}
