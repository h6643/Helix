#!/usr/bin/env node
/**
 * SSH Bridge MCP server — exposes `remote_exec` to the Hermes agent.
 *
 * Spawned by Hermes via config.yaml `mcp_servers` with a stdio transport.
 * Connection parameters arrive via the `env:` block (HERMES_SSH_*), which
 * Hermes passes through verbatim (mcp_tool.py _build_safe_env: env.update).
 * Uses ssh2 directly (no MCP SDK — the stdio protocol is newline-delimited
 * JSON-RPC 2.0, matching what Hermes' stdio_client speaks).
 *
 * Tools:
 *   remote_exec { command, cwd? } → run a command on the remote over SSH.
 *
 * Example config.yaml entry:
 *   ssh-bridge:
 *     command: node
 *     args: ["<path>/electron/ssh-bridge/mcp-server.js"]
 *     env:
 *       HERMES_SSH_HOST: "host"
 *       HERMES_SSH_PORT: "22"
 *       HERMES_SSH_USER: "user"
 *       HERMES_SSH_SECRET: "<password or private key>"
 */
'use strict'

const readline = require('readline')

// ── Connection params from env ─────────────────────────────────────────────
const SSH = {
  host: process.env.HERMES_SSH_HOST || '',
  port: Number(process.env.HERMES_SSH_PORT) || 22,
  user: process.env.HERMES_SSH_USER || '',
  secret: process.env.HERMES_SSH_SECRET || '',
}
const IS_KEY = /-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----/.test(SSH.secret || '')

function failWith(err) {
  return {
    content: [{ type: 'text', text: `[ssh-bridge] ${(err && err.message) || String(err)}` }],
    isError: true,
  }
}

/**
 * Run a command over SSH and return { stdout, stderr, code }.
 * Reuses a single persistent ssh2 connection (lazily created on first use) so
 * consecutive tool calls don't pay SSH handshake each time — that was the main
 * source of "remote SSH 不稳定" (slow/frequent connect/close). Each exec gets a
 * fresh channel but shares the transport.
 */
let conn = null          // persistent ssh2 Client
let connPending = null   // in-flight connect promise (dedupe concurrent connects)

function getConn() {
  if (conn) return Promise.resolve(conn)
  if (connPending) return connPending
  connPending = new Promise((resolve, reject) => {
    const { Client } = require('ssh2')
    const c = new Client()
    const auth = IS_KEY ? { privateKey: SSH.secret } : { password: SSH.secret }
    c.on('ready', () => {
      conn = c
      connPending = null
      resolve(c)
    })
    c.on('error', (err) => {
      connPending = null
      reject(err)
    })
    c.on('keyboard-interactive', (_n, _i, _l, _p, done) => done([SSH.secret]))
    c.connect({
      host: SSH.host,
      port: SSH.port,
      username: SSH.user,
      readyTimeout: 15000,
      hostVerifier: () => true, // MVP: accept host key
      ...auth,
    })
  })
  return connPending
}

const EXEC_TIMEOUT_MS = 120000 // 2min: agent tool calls can run long (builds, claude)

function remoteExec(command, cwd) {
  return new Promise((resolve) => {
    let timer = null
    const finish = (v) => {
      if (timer) { clearTimeout(timer); timer = null }
      if (!settled) { settled = true; resolve(v) }
    }
    let settled = false
    const cmd = cwd ? `cd "${String(cwd).replace(/"/g, '\\"')}" && ${command}` : command

    getConn()
      .then((c) => {
        c.exec(cmd, (err, stream) => {
          if (err) return finish({ ok: false, error: err.message })
          let stdout = ''
          let stderr = ''
          stream.on('close', (code) => finish({ ok: true, stdout, stderr, code: code == null ? 0 : code }))
          stream.on('data', (d) => { stdout += d.toString('utf8') })
          stream.stderr.on('data', (d) => { stderr += d.toString('utf8') })
          stream.on('error', (e) => finish({ ok: false, error: e.message }))
        })
        // Connection succeeded but command hangs → time out so the agent isn't stuck.
        timer = setTimeout(() => {
          try { c.end(); conn = null } catch { /* ignore */ }
          finish({ ok: false, error: 'remote_exec 超时（' + (EXEC_TIMEOUT_MS / 1000) + 's）——命令可能卡住等待输入，请加 timeout 或改用非交互命令' })
        }, EXEC_TIMEOUT_MS)
      })
      .catch((err) => finish({ ok: false, error: (err && err.message) || String(err) }))
  })
}

const TOOLS = [
  {
    name: 'remote_exec',
    description: '在【远程服务器/虚拟机】上执行 shell 命令并返回输出（经 SSH）。' +
      '当用户提到"服务器、虚拟机、远程、那边、cloud、VM、远端"时用这个，而不是本地 terminal 工具。' +
      '注意：本工具运行在远程机器上，文件系统/路径/环境都归属远程，与本地无关。' +
      '不确定用户想在哪台机器执行时，先用 remote_info 确认当前连接的远程主机，或直接询问用户。' +
      '可执行任意命令，包括 claude、git、ls、curl 等。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要在远程服务器上执行的命令' },
        cwd: { type: 'string', description: '远程工作目录（可选）' },
      },
      required: ['command'],
    },
  },
  {
    name: 'remote_info',
    description: '查询当前 SSH 连接的远程主机信息（主机名、端口、用户名）。' +
      '在用户提及远程操作但你不确定是否已连接、或不确定连着哪台机器时调用。' +
      '返回 remote: false 表示未连接远程，此时远程相关请求应告知用户先连接服务器。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
]

// ── stdio JSON-RPC 2.0 (MCP) loop ─────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return } // not JSON-RPC — ignore
  const { id, method, params } = msg || {}

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ssh-bridge', version: '1.0.0' },
      },
    })
  }
  if (method === 'notifications/initialized') return // no response
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  }
  if (method === 'tools/call') {
    const name = params?.name || ''
    const args = params?.arguments || {}
    if (name === 'remote_info') {
      if (!SSH.host || !SSH.user || !SSH.secret) {
        return send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'remote: false — 未连接远程主机。告知用户需先在设置里连接服务器。' }] },
        })
      }
      return send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `remote: true — 已连接 ${SSH.user}@${SSH.host}:${SSH.port}（远程机器）。本地 terminal 工具与 remote_exec 运行在不同机器上。` }] },
      })
    }
    if (name === 'remote_exec') {
      if (!SSH.host || !SSH.user || !SSH.secret) {
        return send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: '[ssh-bridge] 未配置 SSH 连接（HERMES_SSH_* 缺失）——请先在设置里连接服务器' }], isError: true },
        })
      }
      const res = await remoteExec(String(args.command || ''), args.cwd)
      if (!res.ok) return send({ jsonrpc: '2.0', id, result: failWith(new Error(res.error)) })
      const text = [
        res.stdout ? `$ ${args.command}\n${res.stdout}` : '',
        res.stderr ? `[stderr]\n${res.stderr}` : '',
      ].filter(Boolean).join('\n') || `(命令 ${args.command} 无输出，退出码 ${res.code})`
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
    }
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true } })
  }
  // ping / unknown — respond ok to keep the client happy
  return send({ jsonrpc: '2.0', id, result: {} })
})
