"use client";

import React, { useCallback, useEffect, useState } from "react";
import { PopupSelect, SettingGroup } from "./settings-ui";
import { Button } from "@/components/ui/button";
import { getElectronAPI } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

/**
 * 联网搜索配置（config.yaml 的 `web_search:` 块）。
 *
 * 搜索工具本身由第三方扩展 `pi-web-access` 注册，这一页只负责它读的那份配置：
 * 供应商选择 + Tavily / Perplexity 的 key。没有免 key 兜底 —— 扩展里只有这两家
 * （`search.ts`：auto = Tavily 优先、其次 Perplexity，两个都没有就报错），
 * 所以「没配 key ⇒ 搜索必失败」是事实，面板直接把它摆在状态条上。
 *
 * 密钥一律不回显：后端只告诉前端「有没有 / 由什么提供」，输入框永远是空的，
 * 留空保存 = 不动这一项（后端的缺省语义），要清写得点「清除」。
 */

type ProviderId = "auto" | "tavily" | "perplexity";

const PROVIDERS: { id: ProviderId; name: string; hint: string }[] = [
  { id: "auto", name: "自动（Tavily 优先）", hint: "两家都配了就先走 Tavily" },
  { id: "tavily", name: "只用 Tavily", hint: "key 失效时直接报错，不悄悄换供应商" },
  { id: "perplexity", name: "只用 Perplexity", hint: "sonar 模型，按 search 计费" },
];

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

function sourceLabel(s: KeyState): string {
  if (s.source === "env") {
    return `由环境变量 ${s.envVar ?? "?"} 提供${s.processEnvSet ? "（已存在）" : "（当前环境里没有 ⇒ 会失败）"}`;
  }
  if (s.source === "command") return "由命令提供（`!命令` 形态，只有扩展能执行）";
  if (s.source === "literal") return "已配置";
  return "未配置";
}

