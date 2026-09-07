"use client";

import { AlertTriangle, Check, Loader2, Pencil } from "lucide-react";
import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import type { ApprovalLevel } from "@/stores/helix-types";

export interface ApprovalRequest {
  id: string;
  sessionId?: string;
  toolName: string;
  params: Record<string, unknown>;
  command?: string;
  allowPermanent?: boolean;
  timestamp: number;
}

function getApprovalTitle(toolName: string): string {
  // 后端项目外读取审批的 pattern_key 前缀（file_tools._check_approval_required_read）
  if (toolName.includes("read_file:outside_project")) {
    return "检测到工作空间外部文件读取";
  }
  switch (toolName) {
    case "terminal":
    case "run_bash":
    case "execute_code":
      return "检测到工作空间外部文件修改";
    default:
      return "需要你的批准";
  }
}

interface ApprovalBarProps {
  request: ApprovalRequest;
  onApprove: (level: ApprovalLevel) => void;
  pendingCount?: number;
  onApproveAll?: () => void;
  onRejectAll?: () => void;
}

/**
 * Inline approval card (light, non-blocking) — anchored to the bottom-center of
 * the panel via the parent <ApprovalDialog> absolute wrapper, so it is always
 * visible regardless of how long the message list is. No modal overlay, so the
 * user can still switch conversations while it is open.
 * Keyboard: ⌘/Ctrl+Enter = allow · Esc = deny · ↑/↓ = move selection · Enter = confirm.
 */
