import "@/env-shim";
import { installTauriBridge } from "@/lib/tauri-bridge";
import React from "react";
import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import "@/app/globals.css";
import { ErrorBoundary } from "@/components/Helix/error-boundary";

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
    fallback={
      <div className="h-screen w-screen flex items-center justify-center bg-background">
        <div className="text-[length:var(--helix-transcript-size)] text-muted-foreground">
          Loading Helix...
        </div>
      </div>
    }
  >
    <ErrorBoundary>
      <HelixLayout />
    </ErrorBoundary>
  </Suspense>,
);
