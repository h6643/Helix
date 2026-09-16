import { getToolLabel } from "./tool-display-utils";

// 工具名 → 「类目动词 + 细分类目」。顺序敏感：特异规则必须排在通用词之前
// （browser_read 先于 read、memory_read 先于 read、run_task 先于 run）。
// 这是主对话区与子 Agent 工作面板共用的唯一权威定义，避免两套动词表漂移。
export const TOOL_STEP_RULES: Array<{ test: RegExp; verb: string; kind: string }> = [
  { test: /browser_navigate|browser_go|open_browser|navigate/i, verb: "浏览器", kind: "导航" },
  { test: /browser_click/i, verb: "浏览器", kind: "点击" },
  { test: /browser_type|browser_input/i, verb: "浏览器", kind: "输入" },
  { test: /browser_scroll/i, verb: "浏览器", kind: "滚动" },
  { test: /browser_screenshot/i, verb: "浏览器", kind: "截图" },
  { test: /browser_read|browser_get_html|browser_extract|browser_snapshot/i, verb: "浏览器", kind: "读取" },
  { test: /memory/i, verb: "记忆", kind: "记忆" },
  { test: /sub_agent|spawn_agent|delegation/i, verb: "子代理", kind: "子代理" },
  { test: /task_|todo_|plan_|run_task/i, verb: "任务", kind: "任务" },
  { test: /skill/i, verb: "技能", kind: "技能" },
  { test: /websearch|web_search|search_web/i, verb: "查阅", kind: "搜索" },
  { test: /web_fetch|webfetch|fetch|web_extractor/i, verb: "查阅", kind: "网页" },
  { test: /grep|search|glob|find|query/i, verb: "查阅", kind: "搜索" },
  { test: /list_directory|list_files|list|dir/i, verb: "查阅", kind: "列表" },
  { test: /read|view/i, verb: "查阅", kind: "文件" },
  { test: /write|create|artifact/i, verb: "编辑", kind: "写入" },
  { test: /edit|patch|modify|replace/i, verb: "编辑", kind: "编辑" },
  { test: /bash|terminal|shell|run_|execute|command|cmd/i, verb: "终端", kind: "命令" },
];

export interface ToolClass {
  verb: string;
  kind: string;
}

export function classifyTool(toolName: string): ToolClass {
  const name = toolName || "";
  for (const r of TOOL_STEP_RULES) {
    if (r.test.test(name)) return { verb: r.verb, kind: r.kind };
  }
  return { verb: "工具", kind: getToolLabel(name) || name || "工具" };
}

// 连续同类目归并（与子 Agent 面板的 mergeSteps 同算法，但纯函数、不依赖
// UI/status）：相邻同 verb 合并成一组，组内按 kind 计数。
// `file→file→edit→file` 会得到三个组。
export function mergeToolGroups(
  toolNames: string[],
): Array<{ verb: string; kinds: Array<{ kind: string; count: number }> }> {
  const groups: Array<{
    verb: string;
    kinds: Array<{ kind: string; count: number }>;
  }> = [];
  for (const name of toolNames) {
    const { verb, kind } = classifyTool(name);
    const last = groups[groups.length - 1];
    if (last && last.verb === verb) {
      const k = last.kinds.find((x) => x.kind === kind);
      if (k) k.count += 1;
      else last.kinds.push({ kind, count: 1 });
    } else {
      groups.push({ verb, kinds: [{ kind, count: 1 }] });
    }
  }
  return groups;
}

// 单行摘要（图2 风格）：`查阅 · 3 搜索, 2 文件`；多组用 `; ` 连接。
// 无工具时返回空串（调用方据此回退到 `N 个操作`）。
export function formatMergedSummary(toolNames: string[]): string {
  const groups = mergeToolGroups(toolNames);
  if (groups.length === 0) return "";
  return groups
    .map((g) => {
      const detail = g.kinds.map((k) => `${k.count} ${k.kind}`).join(", ");
      return `${g.verb} · ${detail}`;
    })
    .join("; ");
}
