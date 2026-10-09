"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, PopupSelect, SettingGroup } from "./settings-ui";
import { Button } from "@/components/ui/button";
import { getElectronAPI } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";
import type { PermissionRule } from "@/types/electron";

/**
 * 权限规则编辑（settings.json → `permission.userRules`）。
 *
 * # 这一页只编辑「用户规则」
 *
 * 真正做判定的是 pi-permission 扩展：层 1 AST → 层 2 规则 → 层 3 AI/人工。
 * Helix 不实现任何匹配语义 —— 前端只负责把形状写对，判定语义由扩展说了算。
 * 内置危险规则（12 条）在下面只读展示，Helix 从不写它们。
 *
 * # 为什么必须把「生不生效」写在最上面
 *
 * 规则层只在 `auto` + `enabled=true` 时参与判定（`pipeline.ts::checkPermission`）：
 * `yolo` 直接放行、`strict` 全部人工审批，两档都不跑规则 —— 严格档下连 deny 规则
 * 也只是变成「弹窗问一下」。这个坑跟档位下拉一样隐蔽，所以打开页面第一眼就得看见。
 *
 * # 顺序即优先级
 *
 * last-match-wins：`[...内置危险规则, ...用户规则]` 从头到尾遍历，**最后**命中的
 * 那条胜出。所以列表越靠下越优先，行间用 ↑↓ 调顺序，没有「优先级」输入框。
 *
 * # 通配符不是正则
 *
 * 用户规则的 pattern 走 OpenCode wildcard（`*` / `?`，全锚定），内置那份才是正则。
 * 把 `\b` 当成正则抄进来只会匹配到字面量 `\b`，所以这里对明显正则写法给行内警告。
 */

type RuleAction = "allow" | "ask" | "deny";

type Rule = {
  id?: string;
  tool: string;
  pattern: string;
  action: RuleAction;
  source?: string;
  description?: string;
};

const ACTION_OPTIONS: { label: string; value: RuleAction }[] = [
  { label: "放行", value: "allow" },
  { label: "询问", value: "ask" },
  { label: "拒绝", value: "deny" },
];

const TOOL_SUGGESTIONS = ["*", "bash", "read", "write", "edit"];

