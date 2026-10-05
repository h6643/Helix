/**
 * pi-aux-vision 的 Helix 分支。与上游的两点差别：
 *   1) 视觉模型只读 Helix `config.yaml` 的 `vision:` 块（「设置 → 视觉模型」是唯一写入方），
 *      不再有 aux-vision.json，也不经 pi 的 modelRegistry 找模型 —— 直连 OpenAI 兼容端点。
 *   2) `maxOutputTokens` 固定 1024：上游的 8192 会被 glm-4v-flash 一类小上限模型 400 拒掉。
 *
 * 本目录是唯一权威副本。Helix 每次启动把它写出到
 * `~/.pi/agent/extensions/pi-aux-vision/` 并在 pi 的 settings.json 单点登记，
 * 所以 `pi update` 覆盖 npm 安装版不会影响这里（安装逻辑见 src-tauri/src/pi_extensions.rs）。
 * 上游：https://github.com/hu3rror/pi-aux-vision （MIT，LICENSE 随附）
 */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describeConfigSource, isConfigured, readVisionConfig } from "./config";
import { describeImage, errorResult, isErrorResult, structuredOutputSchema, type DescribeImageResult } from "./vision";
import { generateTestImage } from "./test-image";
import { createFooterController } from "./footer-controller";

const TOOL_NAME = "describe_image";

/** 模型是否支持图像输入:门控只依据这一个字段(pi 目录的 `input`)。 */
function isVisionModel(m: { input?: unknown } | undefined): boolean {
  return Boolean(m && Array.isArray(m.input) && (m.input as unknown[]).includes("image"));
}
const TEST_QUESTION =
  "Describe this test image: repeat all visible text, and state which colors the red, blue, and green blocks are.";
/** 用法与状态的分隔线:notify 为纯文本渲染,markdown 分隔符不生效。 */
const STATUS_DIVIDER = "─".repeat(60);

