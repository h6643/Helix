/**
 * Tool display utilities — extracted from agent-flow-panel.tsx.
 * Functions for rendering tool names and labels in the UI.
 */
import type { ExecutionStep } from "@/stores/helix-store";

/**
 * subagent.* 事件里的「合成工具行」并不是子代理真的调用了某个工具。
 *
 * gateway 在后台 spawn 确认时发一条 `tool_name: "background"` 的记录
 * （preview 为 "Agent started in background. Agent ID: …"），它唯一的用途是
 * 把扩展自己的子代理 id 带回前端、绑到卡片的 .output 转录上。把它当成工具行
 * 渲染出来纯属噪声，还会被误读成子代理的动作。
 *
 * 写入侧已经拦掉了（agent-flow-panel 的 subagent.tool 分支），但 store 里的
 * subAgents 是内存态、HMR 不会重置，网关改动之前写入的旧记录会一直残留——
 * 所以渲染前统一过滤一次，任何来源的合成行都不显示。
 */
export function isSyntheticSubAgentToolRow(
  toolName: string | null | undefined,
): boolean {
  const n = (toolName || "").trim().toLowerCase();
  return n === "background" || n === "progress";
}

/** `SubagentWorkflow`：pi-subagents 扩展的工作流派发工具
 *  （扩展侧 SUBAGENT_TOOL_NAMES.WORKFLOW 的字面值，改名要同步）。 */
export const WORKFLOW_TOOL_NAME = "SubagentWorkflow";

export interface WorkflowMetaInfo {
  name?: string;
  description?: string;
  phases: string[];
}

/** 引号感知的平衡括号扫描：返回从 openAt 处 `{`/`[` 到其配对闭合符的切片（不含配对符）。 */
function sliceBalanced(src: string, openAt: number): string | null {
  const open = src[openAt];
  const close = open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return null;
  let depth = 0;
  let quote = "";
  for (let i = openAt; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(openAt + 1, i);
    }
  }
  return null;
}

/**
 * 从工作流工具参数里的脚本文本抠出 `export const meta = {…}` 的
 * name / description / phases 标题。
 *
 * 扩展强制 meta 是**纯字面量**（变量、函数调用、展开、模板插值都算非法，
 * runtime 在脚本执行前读它），所以文本级扫描就足够，不需要也无法求值 ——
 * 更重要的是绝不 eval 模型写的代码。
 */
export function parseWorkflowMeta(
  params?: Record<string, unknown> | null,
): WorkflowMetaInfo | null {
  const script = params?.script;
  if (typeof script !== "string" || !script.trim()) return null;
  const decl = script.search(/export\s+const\s+meta\s*=/);
  if (decl < 0) return null;
  const braceAt = script.indexOf("{", decl);
  if (braceAt < 0) return null;
  const body = sliceBalanced(script, braceAt);
  if (body == null) return null;
  const quoted = (text: string, key: string) => {
    const m = text.match(
      new RegExp(`\\b${key}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`),
    );
    return m ? m[2].trim() : undefined;
  };
  // phases 之后的子对象里也可能带 name/detail 之类的键，标量字段只在它之前找。
  const phasesAt = body.search(/\bphases\s*:\s*\[/);
  const head = phasesAt < 0 ? body : body.slice(0, phasesAt);
  const phasesBody =
    phasesAt < 0 ? null : sliceBalanced(body, body.indexOf("[", phasesAt));
  const phases: string[] = [];
  if (phasesBody) {
    const re = /\btitle\s*:\s*(['"`])([\s\S]*?)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(phasesBody))) {
      const t = m[2].trim();
      if (t) phases.push(t);
    }
  }
  return {
    name: quoted(head, "name"),
    description: quoted(head, "description"),
    phases,
  };
}

const TOOL_LABELS: Record<string, string> = {
  SubagentWorkflow: "运行工作流",
  read_file: "读取文件",
  write_file: "写入文件",
  patch: "编辑文件",
  list_directory: "读取目录",
  glob: "搜索文件",
  search_files: "搜索文件",
  grep: "搜索内容",
  run_bash: "执行命令",
  bash: "执行命令",
  terminal: "执行命令",
  webfetch: "获取网页",
  websearch: "搜索网页",
  web_extractor: "获取网页",
  question: "提—",
  run_task: "执行任务",
  apply_patch: "””补丁",
  create_artifact: "创建制品",
  spawn_agent: "启动子代理",
  get_sub_agent_result: "获取子代理结果",
  session_search: "搜索会话",
  memory_add: "添加记忆",
  memory_read: "读取记忆",
  git_status: "查看状态",
  git_diff: "查看更改",
  git_log: "查看日志",
  git_branch: "查看分支",
  git_commit: "提交代码",
  plan_enter: "进入计划",
  plan_exit: "退出计划",
  task_create: "创建任务",
  task_update: "更新任务",
  task_complete: "完成任务",
  skill: "执行技能",
  browser_navigate: "浏览器导航",
  browser_click: "浏览器点击",
  browser_type: "浏览器输入",
  browser_screenshot: "浏览器截图",
  browser_get_html: "获取页面HTML",
  browser_handoff: "交给人工验证",
  browser_check_login: "检查人工验证",
  browser_hover: "浏览器悬停",
  browser_scroll: "浏览器滚动",
  browser_drag: "浏览器拖拽",
  browser_wait: "等待页面内容",
  browser_eval: "页面执行脚本",
  browser_upload: "上传本地文件",
  browser_dialog: "页面弹窗",
  describe_image: "视觉读图",
};

export function getToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] || toolName;
}

function argToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function extractCommandSnippet(
  params?: Record<string, unknown>,
): string | undefined {
  if (!params) return undefined;
  const keys = [
    "command",
    "script",
    "cmd",
    "args",
    "code",
    "input",
    "query",
    "text",
    "tool_input",
    "pattern",
    "file_glob",
    "image_path",
    "path",
    "file_path",
    "context",
  ];
  for (const k of keys) {
    const v = params[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const k of keys) {
    const v = params[k];
    if (Array.isArray(v) && v.length > 0) {
      const s = v.map(argToText).filter(Boolean).join(" ");
      if (s) return s;
    }
  }
  if (typeof params.raw === "string") {
    const raw = params.raw.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "string") return parsed;
        if (parsed && typeof parsed === "object") {
          for (const k of keys) {
            if (typeof parsed[k] === "string" && parsed[k].trim())
              return parsed[k].trim();
            if (Array.isArray(parsed[k])) {
              const s = parsed[k].map(argToText).filter(Boolean).join(" ");
              if (s) return s;
            }
          }
          for (const v of Object.values(parsed)) {
            if (typeof v === "string" && v.trim()) return v.trim();
          }
        }
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

export function getToolDisplayLabel(
  toolName: string,
  toolKind?: string,
  path?: string,
  params?: Record<string, unknown>,
): string {
  // 工作流卡：标题显示脚本 meta 里的名字，而不是把整段脚本文本当摘要塞进标题
  // （extractCommandSnippet 的键表里有 `script`，不特判就会得到 512KiB 代码墙）。
  if (toolName === WORKFLOW_TOOL_NAME) {
    const meta = parseWorkflowMeta(params);
    const saved =
      typeof params?.name === "string" ? params.name.trim() : "";
    const wfName = meta?.name || saved;
    return wfName ? `工作流 ${wfName}` : "派发工作流";
  }
  // If toolName is a raw ACP-style string like "search: ..." or "read: src/...",
  // try to extract a clean label from it first.
  if (toolName && toolName !== "tool") {
    // Check if it's already a known short tool name → translate via TOOL_LABELS
    if (TOOL_LABELS[toolName]) {
      const label = TOOL_LABELS[toolName];
      let snippet = "";
      if (path && typeof path === "string") {
        snippet = path;
      } else {
        const cmd = extractCommandSnippet(params);
        if (cmd) snippet = cmd;
      }
      if (snippet) {
        // For bash commands, show only the first line
        if (toolName === "bash" || toolName === "run_bash") {
          const firstLine = snippet.split("\n")[0];
          snippet =
            firstLine.length > 50 ? firstLine.slice(0, 50) + "…" : firstLine;
        } else {
          snippet = snippet.length > 60 ? snippet.slice(0, 60) + "…" : snippet;
        }
      }
      return snippet ? `${label}  ${snippet}` : label;
    }

    // toolName looks like "action: description" — use kind-based labels
    const colonIdx = toolName.indexOf(":");
    if (colonIdx > 0) {
      const action = toolName.slice(0, colonIdx).trim().toLowerCase();
      const desc = toolName.slice(colonIdx + 1).trim();
      const kindLabels: Record<string, string> = {
        read: "读取文件",
        write: "写入文件",
        edit: "编辑文件",
        delete: "删除文件",
        move: "移动文件",
        search: "搜索",
        execute: "执行命令",
        run: "执行命令",
        bash: "执行命令",
        think: "思考",
        fetch: "获取网页",
        webfetch: "获取网页",
        switch_mode: "切换模式",
        terminal: "执行命令",
        glob: "搜索文件",
        grep: "搜索内容",
        browser: "浏览器操作",
        skill: "执行技能",
        task: "任务操作",
      };
      const baseLabel =
        kindLabels[action] || getToolLabel(action) || "执行工具";
      // Truncate the long description part
      const shortDesc = desc.length > 50 ? desc.slice(0, 50) + "…" : desc;
      // 有些工具名里塞的是 patch/代码正文/内部字段名，不是可读动作描述；
      // 这些情况下只显示工具名，避免卡片标题变成 "Clear the draft's responseBlocks"。
      const looksLikePatch =
        /^(?:---|\+\+\+|@@|diff )|[\r\n]|\/\/|#\s|responseBlocks/i.test(
          shortDesc,
        );
      return looksLikePatch ? baseLabel : `${baseLabel}  ${shortDesc}`;
    }

    // Fallback: unknown short name — truncate to prevent overflow
    return toolName.length > 40 ? toolName.slice(0, 37) + "…" : toolName;
  }
  const kindLabels: Record<string, string> = {
    read: "读取文件",
    write: "写入文件",
    edit: "编辑文件",
    delete: "删除文件",
    move: "移动文件",
    search: "搜索",
    execute: "执行命令",
    think: "思考",
    fetch: "获取网页",
    switch_mode: "切换模式",
    other: "执行工具",
  };
  let label = "";
  if (toolKind && kindLabels[toolKind]) {
    label = kindLabels[toolKind];
  } else {
    label = getToolLabel(toolName);
  }
  let snippet = "";
  if (path && typeof path === "string") {
    snippet = path;
  } else {
    const cmd = extractCommandSnippet(params);
    if (cmd) snippet = cmd;
  }
  if (snippet) {
    // For bash commands, show only the first line
    if (toolName === "bash" || toolName === "run_bash") {
      const firstLine = snippet.split("\n")[0];
      snippet =
        firstLine.length > 50 ? firstLine.slice(0, 50) + "…" : firstLine;
    } else {
      snippet = snippet.length > 60 ? snippet.slice(0, 60) + "…" : snippet;
    }
  }
  return snippet ? `${label}  ${snippet}` : label;
}

export function extractToolPath(step: ExecutionStep): string {
  if (step.toolParams?.path && typeof step.toolParams.path === "string") {
    return step.toolParams.path as string;
  }
  if (
    step.toolParams?.file_path &&
    typeof step.toolParams.file_path === "string"
  ) {
    return step.toolParams.file_path as string;
  }
  // Helix `tool.start` carries a display `context` preview (e.g. "foo.ts 1-50")
  // instead of raw args — surface it so read/run steps show what they acted on.
  if (step.toolParams?.context && typeof step.toolParams.context === "string") {
    return step.toolParams.context as string;
  }
  // 不再从 step.content 猜路径：content 会随 tool_output_delta 流式追加命令
  // 输出，JSON.parse 恒失败后 fallback 正则会把输出里任意"路径样"片段（如
  // 错误信息里的 C:\xxx 或 /usr/bin）误当成工具操作对象，污染卡片标题。
  return "";
}
