"use client";

import React from "react";
import { SettingGroup } from "./settings-ui";
import { parseChannelModelLabel } from "@/lib/channel-model";
import { useHelixStore } from "@/stores/helix-store";

/** api-settings 传入的 pi 模型条目子集（只取展示渠道模型要用到的字段）。 */
type ChannelModelInfo = {
  id: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
};

const fmtCtx = (n?: number): string => {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  return `${Math.round(n / 1000)}K`;
};

/** 渠道（pi-connect 扩展在 pi 运行期注册的 provider：WorkBuddy / Trae /
 *  Qoder）的模型列表。只读面板：这些 provider 不经过 Helix 的 models.json /
 *  profiles 流程（凭据由扩展自己管理），模型选择走输入框下拉的按会话
 *  set_model 透传，所以这里不提供任何编辑入口。 */
export function ChannelModelSettings({
  channelId,
  models,
}: {
  channelId: string;
  models: ChannelModelInfo[];
}) {
  const channels = useHelixStore((s) => s.piChannelProviders);
  const channel = channels.find((c) => c.id === channelId);
  const entries = channel?.models ?? [];
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <SettingGroup
        className="flex-1 flex flex-col"
        bodyClassName="flex-1 flex flex-col"
      >
        <div className="p-4 flex-1 min-h-0 flex flex-col">
          <div className="flex items-center gap-2.5">
            <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] px-1.5 py-0.5 rounded-full font-medium bg-muted/80 text-muted-foreground">
              渠道
            </span>
            <span className="min-w-0 flex-1 truncate ui-text font-semibold text-foreground">
              {channel?.name || channelId}
            </span>
            <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">
              共 {entries.length} 个模型
            </span>
          </div>
          <p className="mt-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 leading-relaxed">
            该渠道由 pi-connect 扩展在运行期提供给 pi，登录与凭据在「渠道中心」
            管理，无需在这里填写 Key。在输入框的模型下拉里选中模型即可让当前
            对话使用它（按会话生效，不改全局默认模型）。
          </p>
          <div className="mt-3 flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-0.5">
            {entries.length === 0 ? (
              <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-4 text-center text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">
                未发现该渠道的模型（网关未就绪或 pi-connect 扩展未加载）
              </div>
            ) : (
              entries.map((entry) => {
                const info = models.find(
                  (m) => m.provider === channelId && m.id === entry.id,
                );
                const ctx = fmtCtx(info?.contextWindow);
                const vision = (info?.input || []).includes("image");
                const parts = parseChannelModelLabel(entry.label);
                return (
                  <div
                    key={entry.id}
                    className="flex items-center gap-2 rounded-lg border border-border/40 bg-card/60 px-3 py-2"
                  >
                    {/* 主文本用 pi 的装饰名（扩展把倍率/促销后缀拼在 name 里），
                        tooltip 保留裸 id —— 那是 set_model / 配置里要用的值。
                        倍率拆出来放右列，免费统一显示 x0.00。 */}
                    <span
                      className="flex min-w-0 flex-1 items-baseline gap-1.5"
                      data-tip={entry.id}
                    >
                      <span className="min-w-0 shrink truncate font-mono ui-text text-foreground">
                        {parts.name}
                      </span>
                      {parts.notes.length > 0 && (
                        <span className="min-w-0 shrink truncate text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/50">
                          {parts.notes.join(" ")}
                        </span>
                      )}
                    </span>
                    {vision && (
                      <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded-full font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                        图像
                      </span>
                    )}
                    {info?.reasoning && (
                      <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded-full font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                        思考
                      </span>
                    )}
                    <span className="w-11 shrink-0 text-right font-mono tabular-nums text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
                      {parts.factor}
                    </span>
                    {ctx && (
                      <span className="w-12 shrink-0 text-right font-mono tabular-nums text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">
                        {ctx}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </SettingGroup>
    </div>
  );
}
