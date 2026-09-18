"use client";

import {
  Loader2,
  WifiOff,
  RefreshCw,
  Package,
  X,
  CheckCircle2,
} from "lucide-react";
import React, { useEffect, useState } from "react";
import { useGatewayStore } from "@/stores/gateway-store";
import { useHelixStore } from "@/stores/helix-store";

/** Bootstrap stage reported by the Rust backend. */
type BootstrapStage = "preparing" | "done" | null;

const STAGE_LABELS: Record<string, string> = {
  preparing: "正在准备 Helix 运行环境...",
};

/**
 * BootOverlay — full-screen frosted-glass splash shown over the app while the
 * Helix gateway is connecting (or when it fails/disconnects), mirroring the
 * official app's boot surface with clear recovery semantics.
 *
 * Also handles first-run bootstrap progress (extracting the bundled agent runtime).
 *
 * 配色统一走半透明白 rgba(255,255,255,α)，玻璃质感由 .helix-splash-card 的
 * backdrop-filter 提供——它需要后面有真实可模糊的内容（射线/光束/粒子），
 * 所以玻璃面板必须渲染在背景层之后。
 */
export function BootOverlay() {
  const status = useHelixStore((s) => s.gatewayStatus);
  const setGatewayStatus = useHelixStore((s) => s.setGatewayStatus);
  // Single source of truth for connectivity — the SAME field the sidebar
  // connection dot reads (gateway-store.helixConnected). Keying the overlay off
  // this instead of the separate helix-store.gatewayStatus guarantees the dot
  // and the overlay can never disagree, even across dev hot-reloads where the
  // two stores can momentarily desync. gatewayStatus is kept only to pick the
  // message/icon (connecting vs disconnected).
  const helixConnected = useGatewayStore((s) => s.helixConnected);
  const [bootstrapStage, setBootstrapStage] = useState<BootstrapStage>(null);
  const [bootstrapMessage, setBootstrapMessage] = useState("");
  const [isReady, setIsReady] = useState(false);
  const [isFadingOut, setIsFadingOut] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  // Handle fade-out animation when connected.
  // FIX: depend only on `helixConnected`. Previously `isFadingOut` was in the
  // dependency array, so flipping it to true re-ran the effect immediately and
  // the cleanup cleared the 800ms timer — `isReady` never became true and the
  // overlay stayed on screen forever even after the gateway was ready.
  useEffect(() => {
    if (helixConnected && !isFadingOut) {
      setShowSuccess(true);
      setIsFadingOut(true);
      const timer = setTimeout(() => {
        setIsReady(true);
      }, 800); // Fade out duration
      return () => clearTimeout(timer);
    }
  }, [helixConnected]);

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
            const { stage, message } = event.payload.params;
            if (stage === "done") {
              setBootstrapStage("done");
              setBootstrapMessage("");
            } else {
              setBootstrapStage(stage as BootstrapStage);
              setBootstrapMessage(message);
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
    const helix = (window as any).electron?.helix;
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
    >
      {/* ── 背景层：射线 / 光束 / 光晕 / 粒子 / 暗角 ──
          这些是玻璃面板 backdrop-filter 的模糊来源，必须在 card 之前渲染。 */}
      <div className="pointer-events-none absolute inset-0">
        <div className="helix-splash-rays helix-splash-rays-a" />
        <div className="helix-splash-rays helix-splash-rays-b" />
        <div className="helix-splash-beam" />
        <div className="helix-splash-beam helix-splash-beam-2" />
        <div className="helix-splash-veil absolute inset-0" />
        {SPLASH_PARTICLES.map((p, i) => (
          <span key={i} className="helix-splash-particle" style={p} />
        ))}
        <div className="helix-splash-vignette absolute inset-0" />
      </div>

      {/* 四角取景框 */}
      <span className="helix-splash-corner top-5 left-5 border-t border-l" />
      <span className="helix-splash-corner top-5 right-5 border-t border-r" />
      <span className="helix-splash-corner bottom-5 left-5 border-b border-l" />
      <span className="helix-splash-corner bottom-5 right-5 border-b border-r" />

      {/* Close button */}
      <button
        onClick={() => setDismissed(true)}
        className="absolute top-5 right-5 z-20 p-2 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors"
        data-tip="关闭"
      >
        <X className="size-4" />
      </button>

      {/* ── 中央毛玻璃面板 ──
          注意：backdrop-filter 只能模糊到最近的"背景根"（最近的祖先层叠上下文）。
          中间任何带 transform / opacity<1 / z-index 的祖先都会把背景层挡在外面，
          玻璃就只剩半透明白填充、失去模糊质感。所以这里用不带 z-index 的
          absolute inset-0 做居中，保证卡片与背景层之间没有层叠上下文。 */}
      <div className="absolute inset-0 flex flex-col items-center justify-center px-8">
        <div
          className="helix-splash-card helix-splash-rise w-[460px] max-w-full rounded-3xl px-10 py-11"
          style={{ animationDelay: "0.08s" }}
        >
          {/* 面板斜向反光 */}
          <div className="helix-splash-card-shine" />

          <div className="relative flex flex-col items-center text-center">
            {/* 徽标 */}
            <div className="helix-splash-emblem relative size-24 mb-7">
              <div className="helix-splash-mark absolute inset-0 rounded-full" />
              <div className="absolute inset-[5px] rounded-full bg-white/10 border border-white/20" />
              <div className="absolute inset-0 flex items-center justify-center">
                <svg viewBox="0 0 48 48" className="size-12" fill="none">
                  <defs>
                    <linearGradient
                      id="helix-splash-white"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0" stopColor="rgba(255,255,255,1)" />
                      <stop offset="0.5" stopColor="rgba(255,255,255,0.85)" />
                      <stop offset="1" stopColor="rgba(255,255,255,0.55)" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M15 9v30M33 9v30"
                    stroke="url(#helix-splash-white)"
                    strokeWidth="4.5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M15 16c8 0 8 6 16 6M15 26c8 0 8 6 16 6"
                    stroke="url(#helix-splash-white)"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    opacity="0.7"
                  />
                </svg>
              </div>
            </div>

            {/* 透明白字标题 + 流光 */}
            <div className="helix-splash-rise relative mb-4" style={{ animationDelay: "0.24s" }}>
              <h1 className="helix-splash-title text-5xl font-black">
                HELIX
              </h1>
              <h1
                className="helix-splash-sheen text-5xl font-black absolute inset-0 flex items-center justify-center select-none"
              >
                HELIX
              </h1>
            </div>

            {/* 装饰分隔线 */}
            <div
              className="helix-splash-rule h-px w-56 mb-7"
              style={{ animationDelay: "0.4s" }}
            />

            {/* 状态胶囊 + 文案 */}
            <div
              className="helix-splash-rise flex flex-col items-center gap-4"
              style={{ animationDelay: "0.56s" }}
            >
              <div className="helix-splash-chip flex items-center gap-3 rounded-full px-4 py-2">
                {isBootstrapping ? (
                  <Package className="size-4 text-white/90 animate-pulse" />
                ) : isConnecting ? (
                  <Loader2 className="size-4 text-white/90 animate-spin" />
                ) : (
                  <WifiOff className="size-4 text-white/60" />
                )}
                <span className="text-sm font-medium text-white/90">
                  {isBootstrapping
                    ? STAGE_LABELS[bootstrapStage!] ?? bootstrapMessage
                    : isConnecting
                      ? "正在连接 Helix 网关…"
                      : "无法连接到 Helix 网关"}
                </span>
              </div>

              <p className="text-sm text-white/45 leading-relaxed max-w-md">
                {isBootstrapping
                  ? "首次启动需要安装运行环境，请耐心等待。"
                  : isConnecting
                    ? "正在启动 Helix Agent，请稍候。"
                    : "网关未运行或已断开。"}
              </p>
            </div>

            {/* 进度条 */}
            <div
              className="helix-splash-rise mt-7 w-64"
              style={{ animationDelay: "0.7s" }}
            >
              <div className="helix-splash-bar-track h-1.5 rounded-full overflow-hidden">
                {isBootstrapping && bootstrapStage ? (
                  <div
                    className="helix-splash-bar-fill h-full rounded-full transition-all duration-700"
                    style={{ width: bootstrapStage === "preparing" ? "55%" : "100%" }}
                  />
                ) : (
                  <div className="helix-splash-bar-flow h-full w-full rounded-full" />
                )}
              </div>

              {/* Success animation */}
              {showSuccess && (
                <div className="mt-4 flex items-center justify-center gap-1.5 text-sm font-medium text-white/85">
                  <CheckCircle2 className="size-4" />
                  启动成功
                </div>
              )}

              {!isConnecting && (
                <button
                  onClick={retry}
                  className="mt-4 mx-auto inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-white/25 bg-white/10 text-white/90 text-sm font-medium hover:bg-white/20 transition-colors"
                >
                  <RefreshCw className="size-3.5" />
                  重试连接
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 底部标识 */}
      <div className="absolute bottom-7 left-0 right-0 z-10 text-center">
        <span className="text-[11px] tracking-[0.4em] text-white/30 font-medium uppercase">
          Helix Agent Runtime
        </span>
      </div>
    </div>
  );
}

/**
 * 静态粒子配置（模块级，避免每次 render 重新随机导致动画跳动）。
 * 用确定性伪随机，保证 SSR/严格模式下两次 render 结果一致。
 */
const SPLASH_PARTICLES: React.CSSProperties[] = Array.from(
  { length: 28 },
  (_, i) => {
    const rnd = (seed: number) => {
      const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    return {
      left: `${(rnd(1) * 100).toFixed(2)}%`,
      width: `${(2 + rnd(2) * 2.6).toFixed(1)}px`,
      height: `${(2 + rnd(2) * 2.6).toFixed(1)}px`,
      animationDelay: `${(rnd(3) * 9).toFixed(2)}s`,
      animationDuration: `${(7 + rnd(4) * 9).toFixed(1)}s`,
      "--p": (0.35 + rnd(5) * 0.5).toFixed(2),
      "--drift": `${((rnd(6) - 0.5) * 24).toFixed(1)}vw`,
    } as React.CSSProperties;
  },
);
