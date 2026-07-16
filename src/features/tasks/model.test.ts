import { describe, expect, it } from "vitest";
import {
  isTaskActive,
  shortTaskId,
  taskDisplayStatusLabel,
  taskProjectName,
  taskQueueSummary,
  taskStatusLabel,
  type TaskRecord,
} from "./model";

const runningTask: TaskRecord = {
  id: "task-running",
  promptPreview: "test",
  cwd: "C:\\code\\codex-pet",
  terminalId: "windows-terminal",
  status: "running",
  activity: "editing_file",
  statusMessage: "正在编辑文件",
  sessionId: null,
  attempts: 1,
  maxAttempts: 1,
  timeoutMinutes: 30,
  createdAt: 1,
  startedAt: 1,
  finishedAt: null,
  error: null,
};

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

  it("summarizes concurrent workers and queued tasks separately", () => {
    expect(
      taskQueueSummary({
        tasks: [],
        runningTaskIds: ["one", "two", "three"],
        queuedCount: 2,
        maxConcurrentTasks: 3,
      }),
    ).toBe("3 个执行 · 2 个等待");
    expect(
      taskQueueSummary({
        tasks: [],
        runningTaskIds: [],
        queuedCount: 0,
        maxConcurrentTasks: 3,
      }),
    ).toBe("队列空闲");
  });

  it("shows per-task activity and derives project names across platforms", () => {
    expect(taskDisplayStatusLabel(runningTask)).toBe("编辑");
    expect(taskProjectName(runningTask.cwd)).toBe("codex-pet");
    expect(taskProjectName("/work/projects/demo/")).toBe("demo");
  });
});
