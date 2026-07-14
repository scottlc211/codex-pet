import { describe, expect, it } from "vitest";
import {
  classifyReminderLateness,
  defaultReminderConfig,
  nextReminderDate,
  previousReminderDate,
  readReminderSnapshots,
  reminderConfigKey,
  saveBrowserReminderSnapshots,
} from "./model";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("reminder model", () => {
  it("migrates a legacy single reminder", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      reminderConfigKey,
      JSON.stringify({
        enabled: true,
        title: "Review",
        message: "Check changes",
        weekday: 1,
        time: "09:30",
        durationMinutes: 5,
      }),
    );

    const reminders = readReminderSnapshots(storage);

    expect(reminders).toHaveLength(1);
    expect(reminders[0].config).toMatchObject({
      id: "reminder-migrated",
      enabled: true,
      title: "Review",
      weekday: 1,
      time: "09:30",
    });
  });

  it("schedules later today or the same weekday next week", () => {
    const config = {
      ...defaultReminderConfig,
      enabled: true,
      weekday: 1,
      time: "11:00",
    };

    expect(nextReminderDate(config, new Date(2024, 0, 1, 10, 0))?.getDate()).toBe(1);
    expect(nextReminderDate(config, new Date(2024, 0, 1, 12, 0))?.getDate()).toBe(8);
    expect(previousReminderDate(config, new Date(2024, 0, 1, 12, 0))?.getDate()).toBe(1);
  });

  it("classifies on-time, catch-up, and missed reminders", () => {
    const scheduledAt = 1_000_000;
    expect(classifyReminderLateness(scheduledAt, scheduledAt + 60_000)).toBe("triggered");
    expect(classifyReminderLateness(scheduledAt, scheduledAt + 60_001)).toBe("caughtUp");
    expect(classifyReminderLateness(scheduledAt, scheduledAt + 30 * 60_000 + 1)).toBe("missed");
  });

  it("persists reminder runtime status in browser storage", () => {
    const storage = new MemoryStorage();
    const reminders = [
      {
        config: { ...defaultReminderConfig, enabled: true },
        nextReminderAt: 2_000_000,
        lastHandledAt: 1_000_000,
        lastStatus: "caughtUp" as const,
      },
    ];

    expect(saveBrowserReminderSnapshots(reminders, storage)).toBeNull();
    expect(readReminderSnapshots(storage)[0]).toMatchObject({
      lastHandledAt: 1_000_000,
      lastStatus: "caughtUp",
    });
  });

  it("returns storage errors instead of throwing", () => {
    const reminders = readReminderSnapshots(new MemoryStorage());
    const failingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage blocked");
      },
    };

    expect(saveBrowserReminderSnapshots(reminders, failingStorage)).toBe("storage blocked");
  });
});
