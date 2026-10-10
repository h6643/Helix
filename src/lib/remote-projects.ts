/**
 * remote-projects.ts — 「远程项目」（多台 SSH 服务器）的单一事实源。
 *
 * # 为什么需要这一层
 *
 * 远程工作区是**双通道**：后端同时维持本机 `pi` 子进程和**最多一条**通往远端
 * `pi --mode rpc` 的 SSH 隧道。走哪条由**每条会话自己**决定（它的 workDir 是不是
 * `remote://…`），不是由「隧道在不在」决定。所以隧道这一层仍然是单例：
 * `config.yaml` 的 `pi.remote_rpc`（本机隧道口）+ `pi.remote_cwd`（默认远端目录）
 * 一次只能描述一台机器。
 *
 * 但「有哪些服务器可选」是**列表**语义，存放在 `externalServices`（store +
 * `projectFolders` 之外的独立 key，带 safeStorage 加密的 secret）。列表在
 * 输入框下拉与侧边栏都要显示，两者若各写一份「当前连的是哪台」的判定，就会
 * 出现「侧边栏显示已连接、输入框显示未连接」这类无法排查的分裂。所以：
 *
 * - **列表** = `externalServices`（store 是事实源）
 * - **当前隧道** = `remote_tunnel_status`（后端是事实源，它读的是真正生效的
 *   config.yaml + 隧道进程）
 * - 本模块负责把两者**对账**：用 (host, port, username) 三元组把 status 反查成
 *   列表里的某一项，得出 `activeId`。列表里其余项一律视为未连接。
 * - **每条对话在哪台机器** = `session.workDir`（`remote://…` 或本机路径），
 *   见下面的身份层。
 *
 * 关键：**不引入第三份状态**。`externalServices[].connected` 这个字段是历史
 * 遗留（旧的「一次性 SSH 探测」语义），本模块不写它——连接态一律现查 status。
 */

import { helixApi } from "@/lib/electron-bridge";
import type { ExternalService } from "@/stores/helix-store";

/** 后端 `remote_tunnel_status` 的返回形状（见 remote_connect.rs）。 */
export interface RemoteTunnelStatus {
  connected: boolean;
  local_port?: number;
  remote_host?: string;
  remote_port?: number;
  username?: string;
  /** 真正生效的远端目录（后端读 `pi.remote_cwd`），比前端记的值可信。 */
  remote_path?: string | null;
}

/** 后端 `remote_preflight` 的返回形状（向导第 2 步的体检结果）。 */
export interface RemotePreflightResult {
  ok: boolean;
  home: string;
  uname: string;
  node_path: string;
  node_version: string;
  pi_path: string;
  pi_cli_js: string;
  error: string;
}

/** 远程项目在列表里的展示名：用户起的名字优先，否则 `user@host`。 */
export function remoteProjectLabel(svc: ExternalService): string {
  return svc.name?.trim() || `${svc.username ?? ""}@${svc.host}`;
}

/** 副标题（tooltip 用）：地址 + 端口，一眼看得出是哪台。 */
export function remoteProjectSubtitle(svc: ExternalService): string {
  const port = svc.port || 22;
  return `${svc.host}:${port}`;
}

/** 三元组是否指向同一台机器。端口缺省 22（ssh 的约定）。 */
function sameTarget(
  svc: ExternalService,
  host: string | undefined,
  port: number | undefined,
  username: string | undefined,
): boolean {
  if (!host) return false;
  if (svc.host !== host) return false;
  if ((svc.port || 22) !== (port || 22)) return false;
  // username 缺省时不做比较：status 可能不带用户名（本地隧道已经建好、
  // 后端只记得 host:port），此时宁可匹配上，也不要因为缺字段就认不出来。
  if (username && (svc.username ?? "") !== username) return false;
  return true;
}

/**
 * 用后端 status 反查「当前连的是列表里哪一项」。
 *
 * @returns 该项目的 id；没连或对不上任何已存服务器时返回 null。
 */
