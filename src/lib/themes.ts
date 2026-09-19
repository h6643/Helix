// The 25 palettes below are transcribed verbatim from the user's AnuPpuccin
// theme CSS (`--ctp-ext-*` RGB triplets). Each flavor is mapped onto Helix's
// shadcn-style CSS custom properties so the whole UI re-skins when applied.
//
// Applying a flavor injects inline CSS variables onto <html> (documentElement).
// Inline styles win over the `:root` / `.dark` rules in globals.css, so a
// selected flavor fully overrides the built-in cream palette without us having
// to ship a giant CSS block.

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
const atomLight: CtpPalette = P({
  rosewater: "229, 148, 121",
  flamingo: "197, 103, 131",
  pink: "166, 37, 104",
  mauve: "166, 37, 164",
  red: "231, 85, 69",
  maroon: "231, 101, 69",
  peach: "227, 86, 73",
  yellow: "152, 104, 0",
  green: "78, 162, 76",
  teal: "0, 188, 182",
  sky: "0, 132, 188",
  sapphire: "0, 119, 188",
  blue: "61, 116, 246",
  lavender: "152, 84, 151",
  text: "56, 58, 66",
  subtext1: "77, 80, 91",
  subtext0: "99, 102, 116",
  overlay2: "123, 124, 138",
  overlay1: "148, 148, 158",
  overlay0: "174, 173, 179",
  surface2: "201, 197, 197",
  surface1: "218, 216, 216",
  surface0: "237, 237, 237",
  base: "250, 250, 250",
  mantle: "234, 234, 235",
  crust: "219, 219, 220",
});


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
  surface0: "248, 248, 248",
  base: "255, 255, 255",
  mantle: "250, 250, 250",
  crust: "240, 240, 240",
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
  base: "42, 42, 42",
  mantle: "21, 21, 21",
  crust: "0, 0, 0",
});

const royalVelvetDark: CtpPalette = P({
  rosewater: "246, 201, 153",
  flamingo: "245, 189, 166",
  pink: "228, 157, 248",
  mauve: "197, 146, 222",
  red: "240, 120, 160",
  maroon: "230, 102, 102",
  peach: "230, 195, 125",
  yellow: "241, 250, 140",
  green: "130, 235, 130",
  teal: "114, 224, 214",
  sky: "139, 233, 253",
  sapphire: "104, 197, 240",
  blue: "95, 126, 222",
  lavender: "154, 141, 247",
  text: "248, 248, 242",
  subtext1: "211, 211, 197",
  subtext0: "191, 191, 181",
  overlay2: "139, 143, 167",
  overlay1: "110, 114, 145",
  overlay0: "88, 92, 116",
  surface2: "68, 71, 90",
  surface1: "56, 59, 76",
  surface0: "48, 50, 65",
  base: "30, 30, 36",
  mantle: "25, 25, 30",
  crust: "20, 20, 25",
});

const THEMES: Record<string, HelixThemeDef> = {
  "ctp-terracotta-light": {
    id: "ctp-terracotta-light",
    label: "陶土晨光",
    mode: "light",
    ctp: whiteLight,
    primaryOverride: "30, 30, 30",
  },
  "ctp-generic-dark": {
    id: "ctp-generic-dark",
    label: "Grayscale 灰黑",
    mode: "dark",
    ctp: genericDark,
  },
  "ctp-royal-velvet": {
    id: "ctp-royal-velvet",
    label: "陶土终端",
    mode: "dark",
    ctp: royalVelvetDark,
  },
};

const DEFAULT_THEME_STYLE = "default";

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

const VAR_NAMES = Object.keys(buildHelixVars(atomLight));

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

/** Dropdown option groups for the appearance panel. */
export const THEME_SELECT_GROUPS: {
  label: string;
  options: { value: string; label: string }[];
}[] = [
  {
    label: "浅色",
    options: [
      { value: DEFAULT_THEME_STYLE, label: "奶油" },
      { value: "ctp-terracotta-light", label: "陶土晨光" },
    ],
  },
  {
    label: "深色",
    options: [
      { value: "ctp-generic-dark", label: "灰黑" },
      { value: "ctp-royal-velvet", label: "陶土终端" },
    ],
  },
];
