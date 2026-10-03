"use client";

/**
 * serve-gateway.ts — 网关模式分流面（serve 模式已移除，纯 acp）。
 *
 * 历史上这里承载过一个未激活的 `helix serve` 翻译网关（WS JSON-RPC +
 * ServeGatewayClient + 常驻路由器门面）。远程重型机制按用户要求整体删除后，
 * 网关只有一种模式：本地 pi（`window.electron.helix` IPC 直连）。
 *
 * 这些导出保留是为了调用点零改动：
 * - `getServeHelixFacade()` 恒返回 null → `helixApi()` 回落本地 IPC 桥
 * - `isServeActive()` 恒 false → UI 与 config-sync 走本地分支
 * - `getGatewayMode()` 恒 "acp"
 * - `getServeClient()` / `initServeGateway()` 恒 null
 *
 * 想连远程项目（git clone / SMB 挂载 / WSL 路径等本地路径形态）不需要任何
 * 网关模式切换——本地 pi 直接读写该路径即可。
 */

import type { ElectronAPI } from "@/types/electron";

export type HelixFacade = ElectronAPI["helix"];

/** 历史调用点（config-sync / helix-layout）直接摸 `getServeClient()` 的
 *  rpc / setModel 等方法；serve 模式删除后恒返回 null，但形状要保留，
 *  否则这些 `?.` 链在类型上断掉。 */
export interface ServeClientLike {
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  setModel(params: {
    model: string;
    baseUrl?: string;
    apiKey?: string;
    provider?: string;
  }): Promise<unknown>;
  onEvent(cb: (method: string, params?: unknown) => void): () => void;
}

export function isServeActive(): boolean {
  return false;
}

export function getGatewayMode(): Promise<"acp" | "serve"> {
  return Promise.resolve("acp");
}

export function getServeClient(): ServeClientLike | null {
  return null;
}

export function initServeGateway(): Promise<ServeClientLike | null> {
  return Promise.resolve(null);
}

export function getServeHelixFacade(): HelixFacade | null {
  return null;
}
