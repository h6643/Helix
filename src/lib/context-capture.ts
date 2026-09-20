/**
 * context-capture.ts — 上下文分类数据（context_breakdown）的捕获与本地持久化。
 *
 * 从 context-usage.tsx 拆出的纯逻辑模块（组件文件导出非组件成员会破坏 React
 * Fast Refresh），供 ContextUsageIndicator 与 agent-flow-panel（run 结束兜底
 * 捕获）共用。
 *
 * 为什么需要 run 结束捕获：`session.context_breakdown` 在后端 agent 构建完成前
 * 返回空分类（categories: []）。会话创建瞬间的捕获必然拿到空值；只有 run 结束
 * 时 agent 才完整、分类数据才权威。若只在弹窗打开时捕获，没打开过弹窗的会话
 * 重启后分类数据必丢（"重启后有的会消失"根因）。
 */

import { helixApi } from "@/lib/electron-bridge";
import { resolveBackendSid } from "@/lib/session-map";
import { useHelixStore } from "@/stores/helix-store";

interface ContextBreakdownData {
  context_max: number;
  context_used: number;
  context_percent: number;
  estimated_total?: number;
  categories: Array<{
    id: string;
    label: string;
    tokens: number;
    color: string;
    /** 后端"整块占用"兜底项（会话文件未落盘时），落快照时一并保留 */
    aggregate?: boolean;
  }>;
  toolsets?: Array<{
    toolset: string;
    tool_count: number;
    schema_tokens: number;
  }>;
}

/**
 * 拉取某对话的上下文分类并写入本地快照（contextUsage[conversationId]）。
 *
 * - conversationId: Helix 会话 id（跨重启稳定），本地记录键。draft（null）时
 *   退化为用后端 sid 作键（此时没有别的可选项）；读侧两键都查，并在拿到 cid
 *   后把落在 sid 键上的旧快照搬到 cid 键（见 context-usage.tsx 的键统一注释）。
 * - backendSid: 调用方已知的后端 sid（如 handleRun 刚 session/new 出来的）；
 *   省略时按 session-map（epoch 校验）解析。绝不兜底到全局 helixSessionId
 *   ——那是「最后一个跑过的对话」的后端会话，用它查询会把别的对话的
 *   用量/分类写进本对话的快照（跨会话污染）。调用方没给 sid 且映射里
 *   没有本对话的条目时，直接放弃捕获（返回 false）。
 *
 * 写回规则：
 * - 仅当后端返回非空分类或非零用量才写（空会话不把本地真实值覆盖成 0）；
 * - size/used 按 authoritative 直接覆盖。后端 context_used 是「下一条
 *   prompt 将重放的真实上下文」（pi 最后一次请求用量与 jsonl 活跃分支估算、
 *   持久化 usage anchor 的较大者，见 pi_gateway context_breakdown）——与环要
 *   显示的语义一致，且后端已做过 max，本地再取一次只会把残留的高位抬回来。
 *   历史版本用 max(本地快照, 后端值) 保证单调不减，副作用是压缩后本地快照里
 *   的旧高位盖掉后端的 16k，环和弹窗刷新都永远停在压缩前。恢复旧对话读数偏低
 *   的问题由后端那个 max 兜住，不再需要前端这边再抬一次。
 *
 * @returns 是否实际写入了本地快照（供调用方决定是否标记"已捕获"）。
 */
export async function captureContextBreakdown(
  conversationId: string | null | undefined,
  backendSid?: string | null,
): Promise<boolean> {
  // 绝不兜底到全局 helixSessionId（跨会话污染，见 doc 注释）。
  const sid = backendSid || (await resolveBackendSid(conversationId || null));
  if (!sid) return false;
  try {
    const result = await helixApi()?.send("session.context_breakdown", {
      session_id: sid,
    });
    if (!result || typeof result !== "object") return false;
    const data = result as ContextBreakdownData;
    const hasBreakdown =
      (data.categories?.length ?? 0) > 0 ||
      ((data.context_used ?? 0) > 0 && (data.context_max ?? 0) > 0);
    if (!hasBreakdown) return false;
    const key = conversationId || sid;
    // authoritative：context_breakdown 是完整后端查询，返回的 context_used 已按
    // 「下一条 prompt 真实上下文」的语义取过 max——它本身就是权威值，不该再和本地
    // 快照 max 一次。旧的 max 合并是为了解决两个问题：恢复旧对话时读数偏低、估算
    // 偏低时把环缩水。两者都依赖 max 抬升，但如果快照里残留的是压缩前的高位，max
    // 会把后端的 16k 抬回 213k，弹窗刷新就永远不会更新环。
    // 代价：这个函数也会被弹窗每 5s 的轮询调用，工具循环进行中会短暂低于实际在飞
    // 的上下文——下一条 usage_prompt_complete（同样 authoritative）会把它抬回真实值。
    useHelixStore.getState().setContextUsage(
      key,
      data.context_max || 0,
      data.context_used || 0,
      data.categories.map((c) => ({
        id: c.id,
        label: c.label,
        tokens: c.tokens,
        color: c.color,
        ...(c.aggregate ? { aggregate: true } : {}),
      })),
      data.toolsets?.map((t) => ({
        toolset: t.toolset,
        tool_count: t.tool_count,
        schema_tokens: t.schema_tokens,
      })),
      true,
    );
    return true;
  } catch {
    // Backend may not support this — degrade gracefully
    return false;
  }
}
