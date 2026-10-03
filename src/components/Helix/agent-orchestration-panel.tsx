"use client";

import {
  GitBranch,
  Info,
  Loader2,
  Plus,
  Trash2,
  Wand2,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingGroup } from "./settings-ui";
import { cn } from "@/lib/utils";

interface SubagentPreset {
  id: string;
  name: string;
  description?: string;
  model?: string;
  disabled?: boolean;
}

interface OrchestrationTask {
  id: string;
  /** 子代理 preset id（对应 Agent 工具的 subagent_type） */
  agent: string;
  /** 给该子代理的任务描述 */
  goal: string;
}

const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * 子代理编排。
 *
 * 为什么是「生成编排指令」而不是「前端直接派发」：pi 的 RPC 命令全集里**没有**
 * call_tool / tools/call，Agent 工具是模型在 turn 内调用的（pi-subagents 扩展
 * 注册的 model-facing 工具），网关侧 `subagent_map` 只读、没有 spawn command。
 * 所以唯一可靠的启动路径是让模型在 turn 里调 Agent —— 这里的职责就是把
 * 「勾了哪些子代理、各自干什么、并行还是串行」编译成一段结构化指令，交给模型执行，
 * 执行过程与结果照旧回落到 delegations 面板的实时卡片里。
 *
 * 并行提示：扩展默认 `run_in_background: true`，子代理 cwd **继承父会话**，
 * 并行改同一批文件会打架 —— 指令里显式提醒必要时用 isolation: worktree。
 */
