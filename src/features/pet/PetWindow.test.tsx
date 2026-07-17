import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../agents/model";
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

function activeAgentSession(
  provider: AgentSession["provider"],
  sessionId: string,
  cwd: string,
  state: AgentSession["state"],
): AgentSession {
  return {
    key: `${provider}:${sessionId}:root`,
    provider,
    sessionId,
    agentId: null,
    cwd,
    state,
    message: state === "running_command" ? "正在执行命令" : "正在思考",
    updatedAt: 1,
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
        agentSessions={[]}
        hiddenAgentSessionCount={0}
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

  it("renders concurrent external agent sessions without overwriting", () => {
    const markup = renderToStaticMarkup(
      <PetWindow
        state="working"
        renderMode="smooth"
        visual={null}
        visualIdentity="default-working"
        petSize={180}
        bubble={null}
        tasks={[]}
        agentSessions={[
          activeAgentSession("claude", "claude-one", "C:\\code\\alpha", "thinking"),
          activeAgentSession("grok", "grok-one", "C:\\code\\beta", "running_command"),
        ]}
        hiddenAgentSessionCount={0}
        queuedCount={0}
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
    expect(markup).toContain("外部会话执行中");
    expect(markup).toContain("Claude Code · alpha");
    expect(markup).toContain("Grok Build · beta");
    expect(markup).toContain('aria-label="Claude Code 的 alpha 会话，当前状态：思考"');
    expect(markup).toContain('aria-label="Grok Build 的 beta 会话，当前状态：命令"');
  });
});
