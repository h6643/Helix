"use client";

import { Plus, Trash2 } from "lucide-react";
import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { isElectron } from "@/lib/electron-bridge";
import { isTauri } from "@/lib/tauri-bridge";
import {
  type HookType,
  type HookConfig,
  type HooksSettings,
  HOOK_META,
  HOOK_TYPES,
  EMPTY_HOOKS_SETTINGS,
  generateHookId,
} from "@/lib/hooks-config";
import { Toggle, SettingGroup, SectionHeading } from "./settings-ui";

export function HookSettings() {
  const [settings, setSettings] = useState<HooksSettings>(EMPTY_HOOKS_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<null | "ok" | "err">(null);

  const platformReady = isElectron() || isTauri();

  useEffect(() => {
    if (!platformReady) {
      setLoaded(true);
      return;
    }

    const loadConfig = async () => {
      try {
        let r: any;
        if (isTauri()) {
          const { invoke } = await import("@tauri-apps/api/core");
          r = await invoke("hooks_list");
        } else {
          r = await window.electron.hooks.getConfig();
        }

        if (r.ok && r.config) {
          const hooks: HookConfig[] = [];
          if (r.config.hooks && typeof r.config.hooks === "object") {
            for (const [event, handlers] of Object.entries(r.config.hooks)) {
              if (Array.isArray(handlers)) {
                for (const h of handlers) {
                  hooks.push({
                    id: generateHookId(),
                    type: event as HookType,
                    command: (h as any).command || "",
                    matcher: (h as any).matcher || "",
                    enabled: true,
                  });
                }
              }
            }
          }
          setSettings({ enabled: r.config.enabled !== false, hooks });
        }
      } catch {}
    };

    loadConfig().finally(() => setLoaded(true));
  }, [platformReady]);

  const setMasterEnabled = (v: boolean) =>
    setSettings((s) => ({ ...s, enabled: v }));

  const hooksOfType = (type: HookType) =>
    settings.hooks.filter((h) => h.type === type);

  const addHook = (type: HookType) => {
    const newHook: HookConfig = {
      id: generateHookId(),
      type,
      command: "",
      matcher: "",
      enabled: true,
    };
    setSettings((s) => ({ ...s, hooks: [...s.hooks, newHook] }));
  };

  const removeHook = (id: string) => {
    setSettings((s) => ({ ...s, hooks: s.hooks.filter((h) => h.id !== id) }));
  };

  const updateHook = (id: string, patch: Partial<HookConfig>) => {
    setSettings((s) => ({
      ...s,
      hooks: s.hooks.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    }));
  };

  const toggleHook = (id: string) => {
    setSettings((s) => ({
      ...s,
      hooks: s.hooks.map((h) =>
        h.id === id ? { ...h, enabled: !h.enabled } : h,
      ),
    }));
  };

  const save = useCallback(async () => {
    if (!platformReady) return;
    setSaving(true);
    try {
      const hooksConfig: Record<
        string,
        { command: string; matcher?: string }[]
      > = {};
      for (const hook of settings.hooks) {
        if (!hook.command.trim()) continue;
        if (!hooksConfig[hook.type]) hooksConfig[hook.type] = [];
        hooksConfig[hook.type].push({
          command: hook.command,
          ...(hook.matcher ? { matcher: hook.matcher } : {}),
        });
      }

      let r: any;
      if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        r = await invoke("hooks_save", {
          config: { enabled: settings.enabled, hooks: hooksConfig },
        });
      } else {
        r = await window.electron.hooks.setConfig({
          enabled: settings.enabled,
          hooks: hooksConfig,
        });
      }
      setSaveState(r.ok ? "ok" : "err");
    } catch {
      setSaveState("err");
    } finally {
      setSaving(false);
    }
  }, [settings, platformReady]);

  if (!platformReady) {
    return (
      <div className="max-w-3xl">
        <SectionHeading>Hooks</SectionHeading>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="max-w-3xl">
        <SectionHeading>Hooks</SectionHeading>
        <p className="ui-text text-muted-foreground">加载 Hooks 配置中…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeading>Hooks</SectionHeading>

      <div className="flex items-center justify-between gap-3 px-1">
        <span className="ui-subtitle font-semibold text-foreground">
          启用 Hooks
        </span>
        <Toggle
          enabled={settings.enabled}
          onToggle={() => setMasterEnabled(!settings.enabled)}
        />
      </div>

      <SettingGroup>
        {HOOK_TYPES.map((type) => {
          const meta = HOOK_META[type];
          const hooks = hooksOfType(type);
          return (
            <div key={type} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="ui-text text-foreground">{meta.label}</h4>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => addHook(type)}
                  aria-label="添加"
                >
                  <Plus className="size-4" />
                </Button>
              </div>
              <div className="mt-0.5 ui-text text-muted-foreground/60">
                {meta.desc}
              </div>
              <div className="mt-2 space-y-2">
                {hooks.map((hook) => (
                  <div
                    key={hook.id}
                    className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2 space-y-1.5"
                  >
                    <div className="flex items-center gap-3">
                      <Toggle
                        enabled={hook.enabled}
                        onToggle={() => toggleHook(hook.id)}
                      />
                      <div className="flex-1 min-w-0 space-y-1">
                        <label className="block ui-text text-muted-foreground/70">
                          命令 Command
                        </label>
                        <input
                          value={hook.command}
                          onChange={(e) =>
                            updateHook(hook.id, { command: e.target.value })
                          }
                          placeholder="如 python3 ~/.pi/agent/helix/hooks/notify.py"
                          className="w-full px-2.5 py-1.5 bg-background/60 border border-border/20 rounded-md ui-text text-foreground text-center placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/40 font-mono transition-colors"
                        />
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 shrink-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10"
                        onClick={() => removeHook(hook.id)}
                        aria-label="删除 hook"
                        data-tip="删除"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    {meta.supportsMatcher && (
                      <div className="space-y-1 pl-[52px]">
                        <label className="block ui-text text-muted-foreground/70">
                          Matcher 正则（工具名，留空 = 全部）
                        </label>
                        <input
                          value={hook.matcher}
                          onChange={(e) =>
                            updateHook(hook.id, { matcher: e.target.value })
                          }
                          placeholder="如 edit|write"
                          className="w-full px-2.5 py-1.5 bg-background/60 border border-border/20 rounded-md ui-text text-foreground text-center placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/40 font-mono transition-colors"
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </SettingGroup>

      <div className="flex items-center justify-end gap-3 pt-4">
        <Button size="sm" variant="outline" onClick={save} disabled={saving}>
          {saving ? "保存并重启网关…" : "保存 Hooks 配置"}
        </Button>
        {saveState === "ok" && (
          <span className="ui-text text-primary">已保存，网关已重启</span>
        )}
        {saveState === "err" && (
          <span className="ui-text text-destructive">保存失败，请重试</span>
        )}
      </div>
    </div>
  );
}
