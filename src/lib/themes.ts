// Catppuccin / AnuPpuccin theme registry for Helix.
//
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

const everforestLight: CtpPalette = P({
  rosewater: "222, 177, 145",
  flamingo: "221, 181, 194",
  pink: "233, 130, 190",
  mauve: "184, 122, 156",
  red: "248, 85, 82",
  maroon: "248, 104, 82",
  peach: "245, 125, 38",
  yellow: "191, 152, 61",
  green: "137, 156, 64",
  teal: "86, 157, 121",
  sky: "86, 157, 139",
  sapphire: "86, 157, 138",
  blue: "90, 147, 162",
  lavender: "208, 161, 187",
  text: "92, 106, 114",
  subtext1: "114, 125, 132",
  subtext0: "135, 150, 134",
  overlay2: "147, 159, 145",
  overlay1: "164, 173, 158",
  overlay0: "223, 219, 200",
  surface2: "227, 224, 204",
  surface1: "237, 234, 213",
  surface0: "243, 239, 218",
  base: "253, 246, 227",
  mantle: "246, 241, 221",
  crust: "240, 237, 216",
});

const solarizedLight: CtpPalette = P({
  rosewater: "227, 131, 89",
  flamingo: "241, 142, 168",
  pink: "211, 54, 130",
  mauve: "108, 113, 196",
  red: "220, 50, 47",
  maroon: "220, 60, 46",
  peach: "203, 75, 22",
  yellow: "181, 137, 0",
  green: "133, 153, 0",
  teal: "42, 161, 152",
  sky: "42, 145, 161",
  sapphire: "39, 168, 211",
  blue: "38, 139, 210",
  lavender: "139, 143, 222",
  text: "0, 43, 54",
  subtext1: "7, 54, 66",
  subtext0: "10, 76, 92",
  overlay2: "77, 96, 102",
  overlay1: "88, 110, 117",
  overlay0: "101, 123, 131",
  surface2: "131, 148, 150",
  surface1: "145, 160, 161",
  surface0: "173, 184, 184",
  base: "253, 246, 227",
  mantle: "237, 232, 214",
  crust: "224, 215, 184",
});

const terracottaLight: CtpPalette = P({
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
  text: "45, 38, 32",
  subtext1: "105, 95, 82",
  subtext0: "148, 138, 122",
  overlay2: "122, 115, 102",
  overlay1: "155, 148, 132",
  overlay0: "185, 178, 162",
  surface2: "192, 182, 165",
  surface1: "208, 200, 185",
  surface0: "225, 218, 205",
  base: "252, 248, 240",
  mantle: "244, 238, 226",
  crust: "235, 228, 215",
});

const terracottaDark: CtpPalette = P({
  rosewater: "238, 148, 95",
  flamingo: "228, 132, 108",
  pink: "215, 112, 128",
  mauve: "178, 128, 168",
  red: "228, 118, 98",
  maroon: "218, 108, 92",
  peach: "228, 138, 82",
  yellow: "215, 172, 78",
  green: "135, 188, 108",
  teal: "95, 182, 162",
  sky: "125, 175, 202",
  sapphire: "108, 162, 192",
  blue: "125, 158, 185",
  lavender: "162, 148, 202",
  text: "242, 236, 228",
  subtext1: "185, 175, 162",
  subtext0: "142, 132, 118",
  overlay2: "158, 148, 135",
  overlay1: "122, 112, 100",
  overlay0: "95, 88, 78",
  surface2: "85, 78, 68",
  surface1: "70, 62, 54",
  surface0: "55, 50, 42",
  base: "38, 34, 28",
  mantle: "30, 27, 22",
  crust: "22, 20, 16",
});

