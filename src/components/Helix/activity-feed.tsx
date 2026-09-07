"use client";

import {
  X,
  Activity,
  Play,
  Square,
  MessageSquare,
  Wrench,
  Save,
  GitBranch,
} from "lucide-react";
import React, { useState, useEffect, useRef } from "react";
import { timeAgo } from "@/lib/format";
import { useHelixStore } from "@/stores/helix-store";

type ActivityKind =
  "run-start" | "run-end" | "message" | "tool" | "session" | "git";
interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  text: string;
  at: number;
}

// Module-level ring buffer so multiple mounts share history.
const buffer: ActivityEntry[] = [];
const push = (e: Omit<ActivityEntry, "id" | "at">) => {
  buffer.unshift({
    ...e,
    id: Math.random().toString(36).slice(2),
    at: Date.now(),
  });
  if (buffer.length > 60) buffer.pop();
};

const ICONS: Record<
  ActivityKind,
  React.ComponentType<{ className?: string }>
> = {
  "run-start": Play,
  "run-end": Square,
  message: MessageSquare,
  tool: Wrench,
  session: Save,
  git: GitBranch,
};
const COLORS: Record<ActivityKind, string> = {
  "run-start": "text-emerald-400",
  "run-end": "text-muted-foreground",
  message: "text-primary",
  tool: "text-amber-400",
  session: "text-sky-400",
  git: "text-violet-400",
};

export function ActivityFeed({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<ActivityEntry[]>([]);
  const lastMsgCount = useRef(useHelixStore.getState().chatMessages.length);
  const lastRunning = useRef(useHelixStore.getState().isAgentRunning);
  const lastToolCount = useRef(0);

  useEffect(() => {
    // Seed from buffer.
    setItems([...buffer]);

    const sync = () => {
      const st = useHelixStore.getState();
      const msgs = st.chatMessages.length;
      if (msgs !== lastMsgCount.current) {
        const diff = msgs - lastMsgCount.current;
        if (diff > 0) push({ kind: "message", text: `新增 ${diff} 条消息` });
        lastMsgCount.current = msgs;
      }
      if (st.isAgentRunning !== lastRunning.current) {
        push({
          kind: st.isAgentRunning ? "run-start" : "run-end",
          text: st.isAgentRunning ? "Agent 开始运行" : "Agent 运行结束",
        });
        lastRunning.current = st.isAgentRunning;
      }
      setItems([...buffer]);
    };

    const unsub = useHelixStore.subscribe(sync);
    // Track tool calls via the streaming drafts' step counts.
    const toolTimer = setInterval(() => {
      const st = useHelixStore.getState();
      let toolCount = 0;
      Object.values(st.streamingDrafts).forEach((d) => {
        toolCount += d.steps?.length ?? 0;
      });
      if (toolCount !== lastToolCount.current) {
        if (toolCount > lastToolCount.current)
          push({ kind: "tool", text: `执行了工具调用 (共 ${toolCount})` });
        lastToolCount.current = toolCount;
      }
    }, 1500);

    return () => {
      unsub();
      clearInterval(toolTimer);
    };
  }, []);

  // Expose push for other modules (session save / git).
  useEffect(() => {
    (window as any).__helixActivity = push;
    return () => {
      delete (window as any).__helixActivity;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[9998] flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-sm h-full bg-card border-l border-border/60 shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-primary" />
            <h2 className="text-[length:var(--helix-transcript-size)] font-semibold">
              活动流
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent/60"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {items.length === 0 ? (
            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60 text-center mt-8">
              暂无活动记录
            </p>
          ) : (
            items.map((it) => {
              const Icon = ICONS[it.kind];
              return (
                <div
                  key={it.id}
                  className="flex items-start gap-2.5 px-2 py-1.5 rounded-lg hover:bg-accent/30"
                >
                  <Icon
                    className={`size-3.5 mt-0.5 shrink-0 ${COLORS[it.kind]}`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/90 truncate">
                      {it.text}
                    </p>
                    <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/50">
                      {timeAgo(it.at)}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
