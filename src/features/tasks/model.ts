export type TaskStatus =
  | "queued"
  | "running"
  | "retrying"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "timedOut";

export type TaskRecord = {
  id: string;
  promptPreview: string;
  cwd: string;
  status: TaskStatus;
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
  runningTaskId: string | null;
  queuedCount: number;
};

export type TaskSubmission = {
  taskId: string;
};

export const emptyTaskState: TaskStateSnapshot = {
  tasks: [],
  runningTaskId: null,
  queuedCount: 0,
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
