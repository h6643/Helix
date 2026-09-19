/**
 * Schedule parsing utilities — extracted from agent-flow-panel.tsx.
 * Detects scheduled task definitions in LLM output and syncs them to the backend.
 *
 * Parsing rules mirror the pi-scheduled-tasks extension
 * (~/.pi/agent/extensions/pi-scheduled-tasks.ts) so a task created from the
 * 计划 panel and one created via the agent's schedule_create tool behave
 * identically. Dispatch itself is owned by the Rust backend
 * (scheduled_tasks.rs poll_due_jobs) — this module only computes the initial
 * nextRunAt / cronExpression for creation.
 */
import { useHelixStore } from "@/stores/helix-store";

// ── Minimal cron engine（与 Rust next_cron_occurrence / pi 扩展同语义）──────
function parseCronField(
  field: string,
  min: number,
  max: number,
): Set<number> | null {
  const out = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) return null;
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      range = part.slice(0, slash);
      step = parseInt(part.slice(slash + 1), 10);
      if (!Number.isFinite(step) || step < 1) return null;
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    } else {
      lo = parseInt(range, 10);
      if (!Number.isFinite(lo)) return null;
      hi = step > 1 ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

function nextCronOccurrence(expr: string, afterMs: number): number | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const doms = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const dows = parseCronField(fields[4], 0, 7);
  if (dows?.has(7)) dows.add(0); // cron 7 = 周日
  if (!minutes || !hours || !doms || !months || !dows) return null;

  const cur = new Date(afterMs);
  cur.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    cur.setMinutes(cur.getMinutes() + 1);
    if (
      minutes.has(cur.getMinutes()) &&
      hours.has(cur.getHours()) &&
      months.has(cur.getMonth() + 1) &&
      doms.has(cur.getDate()) &&
      dows.has(cur.getDay())
    ) {
      return cur.getTime();
    }
  }
  return null;
}

// ── 中文/自然语言时间解析 ─────────────────────────────────────────────────────
const CN_NUM: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function parseCnNum(s: string): number | null {
  if (s === "十") return 10;
  if (s.startsWith("十")) {
    const ones = CN_NUM[s.slice(1)];
    return ones != null ? 10 + ones : null;
  }
  if (s.endsWith("十")) {
    const tens = CN_NUM[s[0]];
    return tens != null ? tens * 10 : null;
  }
  if (s.includes("十")) {
    const [t, o] = s.split("十");
    const tens = CN_NUM[t];
    const ones = CN_NUM[o];
    if (tens == null || ones == null) return null;
    return tens * 10 + ones;
  }
  return CN_NUM[s] ?? null;
}

function extractTime(
  text: string,
): { h: number; m: number; explicit: boolean } | null {
  let m = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (m) return { h: parseInt(m[1], 10), m: parseInt(m[2], 10), explicit: true };
  m = text.match(/(\d{1,2})\s*[点时]\s*(\d{1,2})\s*分/);
  if (m) return { h: parseInt(m[1], 10), m: parseInt(m[2], 10), explicit: true };
  m = text.match(/(\d{1,2})\s*点\s*半/);
  if (m) return { h: parseInt(m[1], 10), m: 30, explicit: true };
  m = text.match(/([一二两三四五六七八九十]+)\s*点/);
  if (m) {
    const h = parseCnNum(m[1]);
    if (h != null) return { h, m: 0, explicit: true };
  }
  m = text.match(/(\d{1,2})\s*[点时]/);
  if (m) return { h: parseInt(m[1], 10), m: 0, explicit: true };
  return null;
}

function applyAmpm(text: string, h: number): number {
  if (/(下午|傍晚|晚上)/.test(text) && h < 12) return h + 12;
  if (/中午/.test(text) && h === 0) return 12;
  return h;
}

const WEEKDAY_CN: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
};
const WEEKDAY_EN: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
};

/**
 * Parse a human schedule description into a next-run timestamp plus the cron
 * expression when the description describes a recurring task (null for one-shot).
 */
