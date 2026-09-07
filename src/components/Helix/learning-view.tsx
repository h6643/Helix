"use client";

import React, { useState, useEffect, useCallback } from "react";
import { electronFS, electronShell } from "@/lib/electron-bridge";

interface MemNode {
  name: string;
  path: string;
  isDir: boolean;
}

// Read-only view of Helix learning / memory. The gateway's `/api/learning`
// REST endpoint isn't exposed over Helix's stdio gateway, so we read the local
// memory store directly via the fs bridge (read-only).
//
// NOTE: the memory dir is fetched from the MAIN process via electronFS.memoryDir()
// — never derived from process.env.LOCALAPPDATA in the renderer. In a Next.js
// client bundle `process.env.LOCALAPPDATA` is undefined at runtime, which used
// to produce a bogus "/helix/memory" path rejected by the fs sandbox.
export function LearningView({ onClose }: { onClose?: () => void }) {
  const [nodes, setNodes] = useState<MemNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<{
    name: string;
    path: string;
    text: string;
  } | null>(null);
  const [revealErr, setRevealErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setActive(null);
    try {
      const MEMORY_DIR = await electronFS.memoryDir();
      if (!MEMORY_DIR)
        throw new Error("无法获取 Helix 记忆目录（非 Electron 环境？）");
      const list = await electronFS.readDir(MEMORY_DIR);
      setNodes(
        (list as { name: string; isDirectory: boolean }[])
          // Skip editor/process lockfiles and dotfiles — they are not memory
          // content (e.g. MEMORY.md.lock is Helix's concurrent-write lock).
          .filter(
            (n) =>
              // Skip editor/process lockfiles and dotfiles — not memory content.
              !n.name.startsWith(".") &&
              !n.name.endsWith(".lock") &&
              // Skip Helix auto-backups: `MEMORY.md.bak.<ts>`, `USER.md.bak.<ts>`, etc.
              !/\.bak(\.|$)/.test(n.name) &&
              n.name !== "MEMORY.md" &&
              n.name !== "USER.md",
          )
          .map((n) => ({
            name: n.name,
            path: `${MEMORY_DIR}/${n.name}`.replace(/\\/g, "/"),
            isDir: n.isDirectory,
          }))
          .sort(
            (a, b) =>
              Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
          ),
      );
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const open = async (n: MemNode) => {
    if (n.isDir) return;
    setLoading(true);
    try {
      const text = await electronFS.readFile(n.path);
      setActive({
        name: n.name,
        path: n.path,
        text: typeof text === "string" ? text : String(text),
      });
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-1">
      {loading ? (
        <div className="flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60 mt-6">
          读取中…
        </div>
      ) : err ? (
        <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-red-400 mt-6">
          {err}
        </p>
      ) : active ? (
        <div>
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() => setActive(null)}
              className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground hover:text-foreground"
            >
              ← 返回列表
            </button>
            <button
              onClick={async () => {
                setRevealErr(null);
                try {
                  const res = (await electronShell.showItemInFolder(
                    active.path,
                  )) as unknown as { ok?: boolean; error?: string } | undefined;
                  if (res && res.ok === false) {
                    setRevealErr(
                      `无法打开：${res.error || "未知错误"}（多半是主进程未彻底重启）`,
                    );
                  }
                } catch (e: any) {
                  setRevealErr(String(e?.message || e));
                }
              }}
              className="flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground hover:text-foreground"
              data-tip="在资源管理器中打开文件位置"
            >
              打开位置
            </button>
          </div>
          {revealErr && (
            <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-red-400 mb-1">
              {revealErr}
            </p>
          )}
          <h3 className="text-[length:var(--helix-transcript-size)] font-medium mb-1">
            {active.name}
          </h3>
          <pre className="text-[length:var(--helix-transcript-size)] whitespace-pre-wrap break-all max-h-[60vh] overflow-auto bg-muted/40 rounded-lg p-2">
            {active.text.slice(0, 20000)}
          </pre>
        </div>
      ) : (
        <div className="space-y-1">
          {nodes.map((n) => (
            <div
              key={n.path}
              onClick={() => open(n)}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-accent/30 ${n.isDir ? "cursor-default" : "cursor-pointer"}`}
            >
              <span className="text-[calc(var(--helix-transcript-size)*0.8571)] truncate">
                {n.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
