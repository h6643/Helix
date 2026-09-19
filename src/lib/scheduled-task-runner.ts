/**
 * Global scheduled task state refresher — runs independently of any component
 * mount. Re-reads ~/.pi/agent/pi-cron/cron/jobs.json (the shared source of
 * truth written by the pi-scheduled-tasks extension and the Rust backend)
 * every 30 s so the 计划 panel / store stay current even when never opened.
 *
 * NOTE: this runner deliberately does NOT dispatch tasks. Dispatch is owned
 * exclusively by the Rust backend (scheduled_tasks.rs poll_due_jobs, 5 s
 * tick), which advances next_run_at correctly before firing. An earlier
 * version dispatched from here as well, which double-fired every due task
 * (once from this loop, once via the extension's event files → Rust poller).
 */
import { useHelixStore, type ScheduledTask } from "@/stores/helix-store";

let _started = false;

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
    void refreshFromBackend();
  }, 30_000); // Refresh every 30 seconds
}
