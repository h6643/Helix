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
  const [extensionLoaded, setExtensionLoaded] = useState(true);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const api = getElectronAPI()?.webSearch;
    if (!api?.getConfig) return;
    try {
      const r = await api.getConfig();
      if (!r?.ok) return;
      setUnmanagedProvider(r.unmanagedSearchProvider ?? "");
      setTavily(r.secrets?.tavilyApiKey ?? EMPTY_STATE);
      setExtensionLoaded(r.extensionLoaded ?? true);
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
      showToast({ type: "success", title: "联网搜索配置已保存" });
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
      {!extensionLoaded && (
        <div className="px-4 py-3 ui-text-sm2 bg-amber-500/5 text-amber-700">
          没在 pi 的 packages 里看到 web-access 扩展 —— 这里的 key 配好了也没有
          <span className="font-mono"> web_search </span>
          工具。到「扩展」页安装{" "}
          <span className="font-mono">pi-web-access</span>。
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
