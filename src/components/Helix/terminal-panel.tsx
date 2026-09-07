"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { Plus, Terminal, X } from "lucide-react";
import React, { useState, useRef, useEffect, useCallback } from "react";
import { isElectron, electronTerminal } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";
import "@xterm/xterm/css/xterm.css";

interface TerminalPanelProps {
  onClose: () => void;
}

/** Windows `std::fs::canonicalize` returns verbatim `\\?\`-prefixed paths; strip
 *  the namespace prefix so the terminal prompt / cd commands stay clean. */
function stripVerbatimPrefix(
  p: string | null | undefined,
): string | null | undefined {
  if (typeof p !== "string") return p;
  if (p.startsWith("\\\\?\\UNC\\")) return "\\\\" + p.slice(8);
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

// Light theme matching the app chrome (white bg / dark text, standard ANSI).
const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#333333",
  cursor: "#333333",
  cursorAccent: "#ffffff",
  selectionBackground: "#cfe3ff",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#8a8a8a",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#9a9a9a",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

// Transparent theme — blends with the app background
const TRANSPARENT_THEME = {
  background: "rgba(255,255,255,0.7)",
  foreground: "#333333",
  cursor: "#333333",
  cursorAccent: "rgba(255,255,255,0.7)",
  selectionBackground: "rgba(147,197,253,0.4)",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#8a8a8a",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#9a9a9a",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

interface TerminalTabViewProps {
  id: number;
  isActive: boolean;
}

/**
 * One terminal tab. Kept mounted permanently (like the old single-terminal
 * panel) so each tab keeps its full scrollback and live shell across
 * conversation switches and tab switches. The PTY is only spawned once the tab
 * first becomes visible, and is killed when the tab is closed.
 */
function TerminalTabView({ id, isActive }: TerminalTabViewProps) {
  const { selectedWorkDir, isTerminalOpen } = useHelixStore();
  const [electronReady, setElectronReady] = useState(false);
  const [terminalError, setTerminalError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const bufferRef = useRef("");
  const lastCwdRef = useRef<string | null>(null);
  const startedRef = useRef(false);

  // Create the xterm instance exactly once. The PTY itself is started lazily
  // when the tab first becomes active (hidden tabs have a 0-size container).
  useEffect(() => {
    if (!isElectron()) {
      setElectronReady(false);
      return;
    }
    setElectronReady(true);

    const term = new XTerm({
      fontFamily:
        'Consolas, "Cascadia Code", "Microsoft YaHei Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: TRANSPARENT_THEME,
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current!);
    termRef.current = term;
    fitRef.current = fitAddon;

    const fitAndResize = () => {
      if (!isActive) return;
      try {
        fitAddon.fit();
        electronTerminal.resize(id, term.cols, term.rows);
      } catch {
        /* element not laid out yet */
      }
    };

    // Restore previous session output if we switched away and came back.
    if (bufferRef.current) {
      try {
        term.write(bufferRef.current);
      } catch {
        /* ignore */
      }
    }

    // ── Paste de-dup gate ────────────────────────────────────────────────
    // Electron fires paste through SEVERAL channels at once for a single Ctrl+V:
    //   1) xterm's own textarea paste listener (→ term.onData),
    //   2) the native `paste` ClipboardEvent on the container,
    //   3) Electron's insertText injection (also → term.onData),
    //   4) our Ctrl+V handler reading the clipboard.
    // All of (1)(3) funnel through term.onData, which writes RAW keystrokes too —
    // so we can't just gate onData. Instead: gate EVERY multi-char write that
    // reaches the PTY within a short window. A real keystroke is 1-2 chars; a
    // paste is a burst of the SAME text from multiple channels near-simultaneously.
    // We collapse identical bursts within 250ms into ONE PTY write.
    let lastPasteText = "";
    let lastPasteAt = 0;
    const PASTE_DEDUP_MS = 250;
    const writePty = (d: string) => {
      electronTerminal.write(id, d);
    };
    const writePasteOnce = (text: string) => {
      if (!text) return;
      const now = Date.now();
      if (text === lastPasteText && now - lastPasteAt < PASTE_DEDUP_MS) return;
      lastPasteText = text;
      lastPasteAt = now;
      writePty(text);
    };
    // A multi-char burst arriving via onData that duplicates a just-handled paste
    // (xterm's own paste listener / Electron insertText) is swallowed; genuine
    // typed input (1-2 chars, or different text) passes straight through.
    const isDupPasteBurst = (d: string) => {
      if (d.length < 2) return false;
      const now = Date.now();
      if (d === lastPasteText && now - lastPasteAt < PASTE_DEDUP_MS)
        return true;
      // Record multi-char bursts so a subsequent channel for the SAME burst dedups.
      if (now - lastPasteAt < PASTE_DEDUP_MS) return d === lastPasteText;
      lastPasteText = d;
      lastPasteAt = now;
      return false;
    };

    // Forward raw keystrokes from xterm to the PTY (native line editing).
    // xterm owns keystrokes here; paste is handled separately below so it is
    // never double-fed into the PTY.
    term.onData((d) => {
      if (isDupPasteBurst(d)) return;
      writePty(d);
    });

    // ── Copy / paste ────────────────────────────────────────────────────
    // Copy the current selection to the system clipboard whenever it changes.
    const onSelectionChange = () => {
      const sel = term.getSelection();
      if (sel) {
        try {
          navigator.clipboard.writeText(sel).catch(() => {});
        } catch {
          /* clipboard unavailable */
        }
      }
    };
    term.onSelectionChange(onSelectionChange);

    // Single authoritative paste path. Listen on the DOCUMENT in the capture
    // phase (not just the xterm container) so a native paste that lands when the
    // terminal isn't focused is still intercepted before Electron falls back to
    // insertText injection. Only hijack the event when its target is inside our
    // terminal — otherwise let other inputs/outputs handle their own paste.
    const onPasteCapture = (e: ClipboardEvent) => {
      const container = containerRef.current;
      if (!container || !container.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text") ?? "";
      writePasteOnce(text);
    };
    document.addEventListener("paste", onPasteCapture, true);

    // Ctrl+C: if there is a selection, copy it (don't forward to the shell);
    // otherwise let it through as SIGINT. Ctrl+V: read the clipboard ourselves
    // and paste exactly once; return false so xterm never emits ^V or triggers
    // its own paste (that was the source of the triple-paste).
    term.attachCustomKeyEventHandler((ev) => {
      if (!ev.ctrlKey || ev.altKey || ev.metaKey) return true;
      if (ev.key === "c" && !ev.shiftKey) {
        const sel = term.getSelection();
        if (sel) {
          try {
            navigator.clipboard.writeText(sel);
          } catch {
            /* ignore */
          }
          return false; // consume: copy, do not send SIGINT
        }
        return true; // no selection → let Ctrl+C be SIGINT
      }
      if (ev.key === "v" && !ev.shiftKey) {
        try {
          navigator.clipboard
            .readText()
            .then((text) => writePasteOnce(text))
            .catch(() => {});
        } catch {
          /* ignore */
        }
        return false; // consume: we own paste
      }
      return true;
    });

    // Keep the PTY size in sync with the container while this tab is visible.
    const ro = new ResizeObserver(() => fitAndResize());
    ro.observe(containerRef.current!);
    const raf = requestAnimationFrame(fitAndResize);

    // Only dispose when the tab is closed (component is never unmounted on
    // conversation switch, so the terminal survives session changes).
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      document.removeEventListener("paste", onPasteCapture, true);
      term.dispose();
      termRef.current = null;
      // Stop the backend session for this tab.
      electronTerminal.kill(id).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Start the PTY + fit whenever this tab becomes visible. Hidden tabs have a
  // 0-size container, so the shell is only spawned once the tab shows.
  useEffect(() => {
    if (!isActive || !isTerminalOpen) return;
    const term = termRef.current;
    const fitAddon = fitRef.current;
    if (!term || !fitAddon) return;
    const raf = requestAnimationFrame(() => {
      try {
        fitAddon.fit();
        electronTerminal.resize(id, term.cols, term.rows);
      } catch {
        /* not laid out yet */
      }
      if (startedRef.current) return;
      startedRef.current = true;
      // Start the PTY with the current dimensions + the project path as cwd.
      // Never use a bare drive root as cwd; fall back to the main process workDir.
      const dir = stripVerbatimPrefix(selectedWorkDir);
      const isDriveRoot =
        typeof dir === "string" && /^[a-zA-Z]:[\\/]?$/.test(dir);
      const cwd = dir && !isDriveRoot ? dir : undefined;
      lastCwdRef.current = cwd || null;
      electronTerminal
        .start(id, term.cols, term.rows, cwd)
        .then((res) => {
          if (res?.ok) {
            setTerminalError("");
          } else {
            setTerminalError(res?.error || "Terminal failed to start");
          }
        })
        .catch((e) => setTerminalError(String(e)));
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isActive, isTerminalOpen]);

  // Pipe backend output for THIS tab into its xterm instance.
  useEffect(() => {
    return electronTerminal.onData((payload) => {
      if (payload.id !== id) return;
      const term = termRef.current;
      if (!term) return;
      term.write(payload.data);
      bufferRef.current += payload.data;
    });
  }, [id]);

  // When the project directory changes, tell the running shell to cd there.
  // This keeps the terminal in sync with the conversation/project context.
  useEffect(() => {
    if (!isActive || !isTerminalOpen || !selectedWorkDir) return;
    const dir = stripVerbatimPrefix(selectedWorkDir);
    if (!dir) return;
    const isDriveRoot = /^[a-zA-Z]:[\\/]?$/.test(dir);
    if (isDriveRoot) return;
    if (lastCwdRef.current === dir) return;
    // Escape embedded quotes and issue a cd command. On Windows, `cd` does
    // NOT switch drive letters, so send the bare drive letter first — otherwise
    // the terminal label shows the new project while pwd stays on the old drive.
    const safeDir = dir.replace(/"/g, '\\"');
    const driveMatch = dir.match(/^([a-zA-Z]):[\\/]/);
    if (driveMatch) {
      electronTerminal.write(id, `${driveMatch[1]}:\r\n`);
    }
    electronTerminal.write(id, `cd "${safeDir}"\r\n`);
    lastCwdRef.current = dir;
  }, [id, isActive, isTerminalOpen, selectedWorkDir]);

  return (
    <div className={`flex-1 min-h-0 flex flex-col ${isActive ? "" : "hidden"}`}>
      {/* xterm.js terminal */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden bg-transparent backdrop-blur-sm px-1 py-1"
        onClick={() => termRef.current?.focus()}
      />

      {!electronReady && (
        <div className="px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-[#999]">
          Terminal not available in browser mode
        </div>
      )}
      {terminalError && (
        <div className="px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-red-500">
          {terminalError}
        </div>
      )}
    </div>
  );
}

export function TerminalPanel({ onClose }: TerminalPanelProps) {
  const { selectedWorkDir, isTerminalOpen } = useHelixStore();
  const [tabs, setTabs] = useState<{ id: number }[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const nextIdRef = useRef(1);

  // Ensure at least one tab exists whenever the panel is open.
  useEffect(() => {
    if (isTerminalOpen && tabs.length === 0) {
      const id = nextIdRef.current++;
      setTabs([{ id }]);
      setActiveId(id);
    }
  }, [isTerminalOpen, tabs.length]);

  const addTab = useCallback(() => {
    const id = nextIdRef.current++;
    setTabs((prev) => [...prev, { id }]);
    setActiveId(id);
  }, []);

  const closeTab = useCallback(
    (id: number) => {
      setTabs((prev) => prev.filter((t) => t.id !== id));
      setActiveId((prev) => {
        if (prev !== id) return prev;
        const remaining = tabs.filter((t) => t.id !== id);
        if (remaining.length) return remaining[remaining.length - 1].id;
        return null;
      });
    },
    [tabs],
  );

  const handleCloseAll = useCallback(() => {
    // Unmounting every tab runs its cleanup, killing the backend sessions.
    setTabs([]);
    setActiveId(null);
    onClose();
  }, [onClose]);

  const projectName = selectedWorkDir
    ? selectedWorkDir.split(/[\\/]/).pop() || "终端"
    : "终端";

  return (
    <div
      className={`shrink-0 h-64 flex flex-col bg-card border-t border-border/40 rounded-t-lg overflow-hidden ${isTerminalOpen ? "" : "hidden"}`}
    >
      {/* Tab bar — Windows Terminal style */}
      <div className="flex items-center h-8 bg-black/5 backdrop-blur-sm shrink-0 select-none">
        <div className="flex items-center gap-1 px-1 h-full min-w-0 overflow-x-auto scrollbar-hide">
          {tabs.map((tab, i) => {
            const isActive = tab.id === activeId;
            const label =
              tabs.length > 1 ? `${projectName} ${i + 1}` : projectName;
            return (
              <div
                key={tab.id}
                onClick={() => setActiveId(tab.id)}
                className={`flex items-center gap-2 h-full px-3 border-t-2 cursor-pointer whitespace-nowrap transition-colors ${isActive ? "bg-white/60 border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:bg-white/30"}`}
              >
                <Terminal className="size-3.5" />
                <span className="max-w-[140px] truncate text-[calc(var(--helix-transcript-size)*0.8571)]">
                  {label}
                </span>
                {tabs.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className="p-0.5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-black/10 transition-colors"
                    data-tip="关闭终端"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex-1" />
        <button
          onClick={addTab}
          className="px-2.5 h-full flex items-center text-muted-foreground hover:text-foreground hover:bg-black/5 transition-colors"
          data-tip="新建终端"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          onClick={handleCloseAll}
          className="px-2.5 h-full flex items-center text-muted-foreground hover:text-foreground hover:bg-black/5 transition-colors"
          data-tip="关闭并清空终端"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* Terminal area — only the active tab is visible */}
      <div className="flex-1 min-h-0 flex">
        {tabs.map((tab) => (
          <TerminalTabView
            key={tab.id}
            id={tab.id}
            isActive={tab.id === activeId}
          />
        ))}
      </div>
    </div>
  );
}
