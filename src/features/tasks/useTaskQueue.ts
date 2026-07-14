import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import type { CodexEvent } from "../pet/model";
import { isTauriRuntime, releaseTauriListener } from "../../runtime/tauri";
import { emptyTaskState, isTaskActive, type TaskStateSnapshot } from "./model";

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
    cancelTask,
    clearTaskHistory,
  };
}
