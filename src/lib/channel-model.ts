/**
 * 渠道模型显示名（pi-connect 扩展把倍率/促销拼进 pi 的 `name`）的解析。
 *
 * 只在展示层工作：路由、勾选、set_model 一律用裸 id。
 */

/** 扩展侧的分段分隔符（与 pi-connect 的 RATE_SEPARATOR 一致）。 */
const SEP = " · ";

/** `x0.50` / `x 0.50` / `0.50x` 都可能出现在上游目录里。 */
const FACTOR_RE = /x\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*x/i;

/** 目录里也有只给数字、不带 x 的倍率（`credits: "0.29"`）。 */
const BARE_NUMBER_RE = /^\d+(?:\.\d+)?$/;

const FREE_RE = /^免费$/;

export type ChannelModelLabel = {
  name: string;
  /** 右对齐的倍率列，如 `x0.50`；免费 = `x0.00`；无倍率时为空串。 */
  factor: string;
  /** 倍率之外的注记（错峰、夜间免费、促销区间……），保持上游措辞。 */
  notes: string[];
};

export function parseChannelModelLabel(label: string): ChannelModelLabel {
  const segments = label.split(SEP);
  const name = (segments.shift() ?? label).trim();
  const notes: string[] = [];
  let factor = "";
  for (const segment of segments) {
    const text = segment.trim();
    if (text === "") continue;
    if (factor === "" && FREE_RE.test(text)) {
      factor = "x0.00";
      continue;
    }
    if (factor === "") {
      const match = FACTOR_RE.exec(text);
      if (match) {
        const value = Number.parseFloat(match[1] ?? match[2]);
        if (Number.isFinite(value)) {
          factor = `x${value.toFixed(2)}`;
          const rest = `${text.slice(0, match.index)} ${text.slice(
            match.index + match[0].length,
          )}`.trim();
          if (rest !== "") notes.push(rest);
          continue;
        }
      }
      if (BARE_NUMBER_RE.test(text)) {
        factor = `x${Number.parseFloat(text).toFixed(2)}`;
        continue;
      }
    }
    notes.push(text);
  }
  return { name, factor, notes };
}

/**
 * 保持原排版的最小改写：把「免费」段换成 `x0.00`，倍率数值统一两位小数。
 * 用于按钮芯片、tooltip 这类必须单行显示的场合。
 */
export function formatChannelModelLabel(label: string): string {
  const { name, factor, notes } = parseChannelModelLabel(label);
  if (factor === "") return [name, ...notes].filter(Boolean).join(SEP);
  return [name, `${factor}${notes.length > 0 ? ` ${notes.join(SEP)}` : ""}`]
    .filter(Boolean)
    .join(SEP);
}
