"use client";

import {
  Activity,
  AlertTriangle,
  AlertCircle,
  Info,
  RefreshCw,
  CheckCircle2,
  FileText,
  Puzzle,
  Clock,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";

// ── Types (match self-improve extension report schema) ──────────────────────

type Severity = "error" | "warning" | "info";

interface Finding {
  severity: Severity;
  area: "skill" | "extension" | "session";
  target: string;
  title: string;
  detail: string;
  suggestion?: string;
}

interface Report {
  ts: number;
  iso: string;
  marker: string;
  runs: number;
  cooldownMinutes: number;
  findings: Finding[];
  counts: Record<Severity, number>;
  toolsSeen: string[];
  generatedBy: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const severityMeta: Record<
  Severity,
  { icon: React.ReactNode; color: string; label: string }
> = {
  error: {
    icon: <AlertCircle className="size-3.5" />,
    color: "text-red-500 bg-red-500/10",
    label: "错误",
  },
  warning: {
    icon: <AlertTriangle className="size-3.5" />,
    color: "text-amber-500 bg-amber-500/10",
    label: "警告",
  },
  info: {
    icon: <Info className="size-3.5" />,
    color: "text-sky-500 bg-sky-500/10",
    label: "提示",
  },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  return d.toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Main component ──────────────────────────────────────────────────────────

export function SelfImprovePanel() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = (window as any).electron as any;
      const res = await api?.selfImprove?.report?.();
      if (res?.ok && res.report) {
        setReport(res.report as Report);
      } else if (res?.ok && !res.report) {
        setReport(null);
      } else {
        setError(res?.error || "未知错误");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh every 30 seconds while panel is open
  useEffect(() => {
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="h-full w-full flex flex-col">
      {/* Compact header */}
      <div className="flex items-center justify-between px-4 py-2 shrink-0 border-b border-border/40">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-foreground/60" />
          <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground">
            体检报告
          </span>
          {report && (
            <span className="flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
              <Clock className="size-3" />
              {formatDate(report.iso)}
            </span>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.7143)] px-2 py-1 rounded-lg bg-accent/40 text-foreground/60 hover:text-foreground hover:bg-accent/60 transition-colors disabled:opacity-50"
          data-tip="刷新"
        >
          <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="px-4 py-4 space-y-3">
            {loading && (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <RefreshCw className="size-4 animate-spin mr-2" />
                <span className="text-[calc(var(--helix-transcript-size)*0.7857)]">
                  加载中…
                </span>
              </div>
            )}

            {!loading && error && (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <AlertCircle className="size-4 mr-2 text-red-400" />
                <span className="text-[calc(var(--helix-transcript-size)*0.7857)]">
                  {error}
                </span>
              </div>
            )}

            {!loading && !error && !report && (
              <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                <Activity className="size-8 mb-2 opacity-40" />
                <p className="text-[calc(var(--helix-transcript-size)*0.7857)] font-medium text-foreground/60">
                  暂无体检记录
                </p>
                <p className="mt-1 text-[calc(var(--helix-transcript-size)*0.7143)]">
                  在对话中输入 /selfimprove 立即执行
                </p>
              </div>
            )}

            {!loading && !error && report && (
              <>
                {/* Summary */}
                <div className="grid grid-cols-3 gap-2">
                  <SeverityCard
                    severity="error"
                    count={report.counts.error}
                  />
                  <SeverityCard
                    severity="warning"
                    count={report.counts.warning}
                  />
                  <SeverityCard
                    severity="info"
                    count={report.counts.info}
                  />
                </div>

                <div className="flex items-center gap-3 text-[calc(var(--helix-transcript-size)*0.6429)] text-muted-foreground/60 px-1">
                  <span>第 {report.runs} 次体检</span>
                  <span>·</span>
                  <span>冷却 {report.cooldownMinutes} 分钟</span>
                  <span>·</span>
                  <span>{report.toolsSeen.length} 个工具</span>
                </div>

                {/* Findings list */}
                {report.findings.length > 0 ? (
                  <div className="space-y-2">
                    <h3 className="text-[calc(var(--helix-transcript-size)*0.7857)] font-medium text-foreground/70 px-1">
                      发现 {report.findings.length} 项问题
                    </h3>
                    {report.findings.map((finding, i) => (
                      <FindingCard key={i} finding={finding} />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <CheckCircle2 className="size-6 text-emerald-500 mb-1.5" />
                    <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/60">
                      一切正常，未发现任何问题
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function SeverityCard({
  severity,
  count,
}: {
  severity: Severity;
  count: number;
}) {
  const meta = severityMeta[severity];
  const isZero = count === 0;

  return (
    <div
      className={`flex flex-col items-center gap-1.5 rounded-lg border border-border/40 bg-muted/30 px-2 py-2.5 ${
        isZero ? "opacity-60" : ""
      }`}
    >
      <div
        className={`flex items-center justify-center size-7 rounded-md ${
          isZero ? "bg-muted/40 text-muted-foreground/40" : meta.color
        }`}
      >
        {isZero ? <CheckCircle2 className="size-3.5" /> : meta.icon}
      </div>
      <div
        className={`text-[calc(var(--helix-transcript-size)*1.4286)] font-bold tabular-nums ${
          isZero
            ? "text-muted-foreground/50"
            : severity === "error"
              ? "text-red-500"
              : severity === "warning"
                ? "text-amber-500"
                : "text-sky-500"
        }`}
      >
        {count}
      </div>
      <div className="text-[calc(var(--helix-transcript-size)*0.6429)] text-muted-foreground">
        {meta.label}
      </div>
    </div>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  const meta = severityMeta[finding.severity];
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2.5 p-3 text-left hover:bg-accent/30 transition-colors"
      >
        <div
          className={`flex items-center justify-center size-6 rounded-md shrink-0 ${meta.color}`}
        >
          {meta.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span
              className={`text-[calc(var(--helix-transcript-size)*0.6429)] px-1 py-0.5 rounded ${meta.color}`}
            >
              {meta.label}
            </span>
            <AreaBadge area={finding.area} />
          </div>
          <h4 className="text-[calc(var(--helix-transcript-size)*0.7857)] font-medium text-foreground truncate">
            {finding.title}
          </h4>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-1.5">
          <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
            <div className="text-[calc(var(--helix-transcript-size)*0.6429)] text-muted-foreground mb-0.5">
              目标
            </div>
            <div className="text-[calc(var(--helix-transcript-size)*0.7143)] text-foreground font-mono break-all">
              {finding.target}
            </div>
          </div>
          <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
            <div className="text-[calc(var(--helix-transcript-size)*0.6429)] text-muted-foreground mb-0.5">
              详情
            </div>
            <div className="text-[calc(var(--helix-transcript-size)*0.7143)] text-foreground whitespace-pre-wrap">
              {finding.detail}
            </div>
          </div>
          {finding.suggestion && (
            <div className="rounded-md bg-primary/5 border border-primary/20 px-2.5 py-1.5">
              <div className="text-[calc(var(--helix-transcript-size)*0.6429)] text-primary/80 mb-0.5 font-medium">
                建议
              </div>
              <div className="text-[calc(var(--helix-transcript-size)*0.7143)] text-foreground">
                {finding.suggestion}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AreaBadge({ area }: { area: string }) {
  const config: Record<string, { label: string; icon: React.ReactNode }> = {
    skill: { label: "技能", icon: <FileText className="size-2" /> },
    extension: { label: "扩展", icon: <Puzzle className="size-2" /> },
    session: { label: "会话", icon: <Activity className="size-2" /> },
  };
  const c = config[area] || { label: area, icon: null };
  return (
    <span className="text-[calc(var(--helix-transcript-size)*0.6429)] px-1 py-0.5 rounded bg-muted text-muted-foreground flex items-center gap-0.5">
      {c.icon}
      {c.label}
    </span>
  );
}
