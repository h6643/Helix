/**
 * HelixFacade —— 前端调用的「helix IPC 面」的结构化契约。
 *
 * serve 模式下 getServeHelixFacade() 返回的 Proxy 门面
 * 与 window.electron.helix（原始 IPC 桥）必须同形。之前两者都声明为 any，
 * 类型系统零参与。本接口定义共享契约：
 *   - IpcHelixBridge：原始 IPC 桥（preload 暴露的对象）的最小结构
 *   - HelixFacade：路由门面（Proxy 包装后）的最小结构
 * 未覆盖的方法（setConfig/setYamlKey/listPersonalities 等配置面）通过
 * Proxy 透传原始 IPC，类型上标注为「未建模」，不再传染 any。
 */

import type { EventCallback, ServeEvent } from "./serve-gateway";

/** helix IPC 桥的最小契约（未列出的方法仍可能存在，类型上不可访问）。 */
export interface IpcHelixBridge {
  send(method: string, params?: unknown): Promise<unknown>;
  notify?(method: string, params?: unknown): void;
  interrupt?(sessionId: string): Promise<unknown>;
  status?(): Promise<{ connected: boolean }>;
  setModel?(params: SetModelParams): Promise<unknown>;
  onEvent?(cb: EventCallback): (() => void) | undefined;
  getGatewayInfo?(): Promise<{
    mode?: string;
    pending?: boolean;
    port?: number;
    baseUrl?: string;
    wsUrl?: string;
  } | null>;
}

export interface SetModelParams {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  provider?: string;
}

/**
 * 路由门面（buildRouterFacade 的返回类型）。
 * 覆盖 5 个方法 + onEvent；其余属性透传原始 IPC。
 */
export interface HelixFacade {
  send(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  interrupt(sessionId: string): Promise<unknown>;
  status(): Promise<{ connected: boolean }>;
  setModel(params: SetModelParams): Promise<unknown>;
  onEvent(cb: EventCallback): () => void;
}

export type { ServeEvent };
