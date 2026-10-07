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
/* 固定 7 行 × 16 列的网格：行 = 星期（0=周一 … 6=周日），列 = 周。
   所以每列正好一整周，今天所在的那一周固定落在最后一列。 */
const ROWS = 7;
const COLS = 16;
/** 与 ROWS 一一对应：第 0 行是周一 */
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
  // 行=星期：第 0 行周一…第 6 行周日。把起点回退到它所在周的周一，
  // 这样每列正好一整周，且「今天所在的那一周」落在最后一列。
  const backToMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - backToMonday);

  const dated: (string | null)[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dated.push(dayKeyOf(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  // 今天是周三 ⇒ 同一列里右侧的周四~周日属未来，用 null 占位补满整列
  while (dated.length % ROWS !== 0) dated.push(null);

  // 时间从左上往右下走：空位补在头部（左侧），今天永远在最后一列。
  // 头部空位必须是 ROWS 的整数倍，否则整列错位、每列不再是同一星期。
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
          {/* 图例：右上角（已移除色块图例） */}
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
                    // 空位：画成 level-0 淡灰，保持矩形完整
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
          {/* 月份标签：绝对定位对齐到各自列的左缘。
              原来用 flex + gap + marginLeft(m.col*(cell+GAP))，gap 会额外累加，
              标签被逐个右推，最后一个月标签溢出容器被 overflow-hidden 裁掉。 */}
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
