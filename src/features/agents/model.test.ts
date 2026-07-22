import { describe, expect, it } from "vitest";
import {
  aggregateAgentSessions,
  resolveAgentPresentation,
  updateAgentSessions,
  type AgentEvent,
  type AgentSession,
} from "./model";

function event(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    provider: "claude",
    kind: "hook.UserPromptSubmit",
    message: "Claude Code 正在思考",
    state: "thinking",
    sessionId: "session-one",
    timestamp: 100,
    ...overrides,
  };
}

describe("agent session registry", () => {
  it("keeps providers and sessions independent", () => {
    let sessions = updateAgentSessions([], event());
    sessions = updateAgentSessions(
      sessions,
      event({
        provider: "grok",
        sessionId: "session-two",
        state: "running_command",
        message: "Grok Build 正在运行 Bash",
        timestamp: 101,
      }),
    );

    expect(sessions).toHaveLength(2);
    expect(aggregateAgentSessions(sessions)).toMatchObject({
      state: "running_command",
      running: true,
      primary: { provider: "grok", sessionId: "session-two" },
    });
  });

  it("does not let one completed session hide another active session", () => {
    const active: AgentSession[] = updateAgentSessions([], event());
    let sessions = updateAgentSessions(
      active,
      event({ provider: "grok", sessionId: "grok-one", timestamp: 101 }),
    );
    sessions = updateAgentSessions(
      sessions,
      event({
        provider: "grok",
        sessionId: "grok-one",
        kind: "hook.Stop",
        state: "success",
        message: "Grok Build 回合完成",
        timestamp: 102,
      }),
    );

    expect(aggregateAgentSessions(sessions)).toMatchObject({
      state: "thinking",
      running: true,
      primary: { provider: "claude" },
    });
  });

  it("keeps a Claude session completed after the idle notification", () => {
    let sessions = updateAgentSessions([], event());
    sessions = updateAgentSessions(
      sessions,
      event({
        kind: "hook.Stop",
        state: "success",
        message: "Claude Code 回合完成",
        timestamp: 101,
      }),
    );
    sessions = updateAgentSessions(
      sessions,
      event({
        kind: "hook.Notification",
        state: "success",
        message: "Claude Code 回合完成",
        timestamp: 102,
      }),
    );

    expect(aggregateAgentSessions(sessions)).toMatchObject({
      state: "success",
      running: false,
      primary: { provider: "claude", sessionId: "session-one" },
    });
  });

  it("tracks Claude subagents separately and removes them on stop", () => {
    let sessions = updateAgentSessions(
      [],
      event({
        kind: "hook.SubagentStart",
        agentId: "reviewer-1",
        state: "working",
      }),
    );
    expect(sessions[0].key).toContain("reviewer-1");

    sessions = updateAgentSessions(
      sessions,
      event({ kind: "hook.SubagentStop", agentId: "reviewer-1", timestamp: 101 }),
    );
    expect(sessions).toHaveLength(0);
  });

  it("removes every child when the provider session ends", () => {
    const sessions: AgentSession[] = [
      {
        key: "claude:s:a",
        provider: "claude",
        sessionId: "s",
        agentId: "a",
        cwd: null,
        state: "working",
        message: "working",
        updatedAt: 100,
      },
      {
        key: "claude:s:root",
        provider: "claude",
        sessionId: "s",
        agentId: null,
        cwd: null,
        state: "thinking",
        message: "thinking",
        updatedAt: 100,
      },
    ];
    expect(
      updateAgentSessions(
        sessions,
        event({ kind: "hook.SessionEnd", sessionId: "s", state: "idle", timestamp: 101 }),
      ),
    ).toEqual([]);
  });
});

describe("agent terminal presentation", () => {
  it("keeps delayed terminal events hidden after dismissal", () => {
    expect(resolveAgentPresentation(true, "success", "success")).toEqual({
      terminalDismissed: true,
      suppress: true,
    });
    expect(resolveAgentPresentation(true, "idle", "success")).toEqual({
      terminalDismissed: true,
      suppress: true,
    });
  });

  it("allows terminal presentation again after new activity", () => {
    const active = resolveAgentPresentation(true, "thinking", "thinking");
    expect(active).toEqual({ terminalDismissed: false, suppress: false });
    expect(resolveAgentPresentation(active.terminalDismissed, "success", "success")).toEqual({
      terminalDismissed: false,
      suppress: false,
    });
  });
});
