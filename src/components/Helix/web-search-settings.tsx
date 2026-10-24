"use client";

import React, { useCallback, useEffect, useState } from "react";
import { SettingGroup, SettingRow } from "./settings-ui";
import { Button } from "@/components/ui/button";
import { getElectronAPI } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

/**
 * 联网搜索配置（config.yaml 的 `web_search:` 块），「常规」页里的一行 —— 与
 * 「HTTP 代理」同构：标题就是这一行，保存按钮跟在密钥右边。
 *
 * 搜索工具本身由第三方扩展 `pi-web-access` 注册，这里只负责它读的那份配置：
 * Tavily 的 key。没有免 key 兜底 —— 扩展的 auto 就是「Tavily，否则报错」
 * （`search.ts`），所以「没配 key ⇒ 搜索必失败」是事实，状态词直接写在这一行上。
 *
 * 横幅里的「扩展装没装」走后端 extensionStatus，判据是 **pi 自己的发现规则**
 * （`~/.pi/agent/extensions/` 目录自动发现 + settings.json 顶层 `extensions`
 * 的 +/−/! override），而不是 packages 列表：直接 clone 到 extensions 下的扩展
 * 从来不出现在 packages 里，只看那份表就会把正在工作的工具报成「没装」（旧
 * 版本的误报，已由 web_search.rs 的 extension_probe 修）。四态分开说：没装
 * 去安装、被关着去打开、读不到就不提醒。
 *
 * 没有「搜索引擎」可选：Helix 只支持 Tavily，扩展的 auto 与 tavily 在这里是同一条
 * 路，给一个只有一个选项的下拉就是骗控件。扩展自己还留着一条 perplexity 路由（靠
 * `PERPLEXITY_API_KEY` 环境变量或文件里的旧值生效），Helix 不配置它、也不再写
 * `searchProvider`；文件里若还存着那个值，用 unmanagedSearchProvider 如实报出来，
 * 由用户自己删那一行 —— 不装作生效档位是 Tavily。
 *
 * 密钥一律不回显：后端只告诉前端「有没有 / 由什么提供」，输入框永远是空的，
 * 留空保存 = 不动这一项（后端的缺省语义）。
 */

type KeyState = {
  configured: boolean;
  source: "none" | "literal" | "env" | "command";
  envVar: string | null;
  processEnvSet: boolean;
};

const EMPTY_STATE: KeyState = {
  configured: false,
  source: "none",
  envVar: null,
  processEnvSet: false,
};

/** 这一行只放一个状态词：key 由什么提供（长解释留给横幅）。 */
function sourceBadge(s: KeyState): { text: string; className: string } {
  if (s.source === "env") {
    return s.processEnvSet
      ? { text: `环境变量 ${s.envVar ?? "?"}`, className: "text-emerald-600" }
      : {
          text: `环境变量 ${s.envVar ?? "?"} 缺失`,
          className: "text-amber-600",
        };
  }
  if (s.source === "command")
    return { text: "由命令提供", className: "text-emerald-600" };
  if (s.source === "literal")
    return { text: "已配置", className: "text-emerald-600" };
  return { text: "未配置", className: "text-muted-foreground" };
}

