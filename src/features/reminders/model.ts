export type ReminderScheduleType = "weekly" | "once";

export type ReminderConfig = {
  id: string;
  enabled: boolean;
  title: string;
  message: string;
  scheduleType: ReminderScheduleType;
  weekday: number;
  date: string;
  time: string;
  durationMinutes: number;
};

export type ReminderRunStatus = "never" | "triggered" | "caughtUp" | "missed";

export type ReminderSnapshot = {
  config: ReminderConfig;
  nextReminderAt: number | null;
  lastHandledAt: number | null;
  lastStatus: ReminderRunStatus;
};

export type ReminderStateSnapshot = {
  reminders: ReminderSnapshot[];
};

export type ReminderEvent = {
  reminderId: string;
  title: string;
  message: string;
  durationMinutes: number;
  nextReminderAt: number | null;
  triggeredAt: number;
  triggerKind: "triggered" | "caughtUp" | "preview";
};

type ReminderStorage = Pick<Storage, "getItem" | "setItem">;

export const reminderConfigKey = "codex-pet:reminder-config";
export const maxReminderDurationMinutes = 24 * 60;
export const maxReminderMessageCharacters = 1000;
export const reminderOnTimeWindowMs = 60 * 1000;
export const reminderCatchUpWindowMs = 30 * 60 * 1000;
export const reminderWeekdayOptions = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 0, label: "周日" },
] as const;

export const defaultReminderConfig: ReminderConfig = {
  id: "reminder-default",
  enabled: false,
  title: "周报提醒",
  message: "老大，该写周报了。",
  scheduleType: "weekly",
  weekday: 5,
  date: "",
  time: "16:00",
  durationMinutes: 0,
};

let reminderIdSequence = 0;

export function readReminderSnapshots(
  storage: ReminderStorage = window.localStorage,
): ReminderSnapshot[] {
  let stored: string | null = null;
  try {
    stored = storage.getItem(reminderConfigKey);
  } catch {
    return upsertReminderSnapshot([], defaultReminderConfig);
  }
  if (!stored) {
    return upsertReminderSnapshot([], defaultReminderConfig);
  }

  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    const rawSnapshots = Array.isArray(parsed.snapshots)
      ? (parsed.snapshots as Partial<ReminderSnapshot>[])
      : null;
    const snapshots = rawSnapshots
      ? rawSnapshots.map(normalizeReminderSnapshot)
      : (Array.isArray(parsed.reminders)
          ? (parsed.reminders as Partial<ReminderConfig>[])
          : [parsed as Partial<ReminderConfig>]
        ).map((config) => newReminderSnapshot(normalizeReminderConfig(config)));
    return reconcileReminderSnapshots(normalizeReminderSnapshots(snapshots));
  } catch {
    return upsertReminderSnapshot([], defaultReminderConfig);
  }
}

