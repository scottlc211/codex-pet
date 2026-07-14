import { describe, expect, it } from "vitest";
import { isTaskActive, shortTaskId, taskStatusLabel } from "./model";

describe("task model", () => {
  it("distinguishes active and terminal task states", () => {
    expect(isTaskActive("queued")).toBe(true);
    expect(isTaskActive("retrying")).toBe(true);
    expect(isTaskActive("completed")).toBe(false);
    expect(isTaskActive("timedOut")).toBe(false);
  });

  it("formats task status and long identifiers", () => {
    expect(taskStatusLabel("cancelling")).toBe("正在取消");
    expect(shortTaskId("task-12345678901234567890")).toBe("task-1234567890...");
  });
});
