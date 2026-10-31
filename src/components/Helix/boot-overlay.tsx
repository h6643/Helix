"use client";

import { RefreshCw, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useGatewayStore } from "@/stores/gateway-store";
import { useHelixStore } from "@/stores/helix-store";

/** Bootstrap stage reported by the Rust backend. */
type BootstrapStage = "preparing" | "done" | null;

/** 正常交接（网关就绪后）的固定淡出时长。 */
const EXIT_FADE_MS = 900;
/** 用户主动跳过的固定淡出时长——比正常退场快，但不能缩成硬切。 */
const SKIP_FADE_MS = 320;

/**
 * BootOverlay — full-screen frosted-glass splash shown over the app while the
 * Helix gateway is connecting (or when it fails/disconnects).
 *
 * Also handles first-run bootstrap progress (extracting the bundled agent runtime).
 *
 * 视觉取向：**克制**。整屏只有四层——底色、一团呼吸光、一组极慢的射线、
 * 细到几乎看不见的粒子。所有"仪式感"都压在排版上（字距、渐变字、1px 进度线），
 * 而不是叠动效层数：启动页平均只停留 1~2 秒，元素越多越像加载动画而不是界面。
 *
 * 配色：启动页故意脱离应用的浅/深色主题，固定走深色底 + 主题强调色
 * （见 globals.css 里 .helix-splash 对 --foreground 的局部覆盖）——
 * 浅色皮肤下 --foreground 是深棕色，发光效果直接用它会在米白底上糊成脏雾。
 * 玻璃质感由 .helix-splash-card 的 backdrop-filter 提供——它需要后面有真实
 * 可模糊的内容（光晕/射线/粒子），所以面板必须渲染在背景层之后。
 */
