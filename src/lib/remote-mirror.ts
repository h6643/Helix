/**
 * remote-mirror.ts — 连接远程项目时把本机 provider 镜像到远端 pi 的
 * `~/.pi/agent/models.json`。
 *
 * 远端会话的 agent 跑在另一台机器的 pi 上，模型清单读的是**那台机器**的文件。
 * 本机那几十个供应商配置对它不可见，所以本机下拉里选的模型在远端 set_model
 * 只会报 Model not found。镜像就是把这个缺口显式补上（后端见
 * src-tauri/src/remote_mirror.rs）。
 *
 * 这里只负责「构造清单、种进下拉缓存」：每次连接都自动带上全部本机供应商，
 * 不弹确认框。
 */
import {
  REMOTE_GROUP_PREFIX,
  seedRemoteSnapshot,
  addMirrorOverlay,
} from "@/lib/remote-models";
import { useHelixStore } from "@/stores/helix-store";

export type RemoteMirrorProvider = {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: { id: string; name: string; contextWindow?: number }[];
};

/** 镜像清单与下拉共用一份数据：连接后先把下拉填上，不必等远端 pi 实例起来。 */
function seedFromMirror(
  svc: { host?: string; port?: number; username?: string },
  providers: RemoteMirrorProvider[],
): void {
  if (providers.length === 0) return;
  const groups = providers.map((p) => ({
    id: REMOTE_GROUP_PREFIX + p.name,
    name: p.name,
    models: p.models.map((m) => m.id),
    labels: Object.fromEntries(p.models.map((m) => [m.id, m.name])),
  }));
  const key = remoteMachineKey(svc);
  seedRemoteSnapshot(key, groups);
  // 过渡层也要记：活实例的清单是启动时快照的旧值，重新拉一次就会把上面种的
  // 冲回去。没有过渡层的话，镜像文件写远端成功、下拉却纹丝不动。
  addMirrorOverlay(key, groups);
}

function remoteMachineKey(svc: {
  host?: string;
  port?: number;
  username?: string;
}): string {
  return `${svc.username ?? ""}@${svc.host ?? ""}:${svc.port || 22}`;
}

/**
 * 从本机配置构造镜像清单。
 *
 * 只收有 baseUrl 的 provider：没有端点的条目在远端本来就用不了，写过去只是噪音。
 * `name` 是 pi 侧 provider id（models.json 的键），所以取 ProviderConfig.name；
 * `__custom__` 这类占位名跳过——它不是真实 provider 名，写进远端会被当成新端点。
 */
function buildMirrorProviders(): RemoteMirrorProvider[] {
  const st = useHelixStore.getState();
  const out: RemoteMirrorProvider[] = [];
  for (const p of st.providers ?? []) {
    const name = (p.name ?? "").trim();
    const baseUrl = (p.baseUrl ?? "").trim();
    if (!name || !baseUrl || name === "__custom__") continue;
    // 协议格式由设置页维护（apiFormat），同一个 baseUrl 可能对应多个 profile；
    // 取第一个能对上的，缺省 openai-completions 与后端一致。
    const profile = (st.apiProfiles ?? []).find(
      (x) => (x.config?.baseUrl ?? "").trim() === baseUrl,
    );
    const windows = profile?.modelContextWindows ?? {};
    out.push({
      name,
      baseUrl,
      api: profile?.config?.apiFormat || "openai-completions",
      apiKey: (p.apiKey ?? "").trim(),
      models: (p.models ?? []).map((id) => ({
        id,
        name: id,
        contextWindow: windows[id],
      })),
    });
  }
  return out;
}

/**
 * 连接远程项目时准备镜像清单：构造本机供应商，种进下拉缓存（连接后即可见，
 * 不必等远端 pi 实例起来），连同样清单交给 `connectRemoteProject` 由后端写进
 * 远端 models.json。本机没配自定义端点时返回空数组 —— 没东西可传，连接照常。
 *
 * 每次连接都会带**当前**的清单：连接之后在设置里新配的端点，下次连接自动补齐。
 * 远端同名的 provider 由后端跳过不覆盖（见 remote_mirror.rs 的合并规则）。
 */
export function prepareRemoteMirror(svc: {
  host?: string;
  port?: number;
  username?: string;
}): RemoteMirrorProvider[] {
  const providers = buildMirrorProviders();
  seedFromMirror(svc, providers);
  return providers;
}