export function matchActiveRemote(
  services: ExternalService[],
  status: RemoteTunnelStatus | null | undefined,
): string | null {
  if (!status?.connected) return null;
  const { remote_host, remote_port, username } = status;
  const hit = services.find((s) =>
    sameTarget(s, remote_host, remote_port, username),
  );
  return hit?.id ?? null;
}

/** 查隧道状态。任何异常都归一成「未知/未连接」，绝不向上抛。 */
export async function fetchRemoteStatus(): Promise<RemoteTunnelStatus | null> {
  try {
    const api = (window as any).electron?.helix;
    if (!api?.remoteTunnelStatus) return null;
    return (await api.remoteTunnelStatus()) as RemoteTunnelStatus;
  } catch {
    return null;
  }
}

/**
 * 连到指定服务器。
 *
 * 后端做全套：scp bridge → 远端起 node → 本机开隧道 → 写
 * `pi.remote_rpc`/`pi.remote_cwd` → 重启 gateway。所以它**必然重启网关**，
 * 正在跑的对话会被打断 —— UI 层要自己提示。
 *
 * @param remotePath 远端项目目录（`~` 表示 home）
 */
export async function connectRemoteProject(
  svc: Pick<ExternalService, "host" | "port" | "username">,
  remotePath?: string,
): Promise<{ localPort?: number }> {
  const api = (window as any).electron?.helix;
  if (!api?.remoteConnect) throw new Error("远程连接 IPC 不可用");
  const r = await api.remoteConnect({
    host: svc.host,
    port: svc.port || 22,
    username: svc.username ?? "",
    remote_path: remotePath?.trim() || "~",
  });
  return { localPort: r?.local_port };
}

/** 断开：清 config 两个键 + 杀本机隧道 + 重启 gateway（同样会打断对话）。 */
export async function disconnectRemoteProject(): Promise<void> {
  const api = (window as any).electron?.helix;
  if (!api?.remoteDisconnect) throw new Error("远程断开 IPC 不可用");
  await api.remoteDisconnect();
}

/**
 * 连接体检（向导第 2 步）：SSH 是否可达 + 远端有没有 node / pi + 远端 home。
 * 纯只读——不碰 config.yaml、不重启网关，所以可以放心反复点「重新检测」。
 * SSH 不通时后端返回 Err（这里原样抛出，让 UI 显示原因）。
 */
export async function preflightRemoteProject(
  svc: Pick<ExternalService, "host" | "port" | "username">,
): Promise<RemotePreflightResult> {
  const api = (window as any).electron?.helix;
  if (!api?.remotePreflight) throw new Error("远程体检 IPC 不可用");
  return (await api.remotePreflight({
    host: svc.host,
    port: svc.port || 22,
    username: svc.username ?? "",
  })) as RemotePreflightResult;
}

/**
 * 列远端某目录的子目录（向导第 3 步浏览用，走纯 SSH，不需要先连上）。
 *
 * `cwd` 是后端 `pwd -P` 出来的**绝对路径**：`~` / 相对路径都由远端解析掉了，
 * 前端因此只需做字符串裁剪就能「上一步」，写进 `pi.remote_cwd` 的也永远是绝对路径。
 */
export async function listRemotePaths(
  svc: Pick<ExternalService, "host" | "port" | "username">,
  path: string,
  includeHidden?: boolean,
): Promise<{ cwd: string; paths: string[] }> {
  const api = (window as any).electron?.helix;
  if (!api?.remoteListPaths) throw new Error("远程目录浏览 IPC 不可用");
  const r = await api.remoteListPaths({
    host: svc.host,
    port: svc.port || 22,
    username: svc.username ?? "",
    path: path?.trim() || "~",
    include_hidden: !!includeHidden,
  });
  return {
    cwd: typeof r?.cwd === "string" ? r.cwd : path,
    paths: Array.isArray(r?.paths) ? r.paths : [],
  };
}

