"use client";

import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useHelixStore } from "@/stores/helix-store";
import { PopupSelect, SettingGroup } from "./settings-ui";
import { isElectron } from "@/lib/electron-bridge";

const VISION_PROVIDERS = [
  { id: "gemini", name: "Gemini" },
  { id: "zai", name: "Zhipu AI (z.ai) / GLM" },
  { id: "__custom__", name: "自定义" },
];

// 已知 endpoint 的 provider：自动填好 base_url，用户只需填 API Key
const PROVIDER_BASE_URLS: Record<string, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  zai: "https://open.bigmodel.cn/api/paas/v4",
};

export function VisionModelSettings() {
  const showToast = useHelixStore((s) => s.showToast);
  const [provider, setProvider] = useState("gemini");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (!isElectron()) {
        const saved = localStorage.getItem("helix-vision-model");
        if (saved) {
          try {
            const d = JSON.parse(saved);
            setProvider(d.provider || "gemini");
            setModel(d.model || "");
            setBaseUrl(d.baseUrl || "");
            setApiKey(d.apiKey || "");
          } catch {}
        }
        return;
      }
      try {
        const api = (window as any).electron?.vision;
        if (!api?.getConfig) return;
        const r = await api.getConfig();
        if (r?.ok && r.config) {
          setProvider(r.config.provider || "gemini");
          setModel(r.config.model || "");
          setBaseUrl(r.config.baseUrl || "");
          setApiKey(r.config.apiKey || "");
        }
      } catch (e) {
        console.error("[VisionModelSettings] load failed:", e);
      }
    };
    load();
  }, []);

  const knownBaseUrl = PROVIDER_BASE_URLS[provider];
  const showApiKey = provider !== "auto";
  const showBaseUrl = !knownBaseUrl && provider !== "auto";

  const save = async () => {
    setSaving(true);
    try {
      const config = {
        provider: provider === "__custom__" ? "custom" : provider,
        model,
        baseUrl: knownBaseUrl ? knownBaseUrl : showBaseUrl ? baseUrl : "",
        apiKey: showApiKey ? apiKey : "",
      };
      if (isElectron()) {
        const api = (window as any).electron?.vision;
        if (api?.setConfig) await api.setConfig(config);
      } else {
        localStorage.setItem("helix-vision-model", JSON.stringify(config));
      }
      showToast({ type: "success", title: "视觉模型配置已保存" });
    } catch (e) {
      showToast({ type: "error", title: "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <SettingGroup>
        <div className="p-4 space-y-3">
          {/* Provider */}
          <div>
            <label className="block ui-text font-medium text-foreground mb-1.5">
              Provider
            </label>
            <PopupSelect
              value={provider}
              onChange={setProvider}
              placeholder="选择视觉 Provider"
              className="w-full ui-text text-foreground border border-border/50 bg-muted/50 rounded-lg px-3 py-2"
              options={VISION_PROVIDERS.map((p) => ({
                label: p.name,
                value: p.id,
              }))}
            />
          </div>

          {/* Model：纯文本输入，不限制预设列表 */}
          <div>
            <label className="block ui-text font-medium text-foreground mb-1.5">
              模型名称
            </label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="如 gpt-4o、glm-5v-turbo、gemini-2.5-pro、claude-3.5-sonnet ..."
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </div>

          {/* Base URL：已知 endpoint 自动填充（只读）；未知则手填 */}
          {knownBaseUrl ? (
            <div>
              <label className="block ui-text font-medium text-foreground mb-1.5">
                Base URL
              </label>
              <input
                type="text"
                value={knownBaseUrl}
                readOnly
                disabled
                className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground/70 font-mono cursor-not-allowed"
              />
            </div>
          ) : (
            showBaseUrl && (
              <div>
                <label className="block ui-text font-medium text-foreground mb-1.5">
                  Base URL
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://your-vlm-endpoint/v1"
                  className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                />
              </div>
            )
          )}

          {/* API Key：除 auto 外都显示 */}
          {showApiKey && (
            <div>
              <label className="block ui-text font-medium text-foreground mb-1.5">
                API Key
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
              />
            </div>
          )}
        </div>
      </SettingGroup>

      <div className="flex justify-end pt-2">
        <Button size="sm" variant="outline" onClick={save} disabled={saving}>
          {saving ? "保存中..." : "保存"}
        </Button>
      </div>
    </div>
  );
}
