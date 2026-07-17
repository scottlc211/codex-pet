import type { MouseEventHandler, PointerEventHandler } from "react";
import {
  Activity,
  EyeOff,
  MousePointer2,
  MousePointer2Off,
  Power,
  Settings,
  SquareTerminal,
  X,
} from "lucide-react";
import type { RenderMode } from "../../config/preferences";
import {
  agentProviderLabels,
  agentSessionProject,
  type AgentSession,
} from "../agents/model";
import {
  taskDisplayStatusLabel,
  taskProjectName,
  type TaskRecord,
} from "../tasks/model";
import { PetVisualView } from "./PetVisualView";
import { stateLabels, type PetState, type PetVisual } from "./model";

export type PetBubble = {
  tone: "working" | "success" | "error" | "reminder";
  label: string;
  message: string;
  dismissible?: boolean;
  source?: "status" | "reminder";
};

type PetWindowProps = {
  state: PetState;
  renderMode: RenderMode;
  visual: PetVisual | null;
  visualIdentity: string;
  petSize: number;
  bubble: PetBubble | null;
  tasks: TaskRecord[];
  agentSessions: AgentSession[];
  hiddenAgentSessionCount: number;
  queuedCount: number;
  contextMenuOpen: boolean;
  clickThrough: boolean;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerMove: PointerEventHandler<HTMLElement>;
  onPointerEnd: PointerEventHandler<HTMLElement>;
  onContextMenu: MouseEventHandler<HTMLElement>;
  onCloseBubble: () => void;
  onOpenTaskTerminal: (taskId: string) => void;
  onOpenSettings: () => void;
  onHidePet: () => void;
  onToggleClickThrough: () => void;
  onQuit: () => void;
};

export function PetWindow({
  state,
  renderMode,
  visual,
  visualIdentity,
  petSize,
  bubble,
  tasks,
  agentSessions,
  hiddenAgentSessionCount,
  queuedCount,
  contextMenuOpen,
  clickThrough,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onContextMenu,
  onCloseBubble,
  onOpenTaskTerminal,
  onOpenSettings,
  onHidePet,
  onToggleClickThrough,
  onQuit,
}: PetWindowProps) {
  const totalProgressCount = tasks.length + agentSessions.length + hiddenAgentSessionCount;
  const showProgressPanel = tasks.length > 0 || totalProgressCount > 1;
  const progressSummary = (() => {
    const pending: string[] = [];
    if (queuedCount > 0) {
      pending.push(`${queuedCount} 个排队`);
    }
    if (hiddenAgentSessionCount > 0) {
      pending.push(`${hiddenAgentSessionCount} 个折叠`);
    }
    if (pending.length > 0) {
      return `另有 ${pending.join(" · ")}`;
    }
    if (tasks.length > 0 && agentSessions.length > 0) {
      return `${tasks.length} 个托管 · ${agentSessions.length} 个外部`;
    }
    return agentSessions.length > 0 ? "外部会话执行中" : "全部执行中";
  })();

  return (
    <>
      <section
        className={`pet-stage state-${state} render-${renderMode} ${bubble ? "has-bubble" : ""}`}
        aria-label="桌宠"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onContextMenu={onContextMenu}
      >
        {showProgressPanel && !bubble && (
          <div
            className="pet-task-panel"
            aria-label={`并行任务状态，共 ${totalProgressCount} 个任务`}
          >
            <div className="pet-task-panel-header">
              <strong>{totalProgressCount} 个任务并行</strong>
              <span aria-live="polite">{progressSummary}</span>
            </div>
            <ul aria-live="polite">
              {tasks.map((task) => {
                const projectName = taskProjectName(task.cwd);
                return (
                  <li key={task.id} data-activity={task.activity ?? "idle"}>
                    <button
                      type="button"
                      title={`打开 ${projectName} 的任务终端`}
                      aria-label={`打开 ${projectName} 的任务终端，当前状态：${taskDisplayStatusLabel(task)}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenTaskTerminal(task.id);
                      }}
                    >
                      <span className="pet-task-state" aria-hidden="true" />
                      <span className="pet-task-copy">
                        <strong>{projectName}</strong>
                        <small aria-live="polite">
                          {taskDisplayStatusLabel(task)}
                          {task.statusMessage ? ` · ${task.statusMessage}` : ""}
                        </small>
                      </span>
                      <SquareTerminal size={14} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
              {agentSessions.map((session) => {
                const projectName = agentSessionProject(session);
                const providerLabel = agentProviderLabels[session.provider];
                const stateLabel = stateLabels[session.state];
                return (
                  <li key={session.key} data-activity={session.state}>
                    <div
                      className="pet-task-session"
                      title={`${providerLabel} · ${session.cwd ?? session.sessionId}`}
                      aria-label={`${providerLabel} 的 ${projectName} 会话，当前状态：${stateLabel}`}
                    >
                      <span className="pet-task-state" aria-hidden="true" />
                      <span className="pet-task-copy">
                        <strong>
                          {providerLabel} · {projectName}
                        </strong>
                        <small>
                          {stateLabel}
                          {session.message ? ` · ${session.message}` : ""}
                        </small>
                      </span>
                      <Activity size={14} aria-hidden="true" />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {bubble && (
          <div
            className={`pet-bubble tone-${bubble.tone} ${bubble.dismissible ? "is-dismissible" : ""}`}
            role="status"
            aria-live="polite"
          >
            <div className="pet-bubble-header">
              <strong>{bubble.label}</strong>
              {bubble.dismissible && (
                <button
                  className="pet-bubble-close"
                  type="button"
                  aria-label="关闭状态提示"
                  title="关闭状态提示"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseBubble();
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <span>{bubble.message}</span>
          </div>
        )}
        <PetVisualView
          key={visualIdentity}
          visual={visual}
          state={state}
          renderMode={renderMode}
          petSize={petSize}
        />
      </section>

      {contextMenuOpen && (
        <div
          className="context-tablist"
          role="menu"
          aria-label="桌宠菜单"
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={onOpenSettings}>
            <Settings size={16} />
            <span>设置</span>
          </button>
          <button type="button" role="menuitem" onClick={onHidePet}>
            <EyeOff size={16} />
            <span>隐藏桌宠</span>
          </button>
          <button type="button" role="menuitem" onClick={onToggleClickThrough}>
            {clickThrough ? <MousePointer2 size={16} /> : <MousePointer2Off size={16} />}
            <span>{clickThrough ? "关闭鼠标穿透" : "鼠标穿透"}</span>
          </button>
          <button className="danger" type="button" role="menuitem" onClick={onQuit}>
            <Power size={16} />
            <span>退出</span>
          </button>
        </div>
      )}
    </>
  );
}
