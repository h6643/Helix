"use client";

/**
 * helix-rest.ts — `helix serve` 网关 **REST 侧** 的渲染层适配器。
 *
 * 背景：记忆 / 压缩配置只能通过网关暴露的 REST 面读写：
 *
 *   GET  /api/config   → 当前 config.yaml（已合并 managed scope）
 *   PUT  /api/config   → body {config:{…}}，服务端对磁盘配置做**深合并**后落盘
 *
 * ⚠️ 为什么这里不再由渲染层直接 fetch（这是之前 `Failed to fetch` 的根因）：
 * serve 网关在 127.0.0.1:<port> 上跑的是 FastAPI（与 /api/ws 同进程）。但 dashboard
 * 鉴权中间件会在 **CORS 中间件之前**拦截请求——而我们每次调用都带自定义头
 * `X-Helix-Session-Token`，浏览器因此先发 OPTIONS 预检；预检里**没有 token**，
 * 被鉴权中间件直接 401，于是 CORS 响应头永远发不出去，浏览器判为跨源失败 →
 * `TypeError: Failed to fetch`。Node 端 fetch 不做预检、且自带 token，所以主进程
 * 直连能稳定拿到 200。
 *
 * 因此：真正的 HTTP 调用放在 Electron **主进程**（见 electron/main.js 的
 * `helix:getRawConfig` / `helix:setRawConfig`），渲染层只通过 IPC 调它，彻底
 * 绕开浏览器的 CORS 预检。端口每次 serve respawn 都会变（--port 0），主进程
 * 每次调用都实时读 `serveGatewayInfo`，无需渲染层缓存。
 *
 * 实测（起的临时 `helix serve` 探针）：
 *   无 token 的 GET        → 401 {"detail":"Unauthorized"}
 *   OPTIONS 预检（无 token）→ 401（即浏览器被挡的根因）
 *   带 token 的 GET        → 200 + 完整 config.yaml JSON   ✅
 */

import { debug } from "@/lib/logger";
import type { MemoryProviderField } from "@/types/electron";

export class HelixRestUnavailable extends Error {
  constructor() {
    super("Helix 网关未就绪（非 Electron 环境，或 serve 尚未完成握手）");
    this.name = "HelixRestUnavailable";
  }
}

interface RawConfigResult {
  ok: boolean;
  error?: string;
  config?: Record<string, any>;
}

function helixIpc(): any {
  return (
    (typeof window !== "undefined" && (window as any).electron?.helix) || null
  );
}

async function callMain(
  method: "getRawConfig" | "setRawConfig",
  patch?: Record<string, any>,
): Promise<Record<string, any>> {
  const ipc = helixIpc();
  if (!ipc || typeof ipc[method] !== "function")
    throw new HelixRestUnavailable();
  let res: RawConfigResult;
  try {
    res =
      method === "getRawConfig"
        ? await ipc.getRawConfig()
        : await ipc.setRawConfig(patch);
  } catch (e: any) {
    throw new Error(e?.message || String(e));
  }
  if (!res || res.ok === false) {
    const msg = res?.error || "unknown";
    if (msg === "gateway-not-ready") throw new HelixRestUnavailable();
    throw new Error(msg);
  }
  return res.config as Record<string, any>;
}

/** 读取完整 config.yaml（服务端已剥掉 `_` 开头的内部键）。 */
export function getHelixConfig(): Promise<Record<string, any>> {
  return callMain("getRawConfig");
}

/**
 * 深合并写入 config.yaml。只需传要改的子树，例如：
 *   { memory: { memory_enabled: true }, compression: { threshold: 0.6 } }
 * 服务端对磁盘配置做深合并，未提及的键原样保留。
 */
export async function patchHelixConfig(
  patch: Record<string, any>,
): Promise<void> {
  await callMain("setRawConfig", patch);
  debug("[helix-rest] config patched:", Object.keys(patch).join(","));
}

// ── 外置记忆 Provider（serve 网关 /api/memory/*）────────────────────────────
// 同样走主进程直连绕开 CORS 预检。GET/PUT /api/memory/providers/{name}/config
// 是 schema 驱动的：GET 返回字段定义+当前值，PUT 以 {values:{…}} 保存并激活。

async function memoryMain<T>(method: string, ...args: any[]): Promise<T> {
  const ipc = helixIpc();
  if (!ipc || typeof ipc[method] !== "function")
    throw new HelixRestUnavailable();
  let res: any;
  try {
    res = await ipc[method](...args);
  } catch (e: any) {
    throw new Error(e?.message || String(e));
  }
  if (!res || res.ok === false) {
    const msg = res?.error || "unknown";
    if (msg === "gateway-not-ready") throw new HelixRestUnavailable();
    throw new Error(msg);
  }
  return res as T;
}

/** GET /api/memory — 当前激活的 Provider 与已发现插件的状态列表。 */
export async function getMemoryStatus(): Promise<any> {
  return (await memoryMain<any>("getMemoryStatus")).status;
}

/** GET /api/memory/providers/{name}/config — schema 字段 + 当前值。 */
export async function getMemoryProviderConfig(name: string): Promise<{
  name: string;
  label?: string;
  fields: MemoryProviderField[];
  setup?: any;
}> {
  return (await memoryMain<any>("getMemoryProviderConfig", name)).config;
}

/** PUT /api/memory/providers/{name}/config — 保存字段值并激活该 Provider。 */
export async function setMemoryProviderConfig(
  name: string,
  values: Record<string, any>,
): Promise<any> {
  return (await memoryMain<any>("setMemoryProviderConfig", name, values))
    .result;
}

/** POST /api/memory/providers/{name}/setup — 安装缺失的运行时依赖（pip install …）。 */
export async function setupMemoryProvider(name: string): Promise<any> {
  return (await memoryMain<any>("memoryProviderSetup", name)).result;
}
