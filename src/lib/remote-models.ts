/**
 * remote-models.ts — 远程会话的模型清单。
 *
 * # 为什么不能复用本机清单
 *
 * 模型下拉过去只有一个数据源：Helix 自己写进**本机** `~/.pi/agent/models.json`
 * 的 profile（+ 本机 pi 实例注册的渠道 provider）。但会话的模型切换是
 * `set_model` 按 `session_id` 路由到**这个会话自己的 pi 实例**的：远程会话的
 * 实例跑在另一台机器上（`remote-bridge.js` → 远端 `pi --mode rpc`），它只认
 * 自己那台机器上的 `~/.pi/agent/{models.json,settings.json}`。
 *
 * 于是「下拉里选本机供应商的模型 → set_model 打到远端 → pi 按
 * `provider + modelId` 在自己快照里精确匹配 → 匹配不到直接报 Model not found」，
 * 而这个错误以前只落 console。表现就是
 * 「远程项目里选模型没用，用的还是远程里面 pi 的配置」。
 *
 * 正确做法：远程会话的下拉以**该实例自己的** `get_available_models` 为准
 * （带 session_id 走 `routed_instance`，落到这台会话的实例上）。本模块只做
 * 「问 + 分组 + 按机器缓存」，不写任何配置、不搬凭据。
 */

import { helixApi } from "@/lib/electron-bridge";

/** 远程分组 id 的前缀。命中它的选择只写本会话覆盖值：不走 models.json 注册、
 *  不碰全局默认（远端模型在本机可能压根不存在）。 */
export const REMOTE_GROUP_PREFIX = "remote:";

/** 一个下拉分组：远端 pi 的一个 provider 及其模型。 */
export interface RemoteModelGroup {
  /** `remote:<providerId>`。 */
  id: string;
  /** 展示名：远端 provider id（远端机器上就是这么注册的）。 */
  name: string;
  models: string[];
  labels?: Record<string, string>;
}

export interface RemoteModelSnapshot {
  groups: RemoteModelGroup[];
  /** 该实例**当前实际在跑**的模型（get_state）。没有覆盖值时下拉按它显示，
   *  这样芯片说的就是远端真正在用的东西，而不是本机的全局默认。 */
  activeModel?: string;
  activeProvider?: string;
}

export type RemoteModelsResult =
  | { ok: true; snapshot: RemoteModelSnapshot }
  | { ok: false; error: string };

/** 按「远端机器身份」缓存最近一次读到的快照：远程草稿（还没建会话、没有 sid）
 *  拿不到实例，但同一台机器的清单是稳定的，用它兜住「第一条消息前想先选模型」。 */
const cacheByMachine = new Map<string, RemoteModelSnapshot>();

export function cachedRemoteSnapshot(
  machineKey: string | null | undefined,
): RemoteModelSnapshot | null {
  if (!machineKey) return null;
  return cacheByMachine.get(machineKey) ?? null;
}

// ── 镜像清单的过渡层 ────────────────────────────────────────────────────
//
// 镜像在连接时把本机 provider 写进远端 models.json 文件；但 pi 只在**实例
// 启动时**快照它，正在跑的远端实例看不到新 provider，也没有热重载 RPC。
// 连接后再拉一次清单，借活实例一问，必然把 seedRemoteSnapshot 种下的新
// 分组又冲回旧样子 —— 明明镜像成功，下拉却纹丝不动。
//
// 这层在活快照之外**只补充**：镜像过、但当前活快照还没报出来的分组一直显示；
// 等新对话 spawn 新实例（读到新 models.json），活快照自己含有它，两份按
// group id 去重，无缝接管，这层的对应条目自然退场。绝不删活实例报来的东西。
const mirrorOverlayByMachine = new Map<string, RemoteModelGroup[]>();

/** 把刚镜像的一批分组记进过渡层（重复调用按 group id 去重，幂等）。 */
export function addMirrorOverlay(
  machineKey: string,
  groups: RemoteModelGroup[],
): void {
  if (!machineKey || groups.length === 0) return;
  const prev = mirrorOverlayByMachine.get(machineKey) ?? [];
  const seen = new Set(prev.map((g) => g.id));
  mirrorOverlayByMachine.set(machineKey, [
    ...prev,
    ...groups.filter((g) => !seen.has(g.id)),
  ]);
}

