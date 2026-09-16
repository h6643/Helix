/**
 * Global scheduled task runner — runs independently of any component mount.
 * Checks every 30 seconds for due tasks and dispatches them to a DEDICATED
 * Helix session so they never interrupt or pollute the active conversation.
 *
 * Also re-reads ~/.pi/agent/helix/cron/jobs.json (the shared source of truth
 * that the pi-scheduled-tasks extension writes) so tasks created by the agent
 * are picked up and dispatched here even when the 计划 panel isn't open.
 */
import { helixApi } from "@/lib/electron-bridge";
import { parseScheduleForTask } from "@/lib/schedule-utils";
import { useHelixStore, type ScheduledTask } from "@/stores/helix-store";

let _started = false;
// Cached Helix session ID for scheduled tasks (separate from any conversation).
let _taskSessionId: string | null = null;

async function getOrCreateTaskSession(): Promise<string | null> {
  if (_taskSessionId) return _taskSessionId;
  try {
    const res = (await helixApi()!.send("session/new", {
      cwd: useHelixStore.getState().selectedWorkDir || "",
      mcpServers: [],
    })) as any;
    const sid =
      res?._meta?.helix?.sessionProvenance?.acpSessionId ||
      res?.session_id ||
      res?.sessionID ||
      (typeof res === "string" ? res : null);
    if (sid) {
      _taskSessionId = sid;
      return sid;
    }
  } catch (e) {
    console.error("[ScheduledTask] Failed to create task session:", e);
  }
  return null;
}

async function runTask(task: {
  id: string;
  label: string;
  prompt: string;
  scheduleText?: string;
}) {
  const { updateScheduledTask, showToast } = useHelixStore.getState();

  // Create / reuse a DEDICATED Helix session for background tasks — NEVER the
  // active conversation's session.  This prevents the task from polluting the
  // user's current conversation context or interrupting a running agent.
  const taskSid = await getOrCreateTaskSession();
  if (!taskSid) {
    showToast({
      type: "error",
      title: `定时任务 "${task.label}" 失败`,
      description: "无法创建后台会话",
    });
    updateScheduledTask(task.id, { lastRunAt: Date.now() });
    return;
  }

  // Send the prompt to the DEDICATED session — NOT the active conversation.
  // The response events arrive with this session_id, which no active conversation's
  // onEvent handler claims (they filter by their own session_id), so the UI stays
  // untouched.  The task runs silently in the background.
  try {
    await helixApi()!.send("session/prompt", {
      session_id: taskSid,
      prompt: [{ type: "text", text: task.prompt }],
    });
  } catch (e) {
    console.error("[ScheduledTask] Failed to dispatch:", e);
    // Session may have been invalidated (gateway restart) — reset and retry next cycle.
    _taskSessionId = null;
  }

  updateScheduledTask(task.id, { lastRunAt: Date.now() });

  const taskState = useHelixStore.getState().scheduledTasks.find((t) => t.id === task.id);
  const storedNextRunAt = taskState?.nextRunAt ?? null;

  // Trust the backend/extension-advanced nextRunAt when present.
  // Only recompute from scheduleText when the stored value is absent or
  // already in the past (meaning the task fired but the backend didn't
  // advance it — e.g. a frontend-created task that has no cron expr).
  if (storedNextRunAt && storedNextRunAt > Date.now()) {
    // Already advanced by Rust poller / extension — keep it.
  } else {
    const parsed = parseScheduleForTask(task.scheduleText || task.label || "");
    if (parsed.nextRun) {
      updateScheduledTask(task.id, { nextRunAt: parsed.nextRun });
    }
  }

  // NOTE: intentionally NO per-run info toast. It fired every 30s and was pure
  // noise. Failures still surface via the error toast in the session branch above.
}

/**
 * Re-read jobs.json from the Rust backend and merge any NEW backend tasks into
 * the in-memory store. Called each tick so the pi extension's writes show up
 * even when the 计划 panel has never been opened this session.
 *
 * Idempotent: the panel's own load() does the same merge, so opening the
 * panel after this runs is a no-op for already-merged ids.
 */
async function refreshFromBackend() {
  try {
    const electron = (window as any).electron;
    if (!electron?.scheduledTasks?.list) return;
    const res = await electron.scheduledTasks.list();
    if (!res?.ok || !Array.isArray(res.tasks)) return;
    const backendTasks = res.tasks as Array<
      Omit<ScheduledTask, "createdAt" | "updatedAt"> & {
        createdAt?: number;
        updatedAt?: number;
      }
    >;
    const state = useHelixStore.getState();
    const existing = new Set(state.scheduledTasks.map((t) => t.id));
    const now = Date.now();
    const merged: ScheduledTask[] = [...state.scheduledTasks];
    for (const bt of backendTasks) {
      // The Rust reader omits createdAt/updatedAt when absent — fill so the
      // type stays satisfied.
      const task: ScheduledTask = {
        id: bt.id,
        label: bt.label,
        prompt: bt.prompt,
        scheduleText: bt.scheduleText,
        cronExpression: bt.cronExpression,
        enabled: bt.enabled,
        lastRunAt: bt.lastRunAt ?? null,
        nextRunAt: bt.nextRunAt ?? null,
        createdAt: bt.createdAt ?? now,
        updatedAt: bt.updatedAt ?? now,
      };
      if (existing.has(task.id)) {
        const i = merged.findIndex((t) => t.id === task.id);
        if (i >= 0) merged[i] = task;
      } else {
        merged.push(task);
      }
    }
    useHelixStore.setState({ scheduledTasks: merged });
  } catch (e) {
    console.error("[ScheduledTask] refreshFromBackend failed:", e);
  }
}

export function startScheduledTaskRunner() {
  if (_started) return;
  _started = true;

  // Immediate first read so tasks created before this session are visible.
  void refreshFromBackend();

  setInterval(() => {
    void refreshFromBackend().then(() => {
      const state = useHelixStore.getState();
      const now = Date.now();
      for (const task of state.scheduledTasks) {
        if (task.enabled && task.nextRunAt && task.nextRunAt <= now) {
          runTask(task);
        }
      }
    });
  }, 30_000); // Check every 30 seconds
}
