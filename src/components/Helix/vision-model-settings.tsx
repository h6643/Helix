"use client";

import React, { useState, useEffect } from "react";
import { PopupSelect, SettingGroup } from "./settings-ui";
import { Button } from "@/components/ui/button";
import { isElectron } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

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
          } catch { /* empty */}
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

  const save = async (opts?: { silent?: boolean }) => {
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
      if (!opts?.silent) {
        showToast({ type: "success", title: "视觉模型配置已保存" });
      }
    } catch (e) {
      if (!opts?.silent) showToast({ type: "error", title: "保存失败" });
      throw e;
    } finally {
      setSaving(false);
    }
  };

  // 连通性测试：拿一张自己画的测试图打一次真实的视觉调用。
  // 目的是把"填错 model code（例如把显示名"GLM-4.6V Flash"当成 API 的 model code
  // 填进来 → 1211 模型不存在）"这类配置错误在设置页当场暴露出来 —— 以前这种错
  // 只会在发图时静默回退，用户看到的是主模型"不支持图片"，根本不知道是配置问题。
  // 测试前会先保存：vision_describe 读的是 config.yaml，不先存就会测到旧值。
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  function makeTestImageDataUrl(): string {
    // 用 canvas 现画一张正常尺寸的 PNG：1×1 之类的过小图片会被部分视觉模型以
    // "图片输入格式/解析错误" 拒掉，测出来是假阴性。
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const g = canvas.getContext("2d");
    if (!g) return "";
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#e11d48";
    g.fillRect(8, 8, 52, 52);
    g.fillStyle = "#2563eb";
    g.fillRect(68, 8, 52, 52);
    g.fillStyle = "#111827";
    g.font = "bold 60px sans-serif";
    g.fillText("V", 44, 116);
    return canvas.toDataURL("image/png");
  }

  const runTest = async () => {
    if (testing || saving) return;
    setTesting(true);
    setTestResult(null);
    try {
      const api = (window as any).electron?.vision;
      if (!api?.describe) {
        throw new Error("视觉模型接口不可用（window.electron.vision 缺失）");
      }
      const image = makeTestImageDataUrl();
      if (!image) throw new Error("无法生成测试图片（canvas 不可用）");
      await save({ silent: true });
      const desc = await api.describe(
        image,
        "这是一张连通性测试图。请用一句话说明你看到了什么。",
      );
      const text = typeof desc === "string" ? desc.trim() : "";
      if (!text) throw new Error("视觉模型返回了空描述");
      setTestResult({ ok: true, text: `配置已保存。模型返回：${text}` });
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === "string"
            ? e
            : JSON.stringify(e);
      setTestResult({ ok: false, text: msg });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <SettingGroup
        className="flex-1 flex flex-col"
        bodyClassName="flex-1 flex flex-col"
      >
        <div className="p-4 space-y-3 flex-1 flex flex-col">
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
              placeholder=""
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 font-mono"
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
                  placeholder=""
                  className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 font-mono"
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
                className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground placeholder:text-muted-foreground/40 font-mono"
              />
            </div>
          )}

          {/* 连通性测试结果（行内展示，不 toast） */}
          {testResult && (
            <div
              className={`rounded-lg border px-3 py-2 ui-text font-mono whitespace-pre-wrap break-words ${
                testResult.ok
                  ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-600"
                  : "border-destructive/40 bg-destructive/5 text-destructive"
              }`}
            >
              <span className="font-medium">
                {testResult.ok ? "连接正常 · " : "测试失败 · "}
              </span>
              {testResult.text}
            </div>
          )}

          {/* 底部操作行：mt-auto 钉在拉伸后的卡片底部（与对话 tab 的 SaveBar 同位） */}
          <div className="mt-auto flex justify-end gap-2 pt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={runTest}
              disabled={testing || saving}
            >
              {testing ? "测试中..." : "测试连接"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => save()}
              disabled={saving}
            >
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        </div>
      </SettingGroup>
    </div>
  );
}
