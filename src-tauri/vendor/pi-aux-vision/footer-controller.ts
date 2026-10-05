/**
 * footer controller:会话级、事件驱动的接线模块。
 *
 * 决策逻辑在纯函数层(footer.ts:reduceFooter / footerParts / projectFooterConfig / colorFooter),
 * 本模块只做接线:持有会话内状态与 footer key(闭包内)、每次事件重读磁盘配置、
 * 把状态投影为上色文本写入 ui。
 *
 * 窄接口:`FooterUI = { setStatus; theme }`,扩展入口的 ctx.ui 结构上满足,
 * 事件点以 footer.on(event, ctx.ui) 一行转发。
 *
 * 事件处理链(每次事件):reduceFooter(转移状态)→ readVisionConfig(重读 config.yaml)
 * → projectFooterConfig → footerParts → colorFooter → ui.setStatus(footerKey, ...)。
 */
import { readVisionConfig } from "./config";
import {
  INITIAL_FOOTER_STATE,
  colorFooter,
  footerParts,
  projectFooterConfig,
  reduceFooter,
  type FooterEvent,
  type FooterState,
  type FooterTheme,
} from "./footer";

/** footer 写入窄接口:key 由 controller 内部持有,调用方(扩展入口)只需传入 ctx.ui。 */
export interface FooterUI {
  setStatus(key: string, text: string | undefined): void;
  theme: FooterTheme;
}

export interface FooterController {
  /** 事件入口:转移状态 → 重读配置 → 投影 → 上色 → 写入 footer。 */
  on(event: FooterEvent, ui: FooterUI): void;
}

/** 闭包工厂:状态收在闭包内,footer key 归 controller 所有。 */
export function createFooterController(): FooterController {
  const FOOTER_KEY = "aux-vision";
  let state: FooterState = INITIAL_FOOTER_STATE;

  return {
    on(event, ui) {
      state = reduceFooter(state, event);
      const parts = footerParts(state, projectFooterConfig(readVisionConfig()));
      if (!parts) {
        ui.setStatus(FOOTER_KEY, undefined);
        return;
      }
      ui.setStatus(FOOTER_KEY, colorFooter(parts, ui.theme));
    },
  };
}
