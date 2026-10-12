import React, { useEffect, useState } from "react";
import { PageHeader } from "./settings-ui";
import { getElectronAPI } from "@/lib/electron-bridge";

interface AdvancedSettings {
  "cacheWarming"?: "off" | "streaming" | "idle";
  "showCacheMissNotices"?: boolean;
  "hideThinkingBlock"?: boolean;
}

/** 高级设置面板：读/写 pi 的 settings.json（经后端白名单校验）。 */
export function AdvancedSettingsPanel() {
  const [cfg, setCfg] = useState<AdvancedSettings | null>(null);

  useEffect(() => {
    const api = getElectronAPI();
    if (!api) return;
    let cancelled = false;
    api.helix
      .piAdvancedConfig()
      .then((r) => {
        if (cancelled || !r?.ok || !r.settings) return;
        setCfg(r.settings as unknown as AdvancedSettings);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex-1 flex flex-col space-y-6">
      <PageHeader description="pi 的高级行为开关。改动写入 pi 的 settings.json，保存后会自动重放 pi 进程（正在跑的对话会重新附着，不丢历史）。">
        高级
      </PageHeader>

      {!cfg && (
        <div className="px-4 ui-text text-muted-foreground/60">加载中…</div>
      )}
    </div>
  );
}
