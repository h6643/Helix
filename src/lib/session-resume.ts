"use client";

import { helixApi } from "@/lib/electron-bridge";
import { debug } from "@/lib/logger";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Resume 的唯一语义 + broken 的唯一判定
 *
 * Resume = 按 SID 恢复原会话。结果只有三种（Rust `classify_session_error`）：
 *
 *   SESSION_NOT_FOUND     SID 对应的持久化 Session 文件不存在（cache miss +
 *                         磁盘扫描 miss）。这是**永久**的会话生命周期状态：
 *                         这个 SID 对应的会话已经没了。
 *   SESSION_RESTORE_FAILED 文件找到了，但无法恢复（权限、JSONL 损坏、
 *                         switch_session 超时/进程死亡、pi 拒绝切换）。这是
 *                         **可重试**的恢复故障——文件还在磁盘上。
 *   INTERNAL              其他（spawn 失败、网关内部错误）：与会话本身无关。
 *
 * 只有 SESSION_NOT_FOUND 能把会话标记 broken（见 {@link isSessionGone}）。
 * 把 RESTORE_FAILED 也标 broken 会把一次瞬时故障永久化成一个再也找不到的
 * 会话，这正是这里刻意区分两类错误的唯一理由。
 *
 * 所有入口（gateway.ready / handleRun / compact / resync / session/prompt）
 * 都必须用 {@link resumeSession} + {@link isSessionGone}，不允许各自判断
 * code，也不允许 resume 失败后走 createSession / seed_history 换新 SID。
 * broken 由 Session 的生命周期决定，不由某个入口决定。
 * ─────────────────────────────────────────────────────────────────────────
 */
export type ResumeErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_RESTORE_FAILED"
  | "INVALID_REQUEST"
  | "INTERNAL";

export type ResumeResult =
  | { ok: true; sessionId: string; messages?: unknown[] }
  | { ok: false; code: ResumeErrorCode; error: string };

/** 后端结构化 error_kind → 前端 code。未知 kind 一律 INTERNAL，不猜。 */
const KIND_TO_CODE: Record<string, ResumeErrorCode> = {
  session_not_found: "SESSION_NOT_FOUND",
  session_restore_failed: "SESSION_RESTORE_FAILED",
  invalid_request: "INVALID_REQUEST",
  internal: "INTERNAL",
};

/**
 * 错误文本 → code。serve/ACP 模式失败是 throw 出来的字符串，session/prompt
 * 保持 Err 契约、只在消息前缀带上 kind（Rust `routed_instance`），所以这两
 * 条路径要靠文本分类。规则与 Rust `classify_session_error` 对齐：
 * "no session file" 必须在最前面判断——包装后的
 * `session restore task failed: no session file for …` 也必须算
 * SESSION_NOT_FOUND。
 */
export function classifyResumeError(err: unknown): {
  code: ResumeErrorCode;
  error: string;
} {
  const msg = String(
    err instanceof Error ? err.message : typeof err === "string" ? err : "",
  );
  const m = msg.toLowerCase();
  if (
    /no session file|session_not_found|session not found|no such session|unknown session/.test(
      m,
    )
  )
    return { code: "SESSION_NOT_FOUND", error: msg };
  if (
    /session_restore_failed|restore failed|switch session|permission|access denied|denied|corrupt|parse|decode|timeout/.test(
      m,
    )
  )
    return { code: "SESSION_RESTORE_FAILED", error: msg };
  if (/missing session_id|invalid|缺少|参数/i.test(m))
    return { code: "INVALID_REQUEST", error: msg };
  return { code: "INTERNAL", error: msg };
}

/**
 * 统一的 Session Resume 入口（Codex Thread Resume 模型）。
 *
 * 只按传入的 SID 恢复**原会话**：cache 命中+文件存在 → 恢复；cache miss →
 * 后端扫描该 SID 的文件；扫描不到 → SESSION_NOT_FOUND。
 *
 * 这里**绝不**做：换一个 SID、按 cwd/指纹找最近会话、createSession、
 * seedHistory 注入——那些是 Session Discovery / History→New Session 的职责，
 * 不属于 Resume。
 */
