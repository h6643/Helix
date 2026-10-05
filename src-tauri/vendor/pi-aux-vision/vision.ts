/**
 * describe_image 的执行体:读盘 → 校验/压缩 → 直连 OpenAI 兼容的 /chat/completions
 * → 返回文本结果。
 *
 * 模型来自 config.yaml 的 `vision:` 块(provider/model/baseUrl/apiKey),不再走
 * pi 的 modelRegistry —— 视觉端点是 Helix 自己的一份配置,和主模型的 provider
 * 体系无关。代理无需处理:pi_gateway 已给子进程注入 HTTP_PROXY/HTTPS_PROXY +
 * NODE_USE_ENV_PROXY=1,Node 的全局 fetch 会自动走代理。
 */
import {
  detectSupportedImageMimeTypeFromFile,
  formatSize,
  resizeImage,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CALL_KNOBS, type VisionConfig } from "./config";
import { Type } from "typebox";

/** 服务商限制交集:原始图片 10MB 硬上限(Gemini 20MB 请求 / Anthropic 10MB / SenseNova 10MB)。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const SYSTEM_PROMPT =
  // 转录底座契约(ADR-0002):无论问题多窄,都先穷尽转储可见信息,盲模型据此推理,不依赖提问精度。
  "You are a precise image analysis assistant. Regardless of the question, ALWAYS begin with an exhaustive transcription base: " +
  "1) classify the image type (terminal screenshot, log output, error dialog, UI/screenshot, photo, diagram, or other); " +
  "2) transcribe verbatim ALL visible text, code, and error messages — every line, in the original language, untranslated; " +
  "   note the layout and reading order (top to bottom, blocks, highlighted items); " +
  "3) coordinates, colors, and non-text visual details are best-effort only. " +
  "If the image contains no readable text, state that explicitly and describe the visual content instead. " +
  "Then, in a section headed 'Answer', answer the user's question factually and precisely using the transcription base. " +
  "End with a completeness attestation in the response language, using exactly one of: " +
  "'I have exhaustively transcribed all visible text.' or 'No readable text was found — I described the visual content instead.' " +
  "Respond in the same language as the user's question (the transcription itself stays verbatim in the original language).";

// Tool result contract (ADR-0001): success carries { model, usage }, failure { error }.
// Expected failures are returned, not thrown, so the transcript isError stays false.
// Structured result (ADR-0005): codemode scripts receive structuredContent once outputSchema is declared.
export type UsageJson = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export type DescribeImageResult =
  | {
      content: { type: "text"; text: string }[];
      details: { model: string; usage: UsageJson };
      structuredContent: {
        ok: true;
        model: string;
        usage: UsageJson;
        transcription: string;
        truncated: boolean;
        resize_note?: string;
      };
    }
  | {
      content: { type: "text"; text: string }[];
      details: { error: string };
      structuredContent: { ok: false; error: string };
    };

/** Narrow a describe_image result to its expected-failure variant. */
export function isErrorResult(r: DescribeImageResult): r is Extract<DescribeImageResult, { details: { error: string } }> {
  return "error" in r.details;
}

export function errorResult(text: string): {
  content: { type: "text"; text: string }[];
  details: { error: string };
  structuredContent: { ok: false; error: string };
} {
  return {
    content: [{ type: "text" as const, text }],
    details: { error: text },
    structuredContent: { ok: false, error: text },
  };
}

// 结构化输出契约(ADR-0005):转录保持普通字符串字段,脚本可弃;usage 仅承诺 totalTokens。
export const structuredOutputSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    model: Type.String(),
    usage: Type.Object({ totalTokens: Type.Number() }, { additionalProperties: true }),
    transcription: Type.String(),
    truncated: Type.Boolean(),
    resize_note: Type.Optional(Type.String()),
  }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.String(),
  }),
]);