function parseScheduleForTask(text: string): {
  nextRun: number | null;
  cronExpression: string | null;
} {
  const lower = text.toLowerCase().trim();
  const now = Date.now();

  // "in 5 minutes" / "5分钟后" / "N小时后" → one-shot
  const inMin = lower.match(/in\s+(\d+)\s*min/) || lower.match(/(\d+)\s*分钟后/);
  if (inMin) return { nextRun: now + parseInt(inMin[1]) * 60000, cronExpression: null };
  const inHr = lower.match(/in\s+(\d+)\s*hour/) || lower.match(/(\d+)\s*小时后/);
  if (inHr) return { nextRun: now + parseInt(inHr[1]) * 3600000, cronExpression: null };

  const t = extractTime(text);
  const hh = t ? Math.min(applyAmpm(text, t.h), 23) : 9;
  const mm = t ? t.m : 0;
  const cron = (expr: string) => ({
    nextRun: nextCronOccurrence(expr, now) ?? now + 86400000,
    cronExpression: expr,
  });

  // "每周一 9点" / "every monday" / "每周日"
  const wdCn = text.match(/周\s*([一二三四五六日天])/);
  const wdEn = lower.match(/every\s+(mon|tues?|wednes?|thurs?|fri|satur?|sun)(?:day)?\b/);
  if (wdCn || wdEn) {
    const dow = wdCn ? WEEKDAY_CN[wdCn[1]] : WEEKDAY_EN[wdEn![1].slice(0, 3)];
    return cron(`${mm} ${hh} * * ${dow}`);
  }
  // "工作日 9点" / "weekdays" → 周一至周五
  if (/工作日/.test(text) || /\bweekdays?\b/.test(lower)) return cron(`${mm} ${hh} * * 1-5`);
  // "每天早上9点" / "every day at 9:00" / "daily"
  if (/每天|每日|天天/.test(text) || /every\s+day|daily/.test(lower)) return cron(`${mm} ${hh} * * *`);
  // "每小时"
  if (lower.includes("every hour") || lower.includes("每小时"))
    return {
      nextRun: nextCronOccurrence("0 * * * *", now) ?? now + 3600000,
      cronExpression: "0 * * * *",
    };
  // "every 30 minutes" / "每30分钟"
  const minRe = lower.match(/every\s+(\d+)\s*min/) || lower.match(/每\s*(\d+)\s*分钟/);
  if (minRe) {
    const n = parseInt(minRe[1]);
    const expr = n <= 1 ? "* * * * *" : `*/${n} * * * *`;
    return {
      nextRun: nextCronOccurrence(expr, now) ?? now + n * 60000,
      cronExpression: expr,
    };
  }
  // "every 2 hours" / "每2小时"
  const hrRe = lower.match(/every\s+(\d+)\s*hour/) || lower.match(/每\s*(\d+)\s*小时/);
  if (hrRe) {
    const n = parseInt(hrRe[1]);
    const expr = `0 */${n} * * *`;
    return {
      nextRun: nextCronOccurrence(expr, now) ?? now + n * 3600000,
      cronExpression: expr,
    };
  }
  // 裸时间（今天下午3点 / 明天上午10:00 / 具体日期）→ 一次性
  if (/[一-鿿]/.test(text) || t)
    return { nextRun: parseChineseSchedule(text), cronExpression: null };
  return { nextRun: now + 86400000, cronExpression: null };
}

/**
 * Parse Chinese natural-language time expressions like
 * "明天（2026年7月13日）上午 10:00", "今天下午3点", "2026年7月13日 22:00".
 * No date → today, rolled to tomorrow once the time has passed.
 */
export function parseChineseSchedule(text: string): number {
  const t = extractTime(text);
  const now = new Date();
  let base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let hour = 9;
  let minute = 0;
  const dateM = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (dateM) {
    base = new Date(
      parseInt(dateM[1]),
      parseInt(dateM[2]) - 1,
      parseInt(dateM[3]),
    );
  } else if (/后天/.test(text)) {
    base.setDate(base.getDate() + 2);
  } else if (/明天/.test(text)) {
    base.setDate(base.getDate() + 1);
  }
  if (t) {
    hour = Math.min(applyAmpm(text, t.h), 23);
    minute = t.m;
  }
  const result = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    hour,
    minute,
  );
  if (!dateM && result.getTime() <= now.getTime()) {
    result.setDate(result.getDate() + 1);
  }
  return result.getTime();
}

