export const petStates = [
  "idle",
  "thinking",
  "working",
  "running_command",
  "editing_file",
  "waiting_input",
  "success",
  "error",
  "dragging",
  "dragging_left",
  "dragging_right",
  "sweeping",
  "carrying",
] as const;

export type PetState = (typeof petStates)[number];

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

export type PetStateActionMap = Partial<Record<PetState, string>>;

export type PetStateActionOverrides = Record<string, PetStateActionMap>;

export type PetActionOption = {
  key: string;
  label: string;
  visual: PetVisual;
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

const petStateNames = new Set<string>(petStates);
const supportedImageExtensions = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "apng",
]);

export const activeTaskStates = new Set<PetState>([
  "thinking",
  "working",
  "running_command",
  "editing_file",
  "waiting_input",
  "sweeping",
  "carrying",
]);

export function isPetState(value: string): value is PetState {
  return petStateNames.has(value);
}

export function validatePetVisual(visual: unknown): string | null {
  if (!isRecord(visual)) {
    return "动作数据无效";
  }
  if (visual.kind !== "image" && visual.kind !== "atlas") {
    return "动作类型必须是图片或图集";
  }
  if (typeof visual.path !== "string" || !hasSupportedImageExtension(visual.path)) {
    return "仅支持 PNG、JPG、JPEG、GIF、WebP、SVG、APNG 图片";
  }
  if (visual.kind === "image") {
    return null;
  }
  if (!Number.isInteger(visual.row) || Number(visual.row) < 0 || Number(visual.row) > 8) {
    return "图集行号必须是 0–8 的整数";
  }
  if (!Number.isInteger(visual.frames) || Number(visual.frames) < 1 || Number(visual.frames) > 8) {
    return "图集帧数必须是 1–8 的整数";
  }
  if (!isPositiveInteger(visual.totalMs)) {
    return "图集总时长必须是正整数";
  }
  if (!isPositiveInteger(visual.frameWidth) || !isPositiveInteger(visual.frameHeight)) {
    return "图集帧尺寸必须是正整数";
  }
  return null;
}

export function petVisualFormatLabel(visual: PetVisual | null): string {
  if (!visual || validatePetVisual(visual)) {
    return "格式无效";
  }
  if (visual.kind === "atlas") {
    return `图集 · ${visual.frames} 帧`;
  }
  return `图片 · ${imageExtension(visual.path).toUpperCase()}`;
}

export function getPetActionOptions(pet: PetCandidate): PetActionOption[] {
  const orderedKeys = [
    ...petStates.filter((state) => hasOwn(pet.states, state)),
    ...Object.keys(pet.states)
      .filter((state) => !petStateNames.has(state))
      .sort((left, right) => left.localeCompare(right)),
  ];
  const seenVisuals = new Set<string>();
  const options: PetActionOption[] = [];

  for (const key of orderedKeys) {
    const visual = pet.states[key];
    if (validatePetVisual(visual)) {
      continue;
    }
    const validVisual = visual as PetVisual;
    const identity = petVisualIdentity(validVisual);
    if (seenVisuals.has(identity)) {
      continue;
    }
    seenVisuals.add(identity);
    options.push({
      key,
      label: isPetState(key) ? stateLabels[key] : key,
      visual: validVisual,
    });
  }

  return options;
}

export function applyPetStateOverrides(
  pet: PetCandidate,
  overrides: PetStateActionMap | undefined,
): PetCandidate {
  if (!overrides) {
    return pet;
  }

  let nextStates: PetCandidate["states"] | null = null;
  for (const state of petStates) {
    const sourceAction = overrides[state];
    if (!sourceAction || !hasOwn(pet.states, sourceAction)) {
      continue;
    }
    const sourceVisual = pet.states[sourceAction];
    if (validatePetVisual(sourceVisual)) {
      continue;
    }
    nextStates ??= { ...pet.states };
    nextStates[state] = sourceVisual;
  }

  return nextStates ? { ...pet, states: nextStates } : pet;
}

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

function petVisualIdentity(visual: PetVisual) {
  return [
    visual.kind,
    visual.path,
    visual.row ?? "",
    visual.frames ?? "",
    visual.totalMs ?? "",
    visual.frameWidth ?? "",
    visual.frameHeight ?? "",
  ].join("|");
}

function hasSupportedImageExtension(path: string) {
  return supportedImageExtensions.has(imageExtension(path));
}

function imageExtension(path: string) {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const extensionIndex = path.lastIndexOf(".");
  return extensionIndex > separatorIndex ? path.slice(extensionIndex + 1).toLowerCase() : "";
}

function isPositiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0;
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
