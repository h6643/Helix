/**
 * pi-fork.ts — 把「本地分叉点」翻译成 pi 的 fork entryId。
 *
 * 前端的分叉按钮只知道一条本地消息（`forkConversation(messageId)`），而 pi 的
 * `fork` RPC 要的是**会话条目树上的 entryId**，且语义固定是 position
 * "before"：branch 到该 user entry 的 parent，即「保留这条 user 消息之前的
 * 全部历史」。要表达「保留到分叉点为止」就必须传**分叉点之后第一条 user
 * 消息**的 entryId。
 *
 * 两边的序列没有共享 id，只能按文本对齐：pi 的 `get_fork_messages` 返回
 * `[{entryId, text}]`（只含带文本的 user entry，就是 pi 自己 /fork 选择器
 * 用的同一份数据）。本地分叉窗口里的 user 消息按序应当是它的一个**前缀**，
 * 所以从前到后逐条配对齐，配完的那一条的下一个 entry 就是分叉目标。
 *
 * 对齐失败（网关没连上、会话被回收、文本对不上）时返回空 entryId，调用方
 * 整个跳过后端分叉、改走纯本地分叉。这个失败方向是**偏安全**的：后端由前端
 * 用本地历史重建，与用户点的分叉点严格一致；反过来（猜一个更早的 entryId）
 * 会静默砍掉用户明确要保留的上下文，所以宁可漏匹配也不猜。
 *
 * 注意 pi 侧存的是**模型实际收到的 user 消息原文**：附件会以
 * `--- 文件 x 的内容 ---` 等上下文缀在后面（prompt_parts 之前由前端拼好），
 * 所以本地文本只是 pi 文本的前缀，不能按相等判断。
 */

import { helixApi } from "@/lib/electron-bridge";
import type { ChatMessage } from "@/stores/helix-types";

/** pi 的 user message 摘要（`get_fork_messages` 的返回元素）。 */
type PiForkMessage = { entryId?: string; text?: string };

export type ForkTarget = {
  /** pi 的 fork entryId；空串表示「定位失败，调用方应跳过后端分叉」。 */
  entryId: string;
  /** 诊断用：pi 侧一共几条 user 消息、本地前几条对齐成功。 */
  piCount: number;
  alignedCount: number;
  /** 为什么没给出 entryId（对齐日志 / toast 文案用）。 */
  reason?: string;
};

/**
 * 归一化用于比对的文本。只压空白、截前 160 字符：附件上下文可能远比用户输入
 * 长，前缀一致就足以定位，而截断能避开「后半段被压缩摘要改写」的干扰。
 */
function fingerprint(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * 本地分叉窗口里的 user 消息文本（按顺序）。
 *
 * 只收 role === "user"：pi 的 `getUserMessagesForForking` 同样只列 user
 * entry，两边序列才有可比性。system 消息（压缩提示等）在 pi 侧根本不是
 * message entry，收进来只会让对齐从第一条就失败。
 */
function localUserTexts(messages: ChatMessage[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => fingerprint(m.content))
    .filter((t) => t.length > 0);
}

/**
 * 计算这次分叉要传给 `session/fork` 的 entryId。
 *
 * @param backendSid 父对话的后端 sid（`resolveBackendSid` 的结果）
 * @param keptMessages 分叉窗口内的本地消息（含分叉点本身）
 */
export async function getUserMessageEntryIdsForFork(
  backendSid: string,
  keptMessages: ChatMessage[],
): Promise<ForkTarget> {
  if (!backendSid || keptMessages.length === 0) {
    return { entryId: "", piCount: 0, alignedCount: 0, reason: "no-parent-sid" };
  }
  const local = localUserTexts(keptMessages);
  if (local.length === 0) {
    return { entryId: "", piCount: 0, alignedCount: 0, reason: "no-local-user" };
  }

  let piMessages: PiForkMessage[] = [];
  try {
    const r = (await helixApi()?.send("get_fork_messages", {
      session_id: backendSid,
    })) as { messages?: unknown } | null;
    if (Array.isArray(r?.messages)) piMessages = r.messages as PiForkMessage[];
  } catch (e) {
    // 网关没连上 / 会话被回收：拿不到 entry 列表，调用方回落 clone。
    return {
      entryId: "",
      piCount: 0,
      alignedCount: 0,
      reason: `get_fork_messages failed: ${String(e)}`,
    };
  }
  if (piMessages.length === 0) {
    return { entryId: "", piCount: 0, alignedCount: 0, reason: "pi-empty" };
  }

  // 前缀对齐：本地 user 消息必须按序成为 pi 序列的开头。用「pi 文本以本地
  // 文本开头」而不是相等——附件上下文只出现在 pi 那一侧。
  let pi = 0;
  let aligned = 0;
  for (const want of local) {
    let hit = -1;
    for (let i = pi; i < piMessages.length; i++) {
      if (fingerprint(piMessages[i]?.text).startsWith(want)) {
        hit = i;
        break;
      }
    }
    if (hit < 0) break;
    pi = hit + 1;
    aligned++;
  }

  // 分叉点之后的最后一条本地 user 消息没能对上：边界不可信，不猜。
  if (aligned < local.length) {
    return {
      entryId: "",
      piCount: piMessages.length,
      alignedCount: aligned,
      reason: `align-broken at ${aligned}/${local.length}`,
    };
  }

  // 全对齐。下一条 pi user 消息就是分叉点之后的第一条；没有下一条 = 分叉点
  // 在会话末尾（例如分叉一条还没得到回复的用户消息），无从 fork。
  const next = piMessages[pi];
  if (!next || typeof next.entryId !== "string" || !next.entryId.trim()) {
    return {
      entryId: "",
      piCount: piMessages.length,
      alignedCount: aligned,
      reason: "fork-point-at-leaf",
    };
  }
  return {
    entryId: next.entryId,
    piCount: piMessages.length,
    alignedCount: aligned,
  };
}
