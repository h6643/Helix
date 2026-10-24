"use client";

import React, { useState, useEffect, useRef } from "react";

interface DailyUsage {
  totalTokens: number;
  requestCount: number;
  models?: Record<
    string,
    { totalTokens: number; requestCount: number }
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
const MIN_CELL = 8;
const ROWS = 7;
const COLS = 16;
const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

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
  const todayKey = dayKeyOf(end);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  const backToMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - backToMonday);

  const dated: (string | null)[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dated.push(dayKeyOf(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  while (dated.length % ROWS !== 0) dated.push(null);

  const total = ROWS * COLS;
  const headPad = Math.max(0, Math.ceil((total - dated.length) / ROWS)) * ROWS;
  const cells: (string | null)[] = [
    ...Array.from({ length: headPad }, () => null),
    ...dated,
  ];

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
        Math.floor((available + GAP) / COLS) - GAP,
      );
      setCellSize((prev) => (prev === next ? prev : next));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cell = cellSize;
  const gridW = COLS * (cell + GAP) - GAP;

  // 月份标签：取每列首个有数据的日期所在月份
  let monthLabels: { col: number; label: string }[] = [];
  let lastMonth = -1;
  for (let c = 0; c < COLS; c++) {
    const firstDay = cells[c * ROWS];
    if (!firstDay) continue;
    const m = parseInt(firstDay.slice(5, 7), 10);
    if (m !== lastMonth) {
      monthLabels.push({ col: c, label: `${m}月` });
      lastMonth = m;
    }
  }

  const maxVal = Math.max(
    1,
    ...cells.map((k) => (k ? dailyMap.get(k)?.totalTokens ?? 0 : 0)),
  );
  const levelOf = (v: number) =>
    v <= 0
      ? 0
      : Math.min(LEVELS - 1, 1 + Math.floor(((v - 1) / maxVal) * (LEVELS - 1)));

  return (
    <div ref={containerRef}>
      <div className="overflow-hidden">
        <div style={{ width: gridW, margin: "0 auto" }}>
          <div style={{ display: "flex" }}>
            <div
              style={{
                display: "grid",
                gridTemplateRows: `repeat(${ROWS}, ${cell}px)`,
                gridTemplateColumns: `repeat(${COLS}, ${cell}px)`,
                gap: GAP,
              }}
            >
              {Array.from({ length: ROWS }, (_, row) =>
                Array.from({ length: COLS }, (_, col) => {
                  const idx = col * ROWS + row;
                  const key = cells[idx];
                  if (!key) {
                    return (
                      <div
                        key={`empty-${row}-${col}`}
                        style={{
                          width: cell,
                          height: cell,
                          borderRadius: 2,
                          background: levelColor(0),
                        }}
                      />
                    );
                  }
                  const entry = dailyMap.get(key);
                  const val = entry?.totalTokens ?? 0;
                  const lvl = levelOf(val);
                  const isSel = selectedDay === key;
                  const isToday = key === todayKey;
                  return (
                    <div
                      key={key}
                      data-tip={`${key} 周${WEEKDAY_LABELS[row]}：${val.toLocaleString()} tokens`}
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
          <div style={{ position: "relative", height: 13, marginTop: 2 }}>
            {monthLabels.map((m) => (
              <div
                key={m.col}
                style={{
                  position: "absolute",
                  left: m.col * (cell + GAP),
                  top: 0,
                  whiteSpace: "nowrap",
                  fontSize: 10,
                  lineHeight: "13px",
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