/**
 * A scheduled task detected in assistant output but NOT yet created. Creation
 * only happens after the user confirms (via the Scheduled Task confirm dialog).
 */
export interface DetectedTask {
  label: string;
  prompt: string;
  scheduleText: string;
  nextRunAt: number | null;
  cronExpression?: string | null;
  sessionId?: string;
}

/**
 * Fire-and-forget sync of a created scheduled task to Helix backend jobs.json.
 * Pass cronExpression for recurring tasks so the backend stores them as cron
 * jobs (kind=cron) instead of one-shots.
 */
export function syncTaskToBackend(
  label: string,
  prompt: string,
  scheduleText: string,
  nextRunAt: number | null,
  cronExpression?: string | null,
) {
  try {
    const electron = (window as any).electron;
    if (electron?.scheduledTasks?.create) {
      electron.scheduledTasks
        .create({
          name: label,
          prompt,
          scheduleText,
          cronExpression: cronExpression ?? undefined,
          nextRunAt: nextRunAt ?? undefined,
        })
        .catch((e: any) =>
          console.error("sync scheduled task to backend failed:", e),
        );
    }
  } catch (e) {
    console.error("sync scheduled task to backend error:", e);
  }
}

/**
 * Detect ```scheduled-task JSON blocks AND natural-language "已创建定时任务 /
 * 名称： / 时间：" patterns in assistant output, returning the cleaned text
 * (blocks stripped) plus the tasks that were detected.
 *
 * Tasks are NOT auto-created here — the caller shows a confirm dialog and only
 * creates them once the user approves. This avoids silently spamming duplicate
 * tasks on every AI reply (the old behaviour we removed).
 */
export function detectScheduledTasks(text: string): {
  cleaned: string;
  tasks: DetectedTask[];
} {
  const tasks: DetectedTask[] = [];
  let cleaned = text;
  // 1) Structured ```scheduled-task JSON blocks (label/prompt/schedule or aliases)
  const re = /```(\w*)\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const block = m[0];
    const jsonStr = m[2];
    try {
      const data = JSON.parse(jsonStr);
      const label = String(data.label || data.name || data.title || "").trim();
      const prompt = String(
        data.prompt || data.task || data.content || data.message || "",
      ).trim();
      const schedule = String(
        data.schedule || data.when || data.time || "",
      ).trim();
      if (label && prompt && schedule) {
        const parsed = parseScheduleForTask(schedule);
        tasks.push({
          label,
          prompt,
          scheduleText: schedule,
          nextRunAt: parsed.nextRun,
          cronExpression: parsed.cronExpression,
        });
        cleaned = cleaned.replace(block, "");
      }
    } catch {
      // not a JSON block, ignore
    }
  }
  // 2) Natural-language fallback: AI confirmed creation with 名称:/时间: lines.
  const confirmRe =
    /(已成功为你创建|已为你创建|已创建(安排|定时任务|提醒)|已帮你创建|创建成功|已安排)/;
  if (confirmRe.test(text)) {
    const nameMatch = text.match(/名称[：:]\s*([^\n]+)/);
    const timeMatch = text.match(/时间[：:]\s*([^\n]+)/);
    if (nameMatch && timeMatch) {
      const label = nameMatch[1].trim().replace(/\s+/g, " ");
      const timeText = timeMatch[1].trim();
      const parsed = parseScheduleForTask(timeText);
      if (!tasks.some((t) => t.label === label)) {
        tasks.push({
          label,
          prompt: label,
          scheduleText: timeText,
          nextRunAt: parsed.nextRun,
          cronExpression: parsed.cronExpression,
        });
      }
    }
  }
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
  return { cleaned, tasks };
}
