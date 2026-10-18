"use client";

import { Check, ChevronDown } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { useAnchoredPopup, useLockScrollOnOpen } from "./settings-hooks";
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
  /** 标签按该字体渲染（如字体选择器：每项用自身字体显示）。 */
  fontFamily?: string;
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
 * 自定义下拉选择。原生 `<select>` 的弹出列表在部分 webview 引擎下不可靠
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
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // 展开期间跟随触发器：滚动 / resize / 触发器尺寸变化都会重新贴合。
  const pos = useAnchoredPopup(open, btnRef, popRef, {
    width: popupWidth,
  });

  const current = options.find((o) => String(o.value) === value);
  const currentLabel = current?.label ?? placeholder;
  // 选中项若声明了 fontFamily（字体选择器），触发器里的标签也用该字体渲染。
  const currentFontStyle = current?.fontFamily
    ? ({ fontFamily: current.fontFamily } as const)
    : undefined;

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

  // 锚定在触发器下方、右对齐；宽度与触发器一致。定位与翻转逻辑都在
  // useAnchoredPopup 里（它还会在触发器移动时重新贴合）。

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
        <span className="truncate" style={currentFontStyle}>
          {currentLabel}
        </span>
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
          <span className="block truncate" style={o.fontFamily ? { fontFamily: o.fontFamily } : undefined}>
            {o.label}
          </span>
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
