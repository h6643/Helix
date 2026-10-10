"use client";

import { AlertTriangle, Check, Loader2, Pencil } from "lucide-react";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  allowAlwaysLabel,
  deriveAllowPrefix,
  parsePermissionAsk,
  PERM_APPROVE_ANSWER,
  PERM_DENY_ANSWER,
} from "@/lib/permission-allow";
import type { ApprovalLevel } from "@/stores/helix-types";

export interface ApprovalRequest {
  id: string;
  sessionId?: string;
  /**
   * 发起这条请求的 **pi 后端 session id**（事件自带的 `session_id`，不是前端对话 id）。
   * 回应必须按它路由（网关 `routed_instance_or_ui_owner` 严格按 sid 找实例），
   * 所以卡片自己带着它 —— 归属判定只管「显示在哪个视图」，不再决定回给谁。
   */
  sid?: string;
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
    <div className="w-full max-w-[700px] mx-auto bg-card text-foreground border border-border/40 rounded-2xl shadow-2xl p-1.5">
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
        <pre className="bg-card rounded-xl p-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 font-mono whitespace-pre-wrap break-all mb-1.5 max-h-10 overflow-auto">
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

interface ClarifyRequest {
  id: string;
  question: string;
  choices: string[] | null;
  /** 审批卡到期时刻（ms epoch）；缺省/null = 普通 clarify，不显示倒计时 */
  expiresAt?: number | null;
  /**
   * pi-permission 审批卡（网关只在 permission==true 时附 approvalTimeoutSec）。
   * true 时渲染 once/session/reject 三选项（替代扩展的英文 choices 原文），
   * session 挡经 onApproveAlways 回 Approve (session) 原文，落表在扩展侧；
   * 需要父组件提供 onApproveAlways。
   */
  isPermission?: boolean;
}

interface ClarifyBarProps {
  request: ClarifyRequest;
  onRespond: (requestId: string, answer: string) => void;
  /** 审批卡「本会话始终允许」：父组件代答 Approve (session)，放行表归扩展所有。 */
  onApproveAlways?: (requestId: string) => void;
}

/** 统一的选项行：普通 clarify 是 choices 原文；审批卡是 once/always/reject。 */
interface ClarifyOption {
  label: string;
  /** 非 always 时回给扩展的应答原文 */
  answer?: string;
  always?: boolean;
}

export function ClarifyBar({
  request,
  onRespond,
  onApproveAlways,
}: ClarifyBarProps) {
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // 审批卡（pi-permission）且父组件接了 onApproveAlways → 三选项模式；
  // 否则保持原样渲染扩展 choices（strict 档/旧事件路径的兜底）。
  const permAsk = useMemo(
    () =>
      request.isPermission && onApproveAlways
        ? parsePermissionAsk(request.question)
        : null,
    [request.isPermission, request.question, onApproveAlways],
  );
  const permPrefix = permAsk ? deriveAllowPrefix(permAsk.command) : "";
  const options: ClarifyOption[] = useMemo(
    () =>
      permAsk
        ? [
            { label: "允许", answer: PERM_APPROVE_ANSWER },
            {
              label: allowAlwaysLabel(permAsk.tool, permPrefix),
              always: true,
            },
            { label: "拒绝", answer: PERM_DENY_ANSWER },
          ]
        : (request.choices || []).map((c) => ({ label: c, answer: c })),
    [permAsk, permPrefix, request.choices],
  );
  const [selectedIdx, setSelectedIdx] = useState<number | null>(
    options.length > 0 ? 0 : null,
  );
  // 审批卡倒计时（1s 一格）：expiresAt 由面板按网关附带的 approvalTimeoutSec
  // 算出。归零只是显示层面的镜到点；实际 fail-closed 拒绝在扩展侧同一时刻
  // 执行，卡片的出队由面板级过期清扫负责。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (typeof request.expiresAt !== "number") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [request.expiresAt]);
  const countdown =
    typeof request.expiresAt === "number"
      ? Math.max(0, Math.ceil((request.expiresAt - now) / 1000))
      : null;

  const submit = useCallback(
    (answer: string) => {
      const a = answer.trim();
      if (!a || submitting) return;
      setSubmitting(true);
      onRespond(request.id, a);
    },
    [request.id, onRespond, submitting],
  );

  const submitOption = useCallback(
    (opt: ClarifyOption | undefined) => {
      if (!opt || submitting) return;
      if (opt.always) {
        setSubmitting(true);
        onApproveAlways?.(request.id);
        return;
      }
      if (opt.answer) submit(opt.answer);
    },
    [request.id, onApproveAlways, submit, submitting],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 在输入框里打字不劫持数字键/Esc（自由回答仍然可用）。
      const inField = !!(
        e.target instanceof HTMLElement &&
        e.target.closest("input, textarea")
      );
      if (!inField && permAsk && (e.key === "Escape" || e.key === "1" || e.key === "2" || e.key === "3")) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") submitOption(options[2]);
        else submitOption(options[Number(e.key) - 1]);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => {
          if (options.length === 0) return null;
          if (i === null) return 0;
          return i > 0 ? i - 1 : 0;
        });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => {
          if (options.length === 0) return null;
          if (i === null) return options.length - 1;
          return i < options.length - 1 ? i + 1 : options.length - 1;
        });
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (freeText.trim()) {
          submit(freeText);
        } else if (selectedIdx !== null && options[selectedIdx]) {
          submitOption(options[selectedIdx]);
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [options, permAsk, freeText, selectedIdx, submit, submitOption]);

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 w-full px-5 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-[700px] mx-auto bg-card text-foreground border border-border/40 rounded-2xl shadow-2xl p-4">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="text-[calc(var(--helix-transcript-size)*0.9286)] font-semibold leading-snug">
            需要你的确认
          </h3>
          <div className="flex items-center gap-2 shrink-0">
            {countdown !== null && (
              <span
                className={
                  "shrink-0 text-[calc(var(--helix-transcript-size)*0.7143)] font-medium px-2 py-0.5 rounded-full border tabular-nums " +
                  (countdown <= 30
                    ? "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/25"
                    : "bg-muted text-muted-foreground border-border/40")
                }
              >
                剩 {Math.floor(countdown / 60)}:
                {String(countdown % 60).padStart(2, "0")} 自动拒绝
              </span>
            )}
            <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7143)] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/25">
              等待确认
            </span>
          </div>
        </div>

        <div className="bg-muted rounded-lg px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 leading-relaxed whitespace-pre-wrap break-words mb-2 max-h-32 overflow-auto">
          {request.question || "模型需要你的选择"}
        </div>

        {options.length > 0 && (
          <div className="flex flex-col gap-1.5 mb-2 max-h-40 overflow-y-auto pr-0.5">
            {options.map((opt, idx) => {
              const isSel = selectedIdx === idx;
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => submitOption(opt)}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  disabled={submitting}
                  className={
                    "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-left transition-colors disabled:opacity-60 " +
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
                    {opt.label}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2">          <input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            disabled={submitting}
            placeholder={options.length ? "或输入其他回答…" : "输入回答…"}
            className="flex-1 h-9 px-3 rounded-lg bg-background/60 border border-border/50 text-[calc(var(--helix-transcript-size)*0.9286)] text-foreground disabled:opacity-50"
          />
          <Button
            size="sm"
            disabled={submitting || !freeText.trim()}
            onClick={() => submit(freeText)}
            className="h-9 px-4 text-[calc(var(--helix-transcript-size)*0.9286)]"
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              "回复"
            )}
          </Button>
        </div>

        <div className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60 text-center mt-2">
          {permAsk
            ? "内容由 AI 生成，请核实重要信息 · 1 允许 · 2 会话放行 · 3/Esc 拒绝 · 也可自由输入"
            : "内容由 AI 生成，请核实重要信息 · ↑↓ 选择 · Enter 确认 · 也可自由输入"}
        </div>
      </div>
    </div>
  );
}

// ── 计划审查浮条（─────────────────────────────────────
// 计划模式下模型产完计划（本轮 run 结束）后弹出：用户批准后才开始真正执行。
// 批准 → 前端切到 default 并续发一条"请执行"指令触发新一轮 run；
// 继续调整 → 关闭浮条，保持计划模式，用户可继续对话修改方案。

export interface PlanReviewRequest {
  sessionId?: string;
  // 本轮模型产出的计划全文（用于预览）
  content: string;
}

interface PlanReviewBarProps {
  content: string;
  onApprove: () => void;
  /** 修改反馈：传字符串 → 自动作为 plan follow-up 重新规划；不传 → 仅关条。 */
  onAdjust: (feedback?: string) => void;
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

  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");

  const submitFeedback = useCallback(() => {
    const fb = feedback.trim();
    if (!fb || submitting) return;
    setSubmitting("adjust");
    onAdjust(fb);
  }, [feedback, submitting, onAdjust]);

  const closeAdjust = useCallback(() => {
    setShowFeedback(false);
    setFeedback("");
    onAdjust();
  }, [onAdjust]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        approve();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onAdjust();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [approve, onAdjust]);

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 w-full px-5 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-[700px] mx-auto bg-card text-foreground border-2 border-primary/40 rounded-2xl shadow-2xl p-2">
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
            onClick={() => setShowFeedback((v) => !v)}
            className="flex-1 h-8 text-[calc(var(--helix-transcript-size)*0.9286)]"
          >
            <Pencil className="size-3.5" />
            修改计划
          </Button>
        </div>

        {showFeedback && (
          <div className="space-y-2">
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="写修改意见，提交后 agent 基于意见重新规划…"
              rows={2}
              autoFocus
              className="w-full rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] resize-none"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={submitFeedback}
                disabled={!feedback.trim() || submitting !== null}
                className="flex-1 h-8 text-[calc(var(--helix-transcript-size)*0.8571)]"
              >
                {submitting === "adjust" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                提交并重新规划
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={closeAdjust}
                className="h-8 text-[calc(var(--helix-transcript-size)*0.8571)]"
              >
                取消
              </Button>
            </div>
          </div>
        )}

        <div className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60 text-center mt-1">
          批准后开始执行，危险操作仍需确认 · ⌘/Ctrl+Enter 批准 · Esc 修改计划
        </div>
      </div>
    </div>
  );
}
