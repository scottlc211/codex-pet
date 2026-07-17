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
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { availableMonitors, cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import {
  autoTerminalId,
  clampTaskRetries,
  clampTaskTimeoutMinutes,
  loadAppPreferencesWithStatus,
  normalizePetPreferences,
  saveAppPreferences,
  type PetPreferences,
  type RenderMode,
} from "./config/preferences";
import { useDiagnostics } from "./features/diagnostics/useDiagnostics";
import { isAgentSessionActive } from "./features/agents/model";
import { useAgentEvents } from "./features/agents/useAgentEvents";
import { useAgentHooks } from "./features/agents/useAgentHooks";
import { defaultReminderConfig, type ReminderConfig } from "./features/reminders/model";
import { useReminderState } from "./features/reminders/useReminderState";
import {
  isTaskExecuting,
  type TaskActivity,
  type TaskSubmission,
} from "./features/tasks/model";
import { useTaskQueue } from "./features/tasks/useTaskQueue";
import { PetWindow, type PetBubble } from "./features/pet/PetWindow";
import {
  activeTaskStates,
  resolveVisual,
  stateLabels,
  type PetCandidate,
  type PetState,
} from "./features/pet/model";
import { GeneralSettings } from "./features/settings/GeneralSettings";
import {
  ReminderDeleteConfirmation,
  ReminderSettings,
} from "./features/settings/ReminderSettings";
import {
  SettingsWindow,
  type SettingsSection,
} from "./features/settings/SettingsWindow";
import {
  ThemeDeleteConfirmation,
  ThemeSettings,
} from "./features/settings/ThemeSettings";
import { WorkSettings, type TerminalOption } from "./features/settings/WorkSettings";
import { isTauriRuntime, releaseTauriListener } from "./runtime/tauri";
import {
  clampWindowPosition,
  clampWindowPositionToBounds,
  modalMonitorBounds,
  modalViewportBounds,
  monitorDragBounds,
  resizePetWindow,
  type DragBounds,
} from "./runtime/windowGeometry";
import { useWindowPlacement } from "./runtime/windowPlacement";
import "./App.css";

type ModalPosition = { x: number; y: number };

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

type DragSession = {
  pointerId: number;
  lastScreenX: number;
  startWindowX: number;
  startWindowY: number;
  startCursorX: number;
  startCursorY: number;
  bounds: DragBounds[];
  previousState: PetState;
  latestState: PetState;
  pendingFrame: number | null;
};

const petStatusBubbleReserve = 72;
const petTaskPanelBaseReserve = 38;
const petTaskPanelRowReserve = 32;
const maxPetProgressRows = 6;
const autoTerminal: TerminalOption = { id: autoTerminalId, label: "自动选择" };
const isSettingsWindow = isTauriRuntime && getCurrentWindow().label === "settings";

function App() {
  useWindowPlacement(isSettingsWindow ? "settings" : "main", isSettingsWindow);
  const [initialPreferencesResult] = useState(() => loadAppPreferencesWithStatus());
  const initialPreferences = initialPreferencesResult.preferences;
  const [packagePath, setPackagePath] = useState(initialPreferences.pet.packagePath);
  const [selectedPetPath, setSelectedPetPath] = useState(initialPreferences.pet.packagePath);
  const [workdir, setWorkdir] = useState(initialPreferences.work.workdir);
  const [codexPath, setCodexPath] = useState(initialPreferences.work.codexPath);
  const [petSize, setPetSize] = useState(initialPreferences.pet.petSize);
  const [petContainerWidth, setPetContainerWidth] = useState(
    initialPreferences.pet.petContainerWidth,
  );
  const [petContainerHeight, setPetContainerHeight] = useState(
    initialPreferences.pet.petContainerHeight,
  );
  const [petOffsetX, setPetOffsetX] = useState(initialPreferences.pet.petOffsetX);
  const [petOffsetY, setPetOffsetY] = useState(initialPreferences.pet.petOffsetY);
  const [clickThrough, setClickThrough] = useState(initialPreferences.pet.clickThrough);
  const [mainWindowVisible, setMainWindowVisible] = useState(true);
  const [renderMode, setRenderMode] = useState<RenderMode>(initialPreferences.pet.renderMode);
  const [terminalId, setTerminalId] = useState(initialPreferences.work.terminalId);
  const [taskTimeoutMinutes, setTaskTimeoutMinutes] = useState(
    initialPreferences.work.taskTimeoutMinutes,
  );
  const [taskMaxRetries, setTaskMaxRetries] = useState(
    initialPreferences.work.taskMaxRetries,
  );
  const [terminals, setTerminals] = useState<TerminalOption[]>([autoTerminal]);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(isSettingsWindow);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsModalPosition, setSettingsModalPosition] = useState<ModalPosition | null>(null);
  const [task, setTask] = useState("");
  const [importing, setImporting] = useState(false);
  const [deletingTheme, setDeletingTheme] = useState(false);
  const [petBubble, setPetBubble] = useState<PetBubble | null>(null);
  const [activePet, setActivePet] = useState<PetCandidate | null>(null);
  const [candidates, setCandidates] = useState<PetCandidate[]>([]);
  const [pendingThemeDelete, setPendingThemeDelete] = useState<PetCandidate | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const idleAfterDragRef = useRef(false);
  const petBubbleReserveRef = useRef(0);
  const dragRef = useRef<DragSession | null>(null);
  const modalDragRef = useRef<ModalDragSession | null>(null);
  const reminderAutoHideTimerRef = useRef<number | null>(null);
  const reminderTokenRef = useRef(0);
  const windowLayoutKeyRef = useRef("");
  const petPreferencesRef = useRef(initialPreferences.pet);
  const {
    events,
    currentState,
    sessions: agentSessions,
    running: agentRunning,
    pushEvent,
    setCurrentState,
  } =
    useAgentEvents({
      settingsWindow: isSettingsWindow,
      isDragging,
      onStateMessage: updatePetBubble,
    });
  const {
    statuses: agentHookStatuses,
    busyProvider: agentHookBusyProvider,
    setHookInstalled: setAgentHookInstalled,
  } = useAgentHooks({ enabled: isSettingsWindow, pushEvent });
  const {
    taskState,
    hasActiveTasks,
    openTaskTerminal,
    cancelTask,
    clearTaskHistory,
  } = useTaskQueue({ pushEvent });
  const running = agentRunning || hasActiveTasks;
  const activeAgentSessions = useMemo(
    () => agentSessions.filter(isAgentSessionActive),
    [agentSessions],
  );
  const executingTasks = useMemo(
    () =>
      taskState.tasks
        .filter((item) => isTaskExecuting(item.status))
        .slice(0, taskState.maxConcurrentTasks),
    [taskState.maxConcurrentTasks, taskState.tasks],
  );
  const petAgentSessions = useMemo(
    () =>
      activeAgentSessions.slice(
        0,
        Math.max(0, maxPetProgressRows - executingTasks.length),
      ),
    [activeAgentSessions, executingTasks.length],
  );
  const hiddenAgentSessionCount = Math.max(
    0,
    activeAgentSessions.length - petAgentSessions.length,
  );
  const showPetProgressPanel = executingTasks.length > 0 || activeAgentSessions.length > 1;
  const petProgressRowCount = executingTasks.length + petAgentSessions.length;
  const {
    reminderSnapshots,
    reminderDraft,
    selectedReminderId,
    savedReminderDraft,
    pendingReminderDelete,
    createReminder,
    editReminder,
    requestReminderDeletion,
    cancelReminderDeletion,
    confirmReminderDeletion,
    resetReminderDraft,
    saveReminderConfig,
    previewReminder,
    updateReminderDraft,
  } = useReminderState({
    settingsWindow: isSettingsWindow,
    onTriggered: triggerReminderBubble,
    pushEvent,
  });
  const {
    info: diagnosticsInfo,
    reminderHealth,
    busy: diagnosticsBusy,
    recordEvent: recordDiagnosticEvent,
    openDiagnosticsDirectory,
    repairReminderConfiguration,
  } = useDiagnostics({
    settingsWindow: isSettingsWindow,
    preferencesStatus: initialPreferencesResult.status,
    pushEvent,
  });

  const petDisplayState =
    executingTasks.length > 0 && matchesTerminalPetState(currentState)
      ? taskActivityPetState(executingTasks[0].activity)
      : currentState;
  const visiblePetBubble =
    petBubble?.source === "reminder" || !showPetProgressPanel ? petBubble : null;
  const petOverlayReserve = visiblePetBubble
    ? petStatusBubbleReserve
    : showPetProgressPanel
      ? petTaskPanelBaseReserve + petProgressRowCount * petTaskPanelRowReserve
      : 0;
  const visual = useMemo(() => {
    if (!activePet) {
      return null;
    }

    return resolveVisual(activePet, petDisplayState);
  }, [activePet, petDisplayState]);

  const latestMessage = events[events.length - 1]?.message ?? "准备就绪";
  const statusLabel = stateLabels[currentState] ?? "空闲";
  const visualIdentity = visual
    ? `${visual.kind}-${visual.path}-${visual.row ?? "single"}-${petDisplayState}`
    : `default-${petDisplayState}`;
  const shellStyle = {
    "--pet-size": `${petSize}px`,
    "--pet-container-width": `${petContainerWidth}px`,
    "--pet-container-height": `${petContainerHeight}px`,
    "--pet-bubble-reserve": `${petOverlayReserve}px`,
    "--pet-bubble-shift": `${petOverlayReserve / 2}px`,
    "--pet-visual-offset-x": `${petOffsetX}px`,
    "--pet-visual-offset-y": `${petOffsetY}px`,
  } as CSSProperties;
  const petPreferences: PetPreferences = {
    petSize,
    petContainerWidth,
    petContainerHeight,
    petOffsetX,
    petOffsetY,
    clickThrough,
    renderMode,
    packagePath: selectedPetPath,
  };
  petPreferencesRef.current = petPreferences;
  const settingsModalStyle = settingsModalPosition
    ? ({
        left: `${settingsModalPosition.x}px`,
        top: `${settingsModalPosition.y}px`,
        transform: "none",
      } as CSSProperties)
    : undefined;
  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    void refreshCandidates();
    if (isSettingsWindow) {
      void refreshTerminals();
    }
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    const unlistenPreferencesPromise = listen<PetPreferences>("pet-preferences-updated", (event) => {
      applyPetPreferences(normalizePetPreferences(event.payload));
    });
    const unlistenTrayTogglePromise = isSettingsWindow
      ? null
      : listen("tray-toggle-click-through", toggleClickThrough);
    const unlistenMainWindowVisibilityPromise = listen<boolean>(
      "main-window-visibility-changed",
      (event) => setMainWindowVisible(event.payload),
    );
    void invoke<boolean>("get_main_window_visibility")
      .then(setMainWindowVisible)
      .catch((error) => {
        recordDiagnosticEvent(
          "error",
          "windows",
          `failed to read main window visibility: ${String(error)}`,
        );
      });

    return () => {
      releaseTauriListener(unlistenPreferencesPromise);
      releaseTauriListener(unlistenMainWindowVisibilityPromise);
      if (unlistenTrayTogglePromise) {
        releaseTauriListener(unlistenTrayTogglePromise);
      }
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime || isSettingsWindow) {
      return;
    }

    void getCurrentWindow().setIgnoreCursorEvents(clickThrough).catch((error) => {
      pushEvent({ kind: "window.click-through.error", message: String(error), state: "error" });
      recordDiagnosticEvent(
        "error",
        "windows",
        `failed to update click-through: ${String(error)}`,
      );
    });
  }, [clickThrough]);

  useEffect(() => {
    if (isTauriRuntime && !isSettingsWindow) {
      return;
    }

    const error = saveAppPreferences({
      schemaVersion: 1,
      pet: petPreferences,
      work: {
        workdir,
        codexPath,
        terminalId,
        taskTimeoutMinutes,
        taskMaxRetries,
      },
    });
    if (error) {
      pushEvent({ kind: "preferences.save.error", message: error, state: "error" });
      recordDiagnosticEvent("error", "preferences", `failed to save preferences: ${error}`);
    }
  }, [
    petSize,
    petContainerWidth,
    petContainerHeight,
    petOffsetX,
    petOffsetY,
    clickThrough,
    renderMode,
    selectedPetPath,
    workdir,
    codexPath,
    terminalId,
    taskTimeoutMinutes,
    taskMaxRetries,
  ]);

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    const nextLayoutKey = `${petContainerWidth}:${petContainerHeight}:${petOverlayReserve}`;
    if (windowLayoutKeyRef.current === nextLayoutKey) {
      return;
    }
    windowLayoutKeyRef.current = nextLayoutKey;

    const nextBubbleReserve = petOverlayReserve;
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
        recordDiagnosticEvent("error", "windows", `failed to resize pet window: ${String(error)}`);
      });
  }, [petContainerWidth, petContainerHeight, petOverlayReserve]);

  useEffect(() => {
    return () => {
      clearIdleTimer();
      clearReminderAutoHideTimer();
    };
  }, []);

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

    if (!task.trim()) {
      return;
    }

    if (!isTauriRuntime) {
      pushEvent({ kind: "browser", message: "浏览器预览不支持启动 Codex CLI", state: "idle" });
      return;
    }

    setContextMenuOpen(false);
    setCurrentState("thinking");

    try {
      const submission = await invoke<TaskSubmission>("run_codex_task", {
        request: {
          prompt: task,
          cwd: workdir || null,
          codexPath: codexPath.trim() || null,
          terminalId,
          timeoutMinutes: clampTaskTimeoutMinutes(taskTimeoutMinutes),
          maxRetries: clampTaskRetries(taskMaxRetries),
        },
      });
      setTask("");
      pushEvent({
        kind: "task.submitted",
        message: `任务已提交，最多 ${taskState.maxConcurrentTasks} 个并行执行`,
        state: "thinking",
        sessionId: submission.taskId,
      });
    } catch (error) {
      setCurrentState("error");
      const errorMessage = String(error);
      pushEvent({ kind: "error", message: errorMessage, state: "error" });
      updatePetBubble("error", errorMessage);
    }
  }

  function applyPetPreferences(preferences: PetPreferences, updatePathDraft = true) {
    petPreferencesRef.current = preferences;
    setPetSize(preferences.petSize);
    setPetContainerWidth(preferences.petContainerWidth);
    setPetContainerHeight(preferences.petContainerHeight);
    setPetOffsetX(preferences.petOffsetX);
    setPetOffsetY(preferences.petOffsetY);
    setClickThrough(preferences.clickThrough);
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
    const preferences = normalizePetPreferences({ ...petPreferencesRef.current, [key]: value });
    applyPetPreferences(preferences, key === "packagePath");
    if (isTauriRuntime) {
      const targetWindow = isSettingsWindow ? "main" : "settings";
      if (!isSettingsWindow) {
        persistMainWindowPetPreferences(preferences);
      }
      void emitTo(targetWindow, "pet-preferences-updated", preferences).catch((error) => {
        pushEvent({ kind: "preferences.sync.error", message: String(error), state: "error" });
        recordDiagnosticEvent(
          "error",
          "preferences",
          `failed to sync pet preferences: ${String(error)}`,
        );
      });
    }
  }

  function persistMainWindowPetPreferences(preferences: PetPreferences) {
    const stored = loadAppPreferencesWithStatus().preferences;
    const error = saveAppPreferences({ ...stored, pet: preferences });
    if (error) {
      pushEvent({ kind: "preferences.save.error", message: error, state: "error" });
      recordDiagnosticEvent("error", "preferences", `failed to save preferences: ${error}`);
    }
  }

  function toggleClickThrough() {
    setContextMenuOpen(false);
    updatePetPreference("clickThrough", !petPreferencesRef.current.clickThrough);
  }

  function clearReminderAutoHideTimer() {
    if (reminderAutoHideTimerRef.current !== null) {
      window.clearTimeout(reminderAutoHideTimerRef.current);
      reminderAutoHideTimerRef.current = null;
    }
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
        message: normalizeBubbleMessage(message, "Agent 正在处理任务"),
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
      const [position, cursor, outerSize, monitors] = await Promise.all([
        appWindow.outerPosition(),
        cursorPosition(),
        appWindow.outerSize(),
        availableMonitors(),
      ]);

      dragRef.current = {
        pointerId: event.pointerId,
        lastScreenX: event.screenX,
        startWindowX: position.x,
        startWindowY: position.y,
        startCursorX: cursor.x,
        startCursorY: cursor.y,
        bounds: monitors.map((monitor) => monitorDragBounds(monitor, outerSize)),
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
      void updatePetWindowPosition(currentDrag).catch((error) => {
        recordDiagnosticEvent(
          "error",
          "windows",
          `failed to move pet window: ${String(error)}`,
        );
      });
    });
  }

  async function updatePetWindowPosition(drag: DragSession) {
    const cursor = await cursorPosition();
    const currentDrag = dragRef.current;
    if (!currentDrag || currentDrag !== drag) {
      return;
    }

    const nextX = Math.round(drag.startWindowX + cursor.x - drag.startCursorX);
    const nextY = Math.round(drag.startWindowY + cursor.y - drag.startCursorY);
    const boundedPosition = clampWindowPositionToBounds(nextX, nextY, drag.bounds);
    await getCurrentWindow().setPosition(
      new PhysicalPosition(boundedPosition.x, boundedPosition.y),
    );
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
    void cursorPosition()
      .then((cursor) => {
        const nextX = Math.round(drag.startWindowX + cursor.x - drag.startCursorX);
        const nextY = Math.round(drag.startWindowY + cursor.y - drag.startCursorY);
        return clampWindowPositionToBounds(nextX, nextY, drag.bounds);
      })
      .then((position) => getCurrentWindow().setPosition(new PhysicalPosition(position.x, position.y)))
      .catch((error) => {
        recordDiagnosticEvent(
          "error",
          "windows",
          `failed to finish pet drag: ${String(error)}`,
        );
      });
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
        recordDiagnosticEvent(
          "error",
          "windows",
          `failed to open settings window: ${String(error)}`,
        );
      }
      return;
    }
    setSettingsSection("general");
    setSettingsModalPosition(null);
    setSettingsOpen(true);
  }

  async function hideMainWindow() {
    setContextMenuOpen(false);
    if (!isTauriRuntime) {
      setMainWindowVisible(false);
      return;
    }

    try {
      setMainWindowVisible(await invoke<boolean>("hide_main_window"));
    } catch (error) {
      pushEvent({ kind: "window.hide.error", message: String(error), state: "error" });
      recordDiagnosticEvent("error", "windows", `failed to hide main window: ${String(error)}`);
    }
  }

  async function toggleMainWindowVisibility() {
    if (!isTauriRuntime) {
      setMainWindowVisible((visible) => !visible);
      return;
    }

    try {
      setMainWindowVisible(await invoke<boolean>("toggle_main_window"));
    } catch (error) {
      pushEvent({ kind: "window.visibility.error", message: String(error), state: "error" });
      recordDiagnosticEvent(
        "error",
        "windows",
        `failed to toggle main window visibility: ${String(error)}`,
      );
    }
  }

  function closeSettings() {
    if (isTauriRuntime && isSettingsWindow) {
      void invoke("hide_settings_window").catch((error) => {
        pushEvent({ kind: "settings.hide.error", message: String(error), state: "error" });
        recordDiagnosticEvent(
          "error",
          "windows",
          `failed to hide settings window: ${String(error)}`,
        );
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

  function requestThemeDeletion(candidate: PetCandidate) {
    if (!candidate.canDelete || deletingTheme) {
      return;
    }
    setPendingThemeDelete(candidate);
  }

  function cancelThemeDeletion() {
    if (!deletingTheme) {
      setPendingThemeDelete(null);
    }
  }

  async function confirmThemeDeletion() {
    const candidate = pendingThemeDelete;
    if (!candidate || deletingTheme || !candidate.canDelete) {
      return;
    }

    if (!isTauriRuntime) {
      pushEvent({ kind: "browser", message: "浏览器预览不支持卸载本地主题", state: "idle" });
      return;
    }

    setDeletingTheme(true);
    try {
      await invoke("delete_pet_package", { candidatePath: candidate.path });
      setCandidates((current) => current.filter((item) => item.path !== candidate.path));
      if (selectedPetPath === candidate.path) {
        setActivePet(null);
        updatePetPreference("packagePath", "");
      } else if (packagePath === candidate.path) {
        setPackagePath("");
      }
      setPendingThemeDelete(null);
      setCurrentState("success");
      pushEvent({ kind: "theme.deleted", message: `已卸载：${candidate.name}`, state: "success" });
      scheduleIdle();
    } catch (error) {
      const message = String(error);
      setCurrentState("error");
      pushEvent({ kind: "theme.delete.error", message, state: "error" });
      scheduleIdle();
    } finally {
      setDeletingTheme(false);
    }
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
        <PetWindow
          state={petDisplayState}
          renderMode={renderMode}
          visual={visual}
          visualIdentity={visualIdentity}
          petSize={petSize}
          bubble={visiblePetBubble}
          tasks={executingTasks}
          agentSessions={petAgentSessions}
          hiddenAgentSessionCount={hiddenAgentSessionCount}
          queuedCount={taskState.queuedCount}
          contextMenuOpen={contextMenuOpen}
          clickThrough={clickThrough}
          onPointerDown={startPetDrag}
          onPointerMove={movePet}
          onPointerEnd={endPetDrag}
          onContextMenu={openContextMenu}
          onCloseBubble={closePetBubble}
          onOpenTaskTerminal={openTaskTerminal}
          onOpenSettings={openSettingsModal}
          onHidePet={hideMainWindow}
          onToggleClickThrough={toggleClickThrough}
          onQuit={quitApplication}
        />
      )}

      {(isSettingsWindow || settingsOpen) && (
        <SettingsWindow
          nativeWindow={isSettingsWindow}
          modalStyle={settingsModalStyle}
          section={settingsSection}
          statusLabel={statusLabel}
          latestMessage={latestMessage}
          onSectionChange={setSettingsSection}
          onClose={closeSettings}
          onMinimize={minimizeWindow}
          onQuit={quitApplication}
          onPointerDown={startSettingsModalDrag}
          onPointerMove={moveSettingsModal}
          onPointerEnd={endSettingsModalDrag}
          overlay={
            pendingThemeDelete ? (
              <ThemeDeleteConfirmation
                theme={pendingThemeDelete}
                deleting={deletingTheme}
                onCancel={cancelThemeDeletion}
                onConfirm={confirmThemeDeletion}
              />
            ) : pendingReminderDelete ? (
              <ReminderDeleteConfirmation
                reminder={pendingReminderDelete}
                onCancel={cancelReminderDeletion}
                onConfirm={confirmReminderDeletion}
              />
            ) : undefined
          }
        >
            {settingsSection === "general" && (
              <GeneralSettings
                preferences={petPreferences}
                preferencesStatus={initialPreferencesResult.status}
                diagnosticsInfo={diagnosticsInfo}
                reminderHealth={reminderHealth}
                diagnosticsBusy={diagnosticsBusy}
                mainWindowVisible={mainWindowVisible}
                onChange={updatePetPreference}
                onToggleMainWindowVisibility={toggleMainWindowVisibility}
                onOpenDiagnostics={openDiagnosticsDirectory}
                onRepairReminders={repairReminderConfiguration}
              />
            )}

            {settingsSection === "theme" && (
              <ThemeSettings
                candidates={candidates}
                activePet={activePet}
                packagePath={packagePath}
                importing={importing}
                renderMode={renderMode}
                onRefresh={refreshCandidates}
                onSelectDefault={selectDefaultPet}
                onSelect={selectCandidate}
                onRequestDelete={requestThemeDeletion}
                onPackagePathChange={setPackagePath}
                onImport={importPackage}
              />
            )}

            {settingsSection === "reminder" && (
              <ReminderSettings
                reminders={reminderSnapshots}
                selectedReminderId={selectedReminderId}
                draft={reminderDraft}
                savedDraft={savedReminderDraft}
                onCreate={createReminder}
                onEdit={editReminder}
                onRequestDelete={requestReminderDeletion}
                onReset={resetReminderDraft}
                onSave={saveReminderConfig}
                onPreview={previewReminder}
                onDraftChange={updateReminderDraft}
              />
            )}

            {settingsSection === "work" && (
              <WorkSettings
                codexPath={codexPath}
                workdir={workdir}
                terminalId={terminalId}
                terminals={terminals}
                task={task}
                taskTimeoutMinutes={taskTimeoutMinutes}
                taskMaxRetries={taskMaxRetries}
                running={running}
                events={events}
                agentSessions={activeAgentSessions}
                agentHookStatuses={agentHookStatuses}
                agentHookBusyProvider={agentHookBusyProvider}
                taskState={taskState}
                onCodexPathChange={setCodexPath}
                onWorkdirChange={setWorkdir}
                onTerminalChange={setTerminalId}
                onTaskChange={setTask}
                onTaskTimeoutChange={(value) =>
                  setTaskTimeoutMinutes(clampTaskTimeoutMinutes(value))
                }
                onTaskMaxRetriesChange={(value) => setTaskMaxRetries(clampTaskRetries(value))}
                onPickCodexExecutable={pickCodexExecutable}
                onPickWorkPath={pickWorkPath}
                onOpenTerminal={openTerminal}
                onOpenTaskTerminal={openTaskTerminal}
                onCancelTask={cancelTask}
                onClearTaskHistory={clearTaskHistory}
                onSetAgentHookInstalled={setAgentHookInstalled}
                onSubmit={submitTask}
              />
            )}
        </SettingsWindow>
      )}
    </main>
  );
}

function normalizeBubbleMessage(message: string, fallback: string) {
  const text = message.trim().replace(/\s+/g, " ");
  if (!text) {
    return fallback;
  }
  return text.length > 34 ? `${text.slice(0, 33)}...` : text;
}

function matchesTerminalPetState(state: PetState) {
  return state === "idle" || state === "success" || state === "error";
}

function taskActivityPetState(activity: TaskActivity | null): PetState {
  switch (activity) {
    case "thinking":
    case "working":
    case "running_command":
    case "editing_file":
    case "waiting_input":
    case "success":
    case "error":
      return activity;
    case "queued":
      return "thinking";
    case "idle":
    case null:
      return "working";
  }
}

export default App;
