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
 *   退化为用后端 sid 作键——与旧行为一致。
 * - backendSid: 调用方已知的后端 sid（如 handleRun 刚 session/new 出来的）；
 *   省略时按 session-map（epoch 校验）解析。绝不兜底到全局 helixSessionId
 *   ——那是「最后一个跑过的对话」的后端会话，用它查询会把别的对话的
 *   用量/分类写进本对话的快照（跨会话污染）。调用方没给 sid 且映射里
 *   没有本对话的条目时，直接放弃捕获（返回 false）。
 *
 * 写回规则：
 * - 仅当后端返回非空分类才写（唯一目的是持久化分类/工具集明细，重启后
 *   弹窗不显示"暂无上下文分类数据"）；
 * - size/used 不改——环的读数唯一来源是 usage_prompt_complete 实测值
 *   （agent-flow-panel 落盘），两个口径不同，合并会造成读数跳变。
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
    const localPrev = useHelixStore.getState().contextUsage[key];
    // 只写分类/工具集明细，不改 size/used：环的 used/size 由 run 结束的
    // usage_prompt_complete 实测值落盘（agent-flow-panel），是唯一写入口径。
    // 此处是 breakdown RPC（anchored 口径，语义不同），若做 max() 合并会让
    // 本地快照在「开弹窗/切会话」时被抬升，环随之跳变（"上下文乱变动"根因）。
    // 从未跑过 run 的对话 localPrev 为空 → size/used 落 0，环显示空态，符合
    // "没跑过就没有读数"的语义。
    useHelixStore.getState().setContextUsage(
      key,
      localPrev?.size || data.context_max || 0,
      localPrev?.used || data.context_used || 0,
      data.categories.map((c) => ({
        id: c.id,
        label: c.label,
        tokens: c.tokens,
        color: c.color,
      })),
      data.toolsets?.map((t) => ({
        toolset: t.toolset,
        tool_count: t.tool_count,
        schema_tokens: t.schema_tokens,
      })),
    );
    return true;
  } catch {
    // Backend may not support this — degrade gracefully
    return false;
  }
}
