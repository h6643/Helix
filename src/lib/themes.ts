// The palettes below are transcribed verbatim from the user's AnuPpuccin
// theme CSS (`--ctp-ext-*` RGB triplets). Each flavor is mapped onto Helix's
// shadcn-style CSS custom properties so the whole UI re-skins when applied.
//
// Applying a flavor injects inline CSS variables onto <html> (documentElement).
// Inline styles win over the `:root` / `.dark` rules in globals.css, so a
// selected flavor fully overrides the built-in cream palette without us having
// to ship a giant CSS block.
//
// 配色风格只保留两档：浅色（陶土晨光）/ 深色（灰黑）。内置奶油与陶土终端
// 已下架——旧存的 styleId 由 normalizeThemeStyle 迁移到最近的新档。

type ThemeMode = "light" | "dark";

/** Raw Catppuccin palette (RGB triplets as "r, g, b"). */
interface CtpPalette {
  rosewater: string;
  flamingo: string;
  pink: string;
  mauve: string;
  red: string;
  maroon: string;
  peach: string;
  yellow: string;
  green: string;
  teal: string;
  sky: string;
  sapphire: string;
  blue: string;
  lavender: string;
  text: string;
  subtext1: string;
  subtext0: string;
  overlay2: string;
  overlay1: string;
  overlay0: string;
  surface2: string;
  surface1: string;
  surface0: string;
  base: string;
  mantle: string;
  crust: string;
}

interface HelixThemeDef {
  id: string;
  label: string;
  mode: ThemeMode;
  ctp: CtpPalette;
  /** Paired flavor id for the opposite mode (used by the light/dark toggle). */
  pair?: string;
  /** Override --primary and --ring with this RGB triplet instead of ctp.blue. */
  primaryOverride?: string;
}

const P = (p: CtpPalette): CtpPalette => p;

// ── Light flavors ─────────────────────────────────────────────────────────────
const whiteLight: CtpPalette = P({
  rosewater: "238, 158, 125",
  flamingo: "228, 140, 128",
  pink: "198, 112, 115",
  mauve: "155, 105, 142",
  red: "185, 65, 50",
  maroon: "192, 75, 55",
  peach: "205, 112, 48",
  yellow: "178, 142, 42",
  green: "48, 132, 65",
  teal: "42, 132, 118",
  sky: "55, 125, 155",
  sapphire: "65, 115, 162",
  blue: "85, 112, 148",
  lavender: "138, 112, 175",
  text: "40, 40, 40",
  subtext1: "100, 100, 100",
  subtext0: "140, 140, 140",
  overlay2: "120, 120, 120",
  overlay1: "155, 155, 155",
  overlay0: "185, 185, 185",
  surface2: "222, 222, 222",
  surface1: "238, 238, 238",
  surface0: "246, 246, 246",
  base: "255, 255, 255",
  mantle: "255, 255, 255",
  crust: "252, 252, 252",
});

const genericDark: CtpPalette = P({
  rosewater: "245, 224, 220",
  flamingo: "242, 205, 205",
  pink: "245, 194, 231",
  mauve: "203, 166, 247",
  red: "243, 139, 168",
  maroon: "235, 160, 172",
  peach: "250, 179, 135",
  yellow: "249, 226, 175",
  green: "166, 227, 161",
  teal: "148, 226, 213",
  sky: "137, 220, 235",
  sapphire: "116, 199, 236",
  blue: "135, 176, 249",
  lavender: "180, 190, 254",
  text: "255, 255, 255",
  subtext1: "210, 210, 210",
  subtext0: "189, 189, 189",
  overlay2: "168, 168, 168",
  overlay1: "147, 147, 147",
  overlay0: "126, 126, 126",
  surface2: "105, 105, 105",
  surface1: "84, 84, 84",
  surface0: "63, 63, 63",
  base: "44, 44, 44",
  mantle: "26, 26, 26",
  crust: "16, 16, 16",
});