function ApprovalBar({
  request,
  onApprove,
  pendingCount,
  onApproveAll,
  onRejectAll,
}: ApprovalBarProps) {
  const [submitting, setSubmitting] = useState<ApprovalLevel | null>(null);
  const [selected, setSelected] = useState<ApprovalLevel>("once");
  const command =
    request.command ||
    (typeof request.params.command === "string" ? request.params.command : "");

  const handleApprove = useCallback(
    (level: ApprovalLevel) => {
      setSubmitting(level);
      onApprove(level);
    },
    [onApprove],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        handleApprove("once");
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleApprove("deny");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) =>
          s === "deny" ? "session" : s === "session" ? "once" : "once",
        );
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) =>
          s === "once" ? "session" : s === "session" ? "deny" : "deny",
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        handleApprove(selected);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [handleApprove, selected]);

  const options: { key: string; level: ApprovalLevel; label: string }[] = [
    { key: "1", level: "once", label: "允许" },
    { key: "2", level: "session", label: "本次会话内始终允许该类命令" },
    { key: "3", level: "deny", label: "拒绝" },
  ];

  return (
    <div className="w-full max-w-[700px] mx-auto bg-popover text-foreground border border-border rounded-2xl shadow-2xl p-2.5">
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="text-[calc(var(--helix-transcript-size)*0.9286)] font-semibold leading-snug">
          {getApprovalTitle(request.toolName)}
          {typeof pendingCount === "number" && pendingCount > 1 && (
            <span className="ml-2 text-[calc(var(--helix-transcript-size)*0.7857)] font-normal text-foreground/50">
              还有 {pendingCount - 1} 个待确认
            </span>
          )}
        </h3>
        <span className="shrink-0 mt-0.5 text-[calc(var(--helix-transcript-size)*0.7143)] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/25">
          等待确认
        </span>
      </div>
      {command && (
        <pre className="bg-muted rounded-xl p-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 font-mono whitespace-pre-wrap break-all mb-1.5 max-h-10 overflow-auto">
          {command}
        </pre>
      )}
      {/* onApproveAll / onRejectAll removed per user request */}
      <div className="flex flex-col gap-1">
        {options.map((o) => {
          const isSel = selected === o.level;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => handleApprove(o.level)}
              onMouseEnter={() => setSelected(o.level)}
              disabled={submitting !== null}
              className={
                "flex items-center gap-2.5 px-3 py-1.5 rounded-xl border text-left transition-colors disabled:opacity-60 " +
                (isSel
                  ? "border-ring bg-accent ring-1 ring-ring"
                  : "border-transparent hover:bg-accent/60")
              }
            >
              <span
                className={
                  "w-5 h-5 rounded-full flex items-center justify-center text-[calc(var(--helix-transcript-size)*0.7857)] font-semibold shrink-0 " +
                  (isSel
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground")
                }
              >
                {o.key}
              </span>
              <span className="text-[calc(var(--helix-transcript-size)*0.8571)]">
                {o.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Keep the old dialog for backwards compatibility — now renders the inline ApprovalBar
// as a bottom-anchored, non-blocking card (can switch conversations while open).
interface LegacyProps {
  request: ApprovalRequest;
  pendingCount?: number;
  // level 直接透传（once/session/always/deny），由父组件映射为 approval.respond 的
  // choice；不再折成 cache?: boolean（那会丢失 session/deny 语义，2026-08-17）。
  onApprove: (id: string, level: ApprovalLevel) => void;
  onReject: (id: string) => void;
  onApproveAll?: () => void;
  onRejectAll?: () => void;
}
export function ApprovalDialog(props: LegacyProps) {
  const { request, onApprove, onReject } = props;
  const handleApprove = useCallback(
    (level: ApprovalLevel) => {
      if (!request) return;
      onApprove(request.id, level);
    },
    [request, onApprove],
  );
  if (!request) return null;
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 w-full px-5 pointer-events-none">
      <div className="pointer-events-auto mx-auto max-w-[700px]">
        <ApprovalBar
          // key=request.id：连续多个审批时强制重挂载，重置 submitting/selected。
          // 否则第一个审批点击后 submitting 卡在非 null，第二个弹窗按钮全禁用、
          // 看起来"点了不消失也不切下一个"（2026-08-17 实录）。
          key={request.id}
          request={request}
          onApprove={handleApprove}
          pendingCount={props.pendingCount}
          onApproveAll={props.onApproveAll}
          onRejectAll={props.onRejectAll}
        />
      </div>
    </div>
  );
}

// ── Clarify 反问浮条 ─────────────────────────────────────────────────────
// 模型调用 clarify 工具反问你（给几个选项让你挑，或自由输入）。样式/位置与
// ApprovalDialog 的底部浮条一致。点选项或提交输入后 onRespond(requestId, answer)。

export interface ClarifyRequest {
  id: string;
  question: string;
  choices: string[] | null;
}

interface ClarifyBarProps {
  request: ClarifyRequest;
  onRespond: (requestId: string, answer: string) => void;
}

export function ClarifyBar({ request, onRespond }: ClarifyBarProps) {
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const choices = request.choices || [];
  const [selectedIdx, setSelectedIdx] = useState<number | null>(
    choices.length > 0 ? 0 : null,
  );

  const submit = useCallback(
    (answer: string) => {
      const a = answer.trim();
      if (!a || submitting) return;
      setSubmitting(true);
      onRespond(request.id, a);
    },
    [request.id, onRespond, submitting],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => {
          if (choices.length === 0) return null;
          if (i === null) return 0;
          return i > 0 ? i - 1 : 0;
        });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => {
          if (choices.length === 0) return null;
          if (i === null) return choices.length - 1;
          return i < choices.length - 1 ? i + 1 : choices.length - 1;
        });
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (freeText.trim()) {
          submit(freeText);
        } else if (selectedIdx !== null && choices[selectedIdx]) {
          submit(choices[selectedIdx]);
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [choices, freeText, selectedIdx, submit]);

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 w-full px-5 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-[700px] mx-auto bg-popover text-foreground border border-border rounded-2xl shadow-2xl p-3">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <h3 className="text-[calc(var(--helix-transcript-size)*0.9286)] font-semibold leading-snug">
            需要你的确认
          </h3>
          <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7143)] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/25">
            等待确认
          </span>
        </div>

        <div className="bg-muted rounded-lg px-2.5 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 leading-relaxed whitespace-pre-wrap break-words mb-1.5 max-h-16 overflow-auto">
          {request.question || "模型需要你的选择"}
        </div>

        {choices.length > 0 && (
          // 选项列表限制高度：模型一次可能给很多选项，全部平铺会把弹窗撑到
          // 占满整个对话界面。max-h-28(112px,约 3 个选项)以上滚动。
          <div className="flex flex-col gap-1 mb-1.5 max-h-28 overflow-y-auto pr-0.5">
            {choices.map((c, idx) => {
              const isSel = selectedIdx === idx;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => submit(c)}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  disabled={submitting}
                  className={
                    "flex items-center gap-2 px-2.5 py-1 rounded-lg border text-left transition-colors disabled:opacity-60 " +
                    (isSel
                      ? "border-ring bg-accent ring-1 ring-ring"
                      : "border-transparent hover:bg-accent/60")
                  }
                >
                  <span
                    className={
                      "w-5 h-5 rounded-full flex items-center justify-center text-[calc(var(--helix-transcript-size)*0.7857)] font-semibold shrink-0 " +
                      (isSel
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground")
                    }
                  >
                    {idx + 1}
                  </span>
                  <span className="text-[calc(var(--helix-transcript-size)*0.9286)] truncate">
                    {c}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            disabled={submitting}
            placeholder={choices.length ? "或输入其他回答…" : "输入回答…"}
            className="flex-1 h-8 px-3 rounded-lg bg-background/60 border border-border/50 text-[calc(var(--helix-transcript-size)*0.9286)] text-foreground outline-none focus:border-ring disabled:opacity-50"
          />
          <Button
            size="sm"
            disabled={submitting || !freeText.trim()}
            onClick={() => submit(freeText)}
            className="h-8 px-4 text-[calc(var(--helix-transcript-size)*0.9286)]"
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              "回复"
            )}
          </Button>
        </div>

        <div className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60 text-center mt-1">
          内容由 AI 生成，请核实重要信息 · ↑↓ 选择 · Enter 确认 · 也可自由输入
        </div>
      </div>
    </div>
  );
}

// ── 计划审查浮条（Claude 式两阶段）─────────────────────────────────────
// 计划模式下模型产完计划（本轮 run 结束）后弹出：用户批准后才开始真正执行。
// 批准 → 前端切到 accept_edits 并续发一条"请执行"指令触发新一轮 run；
// 继续调整 → 关闭浮条，保持计划模式，用户可继续对话修改方案。

export interface PlanReviewRequest {
  sessionId?: string;
  // 本轮模型产出的计划全文（用于预览）
  content: string;
}

interface PlanReviewBarProps {
  content: string;
  onApprove: () => void;
  onAdjust: () => void;
}

export function PlanReviewBar({
  content,
  onApprove,
  onAdjust,
}: PlanReviewBarProps) {
  const [submitting, setSubmitting] = useState<"approve" | "adjust" | null>(
    null,
  );

  const approve = useCallback(() => {
    if (submitting) return;
    setSubmitting("approve");
    onApprove();
  }, [submitting, onApprove]);

  const adjust = useCallback(() => {
    if (submitting) return;
    setSubmitting("adjust");
    onAdjust();
  }, [submitting, onAdjust]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        approve();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        adjust();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [approve, adjust]);

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 w-full px-5 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-[700px] mx-auto bg-popover text-foreground border border-border rounded-2xl shadow-2xl p-3">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <h3 className="text-[calc(var(--helix-transcript-size)*0.9286)] font-semibold leading-snug">
            计划已生成
          </h3>
          <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7143)] font-medium px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/25">
            待批准执行
          </span>
        </div>

        <div className="bg-muted rounded-lg px-2.5 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 leading-relaxed whitespace-pre-wrap break-words mb-1.5 max-h-64 overflow-auto">
          {content || "（模型未输出可见计划文本）"}
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={submitting !== null}
            onClick={approve}
            className="flex-1 h-8 text-[calc(var(--helix-transcript-size)*0.9286)]"
          >
            {submitting === "approve" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            批准并执行
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={submitting !== null}
            onClick={adjust}
            className="flex-1 h-8 text-[calc(var(--helix-transcript-size)*0.9286)]"
          >
            {submitting === "adjust" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Pencil className="size-3.5" />
            )}
            继续调整
          </Button>
        </div>

        <div className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60 text-center mt-1">
          批准后开始执行，危险操作仍需确认 · ⌘/Ctrl+Enter 批准 · Esc 继续调整
        </div>
      </div>
    </div>
  );
}
