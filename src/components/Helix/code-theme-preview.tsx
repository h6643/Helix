"use client";

/**
 * 「外观 → 代码预览」用的双主题代码样例卡。
 *
 * 与 HelixMarkdown 里的代码卡不同：那里用 shiki 的 dual theme
 * （github-light-default / github-dark-dimmed + defaultColor:"light-dark()"），
 * 高亮结果会跟随系统明暗一起翻转——单个代码块任何时候只呈现一套配色。
 *
 * 这里要的是「同时预览浅色与深色」：两张卡并排，各自用**单一固定主题**渲染
 * 同一段代码，用户改配色风格时能一眼看出两套主题各自的观感。因此不能复用
 * dual theme，必须分别按单一主题取 token。
 *
 * 用 codeToTokens 而不是 codeToHtml：shiki 的 codeToHtml 不支持行号
 * （lineNumbers 是 CodeMirror 的选项，传给 shiki 会直接类型报错），而截图里
 * 浅色/深色两卡都带行号。自己渲染行还能顺手保证两卡等高、行号列对齐。
 *
 * 当前界面（<html> 上的 .dark）生效的那张卡，右上角标注「当前生效」。
 */

import { memo, useEffect, useMemo, useState } from "react";
import type { ThemedToken } from "shiki";
import { SettingGroup } from "./settings-ui";
import { codeThemesFor, type CodeThemePair } from "@/lib/themes";
import { useHelixStore } from "@/stores/helix-store";

/** 预览样例：刻意覆盖字符串 / 关键字 / 属性名 / 数字 / 类型名，好看出发色差异。 */
const PREVIEW_CODE = `const themePreview: ThemeConfig = {
  surface: "sidebar",
  accent: "#339CFF",
  contrast: 45,
};`;

/** 预览卡代码区高度（px）：5 行代码 + 内边距，深浅两卡共用同一高度。 */
const PREVIEW_HEIGHT = 168;

type ShikiModule = typeof import("shiki");

let shikiPromise: Promise<ShikiModule> | null = null;

function loadShiki(): Promise<ShikiModule> {
  if (!shikiPromise) {
    shikiPromise = import("shiki");
  }

  return shikiPromise;
}

/** 单主题取 token：返回二维数组（行 → token）与主题的前景/背景色。
 *  失败返回 null 让调用方退回纯文本。 */
async function tokenize(
  shiki: ShikiModule,
  theme: string,
): Promise<{ lines: ThemedToken[][]; fg?: string; bg?: string } | null> {
  try {
    const result = await shiki.codeToTokens(PREVIEW_CODE, {
      lang: "typescript",
      theme,
      // 关掉 light-dark()：本卡必须固定一套配色，不随系统明暗翻转。
      defaultColor: false,
    });

    return { lines: result.tokens, fg: result.fg, bg: result.bg };
  } catch {
    return null;
  }
}

const CodePreviewCard = memo(function CodePreviewCard({
  mode,
  isCurrent,
  themes,
}: {
  mode: "light" | "dark";
  isCurrent: boolean;
  themes: CodeThemePair;
}) {
  const [data, setData] = useState<{
    lines: ThemedToken[][];
    fg?: string;
    bg?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadShiki()
      .then((shiki) => tokenize(shiki, themes[mode]))
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });

    return () => {
      cancelled = true;
    };
  }, [mode, themes]);

  return (
    <div className="flex-1 min-w-0">
      {/* 头部：标题 + 主题名 + 「当前生效」角标。
          这里不带内边距——外层容器（SettingGroup 内的 p-4）已经给了 16px，
          再加一层会把文字推到比代码区更靠右的位置，两张卡的头部也会因此
          与代码区左缘不齐。 */}
      <div className="flex items-start justify-between gap-2 pb-3">
        <div className="min-w-0">
          <h5 className="ui-text font-semibold text-foreground">
            {mode === "light" ? "浅色预览" : "深色预览"}
          </h5>
          <p className="ui-text-sm2 text-muted-foreground/70 mt-0.5">
            {mode === "light" ? themes.lightLabel : themes.darkLabel}
          </p>
        </div>
        {isCurrent && (
          <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 ui-text-sm2 text-muted-foreground">
            当前生效
          </span>
        )}
      </div>

      {/* 代码区：固定高度 + 内部滚动，深浅两卡等高。
          背景与文字色来自 shiki 主题的 bg/fg（正是要预览的东西），用内联
          style 而不用 utility class，避免被主题变量覆盖。
          不用 mx/mb：外层卡片已有 p-4，代码区撑满卡片内区（截图即如此）。 */}
      <div
        className="overflow-hidden rounded-lg border border-border/30"
        style={{ height: PREVIEW_HEIGHT }}
      >
        {data ? (
          <div
            className="helix-md-preview-code h-full overflow-auto px-3 py-2"
            style={{
              backgroundColor: data.bg,
              color: data.fg,
            }}
          >
            <CodeBody lines={data.lines} />
          </div>
        ) : (
          <pre
            className="helix-md-preview-code h-full overflow-auto m-0 px-3 py-2 ui-text-sm2 text-foreground/80 whitespace-pre"
          >
            {PREVIEW_CODE}
          </pre>
        )}
      </div>
    </div>
  );
});

