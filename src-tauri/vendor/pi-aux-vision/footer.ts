/**
 * footer 状态机:纯函数,不含任何 ANSI 颜色与 TUI 依赖。
 *
 * 状态:本会话是否已触发过 describe_image 调用、最近一次调用是否失败。
 * 事件:reset(新会话)、call(describe_image 调用完成,含失败)。
 * 输出:`vision: provider/model`(最近一次 call 失败追加 `!`)或 undefined(不显示)。
 *
 * 接线层(footer-controller.ts)负责:持有状态、在事件点调用 reduceFooter、把 config.yaml 的视觉块投影为 FooterConfig、
 * 用 ui.theme 经 colorFooter 上色后写 footer。
 */

import type { VisionConfig } from "./config";

export interface FooterState {
  /** 本会话是否已触发过 describe_image 调用。 */
  triggered: boolean;
  /** 最近一次 describe_image 调用是否失败。 */
  lastCallFailed: boolean;
}

export const INITIAL_FOOTER_STATE: FooterState = { triggered: false, lastCallFailed: false };

export type FooterEvent =
  | { type: "reset" } // 新会话开始
  | { type: "call"; ok: boolean }; // describe_image 调用完成(含文件缺失等未触达模型的错误)

export interface FooterConfig {
  provider: string;
  model: string;
}

/** 事件 → 状态转移。显示哪个模型由 footerParts 依传入的配置决定。 */
export function reduceFooter(state: FooterState, event: FooterEvent): FooterState {
  switch (event.type) {
    case "reset":
      return INITIAL_FOOTER_STATE;
    case "call":
      return { triggered: true, lastCallFailed: !event.ok };
  }
}

/** footer 文本结构:供接线层上色(dim 的 prefix + accent 的 model + error 的 `!`)。 */
export interface FooterParts {
  prefix: string; // "vision: "
  model: string; // "provider/model"
  failed: boolean;
}

/** 状态 + 配置 → 显示内容。本会话未触发过 / 未配置模型 → undefined。 */
export function footerParts(state: FooterState, cfg: FooterConfig): FooterParts | undefined {
  if (!state.triggered) return undefined;
  if (!cfg.model) return undefined;
  return {
    prefix: "vision: ",
    model: cfg.provider ? `${cfg.provider}/${cfg.model}` : cfg.model,
    failed: state.lastCallFailed,
  };
}

/** 上色窄接口:纯函数层不依赖 TUI/ANSI,只约定接线层传入的 theme 需提供 fg。 */
export interface FooterTheme {
  fg(color: "dim" | "accent" | "error", text: string): string;
}

/** FooterParts → 上色文本:dim 前缀 + accent 模型名 + 失败时追加 error 色 `!`。纯函数,theme 由调用方传入。 */
export function colorFooter(parts: FooterParts, theme: FooterTheme): string {
  return (
    theme.fg("dim", parts.prefix) +
    theme.fg("accent", parts.model) +
    (parts.failed ? theme.fg("error", "!") : "")
  );
}

/** config.yaml 的视觉块 → FooterConfig;缺省值(空 provider/model)归此一处。 */
export function projectFooterConfig(cfg: VisionConfig): FooterConfig {
  return { provider: cfg.provider, model: cfg.model };
}