export function WebSearchSettings() {
  const showToast = useHelixStore((s) => s.showToast);
  const [unmanagedProvider, setUnmanagedProvider] = useState("");
  const [tavily, setTavily] = useState<KeyState>(EMPTY_STATE);
  const [tavilyDraft, setTavilyDraft] = useState("");
  // 读回来之前按 unknown 处理：宁可不提醒，也不要先亮一下「没装」再灭。
  const [extensionStatus, setExtensionStatus] = useState<
    "loaded" | "disabled" | "absent" | "unknown"
  >("unknown");
  const [extensionPackage, setExtensionPackage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const api = getElectronAPI()?.webSearch;
    if (!api?.getConfig) return;
    try {
      const r = await api.getConfig();
      if (!r?.ok) return;
      setUnmanagedProvider(r.unmanagedSearchProvider ?? "");
      setTavily(r.secrets?.tavilyApiKey ?? EMPTY_STATE);
      // 新字段优先；旧后端只给 extensionLoaded 时退化成两态（不会比从前错得更多）。
      setExtensionStatus(
        r.extensionStatus ??
          (r.extensionLoaded === false ? "absent" : "loaded"),
      );
      setExtensionPackage(
        typeof r.extensionPackage === "string" ? r.extensionPackage : null,
      );
    } catch (e) {
      console.error("[WebSearchSettings] load failed:", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dirty = tavilyDraft.trim().length > 0;

  const save = useCallback(async () => {
    const api = getElectronAPI()?.webSearch;
    if (!api?.setConfig) {
      showToast({ type: "error", title: "仅桌面版可写配置" });
      return;
    }
    setSaving(true);
    try {
      // 只发送动过的字段：后端「缺省 = 不改」，全量发送会把没填的 key 清空。
      const r = await api.setConfig({ tavilyApiKey: tavilyDraft.trim() });
      if (!r?.ok) {
        showToast({ type: "error", title: r?.error ?? "保存失败" });
        return;
      }
      setTavilyDraft("");
      await refresh();
    } catch (e) {
      showToast({
        type: "error",
        title: e instanceof Error ? e.message : "保存失败",
      });
    } finally {
      setSaving(false);
    }
  }, [tavilyDraft, refresh, showToast]);

  // 环境变量会盖过这份文件（扩展的取值顺序：env > config.yaml > json）。
  const envShadowed = tavily.processEnvSet && tavily.source !== "env";
  const badge = sourceBadge(tavily);

  return (
    <SettingGroup>
      {extensionStatus === "absent" && (
        <div className="px-4 py-3 ui-text-sm2 bg-amber-500/5 text-amber-700">
          没在 <span className="font-mono">~/.pi/agent/extensions</span> 里找到
          web-access 扩展 —— 这里的 key 配好了也没有
          <span className="font-mono"> web_search </span>
          工具。到「扩展」页安装{" "}
          <span className="font-mono">pi-web-access</span>。
        </div>
      )}

      {extensionStatus === "disabled" && (
        <div className="px-4 py-3 ui-text-sm2 bg-amber-500/5 text-amber-700">
          web-access 已经装了（
          <span className="font-mono">{extensionPackage ?? "?"}</span>
          ），但在「扩展」页被关着 ⇒ pi 不加载它，也就没有
          <span className="font-mono"> web_search </span>
          工具。去把它打开，不是重装。
        </div>
      )}

      {unmanagedProvider && (
        <div className="px-4 py-3 ui-text-sm2 bg-amber-500/5 text-amber-700">
          文件里的档位是{" "}
          <span className="font-mono">
            searchProvider: &quot;{unmanagedProvider}&quot;
          </span>
          （或遗留的 <span className="font-mono">provider</span>
          ）。扩展还认它，而 Helix 只配 Tavily 这一家 ⇒ 现在实际走的并不是
          Tavily。Helix 不再写这一项，要改得自己在 config.yaml
          里把那行删掉或写成 <span className="font-mono">auto</span>。
        </div>
      )}

      {envShadowed && (
        <div className="px-4 py-3 ui-text-sm2 bg-amber-500/5 text-amber-700">
          进程环境里有 <span className="font-mono">TAVILY_API_KEY</span>
          。扩展的取值顺序是
          <span className="font-mono"> 环境变量 &gt; config.yaml</span>
          ，所以这里填的 key 会被它盖掉。
        </div>
      )}

      <SettingRow
        label="Tavily API Key"
        hint="搜索工具由 pi-web-access 扩展注册，改完点保存即生效"
      >
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <span className={`ui-text-sm2 shrink-0 ${badge.className}`}>
            {badge.text}
          </span>
          <input
            type="password"
            value={tavilyDraft}
            onChange={(e) => setTavilyDraft(e.target.value)}
            placeholder="粘贴 Tavily API Key"
            className="w-56 px-2 py-1 rounded-md border border-border bg-background ui-text-sm2 font-mono text-foreground placeholder:text-muted-foreground/40"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void save()}
            disabled={saving || !dirty}
          >
            {saving ? "保存中…" : "保存"}
          </Button>
          <a
            href="https://app.tavily.com"
            target="_blank"
            rel="noreferrer"
            className="ui-text-sm2 text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            申请
          </a>
        </div>
      </SettingRow>
    </SettingGroup>
  );
}
