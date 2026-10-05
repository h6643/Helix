"use client";

/**
 * RemoteConnectWizard — 远程项目三步连接向导（模态）。
 *
 *   ① 服务器信息  →  ② 连接体检  →  ③ 选择远端目录
 *
 * 第 2 步**只读**（一次 SSH 往返查 node/pi），第 3 步选定目录后才真正调用
 * `remote_connect`（scp bridge + 起 node + 本机隧道 + 写 pi.remote_rpc/remote_cwd
 * + 重启网关）。这样整趟流程网关只重启一次 —— 反过来（先连上再改目录）会连
 * 切两次远程模式，把正在跑的对话打断两回。
 *
 * 挂载：全局单例，挂在 helix-layout。入口只负责 `openRemoteWizard()`，
 * 所以侧边栏和输入框上的按钮唤起的是同一个弹窗。
 */

import {
  Check,
  ChevronRight,
  Folder,
  FolderUp,
  Globe,
  Hash,
  Loader2,
  RefreshCw,
  Server,
  User,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  connectRemoteProject,
  listRemotePaths,
  preflightRemoteProject,
  type RemotePreflightResult,
} from "@/lib/remote-projects";
import { cn } from "@/lib/utils";
import { useHelixStore } from "@/stores/helix-store";

const STEPS = ["服务器", "连接", "目录"] as const;

export function RemoteConnectWizard() {
  const open = useHelixStore((s) => s.remoteWizard.open);
  // 关闭时整棵子树卸载 —— 本地 state（表单/体检/目录栈）随之归零，
  // 下次打开必然是干净的第 1 步，不需要手写 reset。
  return open ? <WizardBody /> : null;
}

