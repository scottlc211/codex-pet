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
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  primaryMonitor,
  type Monitor,
} from "@tauri-apps/api/window";
import {
  Check,
  FileSearch,
  FolderOpen,
  FolderSearch,
  Import,
  LoaderCircle,
  Minus,
  Palette,
  Play,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Terminal,
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
type SettingsSection = "general" | "theme" | "work";
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
  tone: "working" | "success" | "error";
  label: string;
  message: string;
};

type CodexUsageLimit = {
  label: string;
  windowDurationMins: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: number | null;
};

type CodexUsageLimits = {
  status: string;
  message: string;
  fiveHour: CodexUsageLimit;
  weekly: CodexUsageLimit;
};

const packagePathKey = "codex-pet:package-path";
const workdirKey = "codex-pet:workdir";
const petSizeKey = "codex-pet:pet-size";
const petOffsetXKey = "codex-pet:pet-offset-x";
const petOffsetYKey = "codex-pet:pet-offset-y";
const renderModeKey = "codex-pet:render-mode";
const terminalKey = "codex-pet:terminal";
const defaultPetSize = 236;
const settingsWidth = 760;
const settingsHeight = 520;
const themePreviewPetSize = 112;
const themePreviewCanvasSize = 156;
const petCanvasPadding = 48;
const windowPadding = petCanvasPadding + 24;
const defaultPetVisualOffsetX = -24;
const defaultPetVisualOffsetY = -28;
const petVisualOffsetLimit = 36;
const petBubbleReserve = 72;
const petHitWidthRatio = 0.82;
const petHitHeightRatio = 0.92;
const autoTerminal: TerminalOption = { id: "auto", label: "自动选择" };
const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
  const [workdir, setWorkdir] = useState(() => localStorage.getItem(workdirKey) ?? "");
  const [petSize, setPetSize] = useState(() => readPetSize());
  const [petOffsetX, setPetOffsetX] = useState(() => readPetOffset(petOffsetXKey, defaultPetVisualOffsetX));
  const [petOffsetY, setPetOffsetY] = useState(() => readPetOffset(petOffsetYKey, defaultPetVisualOffsetY));
  const [renderMode, setRenderMode] = useState<RenderMode>(() => readRenderMode());
  const [terminalId, setTerminalId] = useState(() => localStorage.getItem(terminalKey) ?? autoTerminal.id);
  const [terminals, setTerminals] = useState<TerminalOption[]>([autoTerminal]);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsModalPosition, setSettingsModalPosition] = useState<ModalPosition | null>(null);
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [currentState, setCurrentState] = useState<PetState>("idle");
  const [petBubble, setPetBubble] = useState<PetBubble | null>(null);
  const [activePet, setActivePet] = useState<PetCandidate | null>(null);
  const [candidates, setCandidates] = useState<PetCandidate[]>([]);
  const [codexUsage, setCodexUsage] = useState<CodexUsageLimits | null>(null);
  const [codexUsageLoading, setCodexUsageLoading] = useState(false);
  const [events, setEvents] = useState<CodexEvent[]>([
    { kind: "idle", message: "准备就绪", state: "idle" },
  ]);
  const idleTimerRef = useRef<number | null>(null);
  const idleAfterDragRef = useRef(false);
  const petBubbleReserveRef = useRef(0);
  const dragRef = useRef<DragSession | null>(null);
  const modalDragRef = useRef<ModalDragSession | null>(null);
  const settingsReturnPositionRef = useRef<PhysicalPosition | null>(null);
  const windowAlwaysOnTopRef = useRef(true);

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
    "--pet-canvas-size": `${petSize + petCanvasPadding}px`,
    "--pet-bubble-reserve": `${bubbleVisible ? petBubbleReserve : 0}px`,
    "--pet-bubble-shift": `${bubbleVisible ? petBubbleReserve / 2 : 0}px`,
    "--pet-visual-offset-x": `${petOffsetX}px`,
    "--pet-visual-offset-y": `${petOffsetY}px`,
  } as CSSProperties;
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

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    void invoke("start_codex_session_monitor").catch((error) => {
      pushEvent({ kind: "monitor.error", message: String(error), state: "error" });
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

        if (nextState === "success" || nextState === "error") {
          scheduleIdle();
        }
      }
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
      clearIdleTimer();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(petSizeKey, String(petSize));
    const returnPosition = settingsReturnPositionRef.current;
    const nextBubbleReserve = bubbleVisible ? petBubbleReserve : 0;
    const previousBubbleReserve = petBubbleReserveRef.current;
    void resizeWindow(settingsOpen, petSize, returnPosition, nextBubbleReserve, previousBubbleReserve)
      .then(() => {
        if (!settingsOpen) {
          petBubbleReserveRef.current = nextBubbleReserve;
        }
        if (!settingsOpen && returnPosition) {
          settingsReturnPositionRef.current = null;
        }
      })
      .catch((error) => {
        pushEvent({ kind: "window.resize.error", message: String(error), state: "error" });
      });
  }, [petSize, settingsOpen, bubbleVisible]);

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
    localStorage.setItem(terminalKey, terminalId);
  }, [terminalId]);

  useEffect(() => {
    if (settingsOpen) {
      void refreshCodexUsageLimits();
    }
  }, [settingsOpen]);

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    const appWindow = getCurrentWindow();
    let disposed = false;
    let ignoringCursor = false;
    let windowFocused = true;
    let layerErrorReported = false;
    let timer: number | null = null;

    async function setIgnoreCursorEvents(next: boolean) {
      if (ignoringCursor === next) {
        return;
      }
      ignoringCursor = next;
      await appWindow.setIgnoreCursorEvents(next);
    }

    async function setWindowAlwaysOnTop(next: boolean) {
      if (windowAlwaysOnTopRef.current === next) {
        return;
      }

      try {
        await appWindow.setAlwaysOnTop(next);
        windowAlwaysOnTopRef.current = next;
      } catch (error) {
        if (!layerErrorReported) {
          layerErrorReported = true;
          pushEvent({ kind: "window.layer.error", message: String(error), state: "error" });
        }
      }
    }

    async function updateCursorHitArea() {
      if (disposed) {
        return;
      }

      try {
        if (isDragging() || modalDragRef.current) {
          await setIgnoreCursorEvents(false);
          await setWindowAlwaysOnTop(true);
        } else if (settingsOpen) {
          const [cursor, position, scaleFactor] = await Promise.all([
            cursorPosition(),
            appWindow.outerPosition(),
            appWindow.scaleFactor(),
          ]);
          const modal = document.querySelector<HTMLElement>(".settings-modal");
          const petStage = document.querySelector<HTMLElement>(".pet-stage");
          const relativeX = (cursor.x - position.x) / scaleFactor;
          const relativeY = (cursor.y - position.y) / scaleFactor;
          const modalRect = modal?.getBoundingClientRect();
          const petRect = petStage?.getBoundingClientRect();
          const insideModal =
            modalRect !== undefined &&
            relativeX >= modalRect.left &&
            relativeX <= modalRect.right &&
            relativeY >= modalRect.top &&
            relativeY <= modalRect.bottom;
          const insidePet =
            petRect !== undefined &&
            relativeX >= petRect.left &&
            relativeX <= petRect.right &&
            relativeY >= petRect.top &&
            relativeY <= petRect.bottom;
          const insideAppControl = insideModal || insidePet;
          await setIgnoreCursorEvents(!insideAppControl);
          if (windowFocused && insideAppControl) {
            await setWindowAlwaysOnTop(true);
          }
        } else if (contextMenuOpen) {
          await setIgnoreCursorEvents(false);
          await setWindowAlwaysOnTop(true);
        } else {
          const [cursor, position, size] = await Promise.all([
            cursorPosition(),
            appWindow.outerPosition(),
            appWindow.outerSize(),
          ]);
          const hitWidth = Math.min(size.width, Math.max(24, Math.round(petSize * petHitWidthRatio)));
          const hitHeight = Math.min(size.height, Math.max(24, Math.round(petSize * petHitHeightRatio)));
          const hitLeft = clamp(
            Math.round((size.width - hitWidth) / 2 + petOffsetX),
            0,
            Math.max(0, size.width - hitWidth),
          );
          const hitTop = clamp(
            Math.round((size.height - hitHeight) / 2 + petOffsetY),
            0,
            Math.max(0, size.height - hitHeight),
          );
          const insideHotArea =
            cursor.x >= position.x + hitLeft &&
            cursor.x <= position.x + hitLeft + hitWidth &&
            cursor.y >= position.y + hitTop &&
            cursor.y <= position.y + hitTop + hitHeight;
          await setIgnoreCursorEvents(!insideHotArea);
          await setWindowAlwaysOnTop(true);
        }
      } catch {
        await setIgnoreCursorEvents(false).catch(() => undefined);
      } finally {
        if (!disposed) {
          timer = window.setTimeout(updateCursorHitArea, ignoringCursor ? 80 : 140);
        }
      }
    }

    void updateCursorHitArea();
    const unlistenFocusPromise = appWindow.onFocusChanged(({ payload: focused }) => {
      windowFocused = focused;
      if (settingsOpen) {
        void setWindowAlwaysOnTop(focused);
      } else if (focused) {
        void setWindowAlwaysOnTop(true);
      }
    });

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      void unlistenFocusPromise.then((unlisten) => unlisten());
      void appWindow.setIgnoreCursorEvents(false).catch(() => undefined);
      void appWindow.setAlwaysOnTop(true).then(() => {
        windowAlwaysOnTopRef.current = true;
      }).catch(() => undefined);
    };
  }, [settingsOpen, contextMenuOpen, petSize, petOffsetX, petOffsetY]);

  useEffect(() => {
    if (packagePath) {
      localStorage.setItem(packagePathKey, packagePath);
    } else {
      localStorage.removeItem(packagePathKey);
    }
  }, [packagePath]);

  useEffect(() => {
    if (workdir) {
      localStorage.setItem(workdirKey, workdir);
    } else {
      localStorage.removeItem(workdirKey);
    }
  }, [workdir]);

  async function refreshCandidates() {
    if (!isTauriRuntime) {
      pushEvent({ kind: "browser", message: "请在 Tauri 桌面窗口中刷新本地宠物", state: "idle" });
      return;
    }

    const found = await invoke<PetCandidate[]>("find_pet_candidates");
    setCandidates(found);
    if (!activePet && found[0]) {
      setActivePet(found[0]);
      setPackagePath(found[0].path);
    }
    pushEvent({ kind: "scan", message: `发现 ${found.length} 个可用宠物资源`, state: "idle" });
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

  async function refreshCodexUsageLimits() {
    if (!isTauriRuntime) {
      setCodexUsage(unavailableCodexUsage("浏览器预览不支持读取 Codex 限额"));
      return;
    }

    setCodexUsageLoading(true);
    try {
      const limits = await invoke<CodexUsageLimits>("get_codex_usage_limits");
      setCodexUsage(limits);
    } catch (error) {
      setCodexUsage(unavailableCodexUsage(String(error)));
    } finally {
      setCodexUsageLoading(false);
    }
  }

  async function importPackage() {
    if (!packagePath.trim()) {
      pushEvent({ kind: "import.empty", message: "先输入动画包目录、zip 或图片路径", state: "waiting_input" });
      setCurrentState("waiting_input");
      return;
    }

    if (!isTauriRuntime) {
      pushEvent({ kind: "browser", message: "浏览器预览不支持导入本地动画包", state: "idle" });
      return;
    }

    try {
      const imported = await invoke<PetCandidate>("import_pet_package", {
        sourcePath: packagePath,
      });
      setActivePet(imported);
      setPackagePath(imported.path);
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
    setSettingsOpen(false);
    setContextMenuOpen(false);
    setCurrentState("thinking");
    const queuedEvent: CodexEvent = { kind: "queued", message: "任务已发送", state: "thinking" };
    pushEvent(queuedEvent);
    updatePetBubble("thinking", queuedEvent.message);

    try {
      await invoke("run_codex_task", {
        prompt: task,
        cwd: workdir || null,
      });
      setTask("");
    } catch (error) {
      setRunning(false);
      setCurrentState("error");
      const errorMessage = String(error);
      pushEvent({ kind: "error", message: errorMessage, state: "error" });
      updatePetBubble("error", errorMessage);
      scheduleIdle();
    }
  }

  function pushEvent(event: CodexEvent) {
    setEvents((current) => [...current.slice(-5), event]);
  }

  function updatePetBubble(state: PetState, message: string) {
    if (activeTaskStates.has(state)) {
      setPetBubble({
        tone: "working",
        label: "进行中",
        message: normalizeBubbleMessage(message, "Codex 正在处理任务"),
      });
      return;
    }

    if (state === "success") {
      setPetBubble({
        tone: "success",
        label: "成功",
        message: normalizeBubbleMessage(message, "任务完成"),
      });
      return;
    }

    if (state === "error") {
      setPetBubble({
        tone: "error",
        label: "失败",
        message: normalizeBubbleMessage(message, "任务失败"),
      });
      return;
    }

    if (state === "idle") {
      setPetBubble(null);
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
        setPetBubble(null);
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
      setPetBubble(null);
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
    setSettingsSection("general");
    setSettingsModalPosition(null);
    if (isTauriRuntime) {
      try {
        settingsReturnPositionRef.current = await getCurrentWindow().outerPosition();
      } catch (error) {
        pushEvent({ kind: "window.position.error", message: String(error), state: "error" });
      }
    }
    setSettingsOpen(true);
  }

  function closeSettings() {
    setSettingsOpen(false);
    setSettingsModalPosition(null);
  }

  async function minimizeWindow() {
    if (isTauriRuntime) {
      await getCurrentWindow().minimize();
    }
  }

  async function closeWindow() {
    if (isTauriRuntime) {
      await getCurrentWindow().close();
    }
  }

  function selectCandidate(candidate: PetCandidate) {
    setActivePet(candidate);
    setPackagePath(candidate.path);
    setCurrentState("idle");
    pushEvent({ kind: "pet.selected", message: `已选择：${candidate.name}`, state: "idle" });
  }

  function selectDefaultPet() {
    setActivePet(null);
    setPackagePath("");
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
    <main className={`pet-shell ${settingsOpen ? "has-settings" : ""}`} style={shellStyle}>
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
          <div className={`pet-bubble tone-${petBubble.tone}`} role="status" aria-live="polite">
            <strong>{petBubble.label}</strong>
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

      {contextMenuOpen && (
        <div className="context-tablist" role="tablist" aria-label="桌宠菜单" onContextMenu={(event) => event.preventDefault()}>
          <button type="button" role="tab" aria-selected="true" onClick={openSettingsModal}>
            <Settings size={16} />
            <span>设置</span>
          </button>
        </div>
      )}

      {settingsOpen && (
        <section
          className="settings-modal"
          style={settingsModalStyle}
          role="dialog"
          aria-modal="true"
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
              <button className="icon-button danger" type="button" title="关闭程序" onClick={closeWindow}>
                <X size={16} />
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
                <div className="section-title with-action">
                  <h2>通用</h2>
                  <button
                    className="icon-button"
                    type="button"
                    title="刷新 Codex 限额"
                    onClick={refreshCodexUsageLimits}
                    disabled={codexUsageLoading}
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
                <div className={`usage-card status-${codexUsage?.status ?? "loading"}`} aria-live="polite">
                  <div className="usage-card-header">
                    <div>
                      <strong>Codex 使用限额</strong>
                      <span>{codexUsageLoading ? "正在读取 Codex 限额" : codexUsage?.message ?? "尚未读取 Codex 限额"}</span>
                    </div>
                    {codexUsageLoading && <LoaderCircle size={16} />}
                  </div>
                  <div className="usage-grid">
                    <div className="usage-item">
                      <span>5 小时使用限额剩余</span>
                      <strong>{formatLimitPercent(codexUsage?.fiveHour.remainingPercent)}</strong>
                    </div>
                    <div className="usage-item">
                      <span>5 小时限额重置时间</span>
                      <strong>{formatResetTime(codexUsage?.fiveHour.resetsAt)}</strong>
                    </div>
                    <div className="usage-item">
                      <span>每周限额剩余</span>
                      <strong>{formatLimitPercent(codexUsage?.weekly.remainingPercent)}</strong>
                    </div>
                    <div className="usage-item">
                      <span>每周限额重置时间</span>
                      <strong>{formatResetTime(codexUsage?.weekly.resetsAt)}</strong>
                    </div>
                  </div>
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
                      onChange={(event) => setPetSize(clampPetSize(Number(event.currentTarget.value)))}
                    />
                    <output>{petSize}px</output>
                  </div>
                </label>
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
                        onChange={(event) => setPetOffsetX(clampPetOffset(Number(event.currentTarget.value)))}
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
                        onChange={(event) => setPetOffsetY(clampPetOffset(Number(event.currentTarget.value)))}
                      />
                      <output>{petOffsetY}px</output>
                    </label>
                  </div>
                </div>
                <label className="field">
                  <span>渲染方式</span>
                  <select value={renderMode} onChange={(event) => setRenderMode(event.currentTarget.value as RenderMode)}>
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
                      placeholder={"D:\\A_STUDY\\codex-pet\\pet-assets\\my-pet.zip"}
                    />
                    <button className="icon-button" type="button" title="导入动画包" onClick={importPackage}>
                      <Import size={16} />
                    </button>
                  </div>
                </label>
              </div>
            )}

            {settingsSection === "work" && (
              <div className="settings-page">
                <div className="section-title">
                  <h2>工作任务</h2>
                </div>
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

async function resizeWindow(
  settingsOpen: boolean,
  petSize: number,
  returnPosition: PhysicalPosition | null,
  bubbleReserve: number,
  previousBubbleReserve: number,
) {
  if (!isTauriRuntime) {
    return;
  }

  const appWindow = getCurrentWindow();
  if (settingsOpen) {
    await appWindow.setSize(new LogicalSize(settingsWidth, settingsHeight));
    await appWindow.center();
    return;
  }

  await appWindow.setSize(new LogicalSize(petSize + windowPadding, petSize + windowPadding + bubbleReserve));
  if (returnPosition) {
    await appWindow.setPosition(returnPosition);
  } else if (bubbleReserve !== previousBubbleReserve) {
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

function unavailableCodexUsage(message: string): CodexUsageLimits {
  return {
    status: "unavailable",
    message,
    fiveHour: unavailableUsageLimit("5 小时"),
    weekly: unavailableUsageLimit("每周"),
  };
}

function unavailableUsageLimit(label: string): CodexUsageLimit {
  return {
    label,
    windowDurationMins: null,
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
  };
}

function formatLimitPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "暂不可用";
  }

  return `${clamp(value, 0, 100).toFixed(1)}%`;
}

function formatResetTime(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "暂不可用";
  }

  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    return "暂不可用";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function readPetSize() {
  return clampPetSize(Number(localStorage.getItem(petSizeKey)));
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