// ── Dark flavors ──────────────────────────────────────────────────────────────
const draculaDark: CtpPalette = P({
  rosewater: "246, 201, 153",
  flamingo: "245, 189, 166",
  pink: "228, 157, 248",
  mauve: "189, 147, 249",
  red: "255, 85, 85",
  maroon: "230, 102, 102",
  peach: "255, 184, 108",
  yellow: "241, 250, 140",
  green: "80, 250, 123",
  teal: "104, 219, 211",
  sky: "139, 233, 253",
  sapphire: "104, 197, 240",
  blue: "95, 126, 222",
  lavender: "197, 146, 222",
  text: "248, 248, 242",
  subtext1: "211, 211, 197",
  subtext0: "191, 191, 181",
  overlay2: "139, 143, 167",
  overlay1: "110, 114, 145",
  overlay0: "88, 92, 116",
  surface2: "68, 71, 90",
  surface1: "56, 59, 76",
  surface0: "48, 50, 65",
  base: "40, 42, 54",
  mantle: "33, 34, 44",
  crust: "26, 27, 35",
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
  "ctp-everforest-light": {
    id: "ctp-everforest-light",
    label: "Everforest 淡绿",
    mode: "light",
    ctp: everforestLight,
    pair: "ctp-terracotta-dark",
  },
  "ctp-solarized-light": {
    id: "ctp-solarized-light",
    label: "Solarized 橙红",
    mode: "light",
    ctp: solarizedLight,
  },
  "ctp-terracotta-light": {
    id: "ctp-terracotta-light",
    label: "陶土晨光",
    mode: "light",
    ctp: terracottaLight,
    pair: "ctp-terracotta-dark",
  },

  "ctp-dracula": {
    id: "ctp-dracula",
    label: "Dracula 暗紫",
    mode: "dark",
    ctp: draculaDark,
  },
  "ctp-generic-dark": {
    id: "ctp-generic-dark",
    label: "Grayscale 灰黑",
    mode: "dark",
    ctp: genericDark,
  },
  "ctp-royal-velvet": {
    id: "ctp-royal-velvet",
    label: "Royal Velvet 紫绒",
    mode: "dark",
    ctp: royalVelvetDark,
  },
  "ctp-terracotta-dark": {
    id: "ctp-terracotta-dark",
    label: "陶土终端",
    mode: "dark",
    ctp: terracottaDark,
    pair: "ctp-terracotta-light",
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
function buildHelixVars(c: CtpPalette): Record<string, string> {
  return {
    "--background": rgb(c.mantle),
    "--foreground": rgb(c.text),
    "--card": rgb(c.base),
    "--card-foreground": rgb(c.text),
    "--popover": rgb(c.crust),
    "--popover-foreground": rgb(c.text),
    "--primary": rgb(c.blue),
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
    "--ring": rgb(c.blue),
    "--link": rgb(c.mauve),
    "--chart-1": rgb(c.blue),
    "--chart-2": rgb(c.green),
    "--chart-3": rgb(c.peach),
    "--chart-4": rgb(c.mauve),
    "--chart-5": rgb(c.teal),
    "--sidebar": rgb(c.mantle),
    "--sidebar-foreground": rgb(c.text),
    "--sidebar-primary": rgb(c.blue),
    "--sidebar-primary-foreground": rgb(c.base),
    "--sidebar-accent": rgb(c.surface0),
    "--sidebar-accent-foreground": rgb(c.text),
    "--sidebar-border": rgb(c.surface0),
    "--sidebar-ring": rgb(c.blue),
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
    // 内置（默认）回到奶油浅色。深色 flavor 会往 <html> 上挂 `.dark`，如果不
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
  const vars = buildHelixVars(meta.ctp);
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
      { value: DEFAULT_THEME_STYLE, label: "默认（奶油）" },
      { value: "ctp-everforest-light", label: "Everforest 淡绿" },
      { value: "ctp-solarized-light", label: "Solarized 橙红" },
      { value: "ctp-terracotta-light", label: "陶土晨光" },
    ],
  },
  {
    label: "深色",
    options: [
      { value: "ctp-dracula", label: "Dracula 暗紫" },
      { value: "ctp-generic-dark", label: "Grayscale 灰黑" },
      { value: "ctp-royal-velvet", label: "Royal Velvet 紫绒" },
      { value: "ctp-terracotta-dark", label: "陶土终端" },
    ],
  },
];