/** helixApi 的存在性检查——非 Electron（浏览器预览）下远程功能整体不可用。 */
export function remoteAvailable(): boolean {
  return typeof window !== "undefined" && !!helixApi()?.remoteTunnelStatus;
}

// ── 远程项目的 workDir 身份 ─────────────────────────────────────────────
//
// 一个对话「属于哪个项目」由 `session.workDir` 决定（侧边栏按它分组）。而远程
// 项目的目录在**另一台机器**上，本地不存在 —— 没有一个本地路径能代表它。所以
// 用一个带前缀的**虚拟键**当身份：
//
//   remote://<user@host:port>/<远端路径>
//
// 选它而不是复用本地路径的原因：本地路径会进 `fs.*` / `git.*` IPC 的 cwd
// 参数，那些后端只认本机磁盘；`remote://…` 一眼可辨且绝不与真实路径混淆。
// 见到这个前缀的代码，一律**不要**把它当目录传给任何本地 fs/git 调用。
//
// 身份为什么是「机器 + 路径」而不是 `externalServices[].id`：id 是服务器**那一行**
// 的代理键，删掉重加就换一个。对话记得却是旧 id，于是删除一次服务器就会把它名下
// 所有对话变成孤儿（哪个远程行都不认它）。`user@host:port` 是这台机器的事实，
// 换行、改名、重加都不受影响。
const REMOTE_WORKDIR_PREFIX = "remote://";

/** 远程项目的稳定身份键（与服务器列表行的 id 无关）。 */
function remoteTargetKey(
  svc: Pick<ExternalService, "host" | "port" | "username">,
): string {
  const port = svc.port || 22;
  return `${svc.username || "unknown"}@${svc.host}:${port}`;
}

/** 某台服务器（可选远端目录）对应的 workDir 虚拟键。 */
export function remoteWorkDirForService(
  svc: Pick<ExternalService, "host" | "port" | "username">,
  remotePath?: string,
): string {
  return makeRemoteWorkDir(remoteTargetKey(svc), remotePath);
}

function makeRemoteWorkDir(
  targetKey: string,
  remotePath?: string,
): string {
  const p = (remotePath ?? "").trim();
  const suffix = p && p !== "~" ? `/${p.replace(/^\/+/, "")}` : "";
  return `${REMOTE_WORKDIR_PREFIX}${targetKey}${suffix}`;
}

export function isRemoteWorkDir(dir: string | null | undefined): boolean {
  return !!dir && dir.startsWith(REMOTE_WORKDIR_PREFIX);
}

/** 远程键的机器身份部分（第一段）；不是远程键则返回 null。 */
export function parseRemoteWorkDir(
  dir: string | null | undefined,
): { targetKey: string; remotePath?: string } | null {
  if (!isRemoteWorkDir(dir)) return null;
  const rest = dir!.slice(REMOTE_WORKDIR_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return { targetKey: rest };
  return { targetKey: rest.slice(0, slash), remotePath: rest.slice(slash + 1) };
}

/**
 * 这个远程对话属于列表里的哪台服务器。
 *
 * 两种键都要认：现在的 `user@host:port`，以及历史上写进库的 `ext_<id>`（当时用
 * 服务器行的代理键当身份）。@param services 当前列表。
 * @returns 匹配到的服务器；对不上任何一项（服务器已删除）时返回 null。
 */
export function findServiceByRemoteWorkDir(
  services: ExternalService[],
  dir: string | null | undefined,
): ExternalService | null {
  const parsed = parseRemoteWorkDir(dir);
  if (!parsed) return null;
  const byTarget = services.find(
    (s) => remoteTargetKey(s) === parsed.targetKey,
  );
  if (byTarget) return byTarget;
  return services.find((s) => s.id === parsed.targetKey) ?? null;
}