export function saveBrowserReminderSnapshots(
  reminders: ReminderSnapshot[],
  storage: ReminderStorage = window.localStorage,
): string | null {
  try {
    storage.setItem(
      reminderConfigKey,
      JSON.stringify({ schemaVersion: 3, snapshots: normalizeReminderSnapshots(reminders) }),
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function normalizeReminderConfig(config: Partial<ReminderConfig>): ReminderConfig {
  return {
    id: normalizeReminderId(config.id),
    enabled: Boolean(config.enabled),
    title: typeof config.title === "string" ? config.title : defaultReminderConfig.title,
    message: typeof config.message === "string" ? config.message : defaultReminderConfig.message,
    scheduleType: config.scheduleType === "once" ? "once" : "weekly",
    weekday: clampReminderWeekday(Number(config.weekday)),
    date: normalizeReminderDate(typeof config.date === "string" ? config.date : ""),
    time: normalizeReminderTime(
      typeof config.time === "string" ? config.time : defaultReminderConfig.time,
    ),
    durationMinutes: clampReminderDuration(Number(config.durationMinutes)),
  };
}

export function normalizeReminderSnapshots(reminders: ReminderSnapshot[]): ReminderSnapshot[] {
  const ids = new Set<string>();
  const normalized: ReminderSnapshot[] = [];
  for (const reminder of reminders) {
    const config = normalizeReminderConfig(reminder.config);
    if (ids.has(config.id)) {
      continue;
    }
    ids.add(config.id);
    normalized.push({
      config,
      nextReminderAt:
        typeof reminder.nextReminderAt === "number" && Number.isFinite(reminder.nextReminderAt)
          ? reminder.nextReminderAt
          : nextReminderDate(config)?.getTime() ?? null,
      lastHandledAt:
        typeof reminder.lastHandledAt === "number" && Number.isFinite(reminder.lastHandledAt)
          ? reminder.lastHandledAt
          : null,
      lastStatus: normalizeReminderRunStatus(reminder.lastStatus),
    });
  }
  return normalized;
}

export function upsertReminderSnapshot(
  reminders: ReminderSnapshot[],
  nextConfig: ReminderConfig,
): ReminderSnapshot[] {
  const config = normalizeReminderConfig(nextConfig);
  const index = reminders.findIndex((reminder) => reminder.config.id === config.id);
  if (index === -1) {
    return [...reminders, newReminderSnapshot(config, new Date(), true)];
  }
  const existing = reminders[index];
  const scheduleChanged =
    existing.config.enabled !== config.enabled ||
    existing.config.scheduleType !== config.scheduleType ||
    existing.config.weekday !== config.weekday ||
    existing.config.date !== config.date ||
    existing.config.time !== config.time;
  const snapshot: ReminderSnapshot = {
    config,
    nextReminderAt: scheduleChanged
      ? nextReminderDate(config)?.getTime() ?? null
      : existing.nextReminderAt,
    lastHandledAt: scheduleChanged ? Date.now() : existing.lastHandledAt,
    lastStatus: scheduleChanged ? "never" : existing.lastStatus,
  };
  return reminders.map((reminder, reminderIndex) =>
    reminderIndex === index ? snapshot : reminder,
  );
}

export function findNextReminder(reminders: ReminderSnapshot[]) {
  return reminders.reduce<{ config: ReminderConfig; nextReminderAt: number } | null>(
    (earliest, reminder) => {
      const nextReminderAt = reminder.config.enabled
        ? reminder.nextReminderAt ?? nextReminderDate(reminder.config)?.getTime() ?? null
        : null;
      if (nextReminderAt === null) {
        return earliest;
      }
      if (!earliest || nextReminderAt < earliest.nextReminderAt) {
        return { config: reminder.config, nextReminderAt };
      }
      return earliest;
    },
    null,
  );
}

export function createReminderConfig(): ReminderConfig {
  reminderIdSequence += 1;
  return {
    ...defaultReminderConfig,
    id: `reminder-${Date.now()}-${reminderIdSequence}`,
    date: defaultReminderDate(),
  };
}

export function nextReminderDate(config: ReminderConfig, now = new Date()) {
  if (!config.enabled) {
    return null;
  }

  const [hour, minute] = parseReminderTime(config.time);
  if (hour === null || minute === null) {
    return null;
  }

  if (config.scheduleType === "once") {
    const candidate = reminderDateTime(config.date, hour, minute);
    return candidate && candidate.getTime() > now.getTime() ? candidate : null;
  }

  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);

  const daysUntil = (config.weekday - now.getDay() + 7) % 7;
  next.setDate(now.getDate() + daysUntil);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 7);
  }

  return next;
}

export function previousReminderDate(config: ReminderConfig, now = new Date()) {
  if (!config.enabled) {
    return null;
  }

  const [hour, minute] = parseReminderTime(config.time);
  if (hour === null || minute === null) {
    return null;
  }

  if (config.scheduleType === "once") {
    const candidate = reminderDateTime(config.date, hour, minute);
    return candidate && candidate.getTime() <= now.getTime() ? candidate : null;
  }

  const previous = new Date(now);
  previous.setSeconds(0, 0);
  previous.setHours(hour, minute, 0, 0);
  const daysSince = (now.getDay() - config.weekday + 7) % 7;
  previous.setDate(now.getDate() - daysSince);
  if (previous.getTime() > now.getTime()) {
    previous.setDate(previous.getDate() - 7);
  }
  return previous;
}

export function classifyReminderLateness(scheduledAt: number, now = Date.now()): ReminderRunStatus {
  const lateness = Math.max(0, now - scheduledAt);
  if (lateness <= reminderOnTimeWindowMs) {
    return "triggered";
  }
  return lateness <= reminderCatchUpWindowMs ? "caughtUp" : "missed";
}

