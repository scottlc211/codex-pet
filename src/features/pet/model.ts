export type PetState =
  | "idle"
  | "thinking"
  | "working"
  | "running_command"
  | "editing_file"
  | "waiting_input"
  | "success"
  | "error"
  | "dragging"
  | "dragging_left"
  | "dragging_right"
  | "sweeping"
  | "carrying";

export type PetVisual = {
  kind: "image" | "atlas";
  path: string;
  row?: number;
  frames?: number;
  totalMs?: number;
  frameWidth?: number;
  frameHeight?: number;
};

export type PetCandidate = {
  name: string;
  path: string;
  kind: string;
  // 只有复制到 Codex Pet 托管目录中的主题才允许从界面删除。
  canDelete: boolean;
  states: Partial<Record<PetState | string, PetVisual>>;
};

export type PetStateEvent = {
  kind: string;
  message?: string;
  state?: PetState;
};

export const stateLabels: Record<PetState, string> = {
  idle: "空闲",
  thinking: "思考",
  working: "工作",
  running_command: "命令",
  editing_file: "编辑",
  waiting_input: "等待",
  success: "完成",
  error: "错误",
  dragging: "拖动",
  dragging_left: "向左",
  dragging_right: "向右",
  sweeping: "压缩",
  carrying: "搬运",
};

export const activeTaskStates = new Set<PetState>([
  "thinking",
  "working",
  "running_command",
  "editing_file",
  "waiting_input",
  "sweeping",
  "carrying",
]);

export function resolveVisual(pet: PetCandidate, state: PetState): PetVisual | null {
  if (state === "idle") {
    return pet.states.idle ?? null;
  }

  const fallbackByState: Partial<Record<PetState, string[]>> = {
    dragging_left: ["dragging_left", "dragging", "working", "idle"],
    dragging_right: ["dragging_right", "dragging", "working", "idle"],
    dragging: ["dragging", "working", "idle"],
    success: ["success", "attention", "idle"],
    error: ["error", "idle"],
    waiting_input: ["waiting_input", "notification", "thinking", "idle"],
    running_command: ["running_command", "working", "thinking", "idle"],
    editing_file: ["editing_file", "working", "thinking", "idle"],
    sweeping: ["sweeping", "working", "idle"],
    carrying: ["carrying", "working", "idle"],
    working: ["working", "thinking", "idle"],
    thinking: ["thinking", "idle"],
  };

  for (const key of fallbackByState[state] ?? [state, "idle"]) {
    const visual = pet.states[key];
    if (visual) {
      return visual;
    }
  }

  return null;
}

export function normalizeEventState(event: PetStateEvent): PetState | null {
  if (event.state) {
    return event.state;
  }

  switch (event.kind) {
    case "turn.started":
    case "thread.started":
    case "event_msg:task_started":
    case "event_msg:user_message":
      return "thinking";
    case "item.started":
    case "response_item:function_call":
      return "working";
    case "event_msg:exec_command_end":
    case "response_item:custom_tool_call":
    case "response_item:web_search_call":
      return "running_command";
    case "event_msg:patch_apply_end":
      return "editing_file";
    case "event_msg:task_complete":
    case "turn.completed":
    case "completed":
      return "success";
    case "turn.failed":
    case "error":
      return "error";
    default:
      return null;
  }
}
