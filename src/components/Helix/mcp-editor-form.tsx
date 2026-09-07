"use client";

import React from "react";
import { Button } from "@/components/ui/button";

export interface McpFormData {
  name: string;
  type: "local" | "remote";
  command: string;
  url: string;
  args: string;
}

export function McpEditorForm({
  form,
  onChange,
  onSave,
  onCancel,
  fullScreen,
}: {
  form: McpFormData;
  onChange: (patch: Partial<McpFormData>) => void;
  onSave: () => void;
  onCancel: () => void;
  fullScreen?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border border-border/60 bg-card overflow-hidden flex flex-col ${fullScreen ? "flex-1" : ""}`}
    >
      <div
        className={`p-4 space-y-4 ${fullScreen ? "flex-1 overflow-y-auto" : ""}`}
      >
        {/* Name */}
        <div>
          <label className="block text-[length:var(--helix-transcript-size)] font-medium text-foreground mb-1.5">
            名称
          </label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="MCP server name"
            className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          />
        </div>

        {/* Type */}
        <div>
          <div className="flex gap-2">
            {(
              [
                ["local", "STDIO"],
                ["remote", "流式 HTTP"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => onChange({ type: t, command: "", url: "" })}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-[length:var(--helix-transcript-size)] transition-colors ${form.type === t ? "border-primary bg-primary/10 text-primary" : "border-border/50 text-muted-foreground hover:bg-accent/50"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Command / URL */}
        {form.type === "local" ? (
          <div>
            <label className="block text-[length:var(--helix-transcript-size)] font-medium text-foreground mb-1.5">
              启动命令
            </label>
            <input
              type="text"
              value={form.command}
              onChange={(e) => onChange({ command: e.target.value })}
              placeholder="npx -y @modelcontextprotocol/server-filesystem ./data"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </div>
        ) : (
          <div>
            <label className="block text-[length:var(--helix-transcript-size)] font-medium text-foreground mb-1.5">
              URL
            </label>
            <input
              type="text"
              value={form.url}
              onChange={(e) => onChange({ url: e.target.value })}
              placeholder="http://localhost:3001/sse"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </div>
        )}

        {/* Args */}
        {form.type === "local" && (
          <div>
            <label className="block text-[length:var(--helix-transcript-size)] font-medium text-foreground mb-1.5">
              参数
            </label>
            <input
              type="text"
              value={form.args}
              onChange={(e) => onChange({ args: e.target.value })}
              placeholder="--port 3000 --verbose"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-t border-border/50 bg-muted/10 flex justify-end gap-2 shrink-0">
        <Button onClick={onCancel} size="sm" variant="ghost">
          取消
        </Button>
        <Button onClick={onSave} size="sm" className="gap-1.5">
          保存
        </Button>
      </div>
    </div>
  );
}
