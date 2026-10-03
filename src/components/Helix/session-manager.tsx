"use client";

import {
  FolderOpen,
  Trash2,
  Download,
  DownloadCloud,
  Upload,
  X,
  Bot,
  Loader2,
  Search,
  AlertTriangle,
  MessageSquare,
} from "lucide-react";
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { timeAgo } from "@/lib/format";
import { persistence, type PersistedSession } from "@/lib/persist";
import { removeConversationIndex } from "@/lib/session-map";
import { useGatewayStore } from "@/stores/gateway-store";
import { useHelixStore } from "@/stores/helix-store";

export function SessionManager({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<PersistedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<PersistedSession | null>(
    null,
  );
  const [exportMenuSession, setExportMenuSession] =
    useState<PersistedSession | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const list = await persistence.loadSessions();
      setSessions(list.sort((a, b) => b.savedAt - a.savedAt));
    } catch (e) {
      console.error("Failed to load sessions:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await persistence.deleteSession(deleteTarget.id);
      // 同步清理磁盘反向索引，避免 conversation-index.json 只增不减
      await removeConversationIndex(deleteTarget.id);
      setDeleteTarget(null);
      await loadSessions();
    } catch (e) {
      console.error("Failed to delete session:", e);
    }
  };

  const handleExportSession = async (
    session: PersistedSession,
    format: "json" | "markdown" = "json",
  ) => {
    try {
      let data: string;
      let ext: string;
      let mime: string;
      if (format === "markdown") {
        data = await persistence.exportSessionAsMarkdown(session);
        ext = "md";
        mime = "text/markdown";
      } else {
        data = await persistence.exportSessionAsJson(session);
        ext = "json";
        mime = "application/json";
      }
      const blob = new Blob([data], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `helix-session-${session.label || session.id}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      useHelixStore
        .getState()
        .showToast({ type: "success", title: "导出成功" });
    } catch (e) {
      console.error("Export failed:", e);
      useHelixStore.getState().showToast({ type: "error", title: "导出失败" });
    }
  };

  const handleExportAll = async () => {
    try {
      const data = JSON.stringify(sessions, null, 2);
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `helix-sessions-all-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      useHelixStore.getState().showToast({
        type: "success",
        title: `已导出 ${sessions.length} 个会话`,
      });
    } catch (e) {
      console.error("Export all failed:", e);
      useHelixStore
        .getState()
        .showToast({ type: "error", title: "批量导出失败" });
    }
  };

  const handleImportSession = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    let imported = 0;
    let failed = 0;
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        if (file.name.endsWith(".md") || file.name.endsWith(".markdown")) {
          const session = await persistence.importSessionFromMarkdown(text);
          if (session) {
            imported++;
          } else {
            failed++;
          }
        } else {
          // JSON: 支持单会话包裹格式、裸单会话，以及「导出全部」裸数组 / {sessions:[...]}
          const data = JSON.parse(text);
          const arr = Array.isArray(data)
            ? data
            : data && Array.isArray((data as any).sessions)
              ? (data as any).sessions
              : null;
          if (arr && arr.length > 0) {
            for (const item of arr) {
              const wrapped =
                typeof item === "string"
                  ? item
                  : JSON.stringify({ type: "helix-session", session: item });
              const s = await persistence.importSessionFromJson(wrapped);
              if (s) {
                imported++;
              } else {
                failed++;
              }
            }
          } else {
            const jsonStr =
              data.type === "helix-session" ? text : JSON.stringify(data);
            const session = await persistence.importSessionFromJson(jsonStr);
            if (session) {
              imported++;
            } else {
              failed++;
            }
          }
        }
      } catch {
        failed++;
      }
    }
    await loadSessions();
    // 通知左侧边栏（sidebar）刷新：sidebar 监听 sessionSaveVersion，import 走 persist 直接写库、不经过 store action，需手动 bump
    useHelixStore.setState((st) => ({
      sessionSaveVersion: (st.sessionSaveVersion || 0) + 1,
    }));
    if (files.length === 1) {
      useHelixStore.getState().showToast({
        type: imported > 0 ? "success" : "error",
        title: imported > 0 ? "会话已导入" : "导入失败",
      });
    } else {
      useHelixStore.getState().showToast({
        type: imported > 0 ? "success" : "error",
        title: `导入完成：${imported} 成功，${failed} 失败`,
      });
    }
    e.target.value = "";
  };

  const handleOpenSession = useCallback(
    async (session: PersistedSession) => {
      try {
        const state = useHelixStore.getState();
        await state.flushSessionPersist();
        state.clearExecutionFlow();
        useGatewayStore.getState().setHelixSessionId(null);
        const all = await persistence.loadSessions();
        const fresh = all.find((s) => s.id === session.id) || session;
        // 丢弃 draft-partial 占位（同 sidebar/navigateSession）：并发下切换/打开
        // 会话不中断后台 run，占位消息不应展示（会与最终提交的完整回复重复）。
        const seen = new Set<string>();
        const msgs = fresh.chatMessages
          .filter((msg) => {
            if (seen.has(msg.id)) return false;
            seen.add(msg.id);
            if (
              typeof msg.id === "string" &&
              msg.id.startsWith("draft-partial-")
            )
              return false;
            return true;
          })
          .map((msg) => ({
            id: msg.id,
            role: msg.role as "user" | "assistant" | "system",
            content: msg.content,
            images: msg.images,
            timestamp: msg.timestamp,
            reasoning: msg.reasoning,
            steps: msg.steps,
            fileChanges: msg.fileChanges,
            blocks: msg.blocks,
          }));
        // 内存合并而非整体覆盖：done 提交 + persistSessionNow 是 fire-and-forget，
        // 磁盘快照可能落后几百 ms——整体替换会让"后台刚完成的回复"三处（内存/
        // draft/磁盘）同时缺席，切回来输出消失。以磁盘为基底，该会话仍在内存的
        // 消息按 id 覆盖（内存是 done 刚提交的新鲜副本）；其他会话的消息原样保留。
        const live = useHelixStore.getState().chatMessages;
        const byId = new Map<string, (typeof msgs)[number]>();
        for (const m of msgs) byId.set(m.id, m);
        for (const m of live) {
          if (!m.sessionId || m.sessionId !== session.id) continue;
          if (typeof m.id === "string" && m.id.startsWith("draft-partial-"))
            continue;
          byId.set(m.id, m as (typeof msgs)[number]);
        }
        const merged = [
          // 其他会话的消息不动（并发 run 的载体）
          ...live.filter((m) => m.sessionId && m.sessionId !== session.id),
          // 本会话：磁盘快照 + 内存覆盖，按时间排序
          ...[...byId.values()],
        ];
        merged.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        useHelixStore.setState({
          chatMessages: merged,
          activeSessionWorkDir: fresh.workDir ?? null,
        });
        // selectedWorkDir 同步到对话所属项目，让 Git 分支选择器等 UI 跟随对话。
        if (fresh.workDir) {
          useHelixStore.getState().setSelectedWorkDir(fresh.workDir);
        }
        useHelixStore.getState().setCurrentSessionId(session.id);
        await useHelixStore.getState().persistToStorage();
        onClose();
      } catch (e) {
        console.error("Failed to open session:", e);
        useHelixStore
          .getState()
          .showToast({ type: "error", title: "加载失败" });
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (sessions.length > 0) {
      const t = setTimeout(() => searchInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [sessions.length]);

  const filteredSessions = sessions.filter((s) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    if (s.label?.toLowerCase().includes(q)) return true;
    const allText = s.chatMessages
      .map((m) => m.content)
      .join(" ")
      .toLowerCase();
    return allText.includes(q);
  });

  // 跨会话消息命中：搜索框下方按会话列出「命中消息」而不是只列出会话。
  // 点击后切到该会话 → 打开会话内搜索（Ctrl+F 同一套 UI）→ 定位并高亮该条。
  const messageHits = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: {
      session: PersistedSession;
      messageId: string;
      role: string;
      snippet: string;
      timestamp: number;
    }[] = [];
    for (const s of sessions) {
      // 会话名命中就整会话展示（没有更细的定位价值）
      if (s.label?.toLowerCase().includes(q)) continue;
      for (const m of s.chatMessages) {
        const text = m.content || "";
        const lower = text.toLowerCase();
        const at = lower.indexOf(q);
        if (at < 0) continue;
        // 以命中处为中心截一段，带前后省略号
        const start = Math.max(0, at - 28);
        const end = Math.min(text.length, at + q.length + 60);
        out.push({
          session: s,
          messageId: m.id,
          role: m.role,
          snippet:
            (start > 0 ? "…" : "") +
            text.slice(start, end).replace(/\s+/g, " ").trim() +
            (end < text.length ? "…" : ""),
          timestamp: m.timestamp || 0,
        });
        if (out.length >= 100) return out; // 上限保护，避免大库卡顿
      }
    }
    return out;
  }, [sessions, searchQuery]);

  // 切会话 → 打开会话内搜索并定位到命中消息。
  // 复用 agent-flow-panel 已有的 `helix:conversation-search` 通道：先派发带
  // query/messageId 的事件，等面板渲染出该消息后再触发滚动定位。
  const handleJumpToMessage = useCallback(
    async (session: PersistedSession, messageId: string, query: string) => {
      await handleOpenSession(session);
      // 等待目标消息挂载（切会话是异步的，DOM 里还没有 data-message-id）
      let waited = 0;
      while (waited < 2000) {
        await new Promise((r) => setTimeout(r, 60));
        waited += 60;
        if (document.querySelector(`[data-message-id="${messageId}"]`)) break;
      }
      window.dispatchEvent(
        new CustomEvent("helix:conversation-search", {
          detail: { query, messageId },
        }),
      );
    },
    [handleOpenSession],
  );

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div className="relative bg-card border border-border/60 rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-4 text-amber-400" />
            <h2 className="text-[length:var(--helix-transcript-size)] font-semibold">
              会话管理
            </h2>
            <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-full">
              {sessions.length} 个会话
            </span>
          </div>
          <div className="flex items-center gap-1">
            {sessions.length > 0 && (
              <button
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/50 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/70 hover:bg-accent/50 cursor-pointer transition-colors h-7"
                onClick={handleExportAll}
              >
                <DownloadCloud className="size-3" />
                全部导出
              </button>
            )}
            <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/50 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/70 hover:bg-accent/50 cursor-pointer transition-colors h-7">
              <Upload className="size-3" />
              导入
              <input
                type="file"
                accept=".json,.md,.markdown"
                multiple
                className="hidden"
                onChange={handleImportSession}
              />
            </label>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Search */}
        {sessions.length > 0 && (
          <div className="px-5 py-2 border-b border-border/50">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索消息内容或会话名..."
                className="w-full pl-8 pr-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] bg-muted/50 border border-border/50 rounded-lg"
              />
            </div>
          </div>
        )}

        {/* 消息命中：跨会话搜正文。放在会话列表之上，一眼看到「哪句话在哪」。 */}
        {messageHits.length > 0 && (
          <div className="border-b border-border/50 max-h-[38vh] overflow-y-auto">
            <div className="px-5 pt-2 pb-1 flex items-center gap-2">
              <MessageSquare className="size-3 text-muted-foreground" />
              <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
                消息命中 {messageHits.length}
                {messageHits.length >= 100 ? "（仅显示前 100 条）" : ""}
              </span>
            </div>
            <div className="p-2 space-y-0.5">
              {messageHits.map((hit) => (
                <button
                  key={`${hit.session.id}:${hit.messageId}`}
                  onClick={() =>
                    handleJumpToMessage(
                      hit.session,
                      hit.messageId,
                      searchQuery.trim(),
                    )
                  }
                  className="w-full text-left px-3 py-2 hover:bg-accent/30 rounded-lg transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span
                      className={`text-[calc(var(--helix-transcript-size)*0.7143)] px-1 py-px rounded shrink-0 ${
                        hit.role === "user"
                          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      {hit.role === "user" ? "我" : "AI"}
                    </span>
                    <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground truncate">
                      {hit.session.label}
                    </span>
                    <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/40 shrink-0 ml-auto">
                      {timeAgo(hit.timestamp)}
                    </span>
                  </div>
                  <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/75 line-clamp-2 group-hover:text-foreground transition-colors">
                    {hit.snippet}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Session list */}
        <ScrollArea className="flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <FolderOpen className="size-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground">
                {searchQuery ? "没有匹配的会话" : "暂无保存的会话"}
              </p>
            </div>
          ) : (
            <div className="p-2">
              {filteredSessions.map((session) => (
                <div
                  key={session.id}
                  onClick={() => handleOpenSession(session)}
                  className="group flex items-center gap-3 px-3 py-2.5 hover:bg-accent/30 rounded-xl transition-colors cursor-pointer"
                >
                  <div className="w-8 h-8 rounded-xl bg-amber-500/10 flex items-center justify-center shrink-0">
                    <Bot className="size-4 text-amber-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium truncate">
                      {session.label}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
                        {timeAgo(session.savedAt)}
                      </span>
                      <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/50">
                        {session.chatMessages.length} 条消息
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground/70 hover:text-foreground transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExportMenuSession(
                        exportMenuSession?.id === session.id ? null : session,
                      );
                    }}
                    data-tip="导出"
                  >
                    <Download className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(session);
                    }}
                    data-tip="删除"
                  >
                    <Trash2 className="size-3 text-destructive/60" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Export format popover */}
      {exportMenuSession && (
        <div
          className="fixed inset-0 z-[10000]"
          onClick={() => setExportMenuSession(null)}
        >
          <div
            className="absolute bg-card border border-border/80 rounded-xl shadow-xl py-1 w-36"
            style={{
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:bg-accent/60 transition-colors"
              onClick={() => {
                handleExportSession(exportMenuSession, "json");
                setExportMenuSession(null);
              }}
            >
              <Download className="size-3.5" />
              导出为 JSON
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:bg-accent/60 transition-colors"
              onClick={() => {
                handleExportSession(exportMenuSession, "markdown");
                setExportMenuSession(null);
              }}
            >
              <Download className="size-3.5" />
              导出为 Markdown
            </button>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDeleteTarget(null)}
          />
          <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-80 mx-4 p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-50 dark:bg-red-950/50 flex items-center justify-center shrink-0">
                <AlertTriangle className="size-5 text-red-500" />
              </div>
              <div>
                <h3 className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
                  删除会话
                </h3>
                <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground mt-0.5">
                  确定要删除「{deleteTarget.label}」吗？此操作不可撤销。
                </p>
              </div>
            </div>
            <div className="flex justify-between gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleConfirmDelete}
                className="gap-1.5"
              >
                <Trash2 className="size-3" />
                删除
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
