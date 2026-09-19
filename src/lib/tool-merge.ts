import { getToolLabel } from "./tool-display-utils";

// 工具名 → 「类目动词 + 细分类目」。顺序敏感：特异规则必须排在通用词之前
// （browser_read 先于 read、memory_read 先于 read、run_task 先于 run）。
// 这是主对话区与子 Agent 工作面板共用的唯一权威定义，避免两套动词表漂移。
const TOOL_STEP_RULES: Array<{ test: RegExp; verb: string; kind: string }> = [
  { test: /^agent$|delegate|spawn_agent|sub_agent|subagent|get_sub_agent/i, verb: "子代理", kind: "子代理" },
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

/** 子代理执行类工具（Agent / delegate_task / spawn_agent / get_sub_agent_result…）。
 *  摘要行不把它们并进动词统计——每次子代理执行单独一行展示。 */
export function isSubAgentTool(toolName: string | undefined | null): boolean {
  return classifyTool(toolName || "").verb === "子代理";
}

// 同类目归并（全局聚合）：同 verb 的工具收进同一组，**不要求相邻**。
// 此前只合并相邻同 verb——查阅/终端/查阅/编辑 交错出现时会拆成 4 个 chip
// 挤满摘要行；折叠摘要是整段工具流的总览，阶段顺序没有信息量，全局聚合后
// chip 数 = 去重后的动词数，一行放得下。verb 按首次出现顺序排列（保留一点
// 时间线感），组内按 kind 计数。
function mergeToolGroups(
  toolNames: string[],
): Array<{ verb: string; kinds: Array<{ kind: string; count: number }> }> {
  const byVerb = new Map<string, Map<string, number>>();
  const verbOrder: string[] = [];
  for (const name of toolNames) {
    const { verb, kind } = classifyTool(name);
    let kinds = byVerb.get(verb);
    if (!kinds) {
      kinds = new Map();
      byVerb.set(verb, kinds);
      verbOrder.push(verb);
    }
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  return verbOrder.map((verb) => ({
    verb,
    kinds: [...(byVerb.get(verb) as Map<string, number>).entries()].map(
      ([kind, count]) => ({ kind, count }),
    ),
  }));
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
