"use client";

import {
  AlertCircle,
  ChevronDown,
  CircleAlert,
  CircleDashed,
  FileSearch,
  Loader2,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isElectron } from "@/lib/electron-bridge";
import type {
  DiagnosticCheck,
  DiagnosticProblem,
  DiagnosticRunResult,
} from "@/types/electron";
import { useHelixStore } from "@/stores/helix-store";

interface DiagnosticsPanelProps {
  onClose: () => void;
}

/** 把问题列表压成一条可直接发给模型的修复请求。 */
function buildFixPrompt(problems: DiagnosticProblem[], label: string): string {
  const lines = problems
    .slice(0, 40)
    .map((p) => `- ${p.file}:${p.line}:${p.column} ${p.message}`);
  return [
    `下面是 \`${label}\` 报出的错误，请逐个修掉（改完再自己跑一次同一条命令确认，不要只改表面）：`,
    "",
    ...lines,
    problems.length > lines.length
      ? `- …另有 ${problems.length - lines.length} 条同类问题`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function DiagnosticsPanel({ onClose }: DiagnosticsPanelProps) {
  const showToast = useHelixStore((s) => s.showToast);
  const injectInput = useHelixStore((s) => s.injectInput);
  const openFileInEditor = useHelixStore((s) => s.openFileInEditor);
  const setRightSidebarTab = useHelixStore((s) => s.setRightSidebarTab);
  const diagnosticsAfterRun = useHelixStore((s) => s.diagnosticsAfterRun);
  const setDiagnosticsAfterRun = useHelixStore((s) => s.setDiagnosticsAfterRun);
  const lastDiagnostics = useHelixStore((s) => s.lastDiagnostics);
  const workDir = useHelixStore(
    (s) => s.activeSessionWorkDir ?? s.selectedWorkDir,
  );

  const [checks, setChecks] = useState<DiagnosticCheck[]>([]);
  const [checkId, setCheckId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DiagnosticRunResult | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [detectNote, setDetectNote] = useState("");

  useEffect(() => {
    if (!workDir) return;
    // 本轮自动检查留下的结果先铺上，避免打开面板只能看到「还没跑」。
    setResult(lastDiagnostics[workDir] ?? null);
    void (async () => {
      const api = window.electron?.diagnostics;
      if (!api) return;
      try {
        const detect = await api.detect(workDir);
        const list = detect.checks ?? [];
        setChecks(list);
        setDetectNote(detect.note ?? "");
        setCheckId((prev) =>
          prev && list.some((c) => c.id === prev)
            ? prev
            : (list[0]?.id ?? ""),
        );
      } catch (e) {
        setDetectNote(String(e));
      }
    })();
    // workDir 变化才重新探测；lastDiagnostics 是渲染初值，不做依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workDir]);

  const runCheck = useCallback(async () => {
    const api = window.electron?.diagnostics;
    if (!api || !workDir) {
      showToast({ type: "warning", title: "未选择工作目录" });
      return;
    }
    setRunning(true);
    setShowRaw(false);
    try {
      const r = await api.run({ checkId: checkId || undefined, cwd: workDir });
      setResult(r);
      if (r.ok && r.cwd) {
        useHelixStore.getState().setLastDiagnostics(r.cwd, r);
      }
      if (!r.ok && r.error) {
        showToast({
          type: "error",
          title: "检查没能跑起来",
          description: r.error,
        });
      }
    } catch (e) {
      showToast({ type: "error", title: "检查失败", description: String(e) });
    } finally {
      setRunning(false);
    }
  }, [checkId, showToast, workDir]);

  const problems = useMemo(() => result?.problems ?? [], [result]);
  const errors = useMemo(
    () => problems.filter((p) => p.severity === "error"),
    [problems],
  );
  const warnings = useMemo(
    () => problems.filter((p) => p.severity !== "error"),
    [problems],
  );

  const jumpTo = async (p: DiagnosticProblem) => {
    setRightSidebarTab("code");
    try {
      const content = (await window.electron?.fs?.read?.(p.absPath)) ?? "";
      const name = p.file.split("/").pop() ?? p.file;
      openFileInEditor(p.absPath, name, content);
      // 面板是铺满主区的覆盖层，会把编辑器一起盖住。跳转后收起面板，
      // 结果留在 store 里（lastDiagnostics），重新打开不用重跑。
      onClose();
    } catch {
      showToast({ type: "error", title: "打开文件失败", description: p.absPath });
    }
  };

  if (!isElectron()) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground">
          诊断功能仅在桌面版可用
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background select-none">
      <div className="shrink-0 px-4 pr-36 py-3 border-b border-border/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileSearch className="size-4 text-muted-foreground" />
          <h2 className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
            诊断
          </h2>
          <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/60 truncate max-w-[18rem]">
            {workDir ?? "未选择项目目录"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={runCheck}
            disabled={running || checks.length === 0}
            className="px-2.5 py-1 flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            运行
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
          >
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)]">
              关闭
            </span>
          </button>
        </div>
      </div>

      {/* 检查项选择 + 每轮自动检查 */}
      <div className="shrink-0 px-4 py-2.5 border-b border-border/40 bg-muted/20 flex items-center gap-2 flex-wrap">
        {checks.length === 0 ? (
          <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
            {detectNote || "没找到可运行的检查"}
          </p>
        ) : (
          <div className="flex items-center gap-1 flex-wrap">
            {checks.map((c) => (
              <button
                key={c.id}
                onClick={() => setCheckId(c.id)}
                title={`${c.source}`}
                className={`px-2 py-1 rounded-lg text-[calc(var(--helix-transcript-size)*0.7857)] font-mono border transition-colors ${
                  checkId === c.id
                    ? "border-primary/60 bg-primary/10 text-primary"
                    : "border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent/50"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={diagnosticsAfterRun}
            onChange={(e) => setDiagnosticsAfterRun(e.target.checked)}
            className="size-3 accent-primary"
          />
          每轮结束自动检查
        </label>
      </div>

      <div className="flex-1 overflow-y-auto">
        {result && (
          <div className="px-4 py-2 border-b border-border/40 flex items-center gap-3 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground">
            <span className="flex items-center gap-1">
              <CircleAlert className="size-3 text-red-500" />
              {errors.length} 错误
            </span>
            <span className="flex items-center gap-1">
              <TriangleAlert className="size-3 text-amber-500" />
              {warnings.length} 警告
            </span>
            {typeof result.durationMs === "number" && (
              <span>{(result.durationMs / 1000).toFixed(1)}s</span>
            )}
            {result.truncated && <span>（已截断，仅前 200 条）</span>}
            {problems.length === 0 && result.ok && !result.timedOut && (
              <span className="text-emerald-500 flex items-center gap-1">
                <CircleDashed className="size-3" />
                没有发现问题
              </span>
            )}
          </div>
        )}

        {!result && !running && (
          <p className="px-4 py-12 text-center text-[length:var(--helix-transcript-size)] text-muted-foreground/60">
            {checks.length > 0
              ? `点「运行」执行 ${checks[0].label}`
              : "选好项目目录后会自动识别可用的检查"}
          </p>
        )}

        {problems.length > 0 && (
          <ul className="py-1">
            {problems.map((p, i) => (
              <li key={`${p.file}:${p.line}:${p.column}:${i}`}>
                <button
                  onClick={() => void jumpTo(p)}
                  className="w-full text-left px-4 py-2 hover:bg-accent/50 transition-colors group"
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={`mt-1 size-1.5 rounded-full shrink-0 ${
                        p.severity === "error" ? "bg-red-500" : "bg-amber-500"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground break-words">
                        {p.message}
                      </p>
                      <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/70 font-mono truncate mt-0.5">
                        {p.file}:{p.line}:{p.column}
                        {p.code ? ` · ${p.code}` : ""}
                      </p>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}

        {problems.length === 0 && result?.rawTail ? (
          <div className="px-4 py-3">
            <button
              onClick={() => setShowRaw((v) => !v)}
              className="flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={`size-3 transition-transform ${showRaw ? "" : "-rotate-90"}`}
              />
              没解析出结构化问题，看原始输出
            </button>
            {showRaw && (
              <pre className="mt-2 p-3 rounded-lg bg-muted/40 border border-border/40 text-[calc(var(--helix-transcript-size)*0.7143)] font-mono whitespace-pre-wrap break-all max-h-80 overflow-y-auto">
                {result.rawTail}
              </pre>
            )}
          </div>
        ) : null}
      </div>

      {errors.length > 0 && (
        <div className="shrink-0 px-4 py-2.5 border-t border-border/40 flex items-center justify-between gap-2">
          <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60">
            填入输入框后可自行编辑再发送
          </p>
          <button
            onClick={() => {
              injectInput(
                buildFixPrompt(errors, result?.label ?? "类型检查"),
              );
              onClose();
            }}
            className="px-3 py-1.5 flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            <Sparkles className="size-3" />
            交给 AI 修复
          </button>
        </div>
      )}

      {result && !result.ok && result.error && (
        <div className="shrink-0 px-4 py-2 border-t border-border/40 flex items-start gap-2 text-red-500">
          <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
          <p className="text-[calc(var(--helix-transcript-size)*0.7857)] break-words">
            {result.error}
          </p>
        </div>
      )}
    </div>
  );
}
