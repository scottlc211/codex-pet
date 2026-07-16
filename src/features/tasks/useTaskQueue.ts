import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import type { CodexEvent } from "../pet/model";
import { isTauriRuntime, releaseTauriListener } from "../../runtime/tauri";
import {
  emptyTaskState,
  isTaskActive,
  type TaskStateSnapshot,
  type TaskTerminalOpenResult,
} from "./model";

type UseTaskQueueOptions = {
  pushEvent: (event: CodexEvent) => void;
};

export function useTaskQueue({ pushEvent }: UseTaskQueueOptions) {
  const [taskState, setTaskState] = useState<TaskStateSnapshot>(emptyTaskState);
  const hasActiveTasks = useMemo(
    () => taskState.tasks.some((task) => isTaskActive(task.status)),
    [taskState.tasks],
  );

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    void invoke<TaskStateSnapshot>("get_task_state")
      .then(setTaskState)
      .catch((error) => {
        pushEvent({ kind: "task.state.error", message: String(error), state: "error" });
      });
    const unlistenPromise = listen<TaskStateSnapshot>("task-state-updated", (event) => {
      setTaskState(event.payload);
    });
    return () => releaseTauriListener(unlistenPromise);
  }, [pushEvent]);

  async function cancelTask(taskId: string) {
    if (!isTauriRuntime) {
      return;
    }
    try {
      setTaskState(await invoke<TaskStateSnapshot>("cancel_codex_task", { taskId }));
    } catch (error) {
      pushEvent({ kind: "task.cancel.error", message: String(error), state: "error" });
    }
  }

  async function openTaskTerminal(taskId: string) {
    if (!isTauriRuntime) {
      return;
    }
    try {
      const opened = await invoke<TaskTerminalOpenResult>("open_task_terminal", { taskId });
      pushEvent({
        kind: "task.terminal.opened",
        message: opened.focusedExisting ? "已定位任务终端" : "已打开任务终端",
        state: "idle",
        sessionId: taskId,
      });
    } catch (error) {
      pushEvent({ kind: "task.terminal.error", message: String(error), state: "error" });
    }
  }

  async function clearTaskHistory() {
    if (!isTauriRuntime) {
      return;
    }
    try {
      setTaskState(await invoke<TaskStateSnapshot>("clear_task_history"));
    } catch (error) {
      pushEvent({ kind: "task.history.error", message: String(error), state: "error" });
    }
  }

  return {
    taskState,
    hasActiveTasks,
    openTaskTerminal,
    cancelTask,
    clearTaskHistory,
  };
}
