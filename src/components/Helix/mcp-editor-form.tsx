"use client";

import React from "react";
import { SaveBar } from "./settings-ui";

export interface McpFormData {
  name: string;
  type: "local" | "remote";
  command: string;
  url: string;
  args: string;
  /** pi 的 description：写进系统提示，告诉模型这个服务器是干什么的 */
  description: string;
  /** pi 的 exposure：codemode / deferred / direct / hidden */
  exposure: "codemode" | "deferred" | "direct" | "hidden";
  /** pi 的 toolExposure，每行「工具名或 glob=exposure」 */
  toolExposureText: string;
  /** pi 的 timeout（秒） */
  timeoutText: string;
}

const EXPOSURE_OPTIONS: { value: McpFormData["exposure"]; label: string; hint: string }[] = [
  { value: "codemode", label: "codemode", hint: "默认。只能通过 codemode 脚本调用" },
  { value: "deferred", label: "deferred", hint: "不进系统提示，搜索后才声明" },
  { value: "direct", label: "direct", hint: "直接声明给模型（小且常用的工具集）" },
  { value: "hidden", label: "hidden", hint: "注册但对模型不可达" },
];

export function McpEditorForm({
  form,
  onChange,
  onSave,
  onCancel,
  saving,
  saveState,
  saveError,
  fullScreen,
}: {
  form: McpFormData;
  onChange: (patch: Partial<McpFormData>) => void;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  saveState?: null | "ok" | "err";
  saveError?: string | null;
  fullScreen?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-border/40 bg-card/60 overflow-hidden flex flex-col ${fullScreen ? "flex-1" : ""}`}
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
            className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/50 font-mono"
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
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/50 font-mono"
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
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/50 font-mono"
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
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/50 font-mono"
            />
          </div>
        )}

        {/* Description */}
        <div>
          <label className="block text-[length:var(--helix-transcript-size)] font-medium text-foreground mb-1.5">
            描述
          </label>
          <textarea
            value={form.description}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="一句话说明这个服务器提供什么（会写进系统提示）"
            rows={2}
            className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/50 resize-y"
          />
        </div>

        {/* Exposure */}
        <div>
          <label className="block text-[length:var(--helix-transcript-size)] font-medium text-foreground mb-1.5">
            工具暴露方式
          </label>
          <div className="flex flex-wrap gap-1.5">
            {EXPOSURE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                title={o.hint}
                onClick={() => onChange({ exposure: o.value })}
                className={`px-2.5 py-1.5 rounded-lg border font-mono text-[length:var(--helix-transcript-size)*0.9] transition-colors ${form.exposure === o.value ? "border-primary bg-primary/10 text-primary" : "border-border/50 text-muted-foreground hover:bg-accent/50"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="mt-1 text-[length:var(--helix-transcript-size)*0.85] text-muted-foreground/60">
            {EXPOSURE_OPTIONS.find((o) => o.value === form.exposure)?.hint}
          </div>
        </div>

        {/* Per-tool exposure overrides */}
        <div>
          <label className="block text-[length:var(--helix-transcript-size)] font-medium text-foreground mb-1.5">
            按工具覆盖
          </label>
          <textarea
            value={form.toolExposureText}
            onChange={(e) => onChange({ toolExposureText: e.target.value })}
            placeholder={"get_*=direct\ndelete_*=hidden"}
            rows={2}
            className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)*0.9] text-foreground placeholder:text-muted-foreground/50 font-mono resize-y"
          />
          <div className="mt-1 text-[length:var(--helix-transcript-size)*0.85] text-muted-foreground/60">
            每行「工具名或 glob=exposure」，例如 get_*=direct
          </div>
        </div>

        {/* Timeout */}
        <div>
          <label className="block text-[length:var(--helix-transcript-size)] font-medium text-foreground mb-1.5">
            超时（秒）
          </label>
          <input
            type="text"
            inputMode="numeric"
            value={form.timeoutText}
            onChange={(e) => onChange({ timeoutText: e.target.value })}
            placeholder="60"
            className="w-32 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground/50 font-mono"
          />
        </div>
      </div>

      <div className="px-4 py-3 border-t border-border/50 bg-muted/10 shrink-0">
        <SaveBar
          saving={saving ?? false}
          status={saveState ?? null}
          errorText={saveError}
          saveLabel="保存"
          onSave={onSave}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}
