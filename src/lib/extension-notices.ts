/**
 * pi 扩展「例行播报」识别 —— 集中判定，避免各处重复硬编码前缀。
 *
 * 背景：pi-hermes-memory 在每次会话启动时做 session backfill，完成后用
 * `ui.notify` 播一条「🧠 Session backfill complete: ...」。它出现在两条
 * 互不相干的通道上，而接收方都只看文本、分不清是谁发的：
 *
 *  - 常驻网关：notify 被网关统一归到 model/warning 兜底通道，
 *    agent-flow-panel 据此静默丢弃；
 *  - 渠道中心：一次性 pi 进程加载了**全部**扩展（见 pi_connect.rs），
 *    hermes-memory 的这条播报会混进 `/connect` 的 notify 流，被当成一个
 *    「渠道卡片」渲染出来 —— 就是面板里那条莫名其妙出现的行。
 *
 * 判定放在这一处，前端两处与 Rust 一处共用同一语义。
 */

export const SESSION_BACKFILL_PREFIX = "🧠 Session backfill";

/** 是否为 pi-hermes-memory 的 session backfill 例行播报。 */
export function isSessionBackfillNotice(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith(SESSION_BACKFILL_PREFIX) ||
    t.includes("Session backfill complete")
  );
}

/**
 * 播报 → toast 描述。格式固定（见 pi-hermes-memory 的 formatBackfillResult）：
 *   「🧠 Session backfill complete: N indexed, M skipped, K messages[后缀].」
 * 拆出来拼成中文；解析不出时回退到剥掉前缀的原文，文案变化也不丢信息。
 */
export function sessionBackfillDetail(text: string): string {
  const stripped = text.trim().replace(/^🧠\s*Session backfill complete:\s*/i, "");
  const m = /^(\d+)\s+indexed,\s*(\d+)\s+skipped,\s*(\d+)\s+messages/i.exec(stripped);
  return m ? `索引 ${m[1]} 条，跳过 ${m[2]} 条，消息 ${m[3]} 条` : stripped;
}
