"use client";

import React, { useState, useEffect, useRef } from "react";

interface DailyUsage {
  totalTokens: number;
  totalCost: number;
  requestCount: number;
  models?: Record<
    string,
    { totalTokens: number; totalCost: number; requestCount: number }
  >;
}

interface UsageHeatmapProps {
  dailyUsage: Record<string, DailyUsage>;
  days?: number;
  selectedDay?: string | null;
  onDaySelect?: (day: string) => void;
}

const GAP = 3;
const LEVELS = 5;
const MIN_CELL = 10;

function levelColor(level: number) {
  if (level <= 0) return "rgba(127,127,127,0.15)";
  const op = 0.25 + (level - 1) * 0.2;
  return `rgba(56,139,235,${op.toFixed(2)})`;
}

function dayKeyOf(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function UsageHeatmap({
  dailyUsage,
  days = 90,
  selectedDay,
  onDaySelect,
}: UsageHeatmapProps) {
  const dailyMap = new Map(Object.entries(dailyUsage));

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  const startDow = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - startDow);

  const cells: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    cells.push(dayKeyOf(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  const weeks = Math.ceil(cells.length / 7);

  // 自适应：测量父容器可用宽度，反推格子尺寸，使热力图撑满卡片并居中
  const [cellSize, setCellSize] = useState(MIN_CELL);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const recompute = () => {
      const available = el.clientWidth;
      if (available <= 0) return;
      const next = Math.max(
        MIN_CELL,
        Math.floor((available + GAP) / weeks) - GAP,
      );
      setCellSize((prev) => (prev === next ? prev : next));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks]);

  const cell = cellSize;
  const gridW = weeks * (cell + GAP) - GAP;

  let monthLabels: { col: number; label: string }[] = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const firstDay = cells[w * 7];
    if (firstDay) {
      const m = parseInt(firstDay.slice(5, 7), 10);
      if (m !== lastMonth) {
        monthLabels.push({ col: w, label: `${m}月` });
        lastMonth = m;
      }
    }
  }

  const maxVal = Math.max(
    1,
    ...cells.map((k) => dailyMap.get(k)?.totalTokens ?? 0),
  );
  const levelOf = (v: number) =>
    v <= 0
      ? 0
      : Math.min(LEVELS - 1, 1 + Math.floor(((v - 1) / maxVal) * (LEVELS - 1)));

  return (
    <div ref={containerRef}>
      <div className="overflow-hidden">
        <div style={{ width: gridW, margin: "0 auto" }}>
          {/* 图例：右上角 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 4,
              fontSize: 10,
              color: "rgba(127,127,127,0.7)",
              marginBottom: 4,
            }}
          >
            <span>较少</span>
            {Array.from({ length: LEVELS }, (_, i) => (
              <div
                key={i}
                style={{
                  width: cell,
                  height: cell,
                  borderRadius: 2,
                  background: levelColor(i),
                }}
              />
            ))}
            <span>较多</span>
          </div>
          <div style={{ display: "flex" }}>
            <div
              style={{
                display: "grid",
                gridTemplateRows: `repeat(7, ${cell}px)`,
                gridTemplateColumns: `repeat(${weeks}, ${cell}px)`,
                gap: GAP,
              }}
            >
              {Array.from({ length: 7 }, (_, row) =>
                Array.from({ length: weeks }, (_, col) => {
                  const idx = col * 7 + row;
                  const key = cells[idx];
                  if (!key) return <div key={`empty-${row}-${col}`} />;
                  const entry = dailyMap.get(key);
                  const val = entry?.totalTokens ?? 0;
                  const lvl = levelOf(val);
                  const isSel = selectedDay === key;
                  const isToday = key === dayKeyOf(new Date());
                  return (
                    <div
                      key={key}
                      title={`${key}：${val.toLocaleString()} tokens`}
                      onClick={() => onDaySelect?.(key)}
                      style={{
                        width: cell,
                        height: cell,
                        borderRadius: 2,
                        background: levelColor(lvl),
                        cursor: onDaySelect ? "pointer" : "default",
                        outline: isSel
                          ? "2px solid #3b82f6"
                          : isToday
                            ? "1px solid rgba(127,127,127,0.5)"
                            : "none",
                        outlineOffset: 1,
                      }}
                    />
                  );
                }),
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: GAP, marginTop: 2 }}>
            {monthLabels.map((m) => (
              <div
                key={m.col}
                style={{
                  width: cell,
                  marginLeft: m.col * (cell + GAP),
                  fontSize: 10,
                  color: "rgba(127,127,127,0.7)",
                }}
              >
                {m.label}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
