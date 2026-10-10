/**
 * 思考过程健康度检测。
 *
 * 独立成模块（而不是塞进 transcript-message.tsx）有两个原因：
 * 1. 它们是**纯文本函数**，与 React 无关 —— 便于单测直接跑真实实现，
 *    不会因打包 UI 依赖而把测试拖下水。
 * 2. 呼叫方不止转录组件：agent-flow-panel 的 done 收尾也要用。
 */

/**
 * 「退化 reasoning」检测 —— 判断一段思考是不是陷入了自重复循环。
 *
 * 背景（2026-10-03 实测，见 .workbuddy/memory/2026-10-03.md）：小模型
 * （`sensenova-6.8-flash-lite`）在 thinkingLevel=high 下会对「Let me do it /
 * Let me run / Let me call」这类**工具调用前的仪式语**产生自重复吸引子 ——
 * reasoning 涨到 2.4 万字符、重复 978 次，却一次 `toolCall` 都没发出，整轮
 * `stopReason: aborted` + `usage 0/0`。模型自己都知道（thinking 原文：
 * "I literally output a bunch of 'Let me do it...' without making any tool call"）。
 *
 * 判据 = **尾部 4-gram 重复率**：把尾部 N 字符切成词、统计每个 4-gram
 * 出现了几次。真实会话校准结果：正常轮次 p50=0.01 / p90=0.06 / max=0.674；
 * 退化轮次 0.73~0.91。
 *
 * @param tailChars 取尾部多少字符参与统计
 */
function reasoningRepetitionRatio(
  text: string,
  tailChars = 2000,
): number {
  const tail = (text || "").slice(-tailChars);
  // 只保留字母数字与 CJK，其余（标点/换行）当分隔符
  const words = tail
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 12) return 0;
  const grams = new Map<string, number>();
  let total = 0;
  for (let i = 0; i + 4 <= words.length; i++) {
    const g = words.slice(i, i + 4).join(" ");
    total++;
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  if (!total) return 0;
  return (total - grams.size) / total;
}

/** 重复率阈值：正常轮次实测最高 0.674，退化轮次最低 0.732，取中间。 */
const DEGENERATE_REASONING_RATIO = 0.7;

/** 长度门槛：正常轮次 p90=5266 字符、max=12307。 */
const DEGENERATE_REASONING_MIN_LEN = 6000;

/**
 * 这段思考是否退化到「只是在原地重复、什么也没推进」。
 *
 * 与 `reasoningRepetitionRatio` 分开是因为**两个条件缺一不可**：
 * 正常长思考里也可能大量复述文件列表（实测行 1022 是正常 toolUse 轮次，
 * 尾部同样是 "Let me do it / Let me run" 那一套，r=0.674）—— 单看重复率会
 * 误伤那些**最终成功发出了 toolCall** 的轮次。而真正该拦的是「重复率极高
 * **且** 长度夸张」：前者是表面现象，后者才说明模型把整轮预算烧在了循环里。
 */
export function isDegenerateReasoning(text: string): boolean {
  if (!text) return false;
  if (text.length < DEGENERATE_REASONING_MIN_LEN) return false;
  return reasoningRepetitionRatio(text) >= DEGENERATE_REASONING_RATIO;
}