function WizardBody() {
  const serviceId = useHelixStore((s) => s.remoteWizard.serviceId);
  const step = useHelixStore((s) => s.remoteWizard.step);
  const setStep = useHelixStore((s) => s.setRemoteWizardStep);
  const close = useHelixStore((s) => s.closeRemoteWizard);
  const bump = useHelixStore((s) => s.bumpRemoteStatusVersion);
  const showToast = useHelixStore((s) => s.showToast);
  const addExternalService = useHelixStore((s) => s.addExternalService);
  const updateExternalService = useHelixStore((s) => s.updateExternalService);
  const services = useHelixStore((s) => s.externalServices);

  const existing = services.find((s) => s.id === serviceId) ?? null;

  // ① 服务器信息
  const [name, setName] = useState(existing?.name ?? "");
  const [host, setHost] = useState(existing?.host ?? "");
  const [port, setPort] = useState(String(existing?.port ?? 22));
  const [user, setUser] = useState(existing?.username ?? "");
  const [formErr, setFormErr] = useState<string | null>(null);
  const [savingServer, setSavingServer] = useState(false);
  // 新增服务器时 addExternalService 会返回 id；后续要把选定的远端目录回写到它身上。
  const [resolvedId, setResolvedId] = useState<string | null>(serviceId);

  // ② 体检
  const [pf, setPf] = useState<RemotePreflightResult | null>(null);
  const [pfBusy, setPfBusy] = useState(false);
  const [pfErr, setPfErr] = useState<string | null>(null);

  // ③ 目录浏览
  const [cwd, setCwd] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [lsBusy, setLsBusy] = useState(false);
  const [lsErr, setLsErr] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connErr, setConnErr] = useState<string | null>(null);

  // 第 2/3 步用的目标三元组。第 1 步提交后 existing 可能仍是 null（新增时
  // store 刚写入、这一帧还没读到），所以兜底回表单值 —— 两者本来就相等。
  // useMemo 是必需的：下面两个 useCallback 把它列进依赖，每次渲染换对象会让
  // 自动体检/自动列目录的 effect 反复被判定为「变了」。
  const target = useMemo(
    () => ({
      host: (existing?.host ?? host).trim(),
      port: Number(existing?.port ?? port) || 22,
      username: (existing?.username ?? user).trim(),
    }),
    [existing?.host, existing?.port, existing?.username, host, port, user],
  );

  const runPreflight = useCallback(async () => {
    setPfBusy(true);
    setPfErr(null);
    try {
      setPf(await preflightRemoteProject(target));
    } catch (e) {
      setPf(null);
      setPfErr((e as Error)?.message ?? String(e));
    } finally {
      setPfBusy(false);
    }
  }, [target]);

  const browse = useCallback(
    async (p: string, hidden = showHidden) => {
      setLsBusy(true);
      setLsErr(null);
      try {
        const r = await listRemotePaths(target, p, hidden);
        setCwd(r.cwd);
        setPathInput(r.cwd);
        setPaths(r.paths);
      } catch (e) {
        setPaths([]);
        setLsErr((e as Error)?.message ?? String(e));
      } finally {
        setLsBusy(false);
      }
    },
    [target, showHidden],
  );

  // 进第 2 步自动体检一次（失败也停在第 2 步，用户能看到原因并重试）。
  useEffect(() => {
    if (step === 2 && !pf && !pfBusy && !pfErr) void runPreflight();
  }, [step, pf, pfBusy, pfErr, runPreflight]);

  // 进第 3 步先列远端 home（体检已经带回来了，省一次 `cd ~`）。
  useEffect(() => {
    if (step === 3 && !cwd) void browse(pf?.home || "~");
  }, [step, cwd, pf?.home, browse]);

  // Esc 关闭（连接中不允许，否则隧道起一半没人收）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !connecting) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, connecting]);

  const submitServer = useCallback(async () => {
    if (!host.trim() || !user.trim()) {
      setFormErr("主机地址和用户名都要填");
      return;
    }
    setSavingServer(true);
    setFormErr(null);
    try {
      const payload = {
        name: name.trim() || `${user.trim()}@${host.trim()}`,
        host: host.trim(),
        port: Number(port) || 22,
        username: user.trim(),
      };
      if (resolvedId) {
        await updateExternalService(resolvedId, payload);
      } else {
        // 同一台机器（host:port + user）复用已有条目。入口现在只剩「添加远程
        // 项目」，重复填同一台是常态，再开一份会在侧边栏长出两个同名服务器。
        const twin = services.find(
          (x) =>
            x.host === payload.host &&
            x.port === payload.port &&
            x.username === payload.username,
        );
        if (twin) {
          await updateExternalService(twin.id, payload);
          setResolvedId(twin.id);
        } else {
          setResolvedId(await addExternalService(payload));
        }
      }
      setStep(2);
    } catch (e) {
      setFormErr(String(e));
    } finally {
      setSavingServer(false);
    }
  }, [addExternalService, host, name, port, resolvedId, services, setStep, updateExternalService, user]);

  const parentOf = (p: string) => {
    const trimmed = p.replace(/\/+$/, "");
    const cut = trimmed.slice(0, trimmed.lastIndexOf("/"));
    return cut || "/";
  };

  const finish = useCallback(async () => {
    if (!cwd) return;
    setConnecting(true);
    setConnErr(null);
    try {
      const { localPort } = await connectRemoteProject(target, cwd);
      if (resolvedId) {
        await updateExternalService(resolvedId, { remotePath: cwd });
      }
      showToast({
        type: "success",
        title: "已连接远程项目",
        description: `${target.username}@${target.host}:${cwd}${
          localPort ? `（隧道 127.0.0.1:${localPort}）` : ""
        } — agent 现在远端跑。`,
      });
      bump();
      close();
    } catch (e) {
      setConnErr((e as Error)?.message ?? String(e));
    } finally {
      setConnecting(false);
    }
  }, [bump, close, cwd, resolvedId, showToast, target, updateExternalService]);

  return (
    <>
      <div
        className="fixed inset-0 bg-black/30 z-[300]"
        onClick={() => !connecting && close()}
      />
      <div className="fixed z-[310] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[560px] max-h-[80vh] bg-card border border-border/50 rounded-xl shadow-2xl flex flex-col overflow-hidden animate-scale-in">
        {/* 头部 + 步骤条 */}
        <div className="shrink-0 px-5 pt-4 pb-3 border-b border-border/40">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-[calc(var(--helix-transcript-size)*1.1429)] font-semibold text-foreground leading-tight">
                连接远程项目
              </h3>
              <p className="mt-0.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
                agent 将在远端执行；本机只保留一条 SSH 隧道。
              </p>
            </div>
            <button
              type="button"
              onClick={() => !connecting && close()}
              className="shrink-0 p-1 rounded text-foreground/40 hover:text-foreground hover:bg-accent/50 transition-colors"
              aria-label="关闭"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2">
            {STEPS.map((label, i) => {
              const n = (i + 1) as 1 | 2 | 3;
              const done = step > n;
              const active = step === n;
              return (
                <React.Fragment key={label}>
                  {i > 0 && <div className="h-px flex-1 bg-border/50" />}
                  <button
                    type="button"
                    disabled={!done}
                    onClick={() => done && setStep(n)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-2 py-0.5 ui-text-sm2 transition-colors",
                      active
                        ? "bg-primary text-primary-foreground"
                        : done
                          ? "bg-primary/10 text-primary hover:bg-primary/20"
                          : "text-muted-foreground/50",
                    )}
                  >
                    {done ? (
                      <Check className="size-3" />
                    ) : (
                      <span className="text-[calc(var(--helix-transcript-size)*0.7857)]">{n}</span>
                    )}
                    {label}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {step === 1 && (
            <>
              <Field label="名称（可选，默认 user@host）">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="我的开发虚拟机"
                  className={inputCls}
                />
              </Field>
              <Field label="主机地址">
                <div className="relative">
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.xx.xx"
                    className={cn(inputCls, "pl-8")}
                  />
                  <Globe className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/35" />
                </div>
              </Field>
              <div className="grid grid-cols-[1fr_96px] gap-2">
                <Field label="用户名">
                  <div className="relative">
                    <input
                      value={user}
                      onChange={(e) => setUser(e.target.value)}
                      placeholder="xxx"
                      className={cn(inputCls, "pl-8")}
                    />
                    <User className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/35" />
                  </div>
                </Field>
                <Field label="端口">
                  <div className="relative">
                    <input
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      placeholder="22"
                      className={cn(inputCls, "pl-7")}
                    />
                    <Hash className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/35" />
                  </div>
                </Field>
              </div>
              <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/60">
                需要已配好 SSH 免密登录（连接全程用 BatchMode，不会弹密码框）。
                下一步只做只读体检，不会改动配置。
              </p>
              {formErr && <ErrorLine text={formErr} />}
            </>
          )}

          {step === 2 && (
            <>
              <div className="ui-text-sm2 text-muted-foreground/70 truncate">
                {target.username}@{target.host}:{target.port}
              </div>
              <CheckRow
                label="SSH 可达"
                busy={pfBusy && !pf}
                ok={!!pf}
                detail={pf?.uname}
                failText={pfErr ?? ""}
              />
              <CheckRow
                label="node"
                busy={pfBusy && !pf}
                ok={!!pf?.node_path}
                detail={pf?.node_path ? `${pf.node_version} — ${pf.node_path}` : ""}
                failText={pf ? "远端没有 node，bridge 起不来" : ""}
              />
              <CheckRow
                label="pi"
                busy={pfBusy && !pf}
                ok={!!(pf?.pi_path || pf?.pi_cli_js)}
                detail={pf?.pi_path || pf?.pi_cli_js || ""}
                failText={pf ? "远端没找到 pi（装好后重新检测）" : ""}
              />
              {pf?.error && <ErrorLine text={pf.error} />}
              {pfErr && !pf && (
                <ErrorLine text={`SSH 连接失败：${pfErr}`} />
              )}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1.5 px-2.5 ui-text-sm2"
                  disabled={pfBusy}
                  onClick={() => void runPreflight()}
                >
                  {pfBusy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  重新检测
                </Button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="flex items-center gap-2">
                <input
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void browse(pathInput.trim());
                  }}
                  placeholder="/home/ruowu"
                  className={cn(inputCls, "flex-1 min-w-0")}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 shrink-0 ui-text-sm2"
                  disabled={lsBusy || !pathInput.trim()}
                  onClick={() => void browse(pathInput.trim())}
                >
                  前往
                </Button>
                <Button
                  size="sm"
                  variant={showHidden ? "default" : "ghost"}
                  className="h-8 shrink-0 ui-text-sm2"
                  onClick={() => {
                    const next = !showHidden;
                    setShowHidden(next);
                    if (cwd) void browse(cwd, next);
                  }}
                >
                  显示隐藏目录
                </Button>
              </div>

              <div className="rounded-lg border border-border/40 bg-background/40">
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border/30 ui-text-sm2 text-muted-foreground/70">
                  <button
                    type="button"
                    disabled={lsBusy || !cwd || cwd === "/"}
                    onClick={() => void browse(parentOf(cwd))}
                    className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent disabled:opacity-35 disabled:hover:bg-transparent transition-colors"
                    title="上一级"
                  >
                    <FolderUp className="size-3.5" />
                    上一级
                  </button>
                  <span className="min-w-0 flex-1 truncate" title={cwd}>
                    {cwd || "…"}
                  </span>
                  {lsBusy && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
                </div>
                <div className="max-h-[240px] overflow-y-auto py-1">
                  {lsErr ? (
                    <p className="px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-destructive/85">
                      {lsErr}
                    </p>
                  ) : !lsBusy && paths.length === 0 ? (
                    <p className="px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/50">
                      没有子目录
                    </p>
                  ) : (
                    paths.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() =>
                          void browse(
                            `${cwd.replace(/\/+$/, "")}/${p}`,
                          )
                        }
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left ui-text-sm2 text-foreground/80 hover:bg-accent transition-colors"
                        title={`${cwd}/${p}`}
                      >
                        <Folder className="size-3.5 shrink-0 text-muted-foreground/50" />
                        <span className="min-w-0 flex-1 truncate">{p}</span>
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/30" />
                      </button>
                    ))
                  )}
                </div>
              </div>
              {connErr && <ErrorLine text={connErr} />}
            </>
          )}
        </div>

        {/* 底部导航 */}
        <div className="shrink-0 px-5 py-3 border-t border-border/40 flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 ui-text-sm2"
            disabled={step === 1 || connecting}
            onClick={() => setStep((step - 1) as 1 | 2)}
          >
            上一步
          </Button>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 ui-text-sm2"
              disabled={connecting}
              onClick={close}
            >
              取消
            </Button>
            {step < 3 ? (
              <Button
                size="sm"
                className="h-7 gap-1.5 ui-text-sm2"
                disabled={
                  savingServer ||
                  (step === 1 && (!host.trim() || !user.trim())) ||
                  (step === 2 && !pf?.ok)
                }
                onClick={() => (step === 1 ? void submitServer() : setStep(3))}
              >
                {savingServer && <Loader2 className="size-3.5 animate-spin" />}
                {step === 1 ? "下一步：连接并检测" : "下一步：选择目录"}
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-7 gap-1.5 ui-text-sm2"
                disabled={!cwd || connecting}
                onClick={() => void finish()}
              >
                {connecting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                {connecting ? "连接中…" : "选择此目录"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

const inputCls =
  "w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 ui-text-sm2 text-foreground outline-none placeholder:text-muted-foreground/40 focus:border-primary/50";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-[calc(var(--helix-transcript-size)*0.7857)] uppercase tracking-wider text-muted-foreground/60">
        {label}
      </span>
      {children}
    </label>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-destructive">
      {text}
    </p>
  );
}

function CheckRow({
  label,
  busy,
  ok,
  detail,
  failText,
}: {
  label: string;
  busy: boolean;
  ok: boolean;
  detail?: string;
  failText?: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/40 bg-background/40 px-2.5 py-2">
      {busy ? (
        <Loader2 className="size-3.5 shrink-0 mt-0.5 animate-spin text-muted-foreground" />
      ) : ok ? (
        <Check className="size-3.5 shrink-0 mt-0.5 text-emerald-500" />
      ) : (
        <X className="size-3.5 shrink-0 mt-0.5 text-destructive/80" />
      )}
      <div className="min-w-0 flex-1">
        <div className="ui-text-sm2 text-foreground/85">{label}</div>
        {ok && detail && (
          <div className="truncate text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/60" title={detail}>
            {detail}
          </div>
        )}
        {!ok && !busy && failText && (
          <div className="text-[calc(var(--helix-transcript-size)*0.7857)] text-destructive/80">
            {failText}
          </div>
        )}
      </div>
    </div>
  );
}
