/**
 * Helix config.yaml → adapter mcp.json bridge.
 *
 * Runs BEFORE the pi-mcp-adapter registers its extension. It reads the
 * canonical `mcp_servers:` block out of the pi agent's config.yaml (the same
 * block Helix's settings page writes) and writes an adapter-shaped
 * ~/.pi/agent/mcp.json mirror when the sources don't agree. If the two
 * already match, the mirror file is left untouched (idempotent).
 *
 * This lets mcp.json stay a pure derived artifact — the user only ever edits
 * config.yaml (via Helix settings), and the adapter keeps working without a
 * manual mcp.json. It is wired in by a pi-extension below.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ── minimal YAML subset reader (matches Helix's mcp_servers writer) ──────
// Supports: top-level `key:`, nested mappings (2-space), block lists of
// scalars (`- "x"` / `- x`), inline JSON scalars, quoted strings. Comments
// and blank lines ignored. This is deliberately tiny — only what the
// `mcp_servers:` block needs.

function parseYaml(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const root = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) { i++; continue; }
    // only parse top-level keys at this pass
    const m = line.match(/^([A-Za-z0-9_$.-]+):(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const inline = m[2].trim();
    if (inline && inline !== "|" && inline !== ">" && !inline.startsWith("#")) {
      root[key] = parseScalar(inline);
      i++;
      continue;
    }
    // nested block
    const block = [];
    i++;
    let curIndent = null;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      const ind = l.length - l.trimStart().length;
      if (ind === 0) break; // next top-level key
      if (curIndent === null) curIndent = ind;
      if (ind < curIndent) break; // dedent back to parent (unexpected) — stop
      block.push(l);
      i++;
    }
    root[key] = parseBlock(block, curIndent || 2);
  }
  return root;
}

function parseBlock(blockLines, indent) {
  // Decide: is this a list or a mapping?
  const first = blockLines.find((l) => l.trim());
  if (!first) return undefined;
  const firstTrim = first.trim();
  const isList = firstTrim.startsWith("- ");
  if (isList) {
    const out = [];
    for (const l of blockLines) {
      const t = l.trim();
      if (!t || t.startsWith("#")) continue;
      if (t.startsWith("- ")) out.push(parseScalar(t.slice(2).trim()));
    }
    return out;
  }
  // mapping
  const out = {};
  let i = 0;
  while (i < blockLines.length) {
    const l = blockLines[i];
    const t = l.trim();
    if (!t || t.startsWith("#")) { i++; continue; }
    const m = t.match(/^([A-Za-z0-9_$.-]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const inline = m[2];
    if (inline && inline !== "|" && inline !== ">" && !inline.startsWith("#")) {
      out[key] = parseScalar(inline);
      i++;
      continue;
    }
    // nested: consume indented children
    const children = [];
    i++;
    let childIndent = null;
    while (i < blockLines.length) {
      const c = blockLines[i];
      if (!c.trim()) { i++; continue; }
      const ci = c.length - c.trimStart().length;
      if (childIndent === null) childIndent = ci;
      if (ci < childIndent) break;
      children.push(c);
      i++;
    }
    out[key] = children.length ? parseBlock(children, childIndent) : undefined;
  }
  return out;
}

function parseScalar(s) {
  if (s === undefined || s === null) return undefined;
  s = s.trim();
  if (s === "") return undefined;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  // strip quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // inline JSON-ish ([...], {...})
  if (s.startsWith("[") || s.startsWith("{")) {
    try { return JSON.parse(s); } catch { /* fall through */ }
  }
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// ── read the mcp_servers block → adapter shape ───────────────────────────
function yamlMcpToAdapter(servers) {
  const out = {};
  for (const [name, entry] of Object.entries(servers || {})) {
    if (!entry || typeof entry !== "object") continue;
    const e = { ...entry };
    // renderer `enabled:false` → adapter `disabled:true`; enabled:true dropped.
    if ("enabled" in e) {
      delete e.enabled;
      if (e.enabled === false) e.disabled = true;
    }
    // yaml writes `env` as a map; adapter uses the same shape. Pass through.
    out[name] = e;
  }
  return out;
}

function readYamlMcpServers() {
  const dir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  const configPath = path.join(dir, "config.yaml");
  let text;
  try { text = fs.readFileSync(configPath, "utf8"); } catch { return undefined; }
  const parsed = parseYaml(text);
  if (!parsed || !parsed.mcp_servers || typeof parsed.mcp_servers !== "object") return undefined;
  return parsed.mcp_servers;
}

// ── main: reconcile mcp.json from config.yaml ───────────────────────────
function reconcile() {
  const dir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  const mcpJsonPath = path.join(dir, "mcp.json");

  const servers = yamlMcpToAdapter(readYamlMcpServers());

  let existing = {};
  try {
    const raw = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"));
    if (raw && typeof raw === "object") {
      existing = raw.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : {};
    }
  } catch { /* missing/corrupt → rebuild */ }

  const want = JSON.stringify(servers, null, 2);
  const have = JSON.stringify(existing, null, 2);
  if (want === have) {
    // already in sync — leave mcp.json as-is (idempotent).
    return { synced: true, changed: false, count: Object.keys(servers || {}).length };
  }

  // Preserve any non-mcpServers top-level keys the adapter wrote.
  let doc = {};
  try {
    const raw = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"));
    if (raw && typeof raw === "object") doc = raw;
  } catch { /* fresh file */ }
  doc.mcpServers = servers;
  fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true });
  fs.writeFileSync(mcpJsonPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return { synced: true, changed: true, count: Object.keys(servers || {}).length };
}

module.exports = { reconcile, parseYaml, yamlMcpToAdapter, readYamlMcpServers };
