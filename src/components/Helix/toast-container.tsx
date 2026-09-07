"use client";

import { Check, X, AlertTriangle, Info, XCircle } from "lucide-react";
import React, { useEffect, useState } from "react";
import { useHelixStore } from "@/stores/helix-store";

function ToastIcon({ type }: { type: string }) {
  switch (type) {
    case "success":
      return (
        <div className="w-4 h-4 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
          <Check className="size-2.5 text-emerald-400" />
        </div>
      );
    case "error":
      return (
        <div className="w-4 h-4 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
          <XCircle className="size-2.5 text-red-400" />
        </div>
      );
    case "warning":
      return (
        <div className="w-4 h-4 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
          <AlertTriangle className="size-2.5 text-amber-400" />
        </div>
      );
    default:
      return (
        <div className="w-4 h-4 rounded-full bg-blue-500/20 flex items-center justify-center shrink-0">
          <Info className="size-2.5 text-blue-400" />
        </div>
      );
  }
}

export function ToastContainer() {
  const { toasts, dismissToast } = useHelixStore();
  const [exiting, setExiting] = useState<Set<string>>(new Set());

  const handleClose = (id: string) => {
    setExiting((prev) => new Set(prev).add(id));
    setTimeout(() => {
      dismissToast(id);
      setExiting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 200);
  };

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-14 right-4 z-[60] flex flex-col gap-1.5 max-w-xs">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.onClick ? "button" : undefined}
          onClick={() => toast.onClick?.()}
          className={`flex items-center gap-2 bg-card/95 border border-border/60 rounded-xl shadow-lg shadow-black/10 px-3 py-2 backdrop-blur-md transition-all duration-300 ${
            toast.onClick ? "cursor-pointer hover:bg-accent/50" : ""
          } ${
            exiting.has(toast.id)
              ? "opacity-0 -translate-y-2 scale-95"
              : "opacity-100 translate-y-0 scale-100"
          }`}
        >
          <ToastIcon type={toast.type} />
          <div className="flex-1 min-w-0">
            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium">
              {toast.title}
            </p>
            {toast.description && (
              <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground mt-0.5 leading-relaxed">
                {toast.description}
              </p>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleClose(toast.id);
            }}
            className="p-0.5 hover:bg-accent rounded shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