const THEMES: Record<string, HelixThemeDef> = {
  "ctp-terracotta-light": {
    id: "ctp-terracotta-light",
    label: "浅色",
    mode: "light",
    ctp: whiteLight,
    primaryOverride: "30, 30, 30",
  },
  "ctp-generic-dark": {
    id: "ctp-generic-dark",
    label: "深色",
    mode: "dark",
    ctp: genericDark,
  },
};

const DEFAULT_THEME_STYLE = "default";

/** 保留的浅色档（界面显示名「浅色」，源自陶土晨光调色板）。 */
const LIGHT_THEME_STYLE = "ctp-terracotta-light";
/** 保留的深色档（界面显示名「深色」，源自灰黑调色板）。 */
const DARK_THEME_STYLE = "ctp-generic-dark";

/**
 * 迁移表：已下架风格 → 保留档。内置奶油（浅色基调）落到陶土晨光，
 * 陶土终端（深色）落到灰黑。normalizeThemeStyle 兜底未知值也归浅色档。
 */
const REMOVED_STYLE_FALLBACK: Record<string, string> = {
  [DEFAULT_THEME_STYLE]: LIGHT_THEME_STYLE,
  "ctp-royal-velvet": DARK_THEME_STYLE,
};

/**
 * 归一任意历史/未知 styleId 到仍存在的两档之一。所有读取入口
 * （localStorage 直读、持久化恢复、合并兜底）都必须先过这里，否则
 * 旧存的 "default" / "ctp-royal-velvet" 会让下拉框显示不出选中项，
 * 甚至把已删的调色板重新应用回界面。
 */
export function normalizeThemeStyle(styleId: string | null | undefined): string {
  const raw = styleId?.trim() || "";
  if (!raw) return LIGHT_THEME_STYLE;
  return REMOVED_STYLE_FALLBACK[raw] ?? (THEMES[raw] ? raw : LIGHT_THEME_STYLE);
}

/** Returns the theme definition, or null for the built-in cream default. */
function getThemeMeta(
  styleId: string | null | undefined,
): HelixThemeDef | null {
  if (!styleId || styleId === DEFAULT_THEME_STYLE) return null;
  return THEMES[styleId] ?? null;
}

const rgb = (triplet: string): string =>
  `rgb(${triplet
    .split(",")
    .map((s) => s.trim())
    .join(" ")})`;

/** Maps a Catppuccin palette onto Helix's shadcn-style CSS custom properties. */
function buildHelixVars(c: CtpPalette, primaryOverride?: string): Record<string, string> {
  const primary = primaryOverride ?? c.blue;
  return {
    "--background": rgb(c.mantle),
    "--foreground": rgb(c.text),
    "--card": rgb(c.base),
    "--card-foreground": rgb(c.text),
    "--popover": rgb(c.crust),
    "--popover-foreground": rgb(c.text),
    "--primary": rgb(primary),
    "--primary-foreground": rgb(c.base),
    "--secondary": rgb(c.surface0),
    "--secondary-foreground": rgb(c.text),
    "--muted": rgb(c.surface0),
    "--muted-foreground": rgb(c.subtext0),
    "--accent": rgb(c.surface0),
    "--accent-foreground": rgb(c.text),
    "--destructive": rgb(c.red),
    "--border": rgb(c.surface0),
    "--input": rgb(c.surface0),
    "--ring": rgb(primary),
    "--link": rgb(c.mauve),
    "--chart-1": rgb(c.blue),
    "--chart-2": rgb(c.green),
    "--chart-3": rgb(c.peach),
    "--chart-4": rgb(c.mauve),
    "--chart-5": rgb(c.teal),
    "--sidebar": rgb(c.mantle),
    "--sidebar-foreground": rgb(c.text),
    "--sidebar-primary": rgb(primary),
    "--sidebar-primary-foreground": rgb(c.base),
    "--sidebar-accent": rgb(c.surface0),
    "--sidebar-accent-foreground": rgb(c.text),
    "--sidebar-border": rgb(c.surface0),
    "--sidebar-ring": rgb(primary),
  };
}

