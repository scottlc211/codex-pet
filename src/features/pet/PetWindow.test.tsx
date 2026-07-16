import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../tasks/model";
import { PetWindow } from "./PetWindow";

function runningTask(id: string, cwd: string, activity: TaskRecord["activity"]): TaskRecord {
  return {
    id,
    promptPreview: "test",
    cwd,
    terminalId: "windows-terminal",
    status: "running",
    activity,
    statusMessage: activity === "running_command" ? "正在执行命令" : "正在思考",
    sessionId: null,
    attempts: 1,
    maxAttempts: 1,
    timeoutMinutes: 30,
    createdAt: 1,
    startedAt: 1,
    finishedAt: null,
    error: null,
  };
}

describe("PetWindow", () => {
  it("renders concurrent project states as terminal shortcuts", () => {
    const markup = renderToStaticMarkup(
      <PetWindow
        state="working"
        renderMode="smooth"
        visual={null}
        visualIdentity="default-working"
        petSize={180}
        bubble={null}
        tasks={[
          runningTask("one", "C:\\code\\alpha", "thinking"),
          runningTask("two", "C:\\code\\beta", "running_command"),
        ]}
        queuedCount={1}
        contextMenuOpen={false}
        clickThrough={false}
        onPointerDown={vi.fn()}
        onPointerMove={vi.fn()}
        onPointerEnd={vi.fn()}
        onContextMenu={vi.fn()}
        onCloseBubble={vi.fn()}
        onOpenTaskTerminal={vi.fn()}
        onOpenSettings={vi.fn()}
        onHidePet={vi.fn()}
        onToggleClickThrough={vi.fn()}
        onQuit={vi.fn()}
      />,
    );

    expect(markup).toContain("2 个任务并行");
    expect(markup).toContain("另有 1 个排队");
    expect(markup).toContain('aria-label="打开 alpha 的任务终端，当前状态：思考"');
    expect(markup).toContain('aria-label="打开 beta 的任务终端，当前状态：命令"');
  });
});
