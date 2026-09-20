/**
 * 纯函数：把 plan.md 的 markdown 文本解析为结构化步骤列表。
 * 支持两种列表项形态：
 *   - "- [ ] xxx"  → pending
 *   - "- [x] xxx"  → completed
 *   - "- [~] xxx"  → in_progress
 *   - "1. xxx" / "- xxx" → pending（普通列表项）
 * 忽略代码块内的内容，忽略空行与标题行。
 */
import type { PlanStep } from "@/stores/helix-types";

type PlanStepStatus = PlanStep["status"];

const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX~])\]\s*(.+)$/;
const OL_ITEM_RE = /^\s*\d+\.\s+(.+)$/;
const UL_ITEM_RE = /^\s*[-*]\s+(?!\[)(.+)$/;

export function parsePlanSteps(markdown: string): PlanStep[] {
  const lines = markdown.split("\n");
  const steps: PlanStep[] = [];
  let inCodeBlock = false;

  for (const raw of lines) {
    // 跳过代码块
    if (raw.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    let text: string | null = null;
    let status: PlanStepStatus = "pending";

    const boxMatch = raw.match(CHECKBOX_RE);
    if (boxMatch) {
      const mark = boxMatch[1].toLowerCase();
      text = boxMatch[2].trim();
      status =
        mark === "x"
          ? "completed"
          : mark === "~"
            ? "in_progress"
            : "pending";
    } else {
      const olMatch = raw.match(OL_ITEM_RE);
      const ulMatch = raw.match(UL_ITEM_RE);
      if (olMatch) {
        text = olMatch[1].trim();
      } else if (ulMatch) {
        text = ulMatch[1].trim();
      }
    }

    if (text && text.length > 0) {
      steps.push({ text, status });
    }
  }

  return steps;
}

/**
 * 从工作目录拉取 plan.md 并解析为 PlanStep[]。
 * 文件不存在或读取失败时返回 null。
 * workDir 为 null/undefined 时返回 null。
 */
export async function loadPlanSteps(
  workDir: string | null | undefined,
): Promise<import("@/stores/helix-types").PlanStep[] | null> {
  if (!workDir) return null;
  try {
    const { electronFS, isElectron } = await import("@/lib/electron-bridge");
    if (!isElectron()) return null;
    const text = await electronFS.readFile(
      `${workDir.replace(/[/\\]+$/, "")}/plan.md`,
    );
    const steps = parsePlanSteps(text);
    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}
