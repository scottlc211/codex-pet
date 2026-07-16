export type TaskStatus =
  | "queued"
  | "running"
  | "retrying"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "timedOut";

export type TaskActivity =
  | "queued"
  | "idle"
  | "thinking"
  | "working"
  | "running_command"
  | "editing_file"
  | "waiting_input"
  | "success"
  | "error";

export type TaskRecord = {
  id: string;
  promptPreview: string;
  cwd: string;
  // 后端解析后的具体终端程序；窗口标识由 task id 动态生成，不持久化到前端。
  terminalId: string;
  status: TaskStatus;
  activity: TaskActivity | null;
  statusMessage: string;
  sessionId: string | null;
  attempts: number;
  maxAttempts: number;
  timeoutMinutes: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
};

export type TaskStateSnapshot = {
  tasks: TaskRecord[];
  runningTaskIds: string[];
  queuedCount: number;
  maxConcurrentTasks: number;
};

export type TaskTerminalOpenResult = {
  taskId: string;
  terminalId: string;
  focusedExisting: boolean;
};

export type TaskSubmission = {
  taskId: string;
};

export const emptyTaskState: TaskStateSnapshot = {
  tasks: [],
  runningTaskIds: [],
  queuedCount: 0,
  maxConcurrentTasks: 3,
};

export function isTaskActive(status: TaskStatus) {
  return status === "queued" || status === "running" || status === "retrying" || status === "cancelling";
}

export function taskStatusLabel(status: TaskStatus) {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "执行中";
    case "retrying":
      return "等待重试";
    case "cancelling":
      return "正在取消";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "timedOut":
      return "已超时";
  }
}

export function shortTaskId(taskId: string) {
  return taskId.length <= 18 ? taskId : `${taskId.slice(0, 15)}...`;
}

export function taskQueueSummary(snapshot: TaskStateSnapshot) {
  const summary: string[] = [];
  if (snapshot.runningTaskIds.length > 0) {
    summary.push(`${snapshot.runningTaskIds.length} 个执行`);
  }
  if (snapshot.queuedCount > 0) {
    summary.push(`${snapshot.queuedCount} 个等待`);
  }
  return summary.length > 0 ? summary.join(" · ") : "队列空闲";
}

export function isTaskExecuting(status: TaskStatus) {
  return status === "running" || status === "retrying" || status === "cancelling";
}

export function taskActivityLabel(activity: TaskActivity | null) {
  switch (activity) {
    case "queued":
      return "排队";
    case "thinking":
      return "思考";
    case "working":
      return "工作";
    case "running_command":
      return "命令";
    case "editing_file":
      return "编辑";
    case "waiting_input":
      return "等待";
    case "success":
      return "完成";
    case "error":
      return "错误";
    case "idle":
    case null:
      return "空闲";
  }
}

export function taskDisplayStatusLabel(task: TaskRecord) {
  if (task.status === "running" && task.activity) {
    return taskActivityLabel(task.activity);
  }
  return taskStatusLabel(task.status);
}

export function taskProjectName(cwd: string) {
  const normalized = cwd.trim().replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized || "项目";
}