export default function (pi: ExtensionAPI) {
  let toolRegistered = false;

  // footer controller:状态与 footer key 收在闭包,事件点一行转发
  const footer = createFooterController();

  // 加载期只做注册:动作方法(getActiveTools/setActiveTools)在扩展加载阶段被 pi 禁止,
  // 可见性完全由门控在 session_start/model_select 中决定(ADR-0004)
  registerToolOnce();

  /** 差分控制 describe_image 在当前会话的可见性,不动其他工具。 */
  function ensureToolActive(active: boolean) {
    const current = pi.getActiveTools();
    const has = current.includes(TOOL_NAME);
    if (active && !has) pi.setActiveTools([...current, TOOL_NAME]);
    else if (!active && has) pi.setActiveTools(current.filter((t) => t !== TOOL_NAME));
  }

  /** 加载即注册;注册后立即移出可见集合(pi 0.86 无 defaultActive,稳态等价,ADR-0004)。 */
  function registerToolOnce() {
    if (toolRegistered) return;
    toolRegistered = true;
    pi.registerTool({
      name: TOOL_NAME,
      label: "Describe Image",
      description:
        "Analyze a local image file with the vision model configured in Helix (设置 → 视觉模型) and answer a specific question about it. " +
        "Pass the exact on-disk path and a precise, focused question, e.g. \"extract the stack trace shown in line 4 of the error message\" or \"why is the button shifted 10px to the right?\". " +
        "The tool reads the file once, sends it to the vision model once, and returns text. " +
        "The result ALWAYS begins with an exhaustive transcription base — image type, verbatim transcription of all visible text, and layout/order — followed by the answer to your question and a completeness attestation, so you can reason from the base even about parts you did not ask about. " +
        "If the result says the transcription was truncated (output hit the token limit), call again with a narrower question or scope. " +
        "Only call this when the actual image content matters — never guess content from the path or filename alone.",
      promptSnippet: "Analyze a local image file with the configured vision model, answering a precise question",
      promptGuidelines: [
        "Use describe_image when you need to understand the visual content of an image file on disk — reading error messages or stack traces, checking UI screenshots or layout issues, transcribing text or diagrams. Pass the file path and a precise question; never guess image content from the path alone.",
      ],
      parameters: Type.Object({
        image_path: Type.String({
          description: "Absolute or workspace-relative path to the image file on disk (png/jpeg/gif/webp/bmp)",
        }),
        question: Type.String({
          description:
            "What to analyze or extract from the image. Be specific: 'Describe all UI elements and their positions', 'Read all text in this screenshot', 'What error is shown?', 'Give coordinates of the submit button', etc.",
        }),
      }),
      outputSchema: structuredOutputSchema,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const result = await runDescribe(params, ctx, signal);
        // 任何调用(含失败)都算触发:footer 显示模型并保持到会话结束
        footer.on({ type: "call", ok: !isErrorResult(result) }, ctx.ui);
        return result;
      },
    });
  }

  /** describe_image 主体:读 config.yaml 的视觉端点并直连调用;供 execute 触发 footer 事件。 */
  async function runDescribe(
    params: { image_path: string; question: string },
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<DescribeImageResult> {
    const cfg = readVisionConfig();
    if (!isConfigured(cfg)) {
      return errorResult(
        "No vision model is configured, so describe_image cannot run. " +
          "Set one in Helix: 设置 → 视觉模型 (writes the `vision:` block of the Helix config.yaml).",
      );
    }
    return describeImage(params, ctx, cfg, signal);
  }

  /**
   * 门控核心(ADR-0004):工具可见 ⇔ 已配置视觉模型 && 当前模型已定且盲。
   * 主模型自己能读图时不暴露 —— 直连视觉输入更准,也省掉一次额外调用。
   * 返回值表示本次是否为"新暴露",供 model_select 决定是否提示。
   */
  function syncToolVisibility(ctx: ExtensionContext): boolean {
    const main = ctx.model;
    const active = isConfigured(readVisionConfig()) && Boolean(main) && !isVisionModel(main);
    const wasActive = pi.getActiveTools().includes(TOOL_NAME);
    ensureToolActive(active);
    return active && !wasActive;
  }

  /** 门控状态描述:/vision status 展示用(ADR-0004)。 */
  function gatingNote(ctx: ExtensionContext, configured: boolean): string {
    if (!configured) return "Gating: no vision model in config.yaml; describe_image is not exposed";
    if (!ctx.model) return "Gating: session model not set; describe_image not exposed yet";
    return isVisionModel(ctx.model)
      ? "Gating: session model reads images natively; describe_image is not exposed"
      : "Gating: session model cannot read images; describe_image is exposed";
  }

  pi.on("session_start", (_event, ctx) => {
    // 新会话:footer 回到未触发(不显示)
    footer.on({ type: "reset" }, ctx.ui);
    syncToolVisibility(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    // 盲→视觉:静默退出;视觉→盲:工具出现时提示一次(ADR-0004)
    if (syncToolVisibility(ctx)) {
      ctx.ui.notify("aux-vision: describe_image is now exposed (session model cannot read images).", "info");
    }
  });

  pi.registerCommand("vision", {
    description: "Inspect describe_image and run an end-to-end check against the configured vision model",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const subcommands = ["status", "test"];
      if (!prefix || !prefix.includes(" ")) {
        return subcommands.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      }
      if (prefix.trimStart().startsWith("test ")) {
        return [{ value: "test <path>", label: "test <path> — test with a specific image file" }];
      }
      return [];
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] ?? "";
      const cfg = readVisionConfig();
      const configured = isConfigured(cfg);
      const level = configured ? "info" : "warning";
      switch (sub) {
        case "status": {
          ctx.ui.notify(`${describeConfigSource(cfg)}\n${STATUS_DIVIDER}\n${gatingNote(ctx, configured)}`, level);
          return;
        }
        case "test": {
          if (!configured) {
            ctx.ui.notify(
              "aux-vision: no vision model configured; cannot test. Set one in Helix 设置 → 视觉模型.",
              "warning",
            );
            return;
          }
          const imagePath = parts.slice(1).join(" ") || (await generateTestImage());
          ctx.ui.notify(`aux-vision: analyzing ${imagePath} with ${cfg.provider}/${cfg.model} ...`, "info");
          const result = await describeImage({ image_path: imagePath, question: TEST_QUESTION }, ctx, cfg, ctx.signal);
          // /vision test 也是本会话内实际调用视觉模型:与 execute 一致,成功/失败都算触发
          const testFailed = isErrorResult(result);
          footer.on({ type: "call", ok: !testFailed }, ctx.ui);
          if (testFailed) {
            ctx.ui.notify(`aux-vision test failed: ${result.content[0].text}`, "error");
            return;
          }
          const text = result.content[0].text;
          const ellipsis = text.length > 300 ? " …" : "";
          ctx.ui.notify(
            `aux-vision test passed (${cfg.provider}/${cfg.model}): ${text.slice(0, 300)}${ellipsis}`,
            "info",
          );
          return;
        }
        default: {
          ctx.ui.notify(
            `Usage: /vision status | test [path]\n${STATUS_DIVIDER}\n${describeConfigSource(cfg)}\n${gatingNote(ctx, configured)}`,
            configured ? "info" : "warning",
          );
          return;
        }
      }
    },
  });
}
