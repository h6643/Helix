import "@/env-shim";
import React from "react";
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import "@/app/reconnect-keyframes.css";
import { ErrorBoundary } from "@/components/Helix/error-boundary";
import { installTauriBridge } from "@/lib/tauri-bridge";

// The old Next.js entry (app/page.tsx) dynamically imported the layout with
// ssr:false. In a static Vite SPA every module is client-only, so React.lazy is
// the equivalent — the heavy layout loads on first paint.
const HelixLayout = lazy(() =>
  import("@/components/Helix/helix-layout").then((m) => ({
    default: m.HelixLayout,
  })),
);

installTauriBridge();

createRoot(document.getElementById("root")!).render(
  <Suspense
    // 主布局 chunk 是 React.lazy 加载的，这段兜底只存在几百毫秒。
    // 不显示 "Loading Helix..." 文字：直接铺与启动动画同色的黑底，避免文字
    // 先闪一下、玻璃面板后出现的割裂感。
    fallback={<div className="fixed inset-0 z-[10000] bg-[#07080b]" />}
  >
    <ErrorBoundary>
      <HelixLayout />
    </ErrorBoundary>
  </Suspense>,
);