/** 行内自检：与后端 `normalize_rule` 同一批硬性条件，让用户在按保存前就看见。 */
function rowIssues(row: Rule): string[] {
  const issues: string[] = [];
  if (!row.tool.trim()) issues.push("工具名是空串 ⇒ 这条永不命中");
  if (!row.pattern.trim()) issues.push("匹配模式是空串 ⇒ 这条永不命中");
  // 明显是正则的写法（wildcard 引擎只会当字面量匹配）
  if (/\\[bswdBWD]|\\\[|\(\?|\{\d+,?\d*\}|^\.\*|\|\|?/.test(row.pattern)) {
    issues.push("看着像正则，但这里只认通配符：* 任意串、? 单字符");
  }
  if (row.pattern.trimStart().startsWith("~")) {
    issues.push("路径不做归一化：~ 不会展开成主目录，请写绝对路径");
  }
  return issues;
}

export function PermissionRulesSettings() {
  const showToast = useHelixStore((s) => s.showToast);
  const [rows, setRows] = useState<Rule[]>([]);
  const [meta, setMeta] = useState<{
    ok: boolean;
    reason?: string;
    mode?: string | null;
    extension_mode?: string;
    enabled?: boolean;
    rulesActive?: boolean;
    storedCount?: number;
    unparsable?: { index: number; reason: string }[];
    builtinRules?: PermissionRule[];
    builtinSnapshotVersion?: string;
    installedVersion?: string | null;
    builtinVersionDrift?: boolean;
    configPath?: string;
  } | null>(null);
  const [errors, setErrors] = useState<{ index: number; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const api = getElectronAPI()?.helix;
    if (!api?.getPermissionRules) {
      setLoaded(false);
      return;
    }
    try {
      const r = await api.getPermissionRules();
      setMeta(r);
      if (r?.ok) {
        setRows((r.rules ?? []).map((x) => ({
          id: x.id,
          tool: x.tool,
          pattern: x.pattern,
          action: x.action,
          description: x.description ?? "",
        })));
        setErrors([]);
      }
    } catch (e) {
      console.error("[PermissionRulesSettings] load failed:", e);
      setMeta({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patchRow = (i: number, patch: Partial<Rule>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const move = (i: number, to: number) => {
    if (to < 0 || to >= rows.length) return;
    setRows((prev) => {
      const next = [...prev];
      const [item] = next.splice(i, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const save = async () => {
    const api = getElectronAPI()?.helix;
    if (!api?.setPermissionRules) {
      showToast({ type: "error", title: "仅桌面版可写规则" });
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      const r = await api.setPermissionRules(
        rows.map((row) => ({
          id: row.id,
          tool: row.tool.trim(),
          pattern: row.pattern.trim(),
          action: row.action,
          source: "user",
          ...(row.description?.trim() ? { description: row.description.trim() } : {}),
        })),
      );
      if (!r?.ok) {
        setErrors(r?.errors ?? []);
        showToast({ type: "error", title: r?.error ?? "规则校验未通过" });
        return;
      }
      showToast({ type: "success", title: `权限规则已保存（${r.count ?? 0} 条）` });
      await refresh();
    } catch (e) {
      showToast({ type: "error", title: e instanceof Error ? e.message : "保存失败" });
    } finally {
      setBusy(false);
    }
  };

  const errorByIndex = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of errors) m.set(e.index, e.message);
    return m;
  }, [errors]);

  const apiAvailable = !!getElectronAPI()?.helix?.getPermissionRules;
  const mode = meta?.mode ?? null;
  const rulesActive = meta?.rulesActive ?? false;

  return (
    <div className="flex-1 flex flex-col space-y-6">
      <PageHeader
        description="用户规则写进 pi-permission 扩展的配置文件，与扩展自己的 /permission 面板同一份数据。"
        action={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              重新读取
            </Button>
            <Button size="sm" variant="outline" onClick={save} disabled={busy || !apiAvailable}>
              {busy ? "保存中..." : "保存"}
            </Button>
          </div>
        }
      >
        权限规则
      </PageHeader>

      {!apiAvailable && (
        <div className="rounded-lg border border-border/40 bg-muted/30 px-3 py-2 ui-text text-muted-foreground">
          规则文件只有桌面版能读写（浏览器 / serve 模式没有本地 settings.json）。
        </div>
      )}

      {meta && !meta.ok && loaded && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 ui-text text-destructive">
          读不到规则配置：{meta.reason ?? "未知原因"}
        </div>
      )}

      {/* 生效条件横幅：档位与总开关都在别处 owns，这里只如实播报，不放第二个控件 */}
      <div
        className={`rounded-lg border px-3 py-2 ui-text ${
          rulesActive
            ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700"
            : "border-amber-500/40 bg-amber-500/5 text-amber-700"
        }`}
      >
        {rulesActive ? (
          <>
            当前是「自动审批」档，规则参与判定：先匹配规则，命中 <span className="font-mono">询问</span>{" "}
            或没命中才进 AI / 人工。
          </>
        ) : mode === "full" ? (
          <>
            当前档位是「完全访问」—— 工具全部直接放行，<span className="font-medium">规则根本不参与判定</span>
            。要让规则生效，先把输入栏的审批档位切到「自动审批」。
          </>
        ) : mode === "ask" ? (
          <>
            当前档位是「询问审批」—— 每个工具都人工确认，<span className="font-medium">规则同样不参与判定</span>
            （连「拒绝」规则也只是变成弹窗问一次）。想让规则自动放行/拒绝，请切到「自动审批」。
          </>
        ) : (
          <>
            规则当前不生效（档位读不到，或扩展总开关已关闭）。总开关 <span className="font-mono">enabled=false</span>{" "}
            等价「完全访问」。
          </>
        )}
      </div>

      {meta?.unparsable && meta.unparsable.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 ui-text text-destructive space-y-1">
          <div className="font-medium">
            文件里有 {meta.unparsable.length} 条规则会被扩展直接丢弃（它们不参与任何判定）：
          </div>
          {meta.unparsable.map((u) => (
            <div key={u.index} className="font-mono ui-text-sm2">
              第 {u.index + 1} 条 · {u.reason}
            </div>
          ))}
          <div className="ui-text-sm2">保存下面这份列表会用合法的那几条整体替换，坏条目随之消失。</div>
        </div>
      )}

      <SettingGroup
        title="用户规则"
        description="越靠下的规则越优先（last-match-wins）。内置的 12 条危险规则始终排在它们前面。"
      >
        <div className="p-3 space-y-2">
          {rows.length === 0 && (
            <div className="px-1 py-3 ui-text text-muted-foreground">
              还没有规则。加一条最常见的：放行某个目录的写入，或者拒绝某类命令。
            </div>
          )}
          {rows.map((row, i) => {
            const issues = [...rowIssues(row), ...(errorByIndex.has(i) ? [errorByIndex.get(i)!] : [])];
            return (
              <div
                key={row.id ?? `new-${i}`}
                className="rounded-lg border border-border/40 bg-muted/20 p-2.5 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <span className="shrink-0 ui-text-sm2 text-muted-foreground w-5 text-right">{i + 1}</span>
                  <input
                    value={row.tool}
                    onChange={(e) => patchRow(i, { tool: e.target.value })}
                    placeholder="工具"
                    className="w-28 shrink-0 px-2 py-1.5 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground font-mono placeholder:text-muted-foreground/40"
                  />
                  <input
                    value={row.pattern}
                    onChange={(e) => patchRow(i, { pattern: e.target.value })}
                    placeholder="匹配模式（命令或路径通配符）"
                    className="flex-1 min-w-0 px-2 py-1.5 bg-muted/50 border border-border/50 rounded-lg ui-text text-foreground font-mono placeholder:text-muted-foreground/40"
                  />
                  <div className="w-24 shrink-0">
                    <PopupSelect
                      value={row.action}
                      onChange={(v) => patchRow(i, { action: v as RuleAction })}
                      className="w-full ui-text text-foreground border border-border/50 bg-muted/50 rounded-lg px-2 py-1.5"
                      options={ACTION_OPTIONS}
                    />
                  </div>
                  <div className="shrink-0 flex items-center">
                    <button
                      onClick={() => move(i, i - 1)}
                      disabled={i === 0}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-30"
                      title="上移（降低优先级）"
                    >
                      <ArrowUp className="size-4" />
                    </button>
                    <button
                      onClick={() => move(i, i + 1)}
                      disabled={i === rows.length - 1}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-30"
                      title="下移（提高优先级）"
                    >
                      <ArrowDown className="size-4" />
                    </button>
                    <button
                      onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-muted/60"
                      title="删除这条"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-7">
                  <input
                    value={row.description ?? ""}
                    onChange={(e) => patchRow(i, { description: e.target.value })}
                    placeholder="备注（可选，只影响展示）"
                    className="flex-1 min-w-0 px-2 py-1.5 bg-transparent border border-border/30 rounded-lg ui-text-sm2 text-foreground placeholder:text-muted-foreground/40"
                  />
                  <div className="shrink-0 flex items-center gap-1">
                    {TOOL_SUGGESTIONS.map((t) => (
                      <button
                        key={t}
                        onClick={() => patchRow(i, { tool: t })}
                        className={`px-1.5 py-0.5 rounded-md ui-text-sm2 font-mono border ${
                          row.tool === t
                            ? "border-primary/50 bg-primary/10 text-primary"
                            : "border-border/40 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                {issues.length > 0 && (
                  <div className="pl-7 space-y-0.5">
                    {issues.map((msg) => (
                      <div key={msg} className="ui-text-sm2 text-destructive">
                        {msg}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRows((prev) => [...prev, { tool: "bash", pattern: "", action: "deny" }])}
          >
            <Plus className="size-4 mr-1" />
            新增规则
          </Button>
        </div>
      </SettingGroup>

      <SettingGroup title="写法" description="判定语义由扩展实现，这里只是它认的形状。">
        <div className="p-3 space-y-1.5 ui-text-sm2 text-muted-foreground leading-relaxed">
          <div>
            <span className="font-mono text-foreground">bash</span> 规则匹配的是拆分后的单条命令（
            <span className="font-mono">git push origin main</span>），不是整串脚本；含管道 /{" "}
            <span className="font-mono">&amp;&amp;</span> / 子 shell 这类「结构危险」的命令会跳过规则层，
            直接进 AI 与人工审批。
          </div>
          <div>
            非 bash 工具（<span className="font-mono">read</span> /{" "}
            <span className="font-mono">write</span> / <span className="font-mono">edit</span>）匹配的是文件路径
            <span className="font-medium">原样</span>：<span className="font-mono">~</span> 不展开、相对路径不补全，
            反斜杠会被当成分隔符。写绝对路径最稳。
          </div>
          <div>
            通配符：<span className="font-mono">*</span> 任意长度、<span className="font-mono">?</span> 单字符，
            整条 pattern 全锚定；正则元字符没有特殊含义。
          </div>
          <div>
            想放行某目录：工具 <span className="font-mono">write</span>、模式{" "}
            <span className="font-mono">D:/Project/Helix/docs/*</span>、动作「放行」。
            想禁止推送：工具 <span className="font-mono">bash</span>、模式{" "}
            <span className="font-mono">git push *</span>、动作「拒绝」。
          </div>
        </div>
      </SettingGroup>

      <SettingGroup
        title="内置危险规则（只读）"
        description={
          meta?.builtinVersionDrift
            ? `快照来自 pi-permission ${meta?.builtinSnapshotVersion}，本机装的是 ${meta?.installedVersion ?? "未知"} —— 下面的列表可能已过期，` +
              "以扩展自己的判定为准。"
            : `与本机安装的 pi-permission（${meta?.installedVersion ?? "未知"}）同一版本，仅作展示；Helix 不写这份列表。`
        }
      >
        <div className="p-3 space-y-1">
          {(meta?.builtinRules ?? []).map((r) => (
            <div
              key={r.id}
              className="flex items-baseline gap-2 px-2 py-1 rounded-md hover:bg-muted/40"
              title={r.pattern}
            >
              <span className="shrink-0 ui-text-sm2 font-mono text-muted-foreground w-14">{r.id}</span>
              <span className="shrink-0 ui-text-sm2 text-destructive">拒绝</span>
              <span className="shrink-0 ui-text-sm2 text-muted-foreground">{r.description}</span>
              <span className="min-w-0 flex-1 truncate ui-text-sm2 font-mono text-foreground/70">
                {r.pattern}
              </span>
            </div>
          ))}
          {meta && !meta.builtinRules?.length && (
            <div className="ui-text-sm2 text-muted-foreground">没有读到内置规则快照。</div>
          )}
          <div className="ui-text-sm2 text-muted-foreground pt-1">
            这一份是抄录的快照（版本 {meta?.builtinSnapshotVersion ?? "?"}）。扩展升级后内置规则可能增删，
            <span className="font-mono">pi update --extensions</span> 之后请以扩展文档核对。
          </div>
        </div>
      </SettingGroup>

      <div className="ui-text-sm2 text-muted-foreground break-all">
        写入位置：<span className="font-mono">{meta?.configPath ?? "settings.json"}</span> 的{" "}
        <span className="font-mono">permission.userRules</span>。扩展每次工具调用都重读文件，保存后下一次调用即生效。
      </div>
    </div>
  );
}