export function AgentOrchestrationPanel({
  onInsert,
}: {
  /** 把生成的编排指令回填到主对话输入框（由 agent-flow-panel 传入） */
  onInsert: (text: string) => void;
}) {
  const [presets, setPresets] = useState<SubagentPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<OrchestrationTask[]>([
    { id: uid(), agent: "", goal: "" },
  ]);
  const [objective, setObjective] = useState("");
  const [parallel, setParallel] = useState(true);

  useEffect(() => {
    let alive = true;
    const listSubagents = (window as any).electron?.helix?.listSubagents;
    if (typeof listSubagents !== "function") {
      setLoading(false);
      return;
    }
    listSubagents()
      .then((ps: any[]) => {
        if (!alive) return;
        if (Array.isArray(ps)) {
          setPresets(
            ps.map((p) => ({
              id: String(p.id || p.name || ""),
              name: String(p.name || p.id || ""),
              description: p.description,
              model: p.model,
              disabled: !!p.disabled,
            })),
          );
          // 默认填第一个可用子代理，省一次点击
          setTasks((prev) =>
            prev.map((t) => {
              if (t.agent || !ps.length) return t;
              const first = ps.find((p) => !p.disabled) || ps[0];
              return { ...t, agent: String(first.id || first.name || "") };
            }),
          );
        }
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const usable = useMemo(
    () => presets.filter((p) => p.id && !p.disabled),
    [presets],
  );
  const filled = useMemo(
    () => tasks.filter((t) => t.agent && t.goal.trim()),
    [tasks],
  );

  const addTask = useCallback(() => {
    setTasks((prev) => [
      ...prev,
      { id: uid(), agent: usable[0]?.id ?? "", goal: "" },
    ]);
  }, [usable]);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) =>
      prev.length <= 1 ? prev : prev.filter((t) => t.id !== id),
    );
  }, []);

  const buildPrompt = useCallback(() => {
    const lines: string[] = [];
    lines.push(
      "请用子代理编排完成下面这组任务。请对每一条分别调用一次 Agent 工具，",
    );
    lines.push(
      parallel
        ? "各子代理互相独立，可以并行启动（run_in_background: true），全部完成后汇总结果。"
        : "严格按下面的顺序串行执行：前一个子代理完成后再启动下一个，最后汇总结果。",
    );
    if (parallel) {
      lines.push(
        "注意：子代理默认继承当前工作目录，并行改同一批文件会互相覆盖；" +
          "若多个子代理都要写同一处文件，请在 Agent 调用里传 isolation: \"worktree\" 做隔离。",
      );
    }
    if (objective.trim()) {
      lines.push("", `总体目标：${objective.trim()}`);
    }
    lines.push("", "任务清单：");
    filled.forEach((t, i) => {
      const preset = usable.find((p) => p.id === t.agent);
      lines.push(
        `${i + 1}. 子代理类型 subagent_type="${t.agent}"${
          preset?.name && preset.name !== t.agent ? `（${preset.name}）` : ""
        }${preset?.model ? `，模型 ${preset.model}` : ""}`,
      );
      lines.push(`   任务：${t.goal.trim()}`);
      if (preset?.description) lines.push(`   该子代理的职责：${preset.description}`);
    });
    lines.push(
      "",
      "全部子代理返回后，请给我一份汇总：每个子代理的结论、发现的问题、建议的下一步。",
    );
    return lines.join("\n");
  }, [filled, objective, parallel, usable]);

  const insertable = filled.length > 0;

  return (
    <div className="space-y-4">
      <SettingGroup title="总体目标（可选）">
        <div className="px-4 py-3">
          <input
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="例如：给这个项目补齐端到端测试并修掉类型错误"
            className="w-full px-2.5 py-1.5 ui-text-sm2 bg-muted/50 border border-border/50 rounded-lg outline-none focus:border-border/80"
          />
        </div>
      </SettingGroup>

      <SettingGroup
        title={
          <span className="flex items-center gap-1.5">
            <GitBranch className="size-3.5 text-muted-foreground" />
            任务清单
          </span>
        }
        action={
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setParallel((v) => !v)}
              className={cn(
                "px-2 py-1 rounded-lg text-[calc(var(--helix-transcript-size)*0.7857)] transition-colors",
                parallel
                  ? "bg-primary/10 text-primary"
                  : "bg-muted/60 text-muted-foreground hover:text-foreground",
              )}
              title="切换并行 / 串行调度"
            >
              {parallel ? "并行" : "串行"}
            </button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1"
              onClick={addTask}
              disabled={loading}
            >
              <Plus className="size-3" />
              添加
            </Button>
          </div>
        }
        bodyClassName="divide-y divide-border/30"
      >
        {loading ? (
          <div className="px-4 py-8 flex items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)]">
              读取子代理列表…
            </span>
          </div>
        ) : usable.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-[calc(var(--helix-transcript-size)*0.9286)] text-muted-foreground">
              没有可用的子代理
            </p>
            <p className="mt-1 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">
              先到「设置 → 子智能体」添加一个
            </p>
          </div>
        ) : (
          tasks.map((t) => {
            const preset = usable.find((p) => p.id === t.agent);
            return (
              <div
                key={t.id}
                className="flex items-start gap-2 px-4 py-2.5 hover:bg-muted/40 transition-colors"
              >
                <select
                  value={t.agent}
                  onChange={(e) =>
                    setTasks((prev) =>
                      prev.map((x) =>
                        x.id === t.id ? { ...x, agent: e.target.value } : x,
                      ),
                    )
                  }
                  className="shrink-0 w-36 px-2 py-1.5 ui-text-sm2 bg-muted/50 border border-border/50 rounded-lg outline-none focus:border-border/80 cursor-pointer"
                >
                  {usable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <div className="flex-1 min-w-0">
                  <input
                    value={t.goal}
                    onChange={(e) =>
                      setTasks((prev) =>
                        prev.map((x) =>
                          x.id === t.id ? { ...x, goal: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder="这个子代理要做什么"
                    className="w-full px-2.5 py-1.5 ui-text-sm2 bg-muted/50 border border-border/50 rounded-lg outline-none focus:border-border/80"
                  />
                  {preset?.description && (
                    <p className="mt-1 px-1 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/50 truncate">
                      {preset.description}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 mt-0.5 text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10"
                  onClick={() => removeTask(t.id)}
                  disabled={tasks.length <= 1}
                  data-tip="删除任务"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            );
          })
        )}
      </SettingGroup>

      <div className="flex items-start gap-1.5 px-1 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/60">
        <Info className="size-3 mt-0.5 shrink-0" />
        <span>
          子代理由模型在当前回合内调度，所以这里生成的是一段结构化指令 ——
          点「插入输入框」后你可以自己检查修改，再发送。执行进度与实时输出照旧出现在
          下方的子代理卡片里。
        </span>
      </div>

      <div className="flex items-center justify-end">
        <Button
          size="sm"
          className="h-7 gap-1.5"
          disabled={!insertable}
          onClick={() => onInsert(buildPrompt())}
        >
          <Wand2 className="size-3" />
          插入输入框
        </Button>
      </div>
    </div>
  );
}