export function normalizeReminderTime(value: string) {
  const [hour, minute] = parseReminderTime(value);
  if (hour === null || minute === null) {
    return defaultReminderConfig.time;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function normalizeReminderDate(value: string) {
  const parts = parseReminderDate(value);
  return parts ? formatReminderDateParts(parts) : "";
}

export function todayReminderDate(now = new Date()) {
  return formatReminderDateValue(now);
}

export function defaultReminderDate(now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  return formatReminderDateValue(date);
}

export function isReminderScheduleValid(config: ReminderConfig, now = new Date()) {
  return !config.enabled || nextReminderDate(config, now) !== null;
}

export function clampReminderDuration(value: number) {
  if (!Number.isFinite(value)) {
    return defaultReminderConfig.durationMinutes;
  }

  return clamp(Math.round(value), 0, maxReminderDurationMinutes);
}

export function clampReminderWeekday(value: number) {
  const rounded = Math.round(value);
  return reminderWeekdayOptions.some((option) => option.value === rounded)
    ? rounded
    : defaultReminderConfig.weekday;
}

export function formatReminderSchedule(timestamp: number | null, enabled: boolean) {
  if (!enabled) {
    return "未启用";
  }
  if (timestamp === null) {
    return "请完善提醒时间";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "请完善提醒时间";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatReminderRule(config: ReminderConfig) {
  if (config.scheduleType === "weekly") {
    const weekday = reminderWeekdayOptions.find((option) => option.value === config.weekday);
    return `每${weekday?.label ?? "周五"} ${config.time}`;
  }

  const parts = parseReminderDate(config.date);
  if (!parts) {
    return `指定日期 ${config.time}`;
  }
  const date = new Date(parts.year, parts.month - 1, parts.day);
  const label = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(date);
  return `${label} ${config.time}`;
}

export function formatReminderRunStatus(snapshot: ReminderSnapshot) {
  if (!snapshot.config.enabled) {
    if (snapshot.config.scheduleType === "once" && snapshot.lastStatus !== "never") {
      return formatHandledStatus("已完成", snapshot.lastHandledAt);
    }
    return "已停用";
  }
  switch (snapshot.lastStatus) {
    case "never":
      return "等待首次触发";
    case "triggered":
      return formatHandledStatus("已准时触发", snapshot.lastHandledAt);
    case "caughtUp":
      return formatHandledStatus("已补发", snapshot.lastHandledAt);
    case "missed":
      return formatHandledStatus("已错过", snapshot.lastHandledAt);
  }
}

function newReminderSnapshot(
  config: ReminderConfig,
  now = new Date(),
  markScheduleStart = false,
): ReminderSnapshot {
  return {
    config,
    nextReminderAt: nextReminderDate(config, now)?.getTime() ?? null,
    lastHandledAt: markScheduleStart ? now.getTime() : null,
    lastStatus: "never",
  };
}

function normalizeReminderSnapshot(snapshot: Partial<ReminderSnapshot>): ReminderSnapshot {
  const config = normalizeReminderConfig(snapshot.config ?? {});
  return {
    config,
    nextReminderAt:
      typeof snapshot.nextReminderAt === "number" && Number.isFinite(snapshot.nextReminderAt)
        ? snapshot.nextReminderAt
        : nextReminderDate(config)?.getTime() ?? null,
    lastHandledAt:
      typeof snapshot.lastHandledAt === "number" && Number.isFinite(snapshot.lastHandledAt)
        ? snapshot.lastHandledAt
        : null,
    lastStatus: normalizeReminderRunStatus(snapshot.lastStatus),
  };
}

function reconcileReminderSnapshots(reminders: ReminderSnapshot[], now = new Date()) {
  return reminders.map((snapshot) => {
    if (!snapshot.config.enabled) {
      return { ...snapshot, nextReminderAt: null };
    }
    if (snapshot.lastHandledAt === null) {
      return {
        ...snapshot,
        nextReminderAt: nextReminderDate(snapshot.config, now)?.getTime() ?? null,
        lastHandledAt: now.getTime(),
      };
    }
    const previous = previousReminderDate(snapshot.config, now)?.getTime() ?? null;
    if (
      snapshot.config.scheduleType === "once" &&
      previous !== null &&
      snapshot.lastHandledAt >= previous
    ) {
      return {
        ...snapshot,
        config: { ...snapshot.config, enabled: false },
        nextReminderAt: null,
      };
    }
    return {
      ...snapshot,
      nextReminderAt:
        previous !== null && snapshot.lastHandledAt < previous
          ? previous
          : nextReminderDate(snapshot.config, now)?.getTime() ?? null,
    };
  });
}

function normalizeReminderRunStatus(value: unknown): ReminderRunStatus {
  return value === "triggered" || value === "caughtUp" || value === "missed" ? value : "never";
}

function formatHandledStatus(label: string, timestamp: number | null) {
  if (timestamp === null) {
    return label;
  }
  const time = new Date(timestamp).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${label} · ${time}`;
}

function normalizeReminderId(value: string | undefined) {
  const normalized = (value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
  return normalized || "reminder-migrated";
}

function parseReminderTime(value: string): [number | null, number | null] {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return [null, null];
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return [null, null];
  }

  return [hour, minute];
}

type ReminderDateParts = { year: number; month: number; day: number };

function parseReminderDate(value: string): ReminderDateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const date = new Date(parts.year, parts.month - 1, parts.day);
  return date.getFullYear() === parts.year &&
    date.getMonth() === parts.month - 1 &&
    date.getDate() === parts.day
    ? parts
    : null;
}

function reminderDateTime(value: string, hour: number, minute: number) {
  const parts = parseReminderDate(value);
  if (!parts) {
    return null;
  }
  const date = new Date(parts.year, parts.month - 1, parts.day, hour, minute, 0, 0);
  return date.getFullYear() === parts.year &&
    date.getMonth() === parts.month - 1 &&
    date.getDate() === parts.day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
    ? date
    : null;
}

function formatReminderDateValue(value: Date) {
  return formatReminderDateParts({
    year: value.getFullYear(),
    month: value.getMonth() + 1,
    day: value.getDate(),
  });
}

function formatReminderDateParts(parts: ReminderDateParts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