const VAR_NAMES = Object.keys(buildHelixVars(whiteLight));

/**
 * Applies a theme style by writing inline CSS variables onto <html>.
 * Inline styles outrank globals.css `:root` / `.dark`, so a flavor fully
 * overrides the built-in cream palette. `null` / 'default' clears overrides
 * and lets the cream light/dark theme take over again.
 */
export function applyHelixPalette(styleId: string | null | undefined): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const meta = getThemeMeta(styleId);
  if (!meta) {
    VAR_NAMES.forEach((name) => root.style.removeProperty(name));
    // 深色 flavor 会往 <html> 上挂 `.dark`，如果不
    // 摘掉，切回内置时界面仍是深色 slate。唯一保留暗色的情况是用户在个性化面板
    // 里显式切换过暗色（helix-theme），此时内置主题就应保持其暗色外观。
    let dark = false;
    try {
      dark = localStorage.getItem("helix-theme") === "dark";
    } catch {
      /* localStorage 不可用时按浅色处理 */
    }
    if (dark) {
      root.classList.add("dark");
      root.style.colorScheme = "dark";
    } else {
      root.classList.remove("dark");
      root.style.colorScheme = "";
    }
    return;
  }
  if (meta.mode === "dark") {
    root.classList.add("dark");
    root.style.colorScheme = "dark";
  } else {
    root.classList.remove("dark");
    root.style.colorScheme = "light";
  }
  const vars = buildHelixVars(meta.ctp, meta.primaryOverride);
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}

/**
 * 配色风格 → 代码高亮主题（浅色 / 深色各一套 shiki 主题 id）。
 *
 * 「配色风格」选的是界面皮肤（Catppuccin 风味），之前与代码高亮完全脱钩：
 * 预览卡写死 github-light-default / github-dark-dimmed，卡片下方还印着裸
 * 主题 id，看上去像在报字体名。这里把两者接上——每个风格给出与其观感
 * 配套的一对代码主题，用户换风格时预览卡同步换色。
 *
 * default（奶油）保持与 shiki-code.tsx 的 SHIKI_THEMES 完全一致：
 * 实际对话里的代码块就用这一对，预览必须与之一致，否则预览毫无参考价值。
 *
 * 配色只留两档后仍按档配对：陶土晨光 → Latte / GitHub 深色，
 * 灰黑 → GitHub 浅色 / Vitesse Black。未知 id（不应再发生，
 * normalizeThemeStyle 已归一）回落到陶土晨光那一对。
 */
interface CodeThemePair {
  light: string;
  dark: string;
  /** 卡副标题用的中文主题名（不暴露裸 id，避免被误读成字体）。 */
  lightLabel: string;
  darkLabel: string;
}

const CODE_THEMES: Record<string, CodeThemePair> = {
  [LIGHT_THEME_STYLE]: {
    light: "catppuccin-latte",
    dark: "github-dark-dimmed",
    lightLabel: "Catppuccin Latte",
    darkLabel: "GitHub 深色",
  },
  [DARK_THEME_STYLE]: {
    light: "github-light-default",
    dark: "vitesse-black",
    lightLabel: "GitHub 浅色",
    darkLabel: "Vitesse Black",
  },
};

const DEFAULT_CODE_THEMES = CODE_THEMES[LIGHT_THEME_STYLE];

/** 取某风格对应的代码主题对；未知/空 id 回落到默认那一对。 */
export function codeThemesFor(styleId: string | null | undefined): CodeThemePair {
  return (styleId && CODE_THEMES[styleId]) || DEFAULT_CODE_THEMES;
}

/** Dropdown option groups for the appearance panel. */
export const THEME_SELECT_GROUPS: {
  label: string;
  options: { value: string; label: string }[];
}[] = [
  {
    label: "配色",
    options: [
      { value: LIGHT_THEME_STYLE, label: "浅色" },
      { value: DARK_THEME_STYLE, label: "深色" },
    ],
  },
];