export function WebSearchSettings() {
  const showToast = useHelixStore((s) => s.showToast);
  const [provider, setProvider] = useState<ProviderId>("auto");
  const [storedProvider, setStoredProvider] = useState("");
  const [legacyProvider, setLegacyProvider] = useState("");
  const [tavily, setTavily] = useState<KeyState>(EMPTY_STATE);
  const [perplexity, setPerplexity] = useState<KeyState>(EMPTY_STATE);
  const [tavilyDraft, setTavilyDraft] = useState("");
  const [perplexityDraft, setPerplexityDraft] = useState("");
  const [clearTavily, setClearTavily] = useState(false);
  const [clearPerplexity, setClearPerplexity] = useState(false);
  const [extensionLoaded, setExtensionLoaded] = useState(true);
  const [configPath, setConfigPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const api = getElectronAPI()?.webSearch;
    if (!api?.getConfig) {
      setLoading(false);
      return;
    }
    try {
      const r = await api.getConfig();
      if (!r?.ok) return;
      const c = r.config;
      setProvider(((c?.searchProvider ?? "auto") as ProviderId));
      setStoredProvider(c?.storedSearchProvider ?? "");
      setLegacyProvider(c?.legacyProvider ?? "");
      setTavily(r.secrets?.tavilyApiKey ?? EMPTY_STATE);
      setPerplexity(r.secrets?.perplexityApiKey ?? EMPTY_STATE);
      setExtensionLoaded(r.extensionLoaded ?? true);
      setConfigPath(r.configPath ?? "");
    } catch (e) {
      console.error("[WebSearchSettings] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dirtyProvider = provider !== (storedProvider || "auto");
  const dirty =
    dirtyProvider ||
    tavilyDraft.trim().length > 0 ||
    perplexityDraft.trim().length > 0 ||
    clearTavily ||
    clearPerplexity;

  const buildPatch = (): Record<string, string> => {
    const patch: Record<string, string> = {};
    // 只发送动过的字段：后端「缺省 = 不改」，全量发送会把没填的那家 key 清空。
    if (dirtyProvider) patch.searchProvider = provider;
    if (clearTavily) patch.tavilyApiKey = "";
    else if (tavilyDraft.trim()) patch.tavilyApiKey = tavilyDraft.trim();
    if (clearPerplexity) patch.perplexityApiKey = "";
    else if (perplexityDraft.trim()) patch.perplexityApiKey = perplexityDraft.trim();
    return patch;
  };

  const save = useCallback(
    async (opts?: { silent?: boolean }) => {
      const api = getElectronAPI()?.webSearch;
      if (!api?.setConfig) {
        if (!opts?.silent) showToast({ type: "error", title: "仅桌面版可写配置" });
        return false;
      }
      setSaving(true);
      try {
        const r = await api.setConfig(buildPatch());
        if (!r?.ok) {
          if (!opts?.silent) {
            showToast({ type: "error", title: r?.error ?? "保存失败" });
          }
          return false;
        }
        setTavilyDraft("");
        setPerplexityDraft("");
        setClearTavily(false);
        setClearPerplexity(false);
        await refresh();
        if (!opts?.silent) {
          showToast({ type: "success", title: "联网搜索配置已保存" });
        }
        return true;
      } catch (e) {
        if (!opts?.silent) {
          showToast({ type: "error", title: e instanceof Error ? e.message : "保存失败" });
        }
        return false;
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [provider, storedProvider, tavilyDraft, perplexityDraft, clearTavily, clearPerplexity, refresh, showToast],
  );

  // 连通性测试：先保存再打一次真实请求。不先存就会测到旧值（后端读的是文件）。
  const runTest = async () => {
    if (testing || saving) return;
    setTesting(true);
    setTestResult(null);
    try {
      const api = getElectronAPI()?.webSearch;
      if (!api?.test) throw new Error("测试接口不可用（仅桌面版）");
      if (dirty) {
        const okSave = await save({ silent: true });
        if (!okSave) throw new Error("保存失败，未执行测试");
      }
      const r = await api.test(provider === "auto" ? undefined : provider);
      if (r?.ok) {
        setTestResult({
          ok: true,
          text: `${r.provider} 返回 HTTP ${r.httpStatus}（${r.latencyMs} ms，key 来自 ${r.keyFrom}）`,
        });
      } else {
        setTestResult({ ok: false, text: r?.error ?? "测试未返回结果" });
      }
    } catch (e) {
      setTestResult({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  };

  // 环境变量会盖过这份文件（扩展的取值顺序：env > config.yaml > json）。
  const envShadowed: string[] = [];
  if (tavily.processEnvSet && tavily.source !== "env") envShadowed.push("TAVILY_API_KEY");
  if (perplexity.processEnvSet && perplexity.source !== "env") {
    envShadowed.push("PERPLEXITY_API_KEY");
  }

  const renderKeyRow = (
    label: string,
    state: KeyState,
    draft: string,
    setDraft: (v: string) => void,
    clearing: boolean,
    setClearing: (v: boolean) => void,
    getUrl: string,
  ) => (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="block ui-text font-medium text-foreground">{label}</label>
        <span
          className={`ui-text-sm2 ${
            state.source === "literal"
              ? "text-emerald-600"
              : state.source === "none"
                ? "text-muted-foreground"
                : "text-amber-600"
          }`}
        >
          {sourceLabel(state)}
        </span>
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value.trim()) setClearing(false);
          }}
          placeholder={
            clearing
              ? "将清除已存的 key"
              : state.source === "literal"
                ? "已配置 —— 留空不改，输入则覆盖"
                : "粘贴 API Key"
          }
          className="flex-1 min-w-0 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 font-mono"
        />
        {state.source === "literal" && !clearing && (
          <Button size="sm" variant="ghost" onClick={() => setClearing(true)}>
            清除
          </Button>
        )}
        {clearing && (
          <Button size="sm" variant="ghost" onClick={() => setClearing(false)}>
            取消清除
          </Button>
        )}
      </div>
      <a
        href={getUrl}
        target="_blank"
        rel="noreferrer"
        className="block ui-text-sm2 text-muted-foreground hover:text-foreground underline underline-offset-2 w-fit"
      >
        申请 key
      </a>
    </div>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <SettingGroup className="flex-1 flex flex-col" bodyClassName="flex-1 flex flex-col">
        <div className="p-4 space-y-4 flex-1 flex flex-col overflow-y-auto">
          {!extensionLoaded && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 ui-text text-amber-700">
              没在 pi 的 packages 里看到 web-access 扩展 —— 这里的 key 配好了也没有
              <span className="font-mono"> web_search </span>
              工具。到「扩展」页安装 <span className="font-mono">pi-web-access</span>。
            </div>
          )}

          {legacyProvider && legacyProvider !== provider && (
            <div className="rounded-lg border border-border/40 bg-muted/30 px-3 py-2 ui-text-sm2 text-muted-foreground">
              文件里还有一个遗留的 <span className="font-mono">web_search.provider: &quot;{legacyProvider}&quot;</span>
              。扩展按 <span className="font-mono">searchProvider ?? provider</span> 读，
              现在生效的是 <span className="font-mono">{provider}</span>。
            </div>
          )}

          {envShadowed.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 ui-text-sm2 text-amber-700">
              进程环境里有 {envShadowed.join(" / ")}。扩展的取值顺序是
              <span className="font-mono"> 环境变量 &gt; config.yaml</span>
              ，所以这里填的 key 会被它盖掉。
            </div>
          )}

          <div>
            <label className="block ui-text font-medium text-foreground mb-1.5">搜索引擎</label>
            <PopupSelect
              value={provider}
              onChange={(v) => setProvider(v as ProviderId)}
              className="w-full ui-text text-foreground border border-border/50 bg-muted/50 rounded-lg px-3 py-2"
              options={PROVIDERS.map((p) => ({ label: p.name, value: p.id }))}
            />
            <p className="mt-1 ui-text-sm2 text-muted-foreground">
              {PROVIDERS.find((p) => p.id === provider)?.hint}
            </p>
          </div>

          {renderKeyRow(
            "Tavily API Key",
            tavily,
            tavilyDraft,
            setTavilyDraft,
            clearTavily,
            setClearTavily,
            "https://app.tavily.com",
          )}
          {renderKeyRow(
            "Perplexity API Key",
            perplexity,
            perplexityDraft,
            setPerplexityDraft,
            clearPerplexity,
            setClearPerplexity,
            "https://perplexity.ai/settings/api",
          )}

          {testResult && (
            <div
              className={`rounded-lg border px-3 py-2 ui-text font-mono whitespace-pre-wrap break-words ${
                testResult.ok
                  ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-600"
                  : "border-destructive/40 bg-destructive/5 text-destructive"
              }`}
            >
              <span className="font-medium">{testResult.ok ? "连接正常 · " : "测试失败 · "}</span>
              {testResult.text}
            </div>
          )}

          <p className="ui-text-sm2 text-muted-foreground">
            配置写进 <span className="font-mono break-all">{configPath || "config.yaml"}</span>
            的 <span className="font-mono">web_search:</span> 块。扩展在 pi
            进程启动时只读一次，改完要等新起的 pi 实例（下一条新对话）才生效。
          </p>

          <div className="mt-auto flex justify-end gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={runTest} disabled={testing || saving || loading}>
              {testing ? "测试中..." : "测试连接"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void save()}
              disabled={saving || !dirty}
            >
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        </div>
      </SettingGroup>
    </div>
  );
}
