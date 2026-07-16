import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskRecord, TaskStateSnapshot } from "../tasks/model";
import { WorkSettings } from "./WorkSettings";

const task: TaskRecord = {
  id: "task-running",
  promptPreview: "检查并修复构建",
  cwd: "C:\\code\\codex-pet",
  terminalId: "windows-terminal",
  status: "running",
  activity: "editing_file",
  statusMessage: "修改文件：src/App.tsx",
  sessionId: "session-one",
  attempts: 1,
  maxAttempts: 2,
  timeoutMinutes: 30,
  createdAt: 1,
  startedAt: 1,
  finishedAt: null,
  error: null,
};

const taskState: TaskStateSnapshot = {
  tasks: [task],
  runningTaskIds: [task.id],
  queuedCount: 2,
  maxConcurrentTasks: 3,
};

describe("WorkSettings", () => {
  it("shows the project, terminal and granular status on a clickable task card", () => {
    const markup = renderToStaticMarkup(
      <WorkSettings
        codexPath=""
        workdir={task.cwd}
        terminalId="windows-terminal"
        terminals={[
          { id: "auto", label: "自动选择" },
          { id: "windows-terminal", label: "Windows Terminal" },
        ]}
        task=""
        taskTimeoutMinutes={30}
        taskMaxRetries={1}
        running
        events={[]}
        agentSessions={[
          {
            key: "claude:session-one:root",
            provider: "claude",
            sessionId: "session-one",
            agentId: null,
            cwd: "C:\\code\\codex-pet",
            state: "editing_file",
            message: "Claude Code 正在运行 Edit",
            updatedAt: 1,
          },
        ]}
        agentHookStatuses={[
          { provider: "claude", installed: true, configPath: "/home/test/.claude/settings.json", error: null },
          { provider: "grok", installed: false, configPath: "/home/test/.grok/hooks/codex-pet.json", error: null },
        ]}
        agentHookBusyProvider={null}
        taskState={taskState}
        onCodexPathChange={vi.fn()}
        onWorkdirChange={vi.fn()}
        onTerminalChange={vi.fn()}
        onTaskChange={vi.fn()}
        onTaskTimeoutChange={vi.fn()}
        onTaskMaxRetriesChange={vi.fn()}
        onPickCodexExecutable={vi.fn()}
        onPickWorkPath={vi.fn()}
        onOpenTerminal={vi.fn()}
        onOpenTaskTerminal={vi.fn()}
        onCancelTask={vi.fn()}
        onClearTaskHistory={vi.fn()}
        onSetAgentHookInstalled={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(markup).toContain("1 个执行 · 2 个等待");
    expect(markup).toContain("codex-pet");
    expect(markup).toContain("Windows Terminal");
    expect(markup).toContain("编辑");
    expect(markup).toContain('aria-label="打开 codex-pet 的任务终端，当前状态：编辑"');
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("已接入");
    expect(markup).toContain("1 个活跃会话");
  });
});
