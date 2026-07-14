import type { FormEventHandler } from "react";
import {
  Clock3,
  FileSearch,
  FolderOpen,
  FolderSearch,
  ListTodo,
  Play,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { CodexEvent } from "../pet/model";
import {
  isTaskActive,
  shortTaskId,
  taskStatusLabel,
  type TaskStateSnapshot,
} from "../tasks/model";

export type TerminalOption = {
  id: string;
  label: string;
};

type WorkSettingsProps = {
  codexPath: string;
  workdir: string;
  terminalId: string;
  terminals: TerminalOption[];
  task: string;
  taskTimeoutMinutes: number;
  taskMaxRetries: number;
  running: boolean;
  events: CodexEvent[];
  taskState: TaskStateSnapshot;
  onCodexPathChange: (value: string) => void;
  onWorkdirChange: (value: string) => void;
  onTerminalChange: (value: string) => void;
  onTaskChange: (value: string) => void;
  onTaskTimeoutChange: (value: number) => void;
  onTaskMaxRetriesChange: (value: number) => void;
  onPickCodexExecutable: () => void;
  onPickWorkPath: (kind: "file" | "directory") => void;
  onOpenTerminal: () => void;
  onCancelTask: (taskId: string) => void;
  onClearTaskHistory: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
};

const maxTaskCharacters = 64 * 1024;

export function WorkSettings({
  codexPath,
  workdir,
  terminalId,
  terminals,
  task,
  taskTimeoutMinutes,
  taskMaxRetries,
  running,
  events,
  taskState,
  onCodexPathChange,
  onWorkdirChange,
  onTerminalChange,
  onTaskChange,
  onTaskTimeoutChange,
  onTaskMaxRetriesChange,
  onPickCodexExecutable,
  onPickWorkPath,
  onOpenTerminal,
  onCancelTask,
  onClearTaskHistory,
  onSubmit,
}: WorkSettingsProps) {
  return (
    <div className="settings-page">
      <div className="section-title">
        <h2>工作任务</h2>
      </div>
      <label className="field">
        <span>Codex CLI 路径</span>
        <div className="work-path-row">
          <input
            value={codexPath}
            onChange={(event) => onCodexPathChange(event.currentTarget.value)}
            placeholder="留空自动查找，例如 C:\Program Files\nodejs\codex.cmd"
          />
          <button
            className="icon-button"
            type="button"
            title="选择 Codex 可执行文件"
            onClick={onPickCodexExecutable}
          >
            <FileSearch size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="清空 Codex 路径"
            onClick={() => onCodexPathChange("")}
          >
            <X size={16} />
          </button>
        </div>
        <small className="field-hint">
          建议留空自动查找；如果读取额度失败，再指定绝对路径，例如 `codex.cmd`。
        </small>
      </label>

      <label className="field">
        <span>工作路径</span>
        <div className="work-path-row">
          <input
            value={workdir}
            onChange={(event) => onWorkdirChange(event.currentTarget.value)}
            placeholder="输入目录或文件路径，留空则使用用户目录"
          />
          <button
            className="icon-button"
            type="button"
            title="选择目录"
            onClick={() => onPickWorkPath("directory")}
          >
            <FolderSearch size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="选择文件"
            onClick={() => onPickWorkPath("file")}
          >
            <FileSearch size={16} />
          </button>
        </div>
      </label>

      <label className="field">
        <span>终端</span>
        <div className="terminal-row">
          <select value={terminalId} onChange={(event) => onTerminalChange(event.currentTarget.value)}>
            {terminals.map((terminal) => (
              <option key={terminal.id} value={terminal.id}>
                {terminal.label}
              </option>
            ))}
          </select>
          <button className="secondary-button" type="button" onClick={onOpenTerminal}>
            <FolderOpen size={16} />
            <span>打开终端</span>
          </button>
        </div>
      </label>

      <form className="task-form" onSubmit={onSubmit}>
        <div className="field">
          <span>执行策略</span>
          <div className="task-policy-row">
            <label>
              <Clock3 size={14} aria-hidden="true" />
              <span>超时</span>
              <input
                aria-label="任务超时分钟"
                type="number"
                min="1"
                max="240"
                value={taskTimeoutMinutes}
                onChange={(event) => onTaskTimeoutChange(Number(event.currentTarget.value))}
              />
              <span>分钟</span>
            </label>
            <label>
              <ListTodo size={14} aria-hidden="true" />
              <span>重试</span>
              <input
                aria-label="任务最大重试次数"
                type="number"
                min="0"
                max="3"
                value={taskMaxRetries}
                onChange={(event) => onTaskMaxRetriesChange(Number(event.currentTarget.value))}
              />
              <span>次</span>
            </label>
          </div>
        </div>
        <label className="field">
          <span>任务</span>
          <textarea
            value={task}
            rows={3}
            maxLength={maxTaskCharacters}
            onChange={(event) => onTaskChange(event.currentTarget.value)}
            placeholder="让 Codex 检查这个项目并总结下一步"
          />
        </label>

        <button className="run-button" type="submit" disabled={!task.trim()}>
          <Play size={18} />
          <span>{running ? "加入队列" : "发送给 Codex"}</span>
        </button>
      </form>

      <section className="task-history" aria-label="任务队列与历史">
        <div className="task-history-header">
          <div>
            <h3>任务记录</h3>
            <span>{taskState.queuedCount > 0 ? `${taskState.queuedCount} 个等待` : "队列空闲"}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            title="清除已结束任务"
            disabled={!taskState.tasks.some((item) => !isTaskActive(item.status))}
            onClick={onClearTaskHistory}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
        {taskState.tasks.length === 0 ? (
          <div className="task-history-empty">暂无任务记录</div>
        ) : (
          <ul className="task-history-list">
            {taskState.tasks.slice(0, 8).map((item) => (
              <li key={item.id} data-status={item.status}>
                <div className="task-history-main">
                  <strong title={item.promptPreview}>{item.promptPreview}</strong>
                  <span>{taskStatusLabel(item.status)}</span>
                </div>
                <div className="task-history-meta">
                  <code title={item.id}>{shortTaskId(item.id)}</code>
                  <span>
                    {item.attempts}/{item.maxAttempts} 次
                  </span>
                  <span>{formatTaskTime(item.createdAt)}</span>
                  {isTaskActive(item.status) && item.status !== "cancelling" && (
                    <button
                      className="icon-button"
                      type="button"
                      title="取消任务"
                      onClick={() => onCancelTask(item.id)}
                    >
                      <Square size={13} aria-hidden="true" />
                    </button>
                  )}
                </div>
                {item.error && <p title={item.error}>{item.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="event-log" aria-label="Codex 状态日志">
        <Sparkles size={15} />
        <ul>
          {events.slice(-3).map((event, index) => (
            <li key={`${event.kind}-${index}`}>
              {event.sessionId ? `${shortSession(event.sessionId)} · ` : ""}
              {event.message}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function shortSession(sessionId: string) {
  return sessionId.length <= 14 ? sessionId : sessionId.slice(0, 11);
}

function formatTaskTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