export async function resumeSession(sid: string): Promise<ResumeResult> {
  try {
    const res = (await helixApi()?.send("session/resume", {
      session_id: sid,
    })) as any;
    // Rust 网关失败时返回结构化响应 { error, error_kind }，不是 throw。
    if (res && typeof res === "object" && (res.error || res.error_kind)) {
      const kind = String(res.error_kind ?? "");
      // 未知 kind 按 INTERNAL 处理：宁可让用户看到"恢复失败"并重试，也不能
      // 猜成 SESSION_NOT_FOUND 把一个可能还活着的会话永久标失效。
      const code: ResumeErrorCode = KIND_TO_CODE[kind] ?? "INTERNAL";
      debug("[SessionResume] resume failed:", sid, kind, res.error);
      return { ok: false, code, error: String(res.error ?? "") };
    }
    const restoredId = res?.session_id || res?.sessionID || sid;
    return { ok: true, sessionId: restoredId, messages: res?.messages };
  } catch (err) {
    // serve/ACP 模式：RPC 失败直接 throw。
    debug("[SessionResume] resume threw:", sid, String(err));
    return { ok: false, ...classifyResumeError(err) };
  }
}

/**
 * **唯一**的 broken 判定：只有 SESSION_NOT_FOUND 才把会话标记 broken。
 *
 * 所有入口都必须走这个函数，不要自己写 `code === "SESSION_NOT_FOUND"`——
 * 判定规则将来要改（比如把 corrupted 也算永久失效）时只改这一处。
 */
export function isSessionGone(r: ResumeResult): boolean {
  return !r.ok && r.code === "SESSION_NOT_FOUND";
}

/**
 * 权威判定：这个 SID 对应的**持久化 Session** 是否真的不存在。
 *
 * 给那些「某个操作报了 session not found、但不能确定是文件没了还是只是没
 * attach」的路径用（session/prompt、session.compress）：serve 模式下后端回
 * 的 "session not found" 指的是**内存里的 ui_session 丢了**（网关重启/回收），
 * 磁盘文件可能还在、还能恢复。直接据此标 broken 会把可恢复会话永久化。
 * 这里做一次权威 resume 检查；返回 true 才允许 markSessionBroken。
 *
 * 注意：这个检查只用于判定生命周期状态，不会重发失败的 prompt / compress。
 */
export async function sessionFileGone(sid: string): Promise<boolean> {
  const r = await resumeSession(sid);
  return isSessionGone(r);
}

/** 统一的失败标题：所有入口同一套措辞，不允许一个入口静默。 */
export function resumeFailureTitle(r: ResumeResult): string {
  return isSessionGone(r) ? "后端会话已失效" : "恢复失败";
}

/**
 * 统一的失败描述：SESSION_NOT_FOUND 明确说会话已标记失效；其余保留真实错误
 * （不谎称会话丢失，用户还能重试）。
 */
export function resumeFailureDescription(r: ResumeResult): string {
  if (isSessionGone(r))
    return "该对话的后端会话文件不存在，已标记为失效，请新建对话";
  return !r.ok && r.error ? r.error.slice(0, 160) : "恢复失败";
}

/** 统一的用户可见错误消息（handleRun throw 用）。 */
export function resumeFailureMessage(r: ResumeResult): string {
  if (isSessionGone(r))
    return "SESSION_NOT_FOUND: 该对话的后端会话文件不存在，已标记为失效，请新建对话";
  return r.ok
    ? "恢复失败：未知错误"
    : `恢复失败 (${r.code}): ${r.error.slice(0, 200)}`;
}

/**
 * `markSessionBroken` 的**统一原因文案**（人话 + 括号里后端原文）。
 *
 * brokenSessionReasons 会直接显示在失效横幅（agent-flow-panel 底部）和
 * handleRun 的 broken 短路报错里（"失效原因：…"），所以不能在各个入口自己拼
 * 字符串，更不能塞后端原文（旧实现干脆把 reason 参数丢了 → 界面永远显示
 * sid）。所有 resume 驱动的 markSessionBroken 都走这里。
 */
export function brokenReasonFromResume(r: ResumeResult): string {
  const detail = !r.ok && r.error ? r.error : "";
  return isSessionGone(r)
    ? brokenReasonFileGone(detail)
    : `会话恢复失败${detail ? `（${detail.slice(0, 120)}）` : ""}`;
}

/**
 * 同一套「文件不存在」原因文案，给**只拿到原始错误文本**、没有 ResumeResult
 * 的路径用（sessionFileGone 已把结果压成 boolean 的调用点）。
 */
export function brokenReasonFileGone(detail?: string): string {
  const d = detail?.trim();
  return d ? `后端会话文件不存在（${d.slice(0, 120)}）` : "后端会话文件不存在";
}
