"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  PageHeader,
  SettingGroup,
  SettingRow,
  Toggle,
  NumberField,
  PopupSelect,
} from "./settings-ui";
import { getElectronAPI } from "@/lib/electron-bridge";

interface CodemodeConfig {
  enabled: boolean;
  mode: "on" | "only";
  inlineBudget: number;
}

/** Codemode 配置：启用开关 + 工具展示模式 + 声明预算（写 pi settings.json）。 */
export function CodemodeSettingsPanel() {
  const [cfg, setCfg] = useState<CodemodeConfig | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    getElectronAPI()
      ?.helix.codemodeConfig()
      .then((r) => setCfg(r as CodemodeConfig))
      .catch(() => setCfg(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const apply = useCallback(
    (updates: Record<string, unknown>) => {
      setBusy(true);
      getElectronAPI()
        ?.helix.setCodemodeConfig(updates)
        .then(refresh)
        .finally(() => setBusy(false));
    },
    [refresh],
  );

  return (
    <div className="flex-1 flex flex-col space-y-6">
      <PageHeader>Codemode</PageHeader>

      <SettingGroup>
        <SettingRow
          label="启用 Codemode"
          hint="让模型可以编写 JavaScript 脚本，在 QuickJS 沙箱中并行调用工具、运行分类器与生图模型。写入 pi 的 defaultTools（+codemode）。"
        >
          <Toggle
            enabled={cfg?.enabled ?? false}
            onToggle={() => apply({ enabled: !(cfg?.enabled ?? false) })}
          />
        </SettingRow>
        <SettingRow
          label="工具展示模式"
          hint="on：普通工具照常声明，描述里附脚本调用说明；only：普通工具对模型隐藏，只能通过 codemode 脚本调用。"
        >
          <PopupSelect
            value={cfg?.mode ?? "on"}
            options={[
              { label: "on — 工具照常声明", value: "on" },
              { label: "only — 仅通过脚本调用", value: "only" },
            ]}
            onChange={(v) => apply({ mode: v })}
          />
        </SettingRow>
        <SettingRow
          label="工具声明预算"
          hint="codemode 描述中用于工具声明的预估 token 上限（0 = 只列命名空间）；放不下的工具用 searchTools 发现。"
        >
          <div className="flex items-center gap-3 justify-end">
            <NumberField
              value={cfg?.inlineBudget ?? 3000}
              min={0}
              max={40000}
              small
              onCommit={(v) => apply({ inlineBudget: v })}
            />
          </div>
        </SettingRow>
      </SettingGroup>

      {busy && (
        <div className="px-4 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
          正在保存…
        </div>
      )}
    </div>
  );
}