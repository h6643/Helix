"use client";

import {
  AlertTriangle,
  Check,
  Download,
  Info,
  Loader2,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Zap,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { PageHeader, SaveBar, SettingGroup } from "./settings-ui";
import { getElectronAPI } from "@/lib/electron-bridge";
import { cn } from "@/lib/utils";

// ── 策略形状 ──────────────────────────────────────────────────────────
// 配置文件里的 `permission` 对象：
//   "*": "ask"                          ← 兜底
//   "bash": { "*": "ask", "rm -rf *": "deny" }   ← 某个面的规则表
//   "npm *": { "action": "deny", "reason": "…" } ← 也可带 reason（不编 UI）
// 规则**后匹配覆盖先匹配**，所以键顺序有意义：宽规则在前、具体覆盖在后。
type State = "allow" | "deny" | "ask";
type RuleValue = State | { action?: State; reason?: string };
type Policy = Record<string, RuleValue>;

const STATES: State[] = ["allow", "ask", "deny"];
const STATE_META: Record<
  State,
  { label: string; cls: string; hint: string }
> = {
  allow: {
    label: "放行",
    cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    hint: "直接执行，不询问",
  },
  ask: {
    label: "询问",
    cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    hint: "每次弹窗等你确认",
  },
  deny: {
    label: "拒绝",
    cls: "bg-red-500/10 text-red-600 dark:text-red-400",
    hint: "阻断并把理由回给模型",
  },
};

function readState(v: RuleValue | undefined): State {
  if (v == null) return "ask";
  if (typeof v === "string") return v;
  return v.action ?? "ask";
}
function readReason(v: RuleValue | undefined): string {
  return v && typeof v === "object" ? (v.reason ?? "") : "";
}
function writeState(v: RuleValue | undefined, s: State): RuleValue {
  // 保留已有 reason，避免切状态时把自定义理由抹掉
  if (v && typeof v === "object" && v.reason) {
    return { action: s, reason: v.reason };
  }
  return s;
}

/** 一个"面"（工具名 / path / external_directory）。顺序即匹配优先级。 */
interface Surface {
  key: string;
  label: string;
  hint?: string;
  rules: Array<{ pattern: string; value: RuleValue }>;
}

const SURFACE_LABELS: Record<string, { label: string; hint?: string }> = {
  "*": { label: "兜底", hint: "任何未列出的工具" },
  path: { label: "文件路径", hint: "对所有读写工具生效" },
  path_read: { label: "读路径", hint: "所有读操作" },
  path_write: { label: "写路径", hint: "所有写操作" },
  external_directory: { label: "越界访问", hint: "项目目录之外" },
  bash: { label: "Shell 命令" },
  mcp: { label: "MCP 工具" },
  skill: { label: "技能" },
  read: { label: "read 工具" },
  write: { label: "write 工具" },
  edit: { label: "edit 工具" },
  grep: { label: "grep 工具" },
  find: { label: "find 工具" },
  ls: { label: "ls 工具" },
};

function toSurfaces(policy: Policy): Surface[] {
  return Object.entries(policy).map(([key, value]) => {
    const meta = SURFACE_LABELS[key] ?? { label: key };
    if (value !== null && typeof value === "object") {
      return {
        key,
        label: meta.label,
        hint: meta.hint,
        rules: Object.entries(value).map(([pattern, v]) => ({
          pattern,
          value: v as RuleValue,
        })),
      };
    }
    return {
      key,
      label: meta.label,
      hint: meta.hint,
      rules: [{ pattern: "*", value: value as RuleValue }],
    };
  });
}

function fromSurfaces(surfaces: Surface[]): Policy {
  const out: Policy = {};
  for (const s of surfaces) {
    if (s.rules.length === 1 && s.rules[0].pattern === "*") {
      out[s.key] = s.rules[0].value;
      continue;
    }
    const map: Record<string, RuleValue> = {};
    for (const r of s.rules) {
      if (!r.pattern) continue;
      map[r.pattern] = r.value;
    }
    out[s.key] = map;
  }
  return out;
}

const SUGGESTIONS: Array<{ surface: string; pattern: string; state: State }> = [
  { surface: "bash", pattern: "git status*", state: "allow" },
  { surface: "bash", pattern: "npm test*", state: "allow" },
  { surface: "bash", pattern: "cargo test*", state: "allow" },
  { surface: "bash", pattern: "git push*", state: "ask" },
  { surface: "bash", pattern: "sudo *", state: "ask" },
  { surface: "bash", pattern: "rm -rf *", state: "deny" },
  { surface: "path", pattern: "*.env", state: "deny" },
  { surface: "path", pattern: "~/.ssh/*", state: "deny" },
  { surface: "external_directory", pattern: "*", state: "ask" },
];

export function PermissionsSettingsPanel() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [yoloMode, setYoloMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<null | "ok" | "err">(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    const api = getElectronAPI();
    if (!api?.helix?.piPermissionsRead) {
      setInstalled(false);
      setLoaded(true);
      return;
    }
    try {
      const res = await api.helix.piPermissionsRead();
      setInstalled(!!res.installed);
      setConfigPath(res.configPath || "");
      setYoloMode(!!res.yoloMode);
      const p = (res.policy ?? null) as Policy | null;
      if (p && typeof p === "object" && Object.keys(p).length > 0) {
        setSurfaces(toSurfaces(p));
      } else {
        setSurfaces([]);
      }
      setDirty(false);
      setStatus(null);
    } catch (e) {
      setErrorText(String(e));
      setStatus("err");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback((fn: (prev: Surface[]) => Surface[]) => {
    setDirty(true);
    setStatus(null);
    setSurfaces((prev) => fn(prev));
  }, []);

  const setRule = (key: string, pattern: string, next: RuleValue) =>
    mutate((prev) =>
      prev.map((s) =>
        s.key !== key
          ? s
          : {
              ...s,
              rules: s.rules.map((r) =>
                r.pattern === pattern ? { ...r, value: next } : r,
              ),
            },
      ),
    );

  const addRule = (key: string) =>
    mutate((prev) =>
      prev.map((s) =>
        s.key === key
          ? {
              ...s,
              rules: [
                // 新规则插到末尾 = 优先级最低；要覆盖前面的宽规则得往上拖，
                // 这里先保证不会意外盖掉 deny。
                ...s.rules,
                { pattern: "", value: "ask" as State },
              ],
            }
          : s,
      ),
    );

  const removeRule = (key: string, pattern: string) =>
    mutate((prev) =>
      prev
        .map((s) =>
          s.key === key
            ? {
                ...s,
                rules: s.rules.filter((r) => r.pattern !== pattern),
              }
            : s,
        )
        // 删空了的面直接整个去掉，避免留下 `"bash": {}` 这种空壳
        .filter((s) => s.rules.length > 0),
    );

  const addSurface = () =>
    mutate((prev) => [
      ...prev,
      { key: "", label: "新规则面", rules: [{ pattern: "*", value: "ask" }] },
    ]);

  const removeSurface = (key: string) =>
    mutate((prev) => prev.filter((s) => s.key !== key));

  const moveRule = (key: string, idx: number, dir: -1 | 1) =>
    mutate((prev) =>
      prev.map((s) => {
        if (s.key !== key) return s;
        const next = [...s.rules];
        const j = idx + dir;
        if (j < 0 || j >= next.length) return s;
        [next[idx], next[j]] = [next[j], next[idx]];
        return { ...s, rules: next };
      }),
    );

  const save = useCallback(async () => {
    const api = getElectronAPI();
    if (!api?.helix?.piPermissionsWrite) return;
    setSaving(true);
    setStatus(null);
    setErrorText(null);
    try {
      // 空 pattern 的行是用户刚加还没填的，丢掉（fromSurfaces 已过滤）
      const policy = fromSurfaces(
        surfaces
          .map((s) => ({ ...s, key: s.key.trim() }))
          .filter((s) => s.key && s.rules.some((r) => r.pattern.trim())),
      );
      await api.helix.piPermissionsWrite(policy, yoloMode);
      setDirty(false);
      setStatus("ok");
    } catch (e) {
      setErrorText(String(e));
      setStatus("err");
    } finally {
      setSaving(false);
    }
  }, [surfaces, yoloMode]);

  const installExtension = useCallback(async () => {
    const api = getElectronAPI();
    if (!api?.helix?.piInstallPackage) return;
    setSaving(true);
    setErrorText(null);
    try {
      await api.helix.piInstallPackage("@gotgenes/pi-permission-system");
      setInstalled(true);
      setStatus("ok");
    } catch (e) {
      setErrorText(String(e));
      setStatus("err");
    } finally {
      setSaving(false);
    }
  }, []);

  const counts = useMemo(() => {
    let allow = 0,
      ask = 0,
      deny = 0;
    for (const s of surfaces) {
      for (const r of s.rules) {
        const st = readState(r.value);
        if (st === "allow") allow++;
        else if (st === "deny") deny++;
        else ask++;
      }
    }
    return { allow, ask, deny };
  }, [surfaces]);

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 py-10 justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span className="text-[length:var(--helix-transcript-size)]">
          读取权限策略…
        </span>
      </div>
    );
  }

  if (installed === false) {
    return (
      <div className="space-y-5">
        <PageHeader description="pi 自身不做工具级审批（其文档明说 does not ask for approval before every tool call），权限要靠扩展注册 tool_call 来实现。">
          权限
        </PageHeader>
        <SettingGroup title="需要先安装权限扩展">
          <div className="px-4 py-5 space-y-3">
            <p className="ui-text text-muted-foreground/80">
              当前环境没有任何扩展拦截工具调用，所以 bash
              /写文件都是直接执行的，不会弹审批。装上官方生态里用得最多的
              <code className="font-mono text-foreground/80 mx-1">
                @gotgenes/pi-permission-system
              </code>
              后，这里编辑的规则就是它真正执行的策略。
            </p>
            <Button
              size="sm"
              className="h-7 gap-1.5"
              disabled={saving}
              onClick={installExtension}
            >
              {saving ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Download className="size-3" />
              )}
              安装扩展
            </Button>
            {errorText && (
              <p className="ui-text-sm2 text-destructive">{errorText}</p>
            )}
          </div>
        </SettingGroup>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        description={
          <>
            规则由 <code className="font-mono">pi-permission-system</code>{" "}
            执行。命中即生效，<b>不需要</b>额外的确认弹窗。
          </>
        }
      >
        权限
      </PageHeader>

      <SettingGroup title="开关">
        <div className="px-4 py-3 space-y-3">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={yoloMode}
              onChange={(e) => {
                setYoloMode(e.target.checked);
                setDirty(true);
                setStatus(null);
              }}
              className="mt-0.5 accent-primary"
            />
            <span className="min-w-0">
              <span className="ui-text flex items-center gap-1.5">
                <Zap className="size-3.5 text-amber-500" />
                全部放行（YOLO）
              </span>
              <span className="ui-text-sm2 text-muted-foreground/70 block mt-0.5">
                关掉所有门禁，任何工具调用都直接执行。仅在容器 / 一次性环境里用。
              </span>
            </span>
          </label>
          {configPath && (
            <p className="ui-text-sm2 text-muted-foreground/50 font-mono break-all">
              {configPath}
            </p>
          )}
        </div>
      </SettingGroup>

      {surfaces.length === 0 ? (
        <SettingGroup title="规则">
          <div className="px-4 py-10 text-center">
            <p className="ui-text text-muted-foreground">还没有规则</p>
            <p className="ui-text-sm2 text-muted-foreground/60 mt-1">
              未列出的操作走扩展默认（每次询问）
            </p>
            <div className="flex justify-center gap-2 mt-4">
              <Button size="sm" variant="outline" className="h-7" onClick={save}>
                写入 Helix 默认策略
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={() => void load()}
              >
                <RotateCcw className="size-3" />
                重新读取
              </Button>
            </div>
          </div>
        </SettingGroup>
      ) : (
        <SettingGroup
          title={
            <span className="flex items-center gap-2">
              <ShieldCheck className="size-3.5 text-muted-foreground" />
              规则
              <span className="text-muted-foreground/50 font-normal">
                {counts.allow} 放行 · {counts.ask} 询问 · {counts.deny} 拒绝
              </span>
            </span>
          }
          action={
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1"
              onClick={addSurface}
            >
              <Plus className="size-3" />
              添加规则面
            </Button>
          }
        >
          {surfaces.map((s) => {
            const open = openKey === s.key || (s.key === "" && openKey === "");
            return (
              <div key={s.key || "__new__"} className="border-b border-border/25 last:border-b-0">
                <div className="flex items-center gap-2 px-4 py-2 hover:bg-muted/40 transition-colors">
                  <button
                    onClick={() => setOpenKey(open ? null : s.key)}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                  >
                    <span className="text-muted-foreground/50 text-[calc(var(--helix-transcript-size)*0.7143)] tabular-nums shrink-0">
                      {String(surfaces.indexOf(s) + 1).padStart(2, "0")}
                    </span>
                    <span className="ui-text-sm2 font-mono text-foreground/85 truncate">
                      {s.key || "（未命名）"}
                    </span>
                    <span className="ui-text-sm2 text-muted-foreground/60 truncate shrink-0">
                      {s.hint || s.label}
                    </span>
                  </button>
                  <span className="ui-text-sm2 text-muted-foreground/40 shrink-0 tabular-nums">
                    {s.rules.length} 条
                  </span>
                  <button
                    onClick={() => removeSurface(s.key)}
                    className="shrink-0 p-1 rounded text-muted-foreground/35 hover:text-destructive hover:bg-destructive/10 transition-colors"
                    data-tip="删除这个规则面"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                {open && (
                  <div className="px-4 pb-3 space-y-1.5">
                    {s.key === "" && (
                      <input
                        defaultValue=""
                        onChange={(e) =>
                          mutate((prev) =>
                            prev.map((x) =>
                              x === s ? { ...x, key: e.target.value } : x,
                            ),
                          )
                        }
                        placeholder="规则面名称（工具名，如 bash / read / path）"
                        className="w-full px-2.5 py-1.5 ui-text-sm2 font-mono bg-muted/50 border border-border/50 rounded-lg outline-none focus:border-border/80"
                      />
                    )}
                    {s.rules.map((r, i) => {
                      const st = readState(r.value);
                      return (
                        <div key={`${r.pattern}-${i}`} className="flex items-center gap-1.5">
                          <div className="flex flex-col shrink-0">
                            <button
                              onClick={() => moveRule(s.key, i, -1)}
                              disabled={i === 0}
                              className="text-muted-foreground/40 hover:text-foreground disabled:opacity-20 leading-none text-[9px]"
                              data-tip="上移（提高优先级）"
                            >
                              ▲
                            </button>
                            <button
                              onClick={() => moveRule(s.key, i, 1)}
                              disabled={i === s.rules.length - 1}
                              className="text-muted-foreground/40 hover:text-foreground disabled:opacity-20 leading-none text-[9px]"
                              data-tip="下移（降低优先级）"
                            >
                              ▼
                            </button>
                          </div>
                          <input
                            value={r.pattern}
                            onChange={(e) =>
                              mutate((prev) =>
                                prev.map((x) =>
                                  x.key !== s.key
                                    ? x
                                    : {
                                        ...x,
                                        rules: x.rules.map((y, j) =>
                                          j === i
                                            ? { ...y, pattern: e.target.value }
                                            : y,
                                        ),
                                      },
                                ),
                              )
                            }
                            placeholder="匹配模式（* 通配，? 单字符）"
                            spellCheck={false}
                            className="flex-1 min-w-0 px-2.5 py-1.5 ui-text-sm2 font-mono bg-muted/50 border border-border/50 rounded-lg outline-none focus:border-border/80"
                          />
                          <button
                            onClick={() => {
                              const order = STATES;
                              const next =
                                order[(order.indexOf(st) + 1) % order.length];
                              setRule(s.key, r.pattern, writeState(r.value, next));
                            }}
                            title={STATE_META[st].hint}
                            className={cn(
                              "shrink-0 px-2 py-1 rounded text-[calc(var(--helix-transcript-size)*0.7857)] transition-opacity hover:opacity-80",
                              STATE_META[st].cls,
                            )}
                          >
                            {STATE_META[st].label}
                          </button>
                          <button
                            onClick={() => removeRule(s.key, r.pattern)}
                            className="shrink-0 p-1 rounded text-muted-foreground/35 hover:text-destructive hover:bg-destructive/10 transition-colors"
                            data-tip="删除这条"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </div>
                      );
                    })}
                    <div className="flex items-center gap-2 pt-0.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[calc(var(--helix-transcript-size)*0.7857)]"
                        onClick={() => addRule(s.key)}
                      >
                        <Plus className="size-3" />
                        加一条
                      </Button>
                      {readReason(s.rules[0]?.value) && (
                        <span className="ui-text-sm2 text-muted-foreground/50 truncate">
                          自定义理由：{readReason(s.rules[0]?.value)}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </SettingGroup>
      )}

      <SettingGroup title="快速添加">
        <div className="px-4 py-2 grid grid-cols-1 gap-0.5">
          {SUGGESTIONS.map((sg) => (
            <button
              key={`${sg.surface}:${sg.pattern}`}
              disabled={dirty && !surfaces.some((s) => s.key === sg.surface)}
              onClick={() =>
                mutate((prev) => {
                  const exists = prev.find((s) => s.key === sg.surface);
                  if (!exists) {
                    return [
                      ...prev,
                      {
                        key: sg.surface,
                        label: SURFACE_LABELS[sg.surface]?.label ?? sg.surface,
                        hint: SURFACE_LABELS[sg.surface]?.hint,
                        rules: [
                          { pattern: "*", value: "ask" as State },
                          { pattern: sg.pattern, value: sg.state },
                        ],
                      },
                    ];
                  }
                  return prev.map((s) =>
                    s.key === sg.surface
                      ? {
                          ...s,
                          rules: [
                            ...s.rules,
                            { pattern: sg.pattern, value: sg.state },
                          ],
                        }
                      : s,
                  );
                })
              }
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-muted/50 transition-colors text-left cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <code className="font-mono text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/75 shrink-0">
                {sg.surface}
                <span className="text-muted-foreground/40"> · </span>
                {sg.pattern}
              </code>
              <span
                className={cn(
                  "shrink-0 px-1.5 py-px rounded text-[calc(var(--helix-transcript-size)*0.7143)]",
                  STATE_META[sg.state].cls,
                )}
              >
                {STATE_META[sg.state].label}
              </span>
              <Plus className="size-3 text-muted-foreground/40 shrink-0 ml-auto" />
            </button>
          ))}
        </div>
      </SettingGroup>

      <div className="flex items-start gap-1.5 px-1 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/60">
        <Info className="size-3 mt-0.5 shrink-0" />
        <span>
          规则<strong className="text-foreground/70">从上到下、后者覆盖前者</strong>
          ，所以宽规则放上面、具体规则放下面；「拒绝」必须排在会命中它的宽规则之后，否则会被盖掉。
          路径规则会同时按原样和符号链接解析后的形态匹配，所以换个软链名字也绕不过去。
        </span>
      </div>

      {errorText && (
        <div className="flex items-start gap-1.5 px-1 text-[calc(var(--helix-transcript-size)*0.7857)] text-destructive">
          <AlertTriangle className="size-3 mt-0.5 shrink-0" />
          <span className="break-all">{errorText}</span>
        </div>
      )}

      <SaveBar
        saving={saving}
        status={status}
        errorText={errorText}
        onSave={save}
        onReset={() => void load()}
        resetLabel="放弃改动"
        disabled={!loaded}
      />
      {status === "ok" && !dirty && (
        <p className="flex items-center gap-1.5 px-1 text-[calc(var(--helix-transcript-size)*0.7857)] text-emerald-600 dark:text-emerald-400">
          <Check className="size-3" />
          已写入。规则由扩展在下次工具调用时读取，无需重启。
        </p>
      )}
    </div>
  );
}
