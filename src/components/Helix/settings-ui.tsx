"use client";

import { Check, ChevronDown } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// 设置界面基础组件：每个 SettingGroup 渲染为一张卡片，
// 卡片内设置项以分隔线区分，控件右对齐。

// 统一排版令牌：所有卡片的标题 / 正文 / 说明共用同一套字号与颜色，
// 避免各处单独写 ui-text / text-xs 导致大小不一致。
const CARD_TITLE = "ui-text text-foreground"; // 卡片标题（字号跟随界面字号，不加粗）
const BODY = "ui-text text-foreground"; // 正文（行标签，字号跟随界面字号）
const DESC = "ui-text text-muted-foreground/60"; // 说明（行提示 / 描述，字号跟随界面字号）

export const Toggle = ({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) => (
  <button
    role="switch"
    aria-checked={enabled}
    onClick={onToggle}
    className={`relative w-10 h-6 rounded-full transition-colors duration-200 ${
      enabled ? "bg-primary" : "bg-muted-foreground/20"
    }`}
  >
    <span
      className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${
        enabled ? "translate-x-4" : ""
      }`}
    />
  </button>
);

export const SettingRow = ({
  label,
  hint,
  labelClassName = "",
  children,
}: {
  label: string;
  hint?: string;
  labelClassName?: string;
  children: React.ReactNode;
}) => (
  <div className="flex items-center gap-3 py-3 px-4 hover:bg-muted/40 transition-colors">
    <span className={`${BODY} min-w-0 flex-1 ${labelClassName}`}>
      {label}
      {hint && <span className={`block ${DESC} mt-0.5`}>{hint}</span>}
    </span>
    <div className="shrink-0">{children}</div>
  </div>
);

export const SettingGroup = ({
  title,
  action,
  description,
  children,
  className = "",
  bodyClassName = "",
  plain = false,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  /** 透传给卡片内层包裹 div（divide-y 那层）：需要让内层随卡片拉伸时用 */
  bodyClassName?: string;
  /** 去掉卡片背景与边框，仅保留标题/描述与行分隔，用于嵌入已有卡片内的分组 */
  plain?: boolean;
}) => (
  <div
    className={`${
      plain ? "" : "rounded-xl border border-border/40 bg-card/60 overflow-hidden"
    } ${className}`}
  >
    {(title || action || description) && (
      <div
        className={`px-4 py-3 ${children ? "border-b border-border/30" : ""}`}
      >
        {(title || action) && (
          <div className="flex items-center justify-between gap-2">
            <h4 className={CARD_TITLE}>{title}</h4>
            {action}
          </div>
        )}
        {description && (
          <div className="mt-0.5 ui-text text-muted-foreground/60">
            {description}
          </div>
        )}
      </div>
    )}
    {children && (
      <div className={`divide-y divide-border/30 ${bodyClassName}`}>
        {children}
      </div>
    )}
  </div>
);

/**
 * 设置页主标题的唯一实现：常规 / 外观 / 模型 / MCP / 子智能体 / 用量 / 归档 / 帮助 等
 * 所有页面共用，保证标题的字号、左对齐（无额外内边距，与下方卡片边缘对齐）完全一致。
 * 右上角操作按钮顶对齐（items-start），不会因按钮高度把标题挤高；
 * description 始终另起一行显示在标题下方，不会与标题挤在同一行。
 * 标题与首个卡片的间距由父容器的 space-y 统一控制。
 */
export const PageHeader = ({
  children,
  description,
  action,
  className = "",
}: {
  children: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) => (
  <div className={className || ""}>
    <div className="flex items-start justify-between gap-3">
      <h3 className="ui-title font-semibold text-foreground tracking-tight">
        {children}
      </h3>
      {action && (
        <div className="flex items-center gap-2 shrink-0">{action}</div>
      )}
    </div>
    {description && (
      <p className="mt-1 ui-text text-muted-foreground/60">{description}</p>
    )}
  </div>
);

/**
 * 数字输入：内部维护字符串草稿，只在 blur / Enter 时提交，
 * 避免每敲一个字符就往后端 PUT 一次（也避免清空输入框瞬间被回填成 0）。
 * 与「记忆预算」等数字输入保持同一套样式（淡边框 + 淡背景）。
 */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  suffix,
  disabled,
  small,
}: {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  suffix?: string;
  disabled?: boolean;
  small?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(n)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={`w-24 px-2 py-1 rounded-lg bg-muted/50 ${small ? "ui-text-sm2" : "ui-text"} text-foreground text-center border border-border disabled:cursor-not-allowed`}
      />
      {suffix && (
        <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60 w-8">
          {suffix}
        </span>
      )}
    </div>
  );
}

interface PopupSelectOption {
  label: string;
  value: string | number;
  hint?: string;
}

interface PopupSelectProps {
  value: string;
  onChange: (v: string) => void;
  options: PopupSelectOption[];
  placeholder?: string;
  className?: string;
  popupWidth?: number;
  disabled?: boolean;
}

/**
 * 下拉/弹层打开时锁定最近的背景滚动容器。弹层多为 position:fixed，背景滚动容器
 * （如设置内容卡片）滚动时触发器会移动而弹层留在视口原位，导致两者错位；锁住背景
 * 滚动并补偿滚动条宽度（隐藏滚动条后避免布局横向跳动），关闭时还原。
 */
export function useLockScrollOnOpen(
  open: boolean,
  btnRef: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    let el: HTMLElement | null = btnRef.current;
    let scroller: HTMLElement | null = null;
    while (el && el !== document.body && el !== document.documentElement) {
      const s = getComputedStyle(el);
      if (
        s.overflowY === "auto" ||
        s.overflowY === "scroll" ||
        s.overflowY === "overlay"
      ) {
        scroller = el;
        break;
      }
      el = el.parentElement;
    }
    if (!scroller) return;
    // 锁定背景滚动，但不动 paddingRight——弹窗是 fixed 定位，本身不受
    // 滚动容器 padding 影响；加 paddingRight 会让滚动容器内容区变窄，
    // 其他元素（左侧文字/卡片）整体往左挤，造成可见的布局抖动。
    // 只需要防止用户滚动背景，不需要补偿滚动条宽度。
    const prevOverflow = scroller.style.overflowY;
    scroller.style.overflowY = "hidden";
    return () => {
      if (!scroller) return;
      scroller.style.overflowY = prevOverflow;
    };
  }, [open, btnRef]);
}

/**
 * 自定义下拉选择。原生 `<select>` 的弹出列表在 WebKitGTK 下不可靠
 * （配色风格选择器因此改用 HTML 列表），这里做成通用组件：触发器 +
 * 固定定位的 HTML 弹出列表，点击外部 / Escape 关闭，选中项高亮打勾，
 * 展开样式与「配色风格」选择器保持一致。
 */
export function PopupSelect({
  value,
  onChange,
  options,
  placeholder = "请选择",
  className = "w-56",
  popupWidth = 224,
  disabled = false,
}: PopupSelectProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => String(o.value) === value);
  const currentLabel = current?.label ?? placeholder;

  // 点击外部 / Escape 关闭。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        (document.activeElement as HTMLElement)?.blur?.();
      }
    };
    const t = setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 锚定在触发器下方、右对齐；宽度与触发器一致。
  useEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const w = r.width || popupWidth;
    // 向下展开时的可用空间（留 8px 底部边距）
    const downMaxH = Math.max(120, window.innerHeight - r.bottom - 8);
    setPos({
      left: r.right - w,
      top: r.bottom + 4,
      width: w,
      maxHeight: downMaxH,
    });
  }, [open, popupWidth]);

  useEffect(() => {
    if (!open || !pos || !popRef.current) return;
    const pr = popRef.current.getBoundingClientRect();
    let top = pos.top;
    let maxHeight = pos.maxHeight;
    // 弹窗底部超出视口 且 向下空间确实不够（<200px）→ 翻到触发器上方。
    // 动态 maxHeight 已限制弹窗高度，轻微超出（几像素舍入）不应触发翻转。
    const downSpaceTooSmall = pos.maxHeight < 200;
    if (
      pr.bottom > window.innerHeight - 8 &&
      downSpaceTooSmall &&
      btnRef.current
    ) {
      const br = btnRef.current.getBoundingClientRect();
      top = Math.max(8, br.top - pr.height - 4);
      // 向上展开时的可用空间（留 8px 顶部边距）
      maxHeight = Math.max(120, br.top - 8);
    }
    const left = Math.max(
      8,
      Math.min(pos.left, window.innerWidth - pr.width - 8),
    );
    popRef.current.style.top = `${top}px`;
    popRef.current.style.left = `${left}px`;
    popRef.current.style.maxHeight = `${maxHeight}px`;
    // 同步回 state 以防后续重渲染覆盖 inline style
    setPos((prev) => (prev ? { ...prev, top, maxHeight } : prev));
  }, [open, pos]);

  // 展开期间锁定背景滚动容器，避免 fixed 弹窗与触发器错位（见 useLockScrollOnOpen）。
  useLockScrollOnOpen(open, btnRef);

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`${className} flex items-center justify-between gap-2 text-left border border-border rounded-lg px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed hover:border-foreground/25 transition-colors`}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-muted-foreground/60 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && pos && (
        <div
          ref={popRef}
          className="fixed z-50 helix-popover-glass border border-border rounded-xl shadow-xl py-1 overflow-y-auto overscroll-contain"
          style={{
            left: pos.left,
            top: pos.top,
            width: pos.width,
            maxHeight: pos.maxHeight,
          }}
        >
          {options.map((o) => {
            const selected = String(o.value) === value;
            return (
              <button
                key={String(o.value)}
                type="button"
                onClick={() => {
                  onChange(String(o.value));
                  setOpen(false);
                  btnRef.current?.focus({ preventScroll: true });
                }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 ui-text-sm2 transition-colors text-left ${
                  selected
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-accent/50"
                }`}
              >
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{o.label}</span>
                  {o.hint && (
                    <span className="block text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60 truncate">
                      {o.hint}
                    </span>
                  )}
                </span>
                {selected && <Check className="size-3.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 统一的「保存」动作栏：与 hook-settings.tsx 的保存交互保持一致——
 * 右侧 outline 保存按钮 + 行内保存状态（保存中 / 已保存 / 保存失败），
 * 不依赖 toast 弹窗。各「添加 X」表单（供应商 / 服务器 / 子智能体）统一复用。
 * - saving=true 时按钮禁用并显示 savingLabel（默认「保存中…」）。
 * - status="ok" 显示绿色 okLabel（默认「已保存」）。
 * - status="err" 显示红色 errorText（缺省「保存失败，请重试」）。
 * - 可选 onReset / onCancel 在保存按钮前渲染 ghost 按钮。
 */
export function SaveBar({
  saving,
  status,
  errorText,
  onSave,
  onReset,
  onCancel,
  disabled,
  saveLabel = "保存",
  savingLabel = "保存中…",
  okLabel = "已保存",
  errLabel = "保存失败，请重试",
  resetLabel = "重置",
}: {
  saving: boolean;
  status: null | "ok" | "err";
  errorText?: string | null;
  onSave: () => void;
  onReset?: () => void;
  onCancel?: () => void;
  disabled?: boolean;
  saveLabel?: string;
  savingLabel?: string;
  okLabel?: string;
  errLabel?: string;
  resetLabel?: string;
}) {
  return (
    <div className="flex items-center justify-end gap-3 pt-4">
      {onReset && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onReset}
          disabled={saving}
        >
          {resetLabel}
        </Button>
      )}
      {onCancel && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
        >
          取消
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={onSave}
        disabled={disabled || saving}
      >
        {saving ? savingLabel : saveLabel}
      </Button>
      {status === "ok" && (
        <span className="ui-text text-primary">{okLabel}</span>
      )}
      {status === "err" && (
        <span className="ui-text text-destructive">
          {errorText ?? errLabel}
        </span>
      )}
    </div>
  );
}
