#!/usr/bin/env node
/**
 * Helix 通用本地 stdio MCP 服务器（零依赖）
 *
 * 传输：stdin/stdout（JSON-RPC 2.0，换行分隔，MCP 标准 stdio 帧）
 * 协议：MCP 2025-03-26 版本
 *
 * 由 Helix 以 local 类型 MCP 挂载（settings → MCP → 新建，type=STDIO）：
 *   启动命令: node
 *   参数:      D:/Project/Helix/src/lib/mcp-stdio-server.js
 *   （等价 config.yaml mcp_servers 条目：
 *      helix-generic:
 *        command: "node"
 *        args: ["D:/Project/Helix/src/lib/mcp-stdio-server.js"]
 *   环境变量 MCP_NAME / MCP_VERSION 可覆盖默认服务器名。）
 *
 * 扩展方式：在 TOOLS 数组里加条目，每个条目含 name / description /
 *   inputSchema（JSON Schema）/ run(ctx, args) => 返回字符串或
 *   { content: [{ type: "text", text }] }。run 抛错自动转 isError 结果。
 */

"use strict";

// ── 协议常量 ────────────────────────────────────────────────────────
const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = {
  name: process.env.MCP_NAME || "helix-generic-mcp",
  version: process.env.MCP_VERSION || "0.1.0",
};

// ── 工具定义（在这里加你的工具）────────────────────────────────────
const TOOLS = [
  {
    name: "echo",
    description: "把传入的文本原样返回（示例工具，用来验证 MCP 链路是否通）。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要回显的文本" },
      },
      required: ["text"],
    },
    run: async (ctx, args) => `echo: ${args.text}`,
  },
  {
    name: "server_info",
    description: "返回当前 MCP 服务器的名称、版本和可用工具列表。",
    inputSchema: { type: "object", properties: {} },
    run: async () =>
      JSON.stringify(
        {
          name: SERVER_INFO.name,
          version: SERVER_INFO.version,
          tools: TOOLS.map((t) => t.name),
        },
        null,
        2,
      ),
  },
];

// 按名字索引
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ── JSON-RPC over stdio（换行分隔帧）───────────────────────────────
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function rpcResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message, data) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

// 工具调用结果（MCP 专用：isError / content）
function toolResult(id, text, isError) {
  rpcResult(id, {
    content: [{ type: "text", text: String(text) }],
    ...(isError ? { isError: true } : {}),
  });
}

// ── 按方法分发的处理器 ──────────────────────────────────────────────
const handlers = {
  // 握手
  initialize: (id) => {
    rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
      capabilities: { tools: { listChanged: false } },
    });
  },

  // 工具列表
  "tools/list": (id) => {
    rpcResult(id, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  },

  // 工具调用
  "tools/call": async (id, params) => {
    const name = params?.name;
    const args = params?.arguments || {};
    const tool = TOOL_MAP.get(name);
    if (!tool) {
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    try {
      const result = await tool.run({ /* 预留：ctx 可访问服务器状态 */ }, args);
      // 支持返回字符串或结构化 { content }
      if (result && typeof result === "object" && Array.isArray(result.content)) {
        rpcResult(id, result);
      } else {
        toolResult(id, result, false);
      }
    } catch (e) {
      toolResult(id, String(e && e.message ? e.message : e), true);
    }
  },

  // 兼容客户端 ping
  ping: (id) => rpcResult(id, {}),
};

// 通知（无 id，比如 notifications/initialized）不回包
function isNotification(method) {
  return method.startsWith("notifications/") || method === "initialized";
}

// ── 主循环：按换行读 stdin，逐帧解析 ────────────────────────────────
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // 非 JSON 帧（如客户端调试打印）直接忽略
      continue;
    }

    const { id, method, params } = msg || {};
    if (method === undefined) continue; // 纯响应/未知帧

    if (isNotification(method)) continue; // 通知不回包

    const handler = handlers[method];
    if (!handler) {
      if (id !== undefined) rpcError(id, -32601, `Method not found: ${method}`);
      continue;
    }

    Promise.resolve()
      .then(() => handler(id, params))
      .catch((e) => {
        if (id !== undefined)
          rpcError(id, -32603, String(e && e.message ? e.message : e));
      });
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

// 防意外：工具里若往 stdout 打日志会破坏协议帧，重定向到 stderr
console.log = (...a) => process.stderr.write(a.join(" ") + "\n");
