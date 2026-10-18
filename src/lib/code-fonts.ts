/**
 * 代码等宽字体清单（编辑器 + diff 共用）。
 *
 * 之前选项散在两处、且各说各话：
 *  - appearance-settings-panel 的「代码字体」：Geist Mono / Monaco / JetBrains
 *    Mono / Fira Code / Consolas / SF Mono —— 这几个里除 Consolas 外，
 *    Windows 默认一个都没有（Geist Mono、Fira Code、SF Mono、Monaco 都是
 *    macOS/Linux 侧或需手动安装的字体）。选它们不会报错，只是静默回落到
 *    系统 monospace，用户看到「选了没生效」。
 *  - customize-panel 的「编辑器字体」：Inter / SF Pro / system-ui / monospace
 *    —— 写的是同一个 store 字段，但那四个都不是等宽字体，选项本身就是错的。
 *
 * 现在统一到这一个清单：栈里只放 Windows 10/11 自带的字体 + 本机确实装了
 * 的开源等宽字体，每一项都能真正生效；跨平台仍可用（缺的那一级会继续往后
 * 落到 Consolas / monospace）。
 */

/** 默认栈：按「观感 → 覆盖率」排序，每一级都是 Windows 自带或本机已装。 */
export const DEFAULT_CODE_FONT =
  '"Cascadia Code", "JetBrains Mono SemiBold", Consolas, "Lucida Console", monospace';

export interface CodeFontOption {
  label: string;
  value: string;
  /**
   * 下拉列表里标签用该字体自身渲染（所见即所得："JetBrains Mono" 这几个字
   * 就用 JetBrains Mono 显示）。缺省（如「默认」这种组合栈）则用界面字体，
   * 避免把一个混合栈误显示成某个具体字体的观感。
   */
  fontFamily?: string;
  /** 仅在本机装了该字体时提示，避免"选了没反应"的困惑。 */
  note?: string;
}

export const CODE_FONT_OPTIONS: CodeFontOption[] = [
  { label: "默认", value: DEFAULT_CODE_FONT },
  // 注：本机装的是 JetBrains Mono 的 SemiBold 字重，其 family 名就叫
  // "JetBrains Mono SemiBold"，写 "JetBrains Mono" 匹配不到（只有 weight 400
  // 的常规族才叫那个名字），会静默回落到 Consolas —— 所以这里写全名。
  {
    label: "JetBrains Mono",
    value: '"JetBrains Mono SemiBold", Consolas, monospace',
    fontFamily: '"JetBrains Mono SemiBold", Consolas, monospace',
  },
  {
    label: "Ubuntu Mono",
    value: '"Ubuntu Mono", Consolas, monospace',
    fontFamily: '"Ubuntu Mono", Consolas, monospace',
  },
  {
    label: "Cascadia Code",
    value: '"Cascadia Code", Consolas, monospace',
    fontFamily: '"Cascadia Code", Consolas, monospace',
    note: "需 Windows Terminal 或 VS",
  },
  {
    label: "Consolas",
    value: 'Consolas, "Lucida Console", monospace',
    fontFamily: 'Consolas, "Lucida Console", monospace',
  },
  {
    label: "Lucida Console",
    value: '"Lucida Console", Consolas, monospace',
    fontFamily: '"Lucida Console", Consolas, monospace',
  },
  {
    label: "Courier New",
    value: '"Courier New", monospace',
    fontFamily: '"Courier New", monospace',
  },
];

/**
 * 能真正命中的 family 名（精确匹配，大小写不敏感）。
 *
 * 关键：列表里**没有** 裸名 "JetBrains Mono"。本机装的是 SemiBold 字重，
 * 它的 family 名就叫 "JetBrains Mono SemiBold"（读 ttf 的 name 表 nameID=1
 * 实测得到），裸名匹配不到 —— 旧选项列表里的 "JetBrains Mono" 一直在静默
 * 回落成 Consolas。如果把裸名也列为「可用」，旧设置就会被误判成有效而
 * 原样保留，用户看到的仍是 Consolas。
 *
 * Cascadia Code 也不在本机，但它是**在售选项**（装了 Windows Terminal /
 * VS 就有），所以必须留着：用户主动选了它就该保留。
 */
const RESOLVABLE_FAMILIES = [
  "Cascadia Code",
  "JetBrains Mono SemiBold",
  "Ubuntu Mono",
  "Consolas",
  "Lucida Console",
  "Courier New",
];

/**
 * 旧版本里存在、但 Windows 上根本没装的字体值。
 *
 * 这些值仍可能留在 localStorage / 后端设置里（旧版写进去的）。照原样回填到
 * CSS 会静默回落成系统 monospace，用户看着像"设置没保存"。迁移到默认栈，
 * 一次解决，不必让用户手动重选。
 *
 * 判定用「栈里没有任何一个具名字体在本机可用」而非精确字符串相等：用户可能
 * 通过旧版 customize-panel 存下过 Inter / SF Pro 这类非等宽值，也可能自己
 * 拼过混合栈。只要有一个级别能命中就认为这份设置有效，不动用户的选择。
 */
export function normalizeCodeFont(stored: string | null | undefined): string {
  if (!stored || stored.trim() === "") return DEFAULT_CODE_FONT;
  const v = stored.trim();
  const families = v.match(/"([^"]+)"|'([^']+)'|([A-Za-z][\w -]*)/g) ?? [];
  const named = families
    .map((f) => f.replace(/^["']|["']$/g, "").trim())
    .filter(
      (f) =>
        f !== "" &&
        !/^(monospace|sans-serif|serif|ui-monospace|inherit|cursive|fantasy)$/i.test(
          f,
        ),
    );
  if (named.length === 0) return DEFAULT_CODE_FONT;
  const usable = named.some((f) =>
    RESOLVABLE_FAMILIES.some((i) => i.toLowerCase() === f.toLowerCase()),
  );
  return usable ? v : DEFAULT_CODE_FONT;
}