"use client";

import React from "react";
import { formatTokens } from "@/lib/format";

export interface DailyUsagePoint {
  day: string;
  totalTokens: number;
  requestCount: number;
}

function dayLabel(day: string): string {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const todayKey = `${y}-${m}-${d}`;
  if (day === todayKey) return "今天";
  const yesterday = new Date(Date.now() - 86400000);
  const yy = yesterday.getFullYear();
  const ym = String(yesterday.getMonth() + 1).padStart(2, "0");
  const yd = String(yesterday.getDate()).padStart(2, "0");
  if (day === `${yy}-${ym}-${yd}`) return "昨天";
  return day.slice(5);
}

export function DailyUsageChart({
  data,
  selectedDay,
  onSelect,
}: {
  data: DailyUsagePoint[];
  selectedDay?: string;
  onSelect?: (day: string) => void;
}) {
  const width = 620;
  const height = 260;
  const padLeft = 64;
  const padBottom = 26;
  const padRight = 8;
  const innerW = width - padLeft - padRight;

  const max = Math.max(1, ...data.map((d) => d.totalTokens));
  const niceMax = max * 1.1;
  const step = niceMax / 4;

  const barGap = data.length > 20 ? 3 : 5;
  const barW = Math.max(2, (innerW - barGap * (data.length - 1)) / data.length);

  /*柱顶数值标签：分行错开（stagger）+ 行内贪心放置，冲突者才省略。
     机制：标签宽 ~35px 而柱距 pitch=barW+barGap 在 30 天模式只有 ~18px，
     单行必然叠字；但把标签升到上一行后，同行间距变成 2*pitch ≈ 36px > 标签宽，
     于是"每根柱都有数字"且互不重叠。上限 3 行，再密就只能省略（90 天档）。
     padTop 按行数动态留出标签空间，否则高层标签会溢出画布顶部被裁。*/
  const LABEL_MIN_H = 26;
  const LABEL_CHAR_W = 5.8;
  const LABEL_GAP = 2;
  const LABEL_ROW_H = 12;
  const estLabelW = (t: string) => t.length * LABEL_CHAR_W;
  const pitch = barW + barGap;
  const rowCount = Math.min(
    3,
    Math.max(1, Math.ceil((estLabelW(formatTokens(max)) + LABEL_GAP) / pitch)),
  );
  const padTop = 18 + (rowCount - 1) * LABEL_ROW_H;
  const innerH = height - padTop - padBottom;

  const gridY = (v: number) => padTop + innerH - (v / niceMax) * innerH;

  // 每行各自维护已占区间，左→右放置
  const rowTaken: { l: number; r: number }[][] = Array.from(
    { length: rowCount },
    () => [],
  );
  const labelsWithIndex = new Map<number, { text: string; row: number }>();
  data.forEach((d, i) => {
    if (d.totalTokens <= 0) return;
    const h = (d.totalTokens / niceMax) * innerH;
    if (h <= LABEL_MIN_H) return;
    const text = formatTokens(d.totalTokens);
    const half = estLabelW(text) / 2;
    const l = padLeft + i * pitch + barW / 2 - half;
    const r = l + half * 2;
    if (l < 0 || r > width) return; // 越界不画，避免出血到画布外
    // 从最高一行开始试，放不下就降一行；全满则省略
    for (let row = 0; row < rowCount; row++) {
      if (rowTaken[row].some((t) => l < t.r + LABEL_GAP && r > t.l - LABEL_GAP))
        continue;
      rowTaken[row].push({ l, r });
      labelsWithIndex.set(i, { text, row });
      return;
    }
  });

  const daysSinceToday = (day: string) => {
    const t = new Date(`${dayLabelForToday()}T00:00:00`).getTime();
    const d = new Date(`${day}T00:00:00`).getTime();
    return Math.round((t - d) / 86400000);
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-auto"
      role="img"
      aria-label="每日用量柱状图"
    >
      {/* Y-axis gridlines */}
      {[0, 1, 2, 3, 4].map((i) => {
        const v = step * i;
        const y = gridY(v);
        return (
          <g key={i}>
            <line
              x1={padLeft}
              y1={y}
              x2={width - padRight}
              y2={y}
              stroke="var(--border)"
              strokeWidth={1}
              strokeOpacity={0.5}
              strokeDasharray={i === 0 ? "none" : "3 3"}
            />
            <text
              x={padLeft - 8}
              y={y + 3}
              fontSize={10}
              textAnchor="end"
              fill="var(--foreground)"
              fillOpacity={0.5}
            >
              {v >= 10000 ? formatTokens(v) : Math.round(v).toLocaleString()}
            </text>
          </g>
        );
      })}

      {/* Bars */}
      {data.map((d, i) => {
        if (d.totalTokens <= 0) return null;
        const x = padLeft + i * (barW + barGap);
        const h = (d.totalTokens / niceMax) * innerH;
        const y = padTop + innerH - h;
        const isToday = d.day === dayLabelForToday();
        const isSelected = d.day === selectedDay;
        const opacity = isSelected
          ? 1
          : isToday
            ? 1
            : 0.45 + 0.4 * (d.totalTokens / max);
        return (
          <g key={d.day}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={h}
              rx={Math.min(3, barW / 2)}
              fill="var(--primary)"
              fillOpacity={opacity}
              className={onSelect ? "cursor-pointer" : undefined}
              onClick={onSelect ? () => onSelect(d.day) : undefined}
            >
              <title>{`${d.day} · ${formatTokens(d.totalTokens)} Tokens`}</title>
            </rect>
            {(() => {
              const lab = labelsWithIndex.get(i);
              if (!lab) return null;
              return (
                <text
                  x={x + barW / 2}
                  y={y - 6 - lab.row * LABEL_ROW_H}
                  fontSize={10}
                  textAnchor="middle"
                  fill="var(--foreground)"
                  fillOpacity={0.7}
                >
                  {lab.text}
                </text>
              );
            })()}
          </g>
        );
      })}

      {/* X-axis labels — dense (30天) mode shows one date per week (anchored at today) */}
      {data.map((d, i) => {
        const dense = data.length > 14;
        const x = padLeft + i * (barW + barGap) + barW / 2;
        const isToday = d.day === dayLabelForToday();
        if (dense && daysSinceToday(d.day) % 7 !== 0) return null;
        const label = dense ? d.day.slice(5) : dayLabel(d.day);
        return (
          <text
            key={d.day}
            x={x}
            y={height - (dense ? 10 : 8)}
            fontSize={dense ? 9 : 10}
            textAnchor="middle"
            fill="var(--foreground)"
            fillOpacity={isToday ? 0.9 : 0.5}
            fontWeight={isToday ? 600 : 400}
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}

function dayLabelForToday(): string {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}
