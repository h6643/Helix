"use client";

import React, { useState } from "react";
import { DailyUsageChart, type DailyUsagePoint } from "./usage-daily-chart";
import { UsageHeatmap } from "./usage-heatmap";
import { formatTokens, promptCacheHit } from "@/lib/format";
import { useHelixStore } from "@/stores/helix-store";

export function TokenUsagePanel() {
  const stats = useHelixStore((s) => s.sessionUsageStats);
  const dailyUsage = useHelixStore((s) => s.dailyUsage);
  const resetUsageStats = useHelixStore((s) => s.resetUsageStats);
  const [rangeDays, setRangeDays] = useState<7 | 30>(30);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  if (stats.requestCount === 0) {
    return (
      <section className="rounded-xl border border-border/40 bg-muted/20 px-5 py-12 text-center">
        <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground/70">
          尚未获取到用量数据
        </p>
        <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/50 mt-1.5">
          运行一次对话后，这里会自动显示 Token 消耗情况
        </p>
      </section>
    );
  }

  const formatBig = (n: number) => {
    if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)} 亿`;
    if (n >= 10_000) return `${(n / 10_000).toFixed(2)} 万`;
    return n.toLocaleString();
  };

  const dayKeyOf = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const addDays = (d: Date, n: number) => {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  };

  const dailyMap = new Map(Object.entries(dailyUsage));
  const days: DailyUsagePoint[] = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const key = dayKeyOf(addDays(new Date(), -i));
    const v = dailyMap.get(key);
    days.push({
      day: key,
      totalTokens: v?.totalTokens ?? 0,
      requestCount: v?.requestCount ?? 0,
    });
  }

  const today = days[days.length - 1];
  const activeDay =
    selectedDay && days.some((p) => p.day === selectedDay)
      ? selectedDay
      : today.day;

  const dayEntry = dailyMap.get(activeDay);
  const modelRows = dayEntry?.models
    ? Object.entries(dayEntry.models).sort(
        (a, b) => b[1].totalTokens - a[1].totalTokens,
      )
    : [];

  // 缓存命中率：prompt 侧口径，分母含缓存两项（`inputTokens` 在 pi 里是**净**
  // 未缓存数）。与上下文环弹窗共用 promptCacheHit，两处数字必须同语义。
  const cacheHit = promptCacheHit({
    input: stats.inputTokens,
    cacheRead: stats.cachedReadTokens,
    cacheWrite: stats.cachedWriteTokens,
  });

  return (
    <section className="space-y-4">
      {/* Total consumed tokens + cache hit rate — two hero cards */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border/40 bg-card/60 p-5">
          <div className="min-w-0">
            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
              真实消耗 Tokens
            </p>
            <p className="text-[calc(var(--helix-transcript-size)*2.1429)] font-semibold tabular-nums text-foreground mt-1">
              {stats.totalTokens.toLocaleString()}
            </p>
            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/50 mt-0.5">
              ≈ {formatBig(stats.totalTokens)}
            </p>
          </div>
        </div>
        <div className="rounded-xl border border-border/40 bg-card/60 p-5">
          <div className="min-w-0">
            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
              平均缓存命中率
            </p>
            <p className="text-[calc(var(--helix-transcript-size)*2.1429)] font-semibold tabular-nums text-foreground mt-1">
              {cacheHit.reported && cacheHit.percent !== null
                ? `${cacheHit.percent.toFixed(1)}%`
                : "未上报"}
            </p>
          </div>
        </div>
      </div>

      {/* Daily usage bar chart */}
      <div className="rounded-xl border border-border/40 bg-card/60 p-4">
        <div className="flex items-center justify-between px-0.5">
          <div className="flex items-center gap-3">
            <h3 className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
              每日用量
            </h3>
            <div className="flex items-center rounded-lg border border-border/40 p-0.5">
              {([7, 30] as const).map((n) => (
                <button
                  key={n}
                  onClick={() => setRangeDays(n)}
                  className={`px-2 py-0.5 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] transition-colors ${
                    rangeDays === n
                      ? "bg-primary text-primary-foreground font-medium"
                      : "text-muted-foreground/60 hover:text-foreground"
                  }`}
                >
                  {n} 天
                </button>
              ))}
            </div>
          </div>
          {today.totalTokens > 0 && (
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">
              今日 {formatBig(today.totalTokens)} Tokens
            </span>
          )}
        </div>
        <div className="mt-3">
          <DailyUsageChart
            data={days}
            selectedDay={activeDay}
            onSelect={setSelectedDay}
          />
        </div>
      </div>

      {/* Activity heatmap — real dailyUsage data (GitHub-style grid), replaces the old static placeholder PNG */}
      <div className="rounded-xl border border-border/40 bg-card/60 p-4">
        <div className="flex items-center justify-between px-0.5">
          <h3 className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
            活跃热力图
          </h3>
          <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">
            最近 90 天
          </span>
        </div>
        <UsageHeatmap
          dailyUsage={dailyUsage}
          days={90}
          selectedDay={activeDay}
          onDaySelect={setSelectedDay}
        />
      </div>

      {/* Per-model breakdown for the selected day */}
      <div className="rounded-xl border border-border/40 bg-card/60">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h3 className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
            模型用量明细
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">
              {activeDay}
            </span>
            {/* 口径改过（计费只认 message_end + 归属用真实模型）之后，历史
                dailyUsage 是永久性错误数据，无法原地修正，只能清空重算。 */}
            <button
              onClick={() => {
                if (
                  window.confirm(
                    "清空全部用量统计？历史每日/每模型明细会一并删除，且无法恢复。",
                  )
                ) {
                  resetUsageStats();
                  setSelectedDay(null);
                }
              }}
              className="rounded-md px-1.5 py-0.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/50 transition-colors hover:text-foreground"
              data-tip="清空用量统计"
            >
              清空
            </button>
          </div>
        </div>
        {modelRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--helix-transcript-size)]">
              <thead>
                <tr className="border-b border-border/50 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">
                  <th className="text-left font-medium px-4 py-2">模型</th>
                  <th className="text-right font-medium px-4 py-2">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {modelRows.map(([model, m]) => (
                  <tr
                    key={model}
                    className="border-b border-border/40 last:border-0"
                  >
                    <td className="px-4 py-2 font-mono text-foreground truncate">
                      {model}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">
                      {formatTokens(m.totalTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-4 pb-4 text-[length:var(--helix-transcript-size)] text-muted-foreground/50">
            该日无用量数据
          </p>
        )}
      </div>
    </section>
  );
}