interface ChatCompletionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; code?: string | number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** OpenAI/兼容端点的 usage → 工具的 UsageJson(缺失字段按 0 计)。 */
function toUsageJson(u: ChatCompletionResponse["usage"]): UsageJson {
  const input = u?.prompt_tokens ?? 0;
  const output = u?.completion_tokens ?? 0;
  const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoning = u?.completion_tokens_details?.reasoning_tokens;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    ...(reasoning !== undefined ? { reasoning } : {}),
    totalTokens: u?.total_tokens ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * 核心图像分析:单次调用,结果作为 tool_result 进入上下文,不产生多余调用。
 * 失败(含 5xx/429 重试耗尽)一律以 errorResult 返回,不抛异常。
 */
export async function describeImage(
  params: { image_path: string; question: string },
  ctx: ExtensionContext,
  cfg: VisionConfig,
  signal: AbortSignal | undefined,
): Promise<DescribeImageResult> {
  const filePath = path.resolve(ctx.cwd, params.image_path);

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return errorResult(
      `Image file does not exist: ${filePath}. Make sure the file is on disk (screenshot, export, or generated) and check the path.`,
    );
  }
  if (!stat.isFile()) {
    return errorResult(`Path is not a file: ${filePath}`);
  }

  const mimeType = await detectSupportedImageMimeTypeFromFile(filePath);
  if (!mimeType) {
    return errorResult(
      `Unsupported image format: ${params.image_path} (supported: png / jpeg / gif / webp / bmp).`,
    );
  }

  let bytes = await fs.readFile(filePath);
  let resizeNote = "";

  // 超过 10MB:优先用官方 resizeImage 压到限制内,压不动才报错。
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    const resized = await resizeImage(bytes, mimeType, { maxBytes: MAX_IMAGE_BYTES });
    if (!resized) {
      return errorResult(
        `Image ${formatSize(stat.size)} exceeds the 10MB limit and could not be auto-compressed; shrink the image and retry.`,
      );
    }
    bytes = Buffer.from(resized.data, "base64");
    resizeNote = `(original ${formatSize(stat.size)} compressed to ${formatSize(bytes.byteLength)})`;
  }

  const base64 = bytes.toString("base64");
  const url = cfg.baseUrl.endsWith("/") ? `${cfg.baseUrl}chat/completions` : `${cfg.baseUrl}/chat/completions`;
  const modelLabel = `${cfg.provider ? `${cfg.provider}/` : ""}${cfg.model}`;

  const body = JSON.stringify({
    model: cfg.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: params.question },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
    max_tokens: CALL_KNOBS.maxOutputTokens,
  });

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  let lastError = "";
  for (let attempt = 0; attempt <= CALL_KNOBS.maxRetries; attempt++) {
    if (signal?.aborted) return errorResult("Vision model call was aborted");
    let resp: Response;
    try {
      resp = await fetch(url, { method: "POST", headers, body, signal });
    } catch (e) {
      if (signal?.aborted) return errorResult("Vision model call was aborted");
      lastError = `request failed: ${e instanceof Error ? e.message : String(e)}`;
      if (attempt < CALL_KNOBS.maxRetries) {
        await sleep(Math.min(CALL_KNOBS.maxRetryDelayMs, 1000 * 2 ** attempt));
        continue;
      }
      return errorResult(`Vision model call failed (${modelLabel}): ${lastError}`);
    }

    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      // 只重试瞬时状态;4xx(鉴权/模型名错)立即返回,避免把配置错误掩盖成"偶尔失败"。
      const retryable = resp.status === 429 || resp.status >= 500;
      const detail = summarizeError(text);
      if (retryable && attempt < CALL_KNOBS.maxRetries) {
        await sleep(Math.min(CALL_KNOBS.maxRetryDelayMs, 1000 * 2 ** attempt));
        continue;
      }
      return errorResult(`Vision model returned HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      return errorResult(`Vision model returned a non-JSON response: ${text.slice(0, 300)}`);
    }

    const content = parsed.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) {
      const apiErr = parsed.error?.message;
      return errorResult(
        apiErr ? `Vision model returned an error: ${apiErr}` : "Vision model returned no text content",
      );
    }

    // 截断显式化(ADR-0002):端点在输出撞到 max_tokens 时标记 finish_reason "length",
    // 此时转录底座可能不完整,必须在头部显式告知,而不是把残缺底座静默交回盲模型。
    const truncated = parsed.choices?.[0]?.finish_reason === "length";
    const body2 = truncated ? `${truncationNotice()}\n${content}` : content;
    const fullText = resizeNote ? `${body2}\n${resizeNote}` : body2;
    const usage = toUsageJson(parsed.usage);

    return {
      content: [{ type: "text", text: fullText }],
      details: { model: modelLabel, usage },
      structuredContent: {
        ok: true,
        model: modelLabel,
        usage,
        transcription: fullText,
        truncated,
        ...(resizeNote ? { resize_note: resizeNote } : {}),
      },
    };
  }

  return errorResult(`Vision model call failed (${modelLabel}): ${lastError || "unreachable"}`);
}

/** 端点错误响应压到一行,避免把整页 HTML 塞进 tool_result。 */
function summarizeError(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  try {
    const j = JSON.parse(text) as { error?: { message?: string; code?: string | number } };
    const m = j.error?.message;
    if (m) return j.error?.code !== undefined ? `${m} (code ${j.error.code})` : m;
  } catch {
    // 非 JSON 错误体:退回原文截断
  }
  return flat.slice(0, 300);
}

// 截断显式化提示语(ADR-0002):头部告知底座可能不完整,并把重调主动权交回调用方。
// 固定英文:提示语属于工具输出的稳定契约,不跟随提问语言(ADR-0002)。
function truncationNotice(): string {
  return (
    "Note: the vision model's output hit the token limit, so the transcription base may be incomplete " +
    "(truncation usually cuts the tail). To get the full content, narrow the scope or call describe_image " +
    "again with a more focused question."
  );
}