/** 下拉的远程分组数据源：活快照在前，镜像过渡层里活快照还没覆盖的在后。 */
export function remoteGroupsForDropdown(
  machineKey: string | null | undefined,
  snapshot: RemoteModelSnapshot | null | undefined,
): RemoteModelGroup[] {
  const live = snapshot?.groups ?? cachedRemoteSnapshot(machineKey)?.groups ?? [];
  if (!machineKey) return live;
  const liveIds = new Set(live.map((g) => g.id));
  const overlay = (mirrorOverlayByMachine.get(machineKey) ?? []).filter(
    (g) => !liveIds.has(g.id) && g.models.length > 0,
  );
  return overlay.length > 0 ? [...live, ...overlay] : live;
}


/**
 * 把「刚镜像到远端」的 provider 清单直接种进下拉缓存。
 *
 * 为什么需要：远端新项目连上的那一刻，一个 pi 实例都还没起（bridge 是按需
 * spawn 的），get_available_models 无处可问。可我们已经确切知道写进去了什么，
 * 所以不必等实例，先用这份清单把下拉填上；等实例起来 loadRemoteModelSnapshot
 * 会用真实快照覆盖它。
 */
export function seedRemoteSnapshot(
  machineKey: string,
  groups: RemoteModelGroup[],
): void {
  if (!machineKey || groups.length === 0) return;
  cacheByMachine.set(machineKey, { groups });
}
/** 把 pi 的模型对象数组按 provider 分组。id 做路由键，name 做展示名。 */
function groupModels(
  models: { id?: unknown; name?: unknown; provider?: unknown }[],
): RemoteModelGroup[] {
  const grouped = new Map<
    string,
    { ids: string[]; labels: Record<string, string> }
  >();
  for (const m of models) {
    const id = typeof m.id === "string" ? m.id.trim() : "";
    const provider = typeof m.provider === "string" ? m.provider.trim() : "";
    if (!id || !provider) continue;
    const entry = grouped.get(provider) ?? { ids: [], labels: {} };
    if (!entry.ids.includes(id)) {
      entry.ids.push(id);
      entry.labels[id] =
        typeof m.name === "string" && m.name.trim() ? m.name : id;
    }
    grouped.set(provider, entry);
  }
  return [...grouped.entries()].map(([provider, e]) => ({
    id: `${REMOTE_GROUP_PREFIX}${provider}`,
    name: provider,
    models: e.ids,
    labels: e.labels,
  }));
}

/**
 * 读某条会话所属实例（远程 = 远端 pi）的模型清单 + 当前在跑的模型。
 *
 * `sessionId` 必须是**后端 sid**：sessionless 调用会落到主实例（= 本机），
 * 那正是要避开的错误来源。没有 sid 时调用方应先用 `cachedRemoteSnapshot`。
 */
export async function loadRemoteModelSnapshot(
  sessionId: string | null,
  machineKey?: string | null,
): Promise<RemoteModelsResult> {
  const api = helixApi();
  if (!api?.send) return { ok: false, error: "网关不可用" };
  // 没有 sid（远程项目里的新对话）时，借这台机器上任一活实例问一遍：
  // 远端 models.json 对同一台机器上的所有会话是同一份。以前这里直接
  // return 报「会话尚未建立」，于是新远程对话的模型下拉永远是空的。
  let sid = sessionId;
  if (!sid) {
    try {
      const r = (await api.send("remote/first_live_session", {})) as {
        session_id?: unknown;
      };
      sid = typeof r?.session_id === "string" ? r.session_id : "";
    } catch {
      sid = "";
    }
  }
  if (!sid) return { ok: false, error: "远端还没有活着的 pi 实例" };
  let groups: RemoteModelGroup[];
  try {
    const r = (await api.send("get_available_models", {
      session_id: sid,
    })) as { models?: unknown };
    groups = groupModels(
      Array.isArray(r?.models)
        ? (r.models as { id?: unknown; name?: unknown; provider?: unknown }[])
        : [],
    );
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  const snapshot: RemoteModelSnapshot = { groups };
  // 当前模型只是展示用：读不到就不显示（绝不猜，猜出来的值会和远端实际在跑的
  // 那个模型分家，正是这次要修的病）。
  try {
    const st = (await api.send("get_state", { session_id: sessionId })) as {
      model?: { id?: unknown; provider?: unknown };
    };
    const id = typeof st?.model?.id === "string" ? st.model.id : "";
    const provider =
      typeof st?.model?.provider === "string" ? st.model.provider : "";
    if (id) snapshot.activeModel = id;
    if (provider) snapshot.activeProvider = provider;
  } catch {
    /* get_state 失败不影响清单 */
  }
  if (machineKey) cacheByMachine.set(machineKey, snapshot);
  return { ok: true, snapshot };
}