export function BootOverlay() {
  const status = useHelixStore((s) => s.gatewayStatus);
  const setGatewayStatus = useHelixStore((s) => s.setGatewayStatus);
  const bootBackgroundImage = useHelixStore((s) => s.bootBackgroundImage);
  // Single source of truth for connectivity — the SAME field the sidebar
  // connection dot reads (gateway-store.helixConnected). Keying the overlay off
  // this instead of the separate helix-store.gatewayStatus guarantees the dot
  // and the overlay can never disagree, even across dev hot-reloads where the
  // two stores can momentarily desync. gatewayStatus is kept only to pick the
  // message/icon (connecting vs disconnected).
  const helixConnected = useGatewayStore((s) => s.helixConnected);
  const [bootstrapStage, setBootstrapStage] = useState<BootstrapStage>(null);
  const [isReady, setIsReady] = useState(false);
  const [isFadingOut, setIsFadingOut] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  // 重入防护标记。用 ref 而不是 isFadingOut state 本身：effect 依赖数组只放
  // helixConnected，闭包里读 state 会拿到过期值；ref 每次 render 都是同一个
  // 对象，随时能读到最新标记，又不会把 effect 重新挂起来。
  const isFadingOutRef = useRef(false);

  // ── 退出时长 ──
  // 退场淡出时长**永远是入口决定的固定值**（正常交接 EXIT_FADE_MS / 跳过
  // SKIP_FADE_MS），绝不许用"当时还剩多少"当时长——那会把某次退场缩到
  // 100ms 级别变成硬切。跳过比正常退场快，是因为用户已经明确说"别等了"。
  const [fadeMs, setFadeMs] = useState(EXIT_FADE_MS);

  const beginExit = useCallback((fade: number) => {
    if (isFadingOutRef.current) return;
    isFadingOutRef.current = true;
    setFadeMs(fade);
    // 网关已就绪才算"启动成功"；用户提前跳过时 UI 底下的连接状态自会说话
    if (useGatewayStore.getState().helixConnected) {
      setShowSuccess(true);
    }
    setIsFadingOut(true);
    // +140ms 余量：淡出 transition 走完再卸载，别掐掉最后几帧渐变
    setTimeout(() => setIsReady(true), fade + 140);
  }, []);

  // Handle fade-out animation when connected.
  // FIX: depend only on `helixConnected`. Previously `isFadingOut` was in the
  // dependency array, so flipping it to true re-ran the effect immediately and
  // the cleanup cleared the 800ms timer — `isReady` never became true and the
  // overlay stayed on screen forever even after the gateway was ready.
  useEffect(() => {
    if (helixConnected && !isFadingOutRef.current) {
      beginExit(EXIT_FADE_MS);
    }
  }, [helixConnected, beginExit]);

  // ── 随时跳过（点击画面 / Esc / 空格 / 回车）──
  // 跳过 = 按固定 SKIP_FADE_MS 淡出并卸载覆盖层，不等网关。UI 早就在底下渲染
  // 好了（侧栏连接点自己会显示断连状态），所以"越过启动页"永远安全。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isFadingOutRef.current) return;
      if (e.key === "Escape" || e.key === " " || e.key === "Enter") {
        e.preventDefault();
        beginExit(SKIP_FADE_MS);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [beginExit]);

  // Listen for bootstrap progress events from the Rust backend.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{
          method: string;
          params: { stage: string; message: string };
        }>("helix:event", (event) => {
          if (event.payload.method === "bootstrap:progress") {
            const { stage } = event.payload.params;
            if (stage === "done") {
              setBootstrapStage("done");
            } else {
              setBootstrapStage(stage as BootstrapStage);
            }
          }
        });
      } catch {
        // Non-Tauri environment (dev server without backend) — silently ignore.
      }
    };
    void setup();
    return () => {
      unlisten?.();
    };
  }, []);

  const [dismissed, setDismissed] = useState(false);

  if (isReady || dismissed) return null;

  const isConnecting = status === "connecting";
  const isBootstrapping =
    bootstrapStage !== null && bootstrapStage !== "done" && isConnecting;

  const retry = () => {
    setGatewayStatus("connecting");
    const helix = window.electron?.helix;
    const probe = async (n = 0) => {
      try {
        const st = await helix?.status?.();
        if (st?.connected) {
          useHelixStore.getState().setGatewayStatus("ready");
          // Also nudge the shared connection flag so the overlay dismisses even
          // when the heartbeat probe is currently throttled.
          useGatewayStore.getState().setHelixConnected(true);
          return;
        }
      } catch {
        // probe failed — keep retrying
      }
      if (n < 20) setTimeout(() => probe(n + 1), 1500);
    };
    probe();
  };

  return (
    <div
      className={`helix-splash fixed inset-0 z-[10000] overflow-hidden ${
        isFadingOut ? "helix-splash-out" : ""
      }`}
      style={{ "--splash-fade": `${fadeMs}ms` } as React.CSSProperties}
      onPointerDown={(e) => {
        // 点击画面任意处跳过。例外：重试/关闭按钮有自己的语义，命中它们
        // （或它们的子孙）就不跳过——两个意图不互相踩。
        if (isFadingOutRef.current) return;
        if (e.button !== 0) return;
        const node = e.target as HTMLElement | null;
        if (node?.closest?.("[data-no-skip]")) return;
        beginExit(SKIP_FADE_MS);
      }}
    >
      {/* ── 背景层：自定义图片 / 呼吸光 / 射线 / 粒子 / 暗角 ──
          这些是玻璃面板 backdrop-filter 的模糊来源，必须在 card 之前渲染。
          如果设置了自定义背景图片，图片作为最底层，光效叠加在上面。 */}
      <div className="pointer-events-none absolute inset-0">
        {bootBackgroundImage && (
          <img
            src={bootBackgroundImage}
            alt=""
            className="helix-splash-bg-image"
          />
        )}
        <div className="helix-splash-veil absolute inset-0" />
        <div className="helix-splash-rays helix-splash-rays-a" />
        {SPLASH_PARTICLES.map((p, i) => (
          <span key={i} className="helix-splash-particle" style={p} />
        ))}
        <div className="helix-splash-vignette absolute inset-0" />
      </div>

      {/* ── 全屏毛玻璃面板（内容居中）──
          注意：backdrop-filter 只能模糊到最近的"背景根"（最近的祖先层叠上下文）。
          中间任何带 transform / opacity<1 / z-index 的祖先都会把背景层挡在外面，
          玻璃就只剩半透明白填充、失去模糊质感。所以这里的包裹层是不带 z-index
          的 absolute inset-0，保证面板与背景层之间没有层叠上下文。 */}
      <div className="absolute inset-0">
        <div className="helix-splash-card helix-splash-card-full flex h-full w-full flex-col items-center justify-center px-8">
          <div className="relative flex flex-col items-center text-center">
            {/* 徽标：细环 + 缓慢自转的强调色弧光，比亮环+光晕更收敛 */}
            <div className="helix-splash-emblem relative mb-9 size-[72px]">
              <div className="helix-splash-mark absolute inset-0 rounded-full" />
              <div className="absolute inset-[7px] flex items-center justify-center rounded-full border border-white/10 bg-white/[0.02]">
                <svg viewBox="0 0 48 48" className="size-10 text-white/90" fill="none">
                  <defs>
                    <linearGradient id="helix-splash-fg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="currentColor" />
                      <stop offset="0.55" stopOpacity="0.8" stopColor="currentColor" />
                      <stop offset="1" stopOpacity="0.5" stopColor="currentColor" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M15 11v26M33 11v26"
                    stroke="url(#helix-splash-fg)"
                    strokeWidth="3.6"
                    strokeLinecap="round"
                  />
                  <path
                    d="M15 17c8 0 8 6 16 6M15 25c8 0 8 6 16 6"
                    stroke="url(#helix-splash-fg)"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    opacity="0.65"
                  />
                </svg>
              </div>
            </div>

            {/* 字标：渐变字 + 极窄高光扫过 */}
            <div className="helix-splash-rise relative" style={{ animationDelay: "0.16s" }}>
              <h1 className="helix-splash-title text-[44px] font-black leading-none">
                HELIX
              </h1>
              <h1 className="helix-splash-sheen text-[44px] font-black leading-none absolute inset-0 flex items-center justify-center select-none">
                HELIX
              </h1>
            </div>

            {/* 副标题：代替原来那条横线分隔——同一份垂直空间里给信息而不是装饰 */}
            <p
              className="helix-splash-rise helix-splash-sub mt-5"
              style={{ animationDelay: "0.32s" }}
            >
              AGENT WORKSPACE
            </p>

            {/* 进度 + 状态：1px 细线，不加圆角，避免"胶囊进度条"的廉价感 */}
            <div
              className="helix-splash-rise mt-12 flex w-[220px] flex-col items-center"
              style={{ animationDelay: "0.5s" }}
            >
              <div className="helix-splash-bar-track h-px w-full overflow-hidden">
                {isBootstrapping && bootstrapStage ? (
                  <div
                    className="helix-splash-bar-fill h-full transition-all duration-700"
                    style={{ width: bootstrapStage === "preparing" ? "55%" : "100%" }}
                  />
                ) : (
                  <div className="helix-splash-bar-flow h-full w-full" />
                )}
              </div>

              {!isConnecting && !showSuccess && (
                <button
                  onClick={retry}
                  data-no-skip
                  className="helix-splash-btn mt-6 mx-auto inline-flex items-center gap-2 px-4 py-1.5 text-xs font-medium transition-colors"
                >
                  <RefreshCw className="size-3" />
                  重试连接
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Close button — 弱化到只在 hover 时显形，避免和启动画面抢注意力 */}
      <button
        onClick={() => setDismissed(true)}
        data-no-skip
        className="helix-splash-close absolute top-5 right-5 z-20 p-2 rounded-lg transition-colors"
        data-tip="关闭"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/**
 * 静态粒子配置（模块级，避免每次 render 重新随机导致动画跳动）。
 * 用确定性伪随机，保证 SSR/严格模式下两次 render 结果一致。
 * 数量压到 12：密度低一点，"上升的光点"才像点缀而不是雪花屏。
 */
const SPLASH_PARTICLES: React.CSSProperties[] = Array.from(
  { length: 12 },
  (_, i) => {
    const rnd = (seed: number) => {
      const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    return {
      left: `${(rnd(1) * 100).toFixed(2)}%`,
      width: `${(1.2 + rnd(2) * 1.4).toFixed(1)}px`,
      height: `${(1.2 + rnd(2) * 1.4).toFixed(1)}px`,
      animationDelay: `${(rnd(3) * 11).toFixed(2)}s`,
      animationDuration: `${(9 + rnd(4) * 10).toFixed(1)}s`,
      "--p": (0.18 + rnd(5) * 0.28).toFixed(2),
      "--drift": `${((rnd(6) - 0.5) * 18).toFixed(1)}vw`,
    } as React.CSSProperties;
  },
);
