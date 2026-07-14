import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { LogicalSize, PhysicalPosition, type PhysicalSize } from "@tauri-apps/api/dpi";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
  type Monitor,
} from "@tauri-apps/api/window";
import {
  Bell,
  Check,
  FileSearch,
  FolderOpen,
  FolderSearch,
  Import,
  LoaderCircle,
  Minus,
  Palette,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import defaultPet from "./assets/default-pet.svg";
import "./App.css";

type PetState =
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

type RenderMode = "smooth" | "pixelated";
type SettingsSection = "general" | "theme" | "reminder" | "work";
type ModalPosition = { x: number; y: number };
type DragBounds = { minX: number; minY: number; maxX: number; maxY: number };

type ModalDragSession = {
  pointerId: number;
  startPointerX: number;
  startPointerY: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
  bounds: DragBounds;
};

type PetVisual = {
  kind: "image" | "atlas";
  path: string;
  row?: number;
  frames?: number;
  totalMs?: number;
  frameWidth?: number;
  frameHeight?: number;
};

type PetCandidate = {
  name: string;
  path: string;
  kind: string;
  states: Partial<Record<PetState | string, PetVisual>>;
};

type CodexEvent = {
  kind: string;
  message: string;
  state?: PetState;
  sessionId?: string;
};

type DragSession = {
  pointerId: number;
  startScreenX: number;
  startScreenY: number;
  lastScreenX: number;
  startWindowX: number;
  startWindowY: number;
  scaleFactor: number;
  bounds: DragBounds | null;
  previousState: PetState;
  latestState: PetState;
  pendingFrame: number | null;
};

type TerminalOption = {
  id: string;
  label: string;
};

type PetBubble = {
  tone: "working" | "success" | "error" | "reminder";
  label: string;
  message: string;
  dismissible?: boolean;
  source?: "status" | "reminder";
};

type ReminderConfig = {
  id: string;
  enabled: boolean;
  title: string;
  message: string;
  weekday: number;
  time: string;
  durationMinutes: number;
};

type ReminderSnapshot = {
  config: ReminderConfig;
  nextReminderAt: number | null;
};

type ReminderStateSnapshot = {
  reminders: ReminderSnapshot[];
};

type ReminderEvent = {
  reminderId: string;
  title: string;
  message: string;
  durationMinutes: number;
  nextReminderAt: number | null;
};

type PetPreferences = {
  petSize: number;
  petContainerWidth: number;
  petContainerHeight: number;
  petOffsetX: number;
  petOffsetY: number;
  renderMode: RenderMode;
  packagePath: string;
};

const packagePathKey = "codex-pet:package-path";
const workdirKey = "codex-pet:workdir";
const codexPathKey = "codex-pet:codex-path";
const petSizeKey = "codex-pet:pet-size";
const petContainerWidthKey = "codex-pet:pet-container-width";
const petContainerHeightKey = "codex-pet:pet-container-height";
const petOffsetXKey = "codex-pet:pet-offset-x";
const petOffsetYKey = "codex-pet:pet-offset-y";
const renderModeKey = "codex-pet:render-mode";
const terminalKey = "codex-pet:terminal";
const reminderConfigKey = "codex-pet:reminder-config";
const defaultPetSize = 236;
const defaultPetContainerWidth = 260;
const defaultPetContainerHeight = 260;
const minPetContainerDimension = 120;
const maxPetContainerDimension = 420;
const themePreviewPetSize = 112;
const themePreviewCanvasSize = 156;
const defaultPetVisualOffsetX = 0;
const defaultPetVisualOffsetY = 0;
const petVisualOffsetLimit = 36;
const petBubbleReserve = 72;
const maxReminderDurationMinutes = 24 * 60;
const maxReminderMessageCharacters = 1000;
const maxTaskCharacters = 64 * 1024;
const autoTerminal: TerminalOption = { id: "auto", label: "自动选择" };
const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const isSettingsWindow = isTauriRuntime && getCurrentWindow().label === "settings";
const reminderWeekdayOptions = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 0, label: "周日" },
] as const;
const defaultReminderConfig: ReminderConfig = {
  id: "reminder-default",
  enabled: false,
  title: "周报提醒",
  message: "老大，该写周报了。",
  weekday: 5,
  time: "16:00",
  durationMinutes: 0,
};