/** 行号 + token 渲染。等宽网格：行号列固定宽，代码列跟着对齐。 */
const CodeBody = memo(function CodeBody({ lines }: { lines: ThemedToken[][] }) {
  return (
    <div className="h-full overflow-auto">
      <pre className="m-0 p-0 bg-transparent flex flex-col">
        {lines.map((tokens, i) => (
          <div key={i} className="flex leading-[1.55]">
            <span
              className="shrink-0 w-9 mr-3 text-right select-none"
              style={{ opacity: 0.4, fontVariantNumeric: "tabular-nums" }}
            >
              {i + 1}
            </span>
            <span className="flex-1 whitespace-pre">
              {tokens.length === 0 ? (
                "\n"
              ) : (
                tokens.map((token, j) => (
                  <span key={j} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))
              )}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
});

/**
 * 读取当前界面的明暗，用于决定哪张预览卡标注「当前生效」。
 * 真相在 <html> 的 .dark class 上（applyTheme 写、anti-flash 启动脚本恢复），
 * 用 MutationObserver 跟随，避免为此在 store 里复制一份状态。
 */
function useCurrentTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof document === "undefined") return "light";
    return document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";
  });

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(
        document.documentElement.classList.contains("dark") ? "dark" : "light",
      );
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
}

export function CodeThemePreview() {
  const current = useCurrentTheme();

  // 跟随「配色风格」：风格变了，预览卡跟着换成配套的代码主题。
  const themeStyle = useHelixStore((s) => s.themeStyle);
  const themes = useMemo(() => codeThemesFor(themeStyle), [themeStyle]);

  // 结构与其他分组一致：标题 + 说明独立在卡片上方（用 px-4 与卡片内容
  // 左缘对齐），下面紧跟一张撑满列宽的 SettingGroup 卡片。
  //
  // ⚠️ 预览卡自身绝不能再加 px-4 / mx-4：SettingGroup 不带水平内边距、
  // 卡是撑满内容列的，预览区再加一层缩进就会比上面的卡片窄一截（左右各
  // 16px），这正是之前「没用，没对齐上面的卡片」的原因。缩进只由
  // SettingGroup 内部这个 p-4 提供一次。
  return (
    <div className="pt-1">
      <div className="px-4 pt-3 pb-2">
        <h4 className="ui-subtitle font-semibold text-foreground">代码预览</h4>
        <p className="ui-text-sm2 text-muted-foreground/70 mt-0.5">
          同时预览浅色与深色代码主题，当前界面使用的主题会标记为“当前生效”。
        </p>
      </div>
      <SettingGroup>
        <div className="p-4 flex flex-col sm:flex-row gap-4">
          <CodePreviewCard
            mode="light"
            isCurrent={current === "light"}
            themes={themes}
          />
          <CodePreviewCard
            mode="dark"
            isCurrent={current === "dark"}
            themes={themes}
          />
        </div>
      </SettingGroup>
    </div>
  );
}