const stateLabels: Record<PetState, string> = {
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

const activeTaskStates = new Set<PetState>(["thinking", "working", "running_command", "editing_file"]);

function App() {
  const [packagePath, setPackagePath] = useState(() => localStorage.getItem(packagePathKey) ?? "");
  const [selectedPetPath, setSelectedPetPath] = useState(
    () => localStorage.getItem(packagePathKey) ?? "",
  );
  const [workdir, setWorkdir] = useState(() => localStorage.getItem(workdirKey) ?? "");
  const [codexPath, setCodexPath] = useState(() => localStorage.getItem(codexPathKey) ?? "");
  const [petSize, setPetSize] = useState(() => readPetSize());
  const [petContainerWidth, setPetContainerWidth] = useState(() =>
    readPetContainerDimension(petContainerWidthKey, defaultPetContainerWidth),
  );
  const [petContainerHeight, setPetContainerHeight] = useState(() =>
    readPetContainerDimension(petContainerHeightKey, defaultPetContainerHeight),
  );
  const [petOffsetX, setPetOffsetX] = useState(() => readPetOffset(petOffsetXKey, defaultPetVisualOffsetX));
  const [petOffsetY, setPetOffsetY] = useState(() => readPetOffset(petOffsetYKey, defaultPetVisualOffsetY));
  const [renderMode, setRenderMode] = useState<RenderMode>(() => readRenderMode());
  const [reminderSnapshots, setReminderSnapshots] = useState<ReminderSnapshot[]>(() => readReminderSnapshots());
  const [reminderDraft, setReminderDraft] = useState<ReminderConfig | null>(() =>
    readReminderSnapshots()[0]?.config ?? null,
  );
  const [selectedReminderId, setSelectedReminderId] = useState<string | null>(() =>
    readReminderSnapshots()[0]?.config.id ?? null,
  );
  const [pendingReminderDeleteId, setPendingReminderDeleteId] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState(() => localStorage.getItem(terminalKey) ?? autoTerminal.id);
  const [terminals, setTerminals] = useState<TerminalOption[]>([autoTerminal]);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(isSettingsWindow);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsModalPosition, setSettingsModalPosition] = useState<ModalPosition | null>(null);
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [currentState, setCurrentState] = useState<PetState>("idle");
  const [petBubble, setPetBubble] = useState<PetBubble | null>(null);
  const [activePet, setActivePet] = useState<PetCandidate | null>(null);
  const [candidates, setCandidates] = useState<PetCandidate[]>([]);
  const [events, setEvents] = useState<CodexEvent[]>([
    { kind: "idle", message: "准备就绪", state: "idle" },
  ]);
  const idleTimerRef = useRef<number | null>(null);
  const idleAfterDragRef = useRef(false);
  const petBubbleReserveRef = useRef(0);
  const dragRef = useRef<DragSession | null>(null);
  const modalDragRef = useRef<ModalDragSession | null>(null);
  const reminderTimerRef = useRef<number | null>(null);
  const reminderAutoHideTimerRef = useRef<number | null>(null);
  const reminderTokenRef = useRef(0);
  const windowLayoutKeyRef = useRef("");

  const visual = useMemo(() => {
    if (!activePet) {
      return null;
    }

    return resolveVisual(activePet, currentState);
  }, [activePet, currentState]);

  const latestMessage = events[events.length - 1]?.message ?? "准备就绪";
  const statusLabel = stateLabels[currentState] ?? "空闲";
  const bubbleVisible = petBubble !== null;
  const visualIdentity = visual
    ? `${visual.kind}-${visual.path}-${visual.row ?? "single"}-${currentState}`
    : `default-${currentState}`;
  const shellStyle = {
    "--pet-size": `${petSize}px`,
    "--pet-container-width": `${petContainerWidth}px`,
    "--pet-container-height": `${petContainerHeight}px`,
    "--pet-bubble-reserve": `${bubbleVisible ? petBubbleReserve : 0}px`,
    "--pet-bubble-shift": `${bubbleVisible ? petBubbleReserve / 2 : 0}px`,
    "--pet-visual-offset-x": `${petOffsetX}px`,
    "--pet-visual-offset-y": `${petOffsetY}px`,
  } as CSSProperties;
  const petPreferences: PetPreferences = {
    petSize,
    petContainerWidth,
    petContainerHeight,
    petOffsetX,
    petOffsetY,
    renderMode,
    packagePath: selectedPetPath,
  };
  const settingsModalStyle = settingsModalPosition
    ? ({
        left: `${settingsModalPosition.x}px`,
        top: `${settingsModalPosition.y}px`,
        transform: "none",
      } as CSSProperties)
    : undefined;
  const themePreviewStyle = {
    "--pet-size": `${themePreviewPetSize}px`,
    "--pet-canvas-size": `${themePreviewCanvasSize}px`,
    "--pet-visual-offset-x": "0px",
    "--pet-visual-offset-y": "0px",
  } as CSSProperties;
  const savedReminderDraft = reminderDraft
    ? reminderSnapshots.find((snapshot) => snapshot.config.id === reminderDraft.id)
    : undefined;
  const pendingReminderDelete = pendingReminderDeleteId
    ? reminderSnapshots.find((snapshot) => snapshot.config.id === pendingReminderDeleteId)
    : undefined;

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    void invoke("start_codex_session_monitor").catch((error) => {
      pushEvent({ kind: "monitor.error", message: String(error), state: "error" });
    });
    void invoke<ReminderStateSnapshot>("get_reminder_state")
      .then((snapshot) => {
        applyReminderState(snapshot);
      })
      .catch((error) => {
        pushEvent({ kind: "reminder.load.error", message: String(error), state: "error" });
      });
    void refreshCandidates();
    void refreshTerminals();

    const unlistenPromise = listen<CodexEvent>("codex-event", (event) => {
      const next = event.payload;
      pushEvent(next);
      const nextState = normalizeEventState(next);

      if (nextState && !isDragging()) {
        setCurrentState(nextState);
      }

      if (nextState !== null) {
        updatePetBubble(nextState, next.message);
        if (activeTaskStates.has(nextState)) {
          setRunning(true);
        }

        if (nextState === "idle" || nextState === "success" || nextState === "error") {
          setRunning(false);
        }

      }
    });
    const unlistenReminderPromise = listen<ReminderEvent>("reminder-triggered", (event) => {
      const reminder = event.payload;
      triggerReminderBubble({
        id: reminder.reminderId,
        enabled: true,
        title: reminder.title,
        message: reminder.message,
        weekday: defaultReminderConfig.weekday,
        time: defaultReminderConfig.time,
        durationMinutes: reminder.durationMinutes,
      });
      setReminderSnapshots((current) =>
        current.map((snapshot) =>
          snapshot.config.id === reminder.reminderId
            ? { ...snapshot, nextReminderAt: reminder.nextReminderAt }
            : snapshot,
        ),
      );
    });
    const unlistenReminderStatePromise = listen<ReminderStateSnapshot>(
      "reminder-state-updated",
      (event) => applyReminderState(event.payload, false),
    );
    const unlistenPreferencesPromise = listen<PetPreferences>("pet-preferences-updated", (event) => {
      applyPetPreferences(normalizePetPreferences(event.payload));
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
      void unlistenReminderPromise.then((unlisten) => unlisten());
      void unlistenReminderStatePromise.then((unlisten) => unlisten());
      void unlistenPreferencesPromise.then((unlisten) => unlisten());
      clearIdleTimer();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(petSizeKey, String(petSize));
  }, [petSize]);

  useEffect(() => {
    localStorage.setItem(petContainerWidthKey, String(petContainerWidth));
  }, [petContainerWidth]);

  useEffect(() => {
    localStorage.setItem(petContainerHeightKey, String(petContainerHeight));
  }, [petContainerHeight]);

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    const nextLayoutKey = `${petContainerWidth}:${petContainerHeight}:${bubbleVisible ? "bubble" : "plain"}`;
    if (windowLayoutKeyRef.current === nextLayoutKey) {
      return;
    }
    windowLayoutKeyRef.current = nextLayoutKey;

    const nextBubbleReserve = bubbleVisible ? petBubbleReserve : 0;
    const previousBubbleReserve = petBubbleReserveRef.current;
    void resizePetWindow(
      petContainerWidth,
      petContainerHeight,
      nextBubbleReserve,
      previousBubbleReserve,
    )
      .then(() => {
        petBubbleReserveRef.current = nextBubbleReserve;
      })
      .catch((error) => {
        pushEvent({ kind: "window.resize.error", message: String(error), state: "error" });
      });
  }, [petContainerWidth, petContainerHeight, bubbleVisible]);

  useEffect(() => {
    localStorage.setItem(petOffsetXKey, String(petOffsetX));
  }, [petOffsetX]);

  useEffect(() => {
    localStorage.setItem(petOffsetYKey, String(petOffsetY));
  }, [petOffsetY]);

  useEffect(() => {
    localStorage.setItem(renderModeKey, renderMode);
  }, [renderMode]);

  useEffect(() => {
    if (!isTauriRuntime) {
      localStorage.setItem(
        reminderConfigKey,
        JSON.stringify({ reminders: reminderSnapshots.map((snapshot) => snapshot.config) }),
      );
    }
  }, [reminderSnapshots]);

  useEffect(() => {
    localStorage.setItem(terminalKey, terminalId);
  }, [terminalId]);

  useEffect(() => {
    if (codexPath) {
      localStorage.setItem(codexPathKey, codexPath);
    } else {
      localStorage.removeItem(codexPathKey);
    }
  }, [codexPath]);

  useEffect(() => {
    if (isTauriRuntime) {
      return;
    }

    scheduleNextReminder();

    return () => {
      clearReminderScheduleTimer();
    };
  }, [reminderSnapshots]);

  useEffect(() => {
    return () => {
      clearReminderScheduleTimer();
      clearReminderAutoHideTimer();
    };
  }, []);

  useEffect(() => {
    if (selectedPetPath) {
      localStorage.setItem(packagePathKey, selectedPetPath);
    } else {
      localStorage.removeItem(packagePathKey);
    }
  }, [selectedPetPath]);

  useEffect(() => {
    if (workdir) {
      localStorage.setItem(workdirKey, workdir);
    } else {
      localStorage.removeItem(workdirKey);
    }
  }, [workdir]);

  useEffect(() => {
    setActivePet(candidates.find((candidate) => candidate.path === selectedPetPath) ?? null);
  }, [candidates, selectedPetPath]);

  async function refreshCandidates() {
    if (!isTauriRuntime) {
      pushEvent({ kind: "browser", message: "请在 Tauri 桌面窗口中刷新本地宠物", state: "idle" });
      return;
    }

    try {
      const found = await invoke<PetCandidate[]>("find_pet_candidates");
      setCandidates(found);
      setActivePet(found.find((candidate) => candidate.path === selectedPetPath) ?? null);
      pushEvent({ kind: "scan", message: `发现 ${found.length} 个可用宠物资源`, state: "idle" });
    } catch (error) {
      setCurrentState("error");
      pushEvent({ kind: "scan.error", message: String(error), state: "error" });
      scheduleIdle();
    }
  }

  async function refreshTerminals() {
    if (!isTauriRuntime) {
      return;
    }

    try {
      const found = await invoke<TerminalOption[]>("list_terminals");
      const next = found.length > 0 ? found : [autoTerminal];
      setTerminals(next);
      if (!next.some((terminal) => terminal.id === terminalId)) {
        setTerminalId(autoTerminal.id);
      }
    } catch (error) {
      pushEvent({ kind: "terminal.scan.error", message: String(error), state: "error" });
    }
  }

  async function importPackage() {
    if (importing) {
      return;
    }
    if (!packagePath.trim()) {
      pushEvent({ kind: "import.empty", message: "先输入动画包目录、zip 或图片路径", state: "waiting_input" });
      setCurrentState("waiting_input");
      return;
    }

    if (!isTauriRuntime) {
      pushEvent({ kind: "browser", message: "浏览器预览不支持导入本地动画包", state: "idle" });
      return;
    }

    setImporting(true);
    try {
      const imported = await invoke<PetCandidate>("import_pet_package", {
        sourcePath: packagePath,
      });
      setActivePet(imported);
      updatePetPreference("packagePath", imported.path);
      setCurrentState("success");
      if (!candidates.some((candidate) => candidate.path === imported.path)) {
        setCandidates((current) => [...current, imported]);
      }
      pushEvent({ kind: "import.ok", message: `已导入：${imported.name}`, state: "success" });
      scheduleIdle();
    } catch (error) {
      setCurrentState("error");
      pushEvent({ kind: "import.error", message: String(error), state: "error" });
      scheduleIdle();
    } finally {
      setImporting(false);
    }
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!task.trim() || running) {
      return;
    }

    if (!isTauriRuntime) {
      pushEvent({ kind: "browser", message: "浏览器预览不支持启动 Codex CLI", state: "idle" });
      return;
    }

    setRunning(true);
    closeSettings();
    setContextMenuOpen(false);
    setCurrentState("thinking");
    const queuedEvent: CodexEvent = { kind: "queued", message: "任务已发送", state: "thinking" };
    pushEvent(queuedEvent);
    updatePetBubble("thinking", queuedEvent.message);

    try {
      await invoke("run_codex_task", {
        prompt: task,
        cwd: workdir || null,
        codexPath: codexPath.trim() || null,
      });
      setTask("");
    } catch (error) {
      setRunning(false);
      setCurrentState("error");
      const errorMessage = String(error);
      pushEvent({ kind: "error", message: errorMessage, state: "error" });
      updatePetBubble("error", errorMessage);
    }
  }

  function pushEvent(event: CodexEvent) {
    setEvents((current) => [...current.slice(-5), event]);
  }

  function applyPetPreferences(preferences: PetPreferences, updatePathDraft = true) {
    setPetSize(preferences.petSize);
    setPetContainerWidth(preferences.petContainerWidth);
    setPetContainerHeight(preferences.petContainerHeight);
    setPetOffsetX(preferences.petOffsetX);
    setPetOffsetY(preferences.petOffsetY);
    setRenderMode(preferences.renderMode);
    setSelectedPetPath(preferences.packagePath);
    if (updatePathDraft) {
      setPackagePath(preferences.packagePath);
    }
  }

  function updatePetPreference<Key extends keyof PetPreferences>(
    key: Key,
    value: PetPreferences[Key],
  ) {
    const preferences = normalizePetPreferences({ ...petPreferences, [key]: value });
    applyPetPreferences(preferences, key === "packagePath");
    if (isTauriRuntime) {
      void emitTo("main", "pet-preferences-updated", preferences).catch((error) => {
        pushEvent({ kind: "preferences.sync.error", message: String(error), state: "error" });
      });
    }
  }

  function applyReminderState(snapshot: ReminderStateSnapshot, updateDraft = true) {
    const reminders = normalizeReminderSnapshots(snapshot.reminders);
    setReminderSnapshots(reminders);
    if (!updateDraft) {
      return;
    }
    const selected =
      reminders.find((reminder) => reminder.config.id === selectedReminderId) ?? reminders[0] ?? null;
    setSelectedReminderId(selected?.config.id ?? null);
    setReminderDraft(selected ? { ...selected.config } : null);
  }

  function clearReminderScheduleTimer() {
    if (reminderTimerRef.current !== null) {
      window.clearTimeout(reminderTimerRef.current);
      reminderTimerRef.current = null;
    }
  }

  function clearReminderAutoHideTimer() {
    if (reminderAutoHideTimerRef.current !== null) {
      window.clearTimeout(reminderAutoHideTimerRef.current);
      reminderAutoHideTimerRef.current = null;
    }
  }

  function scheduleNextReminder() {
    clearReminderScheduleTimer();
    const nextReminder = findNextReminder(reminderSnapshots);
    if (!nextReminder) {
      return;
    }

    const delay = Math.max(0, nextReminder.nextReminderAt - Date.now());
    reminderTimerRef.current = window.setTimeout(() => {
      triggerReminderBubble(nextReminder.config);
      const nextNow = new Date(Date.now() + 1000);
      setReminderSnapshots((current) =>
        current.map((snapshot) => ({
          config: snapshot.config,
          nextReminderAt: nextReminderDate(snapshot.config, nextNow)?.getTime() ?? null,
        })),
      );
    }, delay);
  }

  function triggerReminderBubble(config: ReminderConfig) {
    clearReminderAutoHideTimer();
    reminderTokenRef.current += 1;
    const nextToken = reminderTokenRef.current;
    const title = config.title.trim() || defaultReminderConfig.title;
    const message = normalizeBubbleMessage(config.message, defaultReminderConfig.message);

    setPetBubble({
      tone: "reminder",
      label: title,
      message,
      dismissible: true,
      source: "reminder",
    });
    pushEvent({ kind: "reminder.triggered", message: `${title}：${message}`, state: "idle" });

    if (config.durationMinutes > 0) {
      reminderAutoHideTimerRef.current = window.setTimeout(() => {
        if (reminderTokenRef.current !== nextToken) {
          return;
        }

        setPetBubble((current) => (current?.source === "reminder" ? null : current));
        reminderAutoHideTimerRef.current = null;
      }, config.durationMinutes * 60 * 1000);
    }
  }

  function previewReminder() {
    if (!reminderDraft) {
      return;
    }
    const config = normalizeReminderConfig(reminderDraft);
    if (!isTauriRuntime) {
      triggerReminderBubble(config);
      return;
    }

    void invoke("preview_reminder", { config }).catch((error) => {
      pushEvent({ kind: "reminder.preview.error", message: String(error), state: "error" });
    });
  }

  function saveReminderConfig() {
    if (!reminderDraft) {
      return;
    }
    const nextConfig = normalizeReminderConfig(reminderDraft);
    setSelectedReminderId(nextConfig.id);
    if (!isTauriRuntime) {
      const nextSnapshots = upsertReminderSnapshot(reminderSnapshots, nextConfig);
      setReminderDraft(nextConfig);
      setReminderSnapshots(nextSnapshots);
      pushEvent({ kind: "reminder.saved", message: "提醒任务已保存", state: "idle" });
      return;
    }

    void invoke<ReminderStateSnapshot>("save_reminder_config", { config: nextConfig })
      .then((snapshot) => {
        const reminders = normalizeReminderSnapshots(snapshot.reminders);
        const saved = reminders.find((reminder) => reminder.config.id === nextConfig.id);
        setReminderSnapshots(reminders);
        setSelectedReminderId(saved?.config.id ?? null);
        setReminderDraft(saved ? { ...saved.config } : null);
        pushEvent({ kind: "reminder.saved", message: "提醒任务已保存", state: "idle" });
      })
      .catch((error) => {
        pushEvent({ kind: "reminder.save.error", message: String(error), state: "error" });
      });
  }

  function resetReminderDraft() {
    if (!reminderDraft) {
      return;
    }
    const saved = reminderSnapshots.find(
      (reminder) => reminder.config.id === reminderDraft.id,
    );
    setReminderDraft(
      saved
        ? { ...saved.config }
        : { ...createReminderConfig(), id: reminderDraft.id },
    );
  }

  function createReminder() {
    const reminder = createReminderConfig();
    setSelectedReminderId(reminder.id);
    setReminderDraft(reminder);
  }

  function editReminder(snapshot: ReminderSnapshot) {
    setSelectedReminderId(snapshot.config.id);
    setReminderDraft({ ...snapshot.config });
  }

  function requestReminderDeletion(reminderId: string) {
    const existing = reminderSnapshots.find((reminder) => reminder.config.id === reminderId);
    if (!existing) {
      return;
    }

    setPendingReminderDeleteId(existing.config.id);
  }

  function confirmReminderDeletion() {
    const reminderId = pendingReminderDeleteId;
    if (!reminderId) {
      return;
    }
    setPendingReminderDeleteId(null);

    const applyDeletedState = (snapshot: ReminderStateSnapshot) => {
      const reminders = normalizeReminderSnapshots(snapshot.reminders);
      setReminderSnapshots(reminders);
      if (selectedReminderId !== reminderId) {
        return;
      }
      const first = reminders[0] ?? null;
      setSelectedReminderId(first?.config.id ?? null);
      setReminderDraft(first ? { ...first.config } : null);
    };

    if (!isTauriRuntime) {
      applyDeletedState({
        reminders: reminderSnapshots.filter(
          (reminder) => reminder.config.id !== reminderId,
        ),
      });
      pushEvent({ kind: "reminder.deleted", message: "提醒任务已删除", state: "idle" });
      return;
    }

    void invoke<ReminderStateSnapshot>("delete_reminder_config", { reminderId })
      .then((snapshot) => {
        applyDeletedState(snapshot);
        pushEvent({ kind: "reminder.deleted", message: "提醒任务已删除", state: "idle" });
      })
      .catch((error) => {
        pushEvent({ kind: "reminder.delete.error", message: String(error), state: "error" });
      });
  }

  function updateReminderDraft<Key extends keyof ReminderConfig>(
    key: Key,
    value: ReminderConfig[Key],
  ) {
    setReminderDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function updatePetBubble(state: PetState, message: string) {
    if (state === "idle") {
      setPetBubble((current) => (current?.source === "reminder" ? current : null));
      return;
    }

    clearIdleTimer();

    if (activeTaskStates.has(state)) {
      setPetBubble({
        tone: "working",
        label: "进行中",
        message: normalizeBubbleMessage(message, "Codex 正在处理任务"),
        source: "status",
      });
      return;
    }

    if (state === "success") {
      setPetBubble({
        tone: "success",
        label: "成功",
        message: normalizeBubbleMessage(message, "任务完成"),
        dismissible: true,
        source: "status",
      });
      return;
    }

    if (state === "error") {
      setPetBubble({
        tone: "error",
        label: "失败",
        message: normalizeBubbleMessage(message, "任务失败"),
        dismissible: true,
        source: "status",
      });
      return;
    }
  }

  function closePetBubble() {
    clearIdleTimer();
    clearReminderAutoHideTimer();
    const closingBubble = petBubble;
    setPetBubble(null);
    if (closingBubble?.source !== "reminder" && (currentState === "success" || currentState === "error")) {
      setCurrentState("idle");
    }
  }

  function clearIdleTimer() {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    idleAfterDragRef.current = false;
  }

  function scheduleIdle() {
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(() => {
      if (!isDragging()) {
        setCurrentState("idle");
        setPetBubble((current) => (current?.source === "reminder" ? current : null));
      } else {
        idleAfterDragRef.current = true;
      }
      idleTimerRef.current = null;
    }, 2600);
  }

  function isDragging() {
    return dragRef.current !== null;
  }

  async function startPetDrag(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".settings-modal,.context-tablist")) {
      return;
    }

    event.preventDefault();
    setSettingsOpen(false);
    setContextMenuOpen(false);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

    if (!isTauriRuntime) {
      setCurrentState("dragging");
      return;
    }

    try {
      const appWindow = getCurrentWindow();
      const position = await appWindow.outerPosition();
      const scaleFactor = await appWindow.scaleFactor();
      const [outerSize, monitor] = await Promise.all([
        appWindow.outerSize(),
        currentMonitor().then((value) => value ?? primaryMonitor()),
      ]);

      dragRef.current = {
        pointerId: event.pointerId,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        lastScreenX: event.screenX,
        startWindowX: position.x,
        startWindowY: position.y,
        scaleFactor,
        bounds: monitor ? monitorDragBounds(monitor, outerSize) : null,
        previousState: currentState,
        latestState: "dragging",
        pendingFrame: null,
      };
      setCurrentState("dragging");
    } catch (error) {
      try {
        (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the OS.
      }
      setCurrentState("error");
      pushEvent({ kind: "window.drag.error", message: String(error), state: "error" });
      scheduleIdle();
    }
  }

  function movePet(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !isTauriRuntime) {
      return;
    }

    const deltaX = event.screenX - drag.startScreenX;
    const deltaY = event.screenY - drag.startScreenY;
    const movementX = event.screenX - drag.lastScreenX;
    const pointerId = event.pointerId;
    const directionState: PetState =
      movementX < -1 ? "dragging_left" : movementX > 1 ? "dragging_right" : drag.latestState;
    drag.lastScreenX = event.screenX;
    if (drag.latestState !== directionState) {
      drag.latestState = directionState;
      setCurrentState(directionState);
    }

    if (drag.pendingFrame !== null) {
      window.cancelAnimationFrame(drag.pendingFrame);
    }

    drag.pendingFrame = window.requestAnimationFrame(() => {
      const currentDrag = dragRef.current;
      if (!currentDrag || currentDrag.pointerId !== pointerId) {
        return;
      }

      currentDrag.pendingFrame = null;
      const nextX = Math.round(currentDrag.startWindowX + deltaX * currentDrag.scaleFactor);
      const nextY = Math.round(currentDrag.startWindowY + deltaY * currentDrag.scaleFactor);
      const boundedPosition = clampWindowPosition(nextX, nextY, currentDrag.bounds);
      void getCurrentWindow().setPosition(
        new PhysicalPosition(boundedPosition.x, boundedPosition.y),
      );
    });
  }

  function endPetDrag(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    dragRef.current = null;
    if (drag.pendingFrame !== null) {
      window.cancelAnimationFrame(drag.pendingFrame);
    }
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the OS.
    }
    if (idleAfterDragRef.current && !running) {
      idleAfterDragRef.current = false;
      setCurrentState("idle");
      setPetBubble((current) => (current?.source === "reminder" ? current : null));
      return;
    }

    setCurrentState(running ? "working" : drag.previousState === "idle" ? "idle" : drag.previousState);
  }

  function openContextMenu(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    setContextMenuOpen(true);
    setSettingsOpen(false);
  }

  async function openSettingsModal() {
    setContextMenuOpen(false);
    if (isTauriRuntime && !isSettingsWindow) {
      try {
        await invoke("open_settings_window");
      } catch (error) {
        pushEvent({ kind: "settings.open.error", message: String(error), state: "error" });
      }
      return;
    }
    setSettingsSection("general");
    setSettingsModalPosition(null);
    setSettingsOpen(true);
  }

  function closeSettings() {
    if (isTauriRuntime && isSettingsWindow) {
      void invoke("hide_settings_window").catch((error) => {
        pushEvent({ kind: "settings.hide.error", message: String(error), state: "error" });
      });
      return;
    }
    setSettingsOpen(false);
    setSettingsModalPosition(null);
  }

  async function minimizeWindow() {
    if (isTauriRuntime) {
      await getCurrentWindow().minimize();
    }
  }

  function quitApplication() {
    if (!isTauriRuntime) {
      window.close();
      return;
    }
    void invoke("quit_app");
  }

  function selectCandidate(candidate: PetCandidate) {
    setActivePet(candidate);
    updatePetPreference("packagePath", candidate.path);
    setCurrentState("idle");
    pushEvent({ kind: "pet.selected", message: `已选择：${candidate.name}`, state: "idle" });
  }

  function selectDefaultPet() {
    setActivePet(null);
    updatePetPreference("packagePath", "");
    setCurrentState("idle");
    pushEvent({ kind: "pet.selected", message: "已选择：默认主题", state: "idle" });
  }

  async function openTerminal() {
    if (!isTauriRuntime) {
      pushEvent({ kind: "browser", message: "浏览器预览不支持打开终端", state: "idle" });
      return;
    }

    try {
      await invoke("open_terminal", {
        cwd: workdir || null,
        terminal: terminalId,
      });
      pushEvent({ kind: "terminal.opened", message: "已打开终端", state: "idle" });
    } catch (error) {
      setCurrentState("error");
      pushEvent({ kind: "terminal.error", message: String(error), state: "error" });
      scheduleIdle();
    }
  }

  async function pickWorkPath(kind: "file" | "directory") {
    if (!isTauriRuntime) {
      pushEvent({ kind: "browser", message: "浏览器预览不支持选择本地路径", state: "idle" });
      return;
    }

    try {
      const selected = await open({
        title: kind === "directory" ? "选择工作目录" : "选择工作文件",
        directory: kind === "directory",
        multiple: false,
      });
      if (selected) {
        setWorkdir(selected);
        pushEvent({ kind: "path.selected", message: `已选择：${selected}`, state: "idle" });
      }
    } catch (error) {
      setCurrentState("error");
      pushEvent({ kind: "path.select.error", message: String(error), state: "error" });
      scheduleIdle();
    }
  }

  async function pickCodexExecutable() {
    if (!isTauriRuntime) {
      pushEvent({ kind: "browser", message: "浏览器预览不支持选择 Codex 路径", state: "idle" });
      return;
    }

    try {
      const selected = await open({
        title: "选择 Codex 可执行文件",
        directory: false,
        multiple: false,
      });
      if (selected) {
        setCodexPath(selected);
        pushEvent({ kind: "codex.path.selected", message: `已选择 Codex：${selected}`, state: "idle" });
      }
    } catch (error) {
      setCurrentState("error");
      pushEvent({ kind: "codex.path.error", message: String(error), state: "error" });
      scheduleIdle();
    }
  }

  function startSettingsModalDrag(event: PointerEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (
      event.button !== 0 ||
      !target.closest(".settings-drag-handle") ||
      target.closest("button,input,select,textarea")
    ) {
      return;
    }

    event.preventDefault();
    if (isTauriRuntime && isSettingsWindow) {
      void getCurrentWindow().startDragging().catch((error) => {
        pushEvent({ kind: "settings.drag.error", message: String(error), state: "error" });
      });
      return;
    }
    const modal = event.currentTarget;
    const rect = modal.getBoundingClientRect();
    const pointerId = event.pointerId;
    const fallbackBounds = modalViewportBounds(rect.width, rect.height);
    modalDragRef.current = {
      pointerId,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startX: rect.left,
      startY: rect.top,
      width: rect.width,
      height: rect.height,
      bounds: fallbackBounds,
    };
    modal.setPointerCapture(pointerId);
    setSettingsModalPosition(clampWindowPosition(rect.left, rect.top, fallbackBounds));

    void modalMonitorBounds(rect.width, rect.height)
      .then((bounds) => {
        const drag = modalDragRef.current;
        if (!drag || drag.pointerId !== pointerId) {
          return;
        }

        drag.bounds = bounds;
        setSettingsModalPosition((current) => {
          const position = current ?? { x: drag.startX, y: drag.startY };
          return clampWindowPosition(position.x, position.y, bounds);
        });
      })
      .catch(() => undefined);
  }

  function moveSettingsModal(event: PointerEvent<HTMLElement>) {
    const drag = modalDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const nextX = drag.startX + event.clientX - drag.startPointerX;
    const nextY = drag.startY + event.clientY - drag.startPointerY;
    setSettingsModalPosition(clampWindowPosition(nextX, nextY, drag.bounds));
  }

  function endSettingsModalDrag(event: PointerEvent<HTMLElement>) {
    const drag = modalDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    modalDragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the OS.
    }
  }

  return (
    <main
      className={`${isSettingsWindow ? "settings-window-shell" : "pet-shell"} ${settingsOpen ? "has-settings" : ""}`}
      style={shellStyle}
    >
      {!isSettingsWindow && (
        <section
          className={`pet-stage state-${currentState} render-${renderMode} ${bubbleVisible ? "has-bubble" : ""}`}
          aria-label="桌宠"
          onPointerDown={startPetDrag}
          onPointerMove={movePet}
          onPointerUp={endPetDrag}
          onPointerCancel={endPetDrag}
          onContextMenu={openContextMenu}
        >
          {petBubble && (
            <div
              className={`pet-bubble tone-${petBubble.tone} ${petBubble.dismissible ? "is-dismissible" : ""}`}
              role="status"
              aria-live="polite"
            >
              <div className="pet-bubble-header">
                <strong>{petBubble.label}</strong>
                {petBubble.dismissible && (
                  <button
                    className="pet-bubble-close"
                    type="button"
                    aria-label="关闭状态提示"
                    title="关闭状态提示"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      closePetBubble();
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <span>{petBubble.message}</span>
            </div>
          )}
          <PetVisualView
            key={visualIdentity}
            visual={visual}
            state={currentState}
            renderMode={renderMode}
            petSize={petSize}
          />
        </section>
      )}

      {!isSettingsWindow && contextMenuOpen && (
        <div className="context-tablist" role="menu" aria-label="桌宠菜单" onContextMenu={(event) => event.preventDefault()}>
          <button type="button" role="menuitem" onClick={openSettingsModal}>
            <Settings size={16} />
            <span>设置</span>
          </button>
          <button className="danger" type="button" role="menuitem" onClick={quitApplication}>
            <Power size={16} />
            <span>退出</span>
          </button>
        </div>
      )}

      {(isSettingsWindow || settingsOpen) && (
        <section
          className="settings-modal"
          style={isSettingsWindow ? undefined : settingsModalStyle}
          role="dialog"
          aria-modal={!isSettingsWindow}
          aria-label="桌宠设置"
          onPointerDown={startSettingsModalDrag}
          onPointerMove={moveSettingsModal}
          onPointerUp={endSettingsModalDrag}
          onPointerCancel={endSettingsModalDrag}
          onContextMenu={(event) => event.preventDefault()}
        >
          <aside className="settings-sidebar">
            <header className="settings-drag-handle">
              <span className="eyebrow">Codex Pet</span>
              <h1>设置</h1>
            </header>
            <nav className="settings-menu" aria-label="设置菜单">
              <button
                className={settingsSection === "general" ? "active" : ""}
                type="button"
                onClick={() => setSettingsSection("general")}
              >
                <SlidersHorizontal size={17} />
                <span>通用</span>
              </button>
              <button
                className={settingsSection === "theme" ? "active" : ""}
                type="button"
                onClick={() => setSettingsSection("theme")}
              >
                <Palette size={17} />
                <span>主题</span>
              </button>
              <button
                className={settingsSection === "reminder" ? "active" : ""}
                type="button"
                onClick={() => setSettingsSection("reminder")}
              >
                <Bell size={17} />
                <span>提醒</span>
              </button>
              <button
                className={settingsSection === "work" ? "active" : ""}
                type="button"
                onClick={() => setSettingsSection("work")}
              >
                <Terminal size={17} />
                <span>工作任务</span>
              </button>
            </nav>
            <div className="sidebar-actions">
              <button className="icon-button" type="button" title="最小化" onClick={minimizeWindow}>
                <Minus size={16} />
              </button>
              <button className="icon-button danger" type="button" title="退出应用" onClick={quitApplication}>
                <Power size={16} />
              </button>
            </div>
          </aside>

          <section className="settings-content">
            <header className="settings-content-header settings-drag-handle">
              <div>
                <span className="status-chip">{statusLabel}</span>
                <p>{latestMessage}</p>
              </div>
              <button className="icon-button" type="button" title="关闭设置" onClick={closeSettings}>
                <X size={16} />
              </button>
            </header>

            {settingsSection === "general" && (
              <div className="settings-page">
                <div className="section-title">
                  <h2>通用</h2>
                </div>
                <label className="field">
                  <span>桌宠大小</span>
                  <div className="range-row">
                    <input
                      type="range"
                      min="150"
                      max="330"
                      step="5"
                      value={petSize}
                      onChange={(event) =>
                        updatePetPreference("petSize", clampPetSize(Number(event.currentTarget.value)))
                      }
                    />
                    <output>{petSize}px</output>
                  </div>
                </label>
                <div className="field">
                  <span>桌宠容器</span>
                  <div className="container-size-row">
                    <label>
                      <span>宽度</span>
                      <input
                        type="number"
                        min={minPetContainerDimension}
                        max={maxPetContainerDimension}
                        step="4"
                        value={petContainerWidth}
                        onChange={(event) =>
                          updatePetPreference(
                            "petContainerWidth",
                            clampPetContainerDimension(Number(event.currentTarget.value)),
                          )
                        }
                      />
                    </label>
                    <label>
                      <span>高度</span>
                      <input
                        type="number"
                        min={minPetContainerDimension}
                        max={maxPetContainerDimension}
                        step="4"
                        value={petContainerHeight}
                        onChange={(event) =>
                          updatePetPreference(
                            "petContainerHeight",
                            clampPetContainerDimension(Number(event.currentTarget.value)),
                          )
                        }
                      />
                    </label>
                  </div>
                </div>
                <div className="field">
                  <span>显示偏移</span>
                  <div className="offset-row">
                    <label className="offset-control">
                      <span aria-hidden="true">X</span>
                      <input
                        aria-label="显示偏移 X"
                        type="range"
                        min={-petVisualOffsetLimit}
                        max={petVisualOffsetLimit}
                        step="1"
                        value={petOffsetX}
                        onChange={(event) =>
                          updatePetPreference("petOffsetX", clampPetOffset(Number(event.currentTarget.value)))
                        }
                      />
                      <output>{petOffsetX}px</output>
                    </label>
                    <label className="offset-control">
                      <span aria-hidden="true">Y</span>
                      <input
                        aria-label="显示偏移 Y"
                        type="range"
                        min={-petVisualOffsetLimit}
                        max={petVisualOffsetLimit}
                        step="1"
                        value={petOffsetY}
                        onChange={(event) =>
                          updatePetPreference("petOffsetY", clampPetOffset(Number(event.currentTarget.value)))
                        }
                      />
                      <output>{petOffsetY}px</output>
                    </label>
                  </div>
                </div>
                <label className="field">
                  <span>渲染方式</span>
                  <select
                    value={renderMode}
                    onChange={(event) =>
                      updatePetPreference("renderMode", event.currentTarget.value as RenderMode)
                    }
                  >
                    <option value="smooth">平滑</option>
                    <option value="pixelated">像素</option>
                  </select>
                </label>
              </div>
            )}

            {settingsSection === "theme" && (
              <div className="settings-page">
                <div className="section-title with-action">
                  <h2>主题</h2>
                  <button className="icon-button" type="button" title="刷新主题" onClick={refreshCandidates}>
                    <RefreshCw size={16} />
                  </button>
                </div>
                <div className="theme-grid" aria-label="主题列表">
                  <button
                    className={`theme-card ${activePet ? "" : "active"}`}
                    type="button"
                    onClick={selectDefaultPet}
                  >
                    <div className="theme-preview" style={themePreviewStyle}>
                      <PetVisualView visual={null} state="idle" renderMode={renderMode} petSize={themePreviewPetSize} />
                    </div>
                    <div>
                      <strong>默认主题</strong>
                      <span>内置</span>
                    </div>
                    {!activePet && <Check size={16} />}
                  </button>

                  {candidates.map((candidate) => (
                    <button
                      className={`theme-card ${activePet?.path === candidate.path ? "active" : ""}`}
                      key={candidate.path}
                      type="button"
                      title={candidate.path}
                      onClick={() => selectCandidate(candidate)}
                    >
                      <div className="theme-preview" style={themePreviewStyle}>
                        <PetVisualView
                          visual={resolveVisual(candidate, "idle")}
                          state="idle"
                          renderMode={renderMode}
                          petSize={themePreviewPetSize}
                        />
                      </div>
                      <div>
                        <strong>{candidate.name}</strong>
                        <span>{candidate.kind}</span>
                      </div>
                      {activePet?.path === candidate.path && <Check size={16} />}
                    </button>
                  ))}
                </div>

                <label className="field">
                  <span>动画包 / 图片路径</span>
                  <div className="path-row">
                    <input
                      value={packagePath}
                      onChange={(event) => setPackagePath(event.currentTarget.value)}
                      placeholder="选择目录、zip 或图片文件"
                    />
                    <button
                      className="icon-button"
                      type="button"
                      title="导入动画包"
                      disabled={importing}
                      onClick={importPackage}
                    >
                      {importing ? <LoaderCircle className="spin-icon" size={16} /> : <Import size={16} />}
                    </button>
                  </div>
                </label>
              </div>
            )}

            {settingsSection === "reminder" && (
              <div className="settings-page reminder-page">
                <div className="section-title with-action">
                  <h2>定时提醒</h2>
                  <button className="secondary-button" type="button" onClick={createReminder}>
                    <Plus size={15} />
                    <span>新建提醒</span>
                  </button>
                </div>

                <div className="reminder-workspace">
                  <div className="reminder-list" aria-label="提醒任务列表">
                    {reminderSnapshots.length === 0 && (
                      <div className="reminder-empty">
                        <Bell size={18} />
                        <span>暂无提醒任务</span>
                      </div>
                    )}
                    {reminderSnapshots.map((snapshot) => (
                      <div
                        className={`reminder-list-item ${selectedReminderId === snapshot.config.id ? "active" : ""}`}
                        key={snapshot.config.id}
                      >
                        <button type="button" onClick={() => editReminder(snapshot)}>
                          <span>
                            <strong>{snapshot.config.title}</strong>
                            <small>
                              {formatReminderSchedule(
                                snapshot.nextReminderAt,
                                snapshot.config.enabled,
                              )}
                            </small>
                          </span>
                          <Pencil size={14} />
                        </button>
                        <button
                          className="reminder-delete-button"
                          type="button"
                          title="删除提醒"
                          aria-label={`删除提醒 ${snapshot.config.title}`}
                          onClick={() => requestReminderDeletion(snapshot.config.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>

                  {reminderDraft ? (
                    <div className="reminder-editor">
                      <header className="reminder-editor-header">
                        <div>
                          <strong>{savedReminderDraft ? "编辑提醒" : "新建提醒"}</strong>
                          <span>
                            {formatReminderSchedule(
                              savedReminderDraft?.nextReminderAt ?? null,
                              reminderDraft.enabled,
                            )}
                          </span>
                        </div>
                        <div className="reminder-actions">
                          <button
                            className="icon-button"
                            type="button"
                            title="还原当前提醒"
                            onClick={resetReminderDraft}
                          >
                            <RefreshCw size={16} />
                          </button>
                          <button className="secondary-button" type="button" onClick={saveReminderConfig}>
                            <Check size={15} />
                            <span>保存</span>
                          </button>
                        </div>
                      </header>

                      <div className="reminder-summary">
                        <div>
                          <strong>下次提醒</strong>
                          <span>
                            {formatReminderSchedule(
                              savedReminderDraft?.nextReminderAt ?? null,
                              reminderDraft.enabled,
                            )}
                          </span>
                        </div>
                        <button className="secondary-button" type="button" onClick={previewReminder}>
                          <Bell size={15} />
                          <span>立即测试</span>
                        </button>
                      </div>

                      <label className="toggle-field">
                        <span>启用提醒</span>
                        <input
                          type="checkbox"
                          checked={reminderDraft.enabled}
                          onChange={(event) =>
                            updateReminderDraft("enabled", event.currentTarget.checked)
                          }
                        />
                        <span className="toggle-track" aria-hidden="true" />
                      </label>

                      <label className="field">
                        <span>提醒标题</span>
                        <input
                          value={reminderDraft.title}
                          maxLength={16}
                          onChange={(event) => updateReminderDraft("title", event.currentTarget.value)}
                          placeholder="例如：周报提醒"
                        />
                      </label>

                      <label className="field">
                        <span>提醒内容</span>
                        <textarea
                          value={reminderDraft.message}
                          rows={3}
                          maxLength={maxReminderMessageCharacters}
                          onChange={(event) => updateReminderDraft("message", event.currentTarget.value)}
                          placeholder="例如：老大，该写周报了。"
                        />
                      </label>

                      <div className="reminder-grid">
                        <label className="field">
                          <span>提醒日期</span>
                          <select
                            value={String(reminderDraft.weekday)}
                            onChange={(event) =>
                              updateReminderDraft(
                                "weekday",
                                clampReminderWeekday(Number(event.currentTarget.value)),
                              )
                            }
                          >
                            {reminderWeekdayOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="field">
                          <span>提醒时间</span>
                          <input
                            type="time"
                            value={reminderDraft.time}
                            onChange={(event) =>
                              updateReminderDraft(
                                "time",
                                normalizeReminderTime(event.currentTarget.value),
                              )
                            }
                          />
                        </label>
                      </div>

                      <label className="field">
                        <span>提醒时长（分钟）</span>
                        <input
                          type="number"
                          min="0"
                          max={String(maxReminderDurationMinutes)}
                          value={reminderDraft.durationMinutes}
                          onChange={(event) =>
                            updateReminderDraft(
                              "durationMinutes",
                              clampReminderDuration(Number(event.currentTarget.value)),
                            )
                          }
                        />
                        <small className="field-hint">0 表示持续显示，直到手动关闭。</small>
                      </label>
                    </div>
                  ) : (
                    <div className="reminder-empty editor-empty">
                      <Bell size={20} />
                      <span>选择或新建提醒任务</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {settingsSection === "work" && (
              <div className="settings-page">
                <div className="section-title">
                  <h2>工作任务</h2>
                </div>
                <label className="field">
                  <span>Codex CLI 路径</span>
                  <div className="work-path-row">
                    <input
                      value={codexPath}
                      onChange={(event) => setCodexPath(event.currentTarget.value)}
                      placeholder="留空自动查找，例如 C:\\Program Files\\nodejs\\codex.cmd"
                    />
                    <button className="icon-button" type="button" title="选择 Codex 可执行文件" onClick={pickCodexExecutable}>
                      <FileSearch size={16} />
                    </button>
                    <button className="icon-button" type="button" title="清空 Codex 路径" onClick={() => setCodexPath("")}>
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
                      onChange={(event) => setWorkdir(event.currentTarget.value)}
                      placeholder="输入目录或文件路径，留空则使用用户目录"
                    />
                    <button className="icon-button" type="button" title="选择目录" onClick={() => pickWorkPath("directory")}>
                      <FolderSearch size={16} />
                    </button>
                    <button className="icon-button" type="button" title="选择文件" onClick={() => pickWorkPath("file")}>
                      <FileSearch size={16} />
                    </button>
                  </div>
                </label>

                <label className="field">
                  <span>终端</span>
                  <div className="terminal-row">
                    <select value={terminalId} onChange={(event) => setTerminalId(event.currentTarget.value)}>
                      {terminals.map((terminal) => (
                        <option key={terminal.id} value={terminal.id}>
                          {terminal.label}
                        </option>
                      ))}
                    </select>
                    <button className="secondary-button" type="button" onClick={openTerminal}>
                      <FolderOpen size={16} />
                      <span>打开终端</span>
                    </button>
                  </div>
                </label>

                <form className="task-form" onSubmit={submitTask}>
                  <label className="field">
                    <span>任务</span>
                    <textarea
                      value={task}
                      rows={3}
                      maxLength={maxTaskCharacters}
                      onChange={(event) => setTask(event.currentTarget.value)}
                      placeholder="让 Codex 检查这个项目并总结下一步"
                    />
                  </label>

                  <button className="run-button" type="submit" disabled={running || !task.trim()}>
                    {running ? <LoaderCircle size={18} /> : <Play size={18} />}
                    <span>{running ? "处理中" : "发送给 Codex"}</span>
                  </button>
                </form>

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
            )}
          </section>

          {pendingReminderDelete && (
            <div className="confirmation-backdrop" role="presentation">
              <section
                className="confirmation-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="delete-reminder-title"
              >
                <div className="confirmation-icon" aria-hidden="true">
                  <Trash2 size={18} />
                </div>
                <div>
                  <h2 id="delete-reminder-title">删除提醒？</h2>
                  <p>{pendingReminderDelete.config.title}</p>
                </div>
                <div className="confirmation-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setPendingReminderDeleteId(null)}
                  >
                    取消
                  </button>
                  <button className="danger-button" type="button" onClick={confirmReminderDeletion}>
                    <Trash2 size={15} />
                    <span>删除</span>
                  </button>
                </div>
              </section>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function PetVisualView({
  visual,
  state,
  renderMode,
  petSize,
}: {
  visual: PetVisual | null;
  state: PetState;
  renderMode: RenderMode;
  petSize: number;
}) {
  if (!visual) {
    return (
      <div className="pet-visual-frame">
        <img className="pet-image" src={defaultPet} alt="Codex Pet" draggable={false} />
      </div>
    );
  }

  if (visual.kind === "atlas") {
    const frameWidth = visual.frameWidth ?? 192;
    const frameHeight = visual.frameHeight ?? 208;
    const frames = Math.max(1, visual.frames ?? 1);
    const row = visual.row ?? 0;
    const totalMs = Math.max(1, visual.totalMs ?? 1000);
    const atlasScale = petSize / Math.max(frameWidth, frameHeight);
    const style = {
      "--atlas-url": `url("${convertFileSrc(visual.path)}")`,
      "--frame-width": `${frameWidth}px`,
      "--frame-height": `${frameHeight}px`,
      "--atlas-scale": String(Math.max(0.1, Math.min(4, atlasScale))),
      "--atlas-width": `${frameWidth * 8}px`,
      "--atlas-height": `${frameHeight * 9}px`,
      "--atlas-frames": frames,
      "--atlas-duration": `${totalMs}ms`,
      "--atlas-row-offset": `${row * frameHeight * -1}px`,
      "--atlas-end-x": `${frames * frameWidth * -1}px`,
    } as CSSProperties;
    const visualKey = `${visual.path}-${state}-${row}-${frames}-${totalMs}-${frameWidth}x${frameHeight}`;

    return (
      <div className="pet-visual-frame">
        <div
          key={visualKey}
          className={`pet-atlas-wrap render-${renderMode}`}
          style={style}
          aria-label={`宠物状态 ${state}`}
        >
          <div className="pet-atlas" key={visualKey} />
        </div>
      </div>
    );
  }

  return (
    <div className="pet-visual-frame">
      <img
        key={`${visual.path}-${state}`}
        className={`pet-image render-${renderMode}`}
        src={isTauriRuntime ? convertFileSrc(visual.path) : defaultPet}
        alt={`宠物状态 ${state}`}
        draggable={false}
      />
    </div>
  );
}

function resolveVisual(pet: PetCandidate, state: PetState): PetVisual | null {
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

function normalizeEventState(event: CodexEvent): PetState | null {
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

async function resizePetWindow(
  containerWidth: number,
  containerHeight: number,
  bubbleReserve: number,
  previousBubbleReserve: number,
) {
  if (!isTauriRuntime) {
    return;
  }

  const appWindow = getCurrentWindow();
  await appWindow.setSize(new LogicalSize(containerWidth, containerHeight + bubbleReserve));
  if (bubbleReserve !== previousBubbleReserve) {
    const position = await appWindow.outerPosition();
    await appWindow.setPosition(new PhysicalPosition(position.x, position.y - (bubbleReserve - previousBubbleReserve)));
  }
}

function monitorDragBounds(monitor: Monitor, windowSize: PhysicalSize): DragBounds {
  const minX = monitor.workArea.position.x;
  const minY = monitor.workArea.position.y;
  return {
    minX,
    minY,
    maxX: Math.max(minX, minX + monitor.workArea.size.width - windowSize.width),
    maxY: Math.max(minY, minY + monitor.workArea.size.height - windowSize.height),
  };
}

function modalViewportBounds(width: number, height: number): DragBounds {
  const minX = 8;
  const minY = 8;
  return {
    minX,
    minY,
    maxX: Math.max(minX, window.innerWidth - width - minX),
    maxY: Math.max(minY, window.innerHeight - height - minY),
  };
}

async function modalMonitorBounds(width: number, height: number): Promise<DragBounds> {
  if (!isTauriRuntime) {
    return modalViewportBounds(width, height);
  }

  const appWindow = getCurrentWindow();
  const [position, scaleFactor, monitor] = await Promise.all([
    appWindow.outerPosition(),
    appWindow.scaleFactor(),
    currentMonitor().then((value) => value ?? primaryMonitor()),
  ]);
  const viewportBounds = modalViewportBounds(width, height);
  if (!monitor) {
    return viewportBounds;
  }

  const margin = 8;
  const minX = (monitor.position.x - position.x) / scaleFactor + margin;
  const minY = (monitor.position.y - position.y) / scaleFactor + margin;
  const maxX =
    (monitor.position.x + monitor.size.width - position.x) / scaleFactor -
    width -
    margin;
  const maxY =
    (monitor.position.y + monitor.size.height - position.y) / scaleFactor -
    height -
    margin;

  return intersectDragBounds(viewportBounds, {
    minX,
    minY,
    maxX: Math.max(minX, maxX),
    maxY: Math.max(minY, maxY),
  });
}

function intersectDragBounds(base: DragBounds, next: DragBounds): DragBounds {
  const minX = Math.max(base.minX, next.minX);
  const minY = Math.max(base.minY, next.minY);
  return {
    minX,
    minY,
    maxX: Math.max(minX, Math.min(base.maxX, next.maxX)),
    maxY: Math.max(minY, Math.min(base.maxY, next.maxY)),
  };
}

function clampWindowPosition(x: number, y: number, bounds: DragBounds | null) {
  if (!bounds) {
    return { x, y };
  }

  return {
    x: clamp(x, bounds.minX, bounds.maxX),
    y: clamp(y, bounds.minY, bounds.maxY),
  };
}

function clampPetSize(value: number) {
  if (!Number.isFinite(value)) {
    return defaultPetSize;
  }
  return clamp(Math.round(value), 150, 330);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatReminderSchedule(timestamp: number | null, enabled: boolean) {
  if (!enabled) {
    return "未启用";
  }
  if (timestamp === null) {
    return "请完善提醒时间";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "请完善提醒时间";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function readReminderSnapshots(): ReminderSnapshot[] {
  const stored = localStorage.getItem(reminderConfigKey);
  if (!stored) {
    return upsertReminderSnapshot([], defaultReminderConfig);
  }

  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    const rawReminders = Array.isArray(parsed.reminders)
      ? (parsed.reminders as Partial<ReminderConfig>[])
      : [parsed as Partial<ReminderConfig>];
    return normalizeReminderSnapshots(
      rawReminders.map((config) => {
        const normalized = normalizeReminderConfig(config);
        return {
          config: normalized,
          nextReminderAt: nextReminderDate(normalized)?.getTime() ?? null,
        };
      }),
    );
  } catch {
    return upsertReminderSnapshot([], defaultReminderConfig);
  }
}

function normalizeReminderConfig(config: Partial<ReminderConfig>): ReminderConfig {
  return {
    id: normalizeReminderId(config.id),
    enabled: Boolean(config.enabled),
    title: typeof config.title === "string" ? config.title : defaultReminderConfig.title,
    message: typeof config.message === "string" ? config.message : defaultReminderConfig.message,
    weekday: clampReminderWeekday(Number(config.weekday)),
    time: normalizeReminderTime(typeof config.time === "string" ? config.time : defaultReminderConfig.time),
    durationMinutes: clampReminderDuration(Number(config.durationMinutes)),
  };
}

function normalizeReminderSnapshots(reminders: ReminderSnapshot[]): ReminderSnapshot[] {
  const ids = new Set<string>();
  const normalized: ReminderSnapshot[] = [];
  for (const reminder of reminders) {
    const config = normalizeReminderConfig(reminder.config);
    if (ids.has(config.id)) {
      continue;
    }
    ids.add(config.id);
    normalized.push({
      config,
      nextReminderAt:
        typeof reminder.nextReminderAt === "number" && Number.isFinite(reminder.nextReminderAt)
          ? reminder.nextReminderAt
          : nextReminderDate(config)?.getTime() ?? null,
    });
  }
  return normalized;
}

function upsertReminderSnapshot(
  reminders: ReminderSnapshot[],
  nextConfig: ReminderConfig,
): ReminderSnapshot[] {
  const config = normalizeReminderConfig(nextConfig);
  const snapshot = {
    config,
    nextReminderAt: nextReminderDate(config)?.getTime() ?? null,
  };
  const index = reminders.findIndex((reminder) => reminder.config.id === config.id);
  if (index === -1) {
    return [...reminders, snapshot];
  }
  return reminders.map((reminder, reminderIndex) =>
    reminderIndex === index ? snapshot : reminder,
  );
}

function findNextReminder(reminders: ReminderSnapshot[]) {
  return reminders.reduce<{ config: ReminderConfig; nextReminderAt: number } | null>((earliest, reminder) => {
    const nextReminderAt = nextReminderDate(reminder.config)?.getTime() ?? null;
    if (nextReminderAt === null) {
      return earliest;
    }
    if (!earliest || earliest.nextReminderAt === null || nextReminderAt < earliest.nextReminderAt) {
      return { config: reminder.config, nextReminderAt };
    }
    return earliest;
  }, null);
}

let reminderIdSequence = 0;

function createReminderConfig(): ReminderConfig {
  reminderIdSequence += 1;
  return {
    ...defaultReminderConfig,
    id: `reminder-${Date.now()}-${reminderIdSequence}`,
  };
}

function normalizeReminderId(value: string | undefined) {
  const normalized = (value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
  return normalized || "reminder-migrated";
}

function nextReminderDate(config: ReminderConfig, now = new Date()) {
  if (!config.enabled) {
    return null;
  }

  const [hour, minute] = parseReminderTime(config.time);
  if (hour === null || minute === null) {
    return null;
  }

  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);

  const daysUntil = (config.weekday - now.getDay() + 7) % 7;
  next.setDate(now.getDate() + daysUntil);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 7);
  }

  return next;
}

function parseReminderTime(value: string): [number | null, number | null] {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return [null, null];
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return [null, null];
  }

  return [hour, minute];
}

function normalizeReminderTime(value: string) {
  const [hour, minute] = parseReminderTime(value);
  if (hour === null || minute === null) {
    return defaultReminderConfig.time;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clampReminderDuration(value: number) {
  if (!Number.isFinite(value)) {
    return defaultReminderConfig.durationMinutes;
  }

  return clamp(Math.round(value), 0, maxReminderDurationMinutes);
}

function clampReminderWeekday(value: number) {
  const rounded = Math.round(value);
  return reminderWeekdayOptions.some((option) => option.value === rounded) ? rounded : defaultReminderConfig.weekday;
}

function readPetSize() {
  const stored = localStorage.getItem(petSizeKey);
  return stored === null ? defaultPetSize : clampPetSize(Number(stored));
}

function readPetContainerDimension(key: string, fallback: number) {
  const stored = localStorage.getItem(key);
  return stored === null ? fallback : clampPetContainerDimension(Number(stored));
}

function clampPetContainerDimension(value: number) {
  if (!Number.isFinite(value)) {
    return defaultPetContainerWidth;
  }
  return clamp(Math.round(value), minPetContainerDimension, maxPetContainerDimension);
}

function readPetOffset(key: string, fallback: number) {
  const storedValue = localStorage.getItem(key);
  if (storedValue === null) {
    return fallback;
  }
  const value = Number(storedValue);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return clampPetOffset(value);
}

function clampPetOffset(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clamp(Math.round(value), -petVisualOffsetLimit, petVisualOffsetLimit);
}

function normalizePetPreferences(preferences: PetPreferences): PetPreferences {
  return {
    petSize: clampPetSize(Number(preferences.petSize)),
    petContainerWidth: clampPetContainerDimension(Number(preferences.petContainerWidth)),
    petContainerHeight: clampPetContainerDimension(Number(preferences.petContainerHeight)),
    petOffsetX: clampPetOffset(Number(preferences.petOffsetX)),
    petOffsetY: clampPetOffset(Number(preferences.petOffsetY)),
    renderMode: preferences.renderMode === "pixelated" ? "pixelated" : "smooth",
    packagePath: typeof preferences.packagePath === "string" ? preferences.packagePath : "",
  };
}

function normalizeBubbleMessage(message: string, fallback: string) {
  const text = message.trim().replace(/\s+/g, " ");
  if (!text) {
    return fallback;
  }
  return text.length > 34 ? `${text.slice(0, 33)}...` : text;
}

function readRenderMode(): RenderMode {
  return localStorage.getItem(renderModeKey) === "pixelated" ? "pixelated" : "smooth";
}

function shortSession(sessionId: string) {
  if (sessionId.length <= 14) {
    return sessionId;
  }
  return sessionId.slice(0, 11);
}

export default App;
