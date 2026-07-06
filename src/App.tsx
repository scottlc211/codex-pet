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
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Import,
  LoaderCircle,
  Minus,
  Play,
  RefreshCw,
  Settings,
  Sparkles,
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
  previousState: PetState;
  latestState: PetState;
  pendingFrame: number | null;
};

const packagePathKey = "codex-pet:package-path";
const workdirKey = "codex-pet:workdir";
const petSizeKey = "codex-pet:pet-size";
const renderModeKey = "codex-pet:render-mode";
const defaultPetSize = 236;
const settingsWidth = 390;
const settingsHeight = 570;
const settingsPanelReserve = 410;
const petCanvasPadding = 48;
const windowPadding = petCanvasPadding + 32;
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

function App() {
  const [packagePath, setPackagePath] = useState(() => localStorage.getItem(packagePathKey) ?? "");
  const [workdir, setWorkdir] = useState(() => localStorage.getItem(workdirKey) ?? "");
  const [petSize, setPetSize] = useState(() => readPetSize());
  const [renderMode, setRenderMode] = useState<RenderMode>(() => readRenderMode());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [currentState, setCurrentState] = useState<PetState>("idle");
  const [activePet, setActivePet] = useState<PetCandidate | null>(null);
  const [candidates, setCandidates] = useState<PetCandidate[]>([]);
  const [events, setEvents] = useState<CodexEvent[]>([
    { kind: "idle", message: "准备就绪", state: "idle" },
  ]);
  const idleTimerRef = useRef<number | null>(null);
  const dragRef = useRef<DragSession | null>(null);

  const visual = useMemo(() => {
    if (!activePet) {
      return null;
    }

    return resolveVisual(activePet, currentState);
  }, [activePet, currentState]);

  const latestMessage = events[events.length - 1]?.message ?? "准备就绪";
  const statusLabel = stateLabels[currentState] ?? "空闲";
  const visualIdentity = visual
    ? `${visual.kind}-${visual.path}-${visual.row ?? "single"}-${currentState}`
    : `default-${currentState}`;
  const shellStyle = {
    "--pet-size": `${petSize}px`,
    "--pet-canvas-size": `${petSize + petCanvasPadding}px`,
  } as CSSProperties;

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    void invoke("start_codex_session_monitor").catch((error) => {
      pushEvent({ kind: "monitor.error", message: String(error), state: "error" });
    });
    void refreshCandidates();

    const unlistenPromise = listen<CodexEvent>("codex-event", (event) => {
      const next = event.payload;
      pushEvent(next);
      const nextState = normalizeEventState(next);

      if (nextState && !isDragging()) {
        setCurrentState(nextState);
      }

      if (
        nextState === "thinking" ||
        nextState === "working" ||
        nextState === "running_command" ||
        nextState === "editing_file"
      ) {
        setRunning(true);
      }

      if (nextState === "idle" || nextState === "success" || nextState === "error") {
        setRunning(false);
      }

      if (nextState === "success" || nextState === "error") {
        scheduleIdle();
      }
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
      clearIdleTimer();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(petSizeKey, String(petSize));
    void resizeWindow(settingsOpen, petSize).catch((error) => {
      pushEvent({ kind: "window.resize.error", message: String(error), state: "error" });
    });
  }, [petSize, settingsOpen]);

  useEffect(() => {
    localStorage.setItem(renderModeKey, renderMode);
  }, [renderMode]);

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
    setCurrentState("thinking");
    pushEvent({ kind: "queued", message: "任务已发送", state: "thinking" });

    try {
      await invoke("run_codex_task", {
        prompt: task,
        cwd: workdir || null,
      });
      setTask("");
    } catch (error) {
      setRunning(false);
      setCurrentState("error");
      pushEvent({ kind: "error", message: String(error), state: "error" });
      scheduleIdle();
    }
  }

  function pushEvent(event: CodexEvent) {
    setEvents((current) => [...current.slice(-5), event]);
  }

  function clearIdleTimer() {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }

  function scheduleIdle() {
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(() => {
      if (!isDragging()) {
        setCurrentState("idle");
      }
      idleTimerRef.current = null;
    }, 2600);
  }

  function isDragging() {
    return dragRef.current !== null;
  }

  async function startPetDrag(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".settings-popover")) {
      return;
    }

    event.preventDefault();
    setSettingsOpen(false);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

    if (!isTauriRuntime) {
      setCurrentState("dragging");
      return;
    }

    try {
      const appWindow = getCurrentWindow();
      const position = await appWindow.outerPosition();
      const scaleFactor = await appWindow.scaleFactor();

      dragRef.current = {
        pointerId: event.pointerId,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        lastScreenX: event.screenX,
        startWindowX: position.x,
        startWindowY: position.y,
        scaleFactor,
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
      void getCurrentWindow().setPosition(
        new PhysicalPosition(
          Math.round(currentDrag.startWindowX + deltaX * currentDrag.scaleFactor),
          Math.round(currentDrag.startWindowY + deltaY * currentDrag.scaleFactor),
        ),
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
    setCurrentState(running ? "working" : drag.previousState === "idle" ? "idle" : drag.previousState);
  }

  function openSettings(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    setSettingsOpen(true);
  }

  function closeSettings() {
    setSettingsOpen(false);
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

  return (
    <main className={`pet-shell ${settingsOpen ? "has-settings" : ""}`} style={shellStyle}>
      <section
        className={`pet-stage state-${currentState} render-${renderMode}`}
        aria-label="桌宠"
        onPointerDown={startPetDrag}
        onPointerMove={movePet}
        onPointerUp={endPetDrag}
        onPointerCancel={endPetDrag}
        onContextMenu={openSettings}
      >
        <PetVisualView
          key={visualIdentity}
          visual={visual}
          state={currentState}
          renderMode={renderMode}
          petSize={petSize}
        />
      </section>

      {settingsOpen && (
        <section className="settings-popover" role="dialog" aria-label="桌宠设置" onContextMenu={(event) => event.preventDefault()}>
          <header className="settings-header">
            <div>
              <span className="eyebrow">Codex Pet</span>
              <h1>设置</h1>
            </div>
            <div className="settings-actions">
              <button className="icon-button" type="button" title="刷新宠物" onClick={refreshCandidates}>
                <RefreshCw size={16} />
              </button>
              <button className="icon-button" type="button" title="最小化" onClick={minimizeWindow}>
                <Minus size={16} />
              </button>
              <button className="icon-button danger" type="button" title="关闭程序" onClick={closeWindow}>
                <X size={16} />
              </button>
              <button className="icon-button" type="button" title="关闭设置" onClick={closeSettings}>
                <Settings size={16} />
              </button>
            </div>
          </header>

          <div className="status-line" aria-live="polite">
            <span>{statusLabel}</span>
            <p>{latestMessage}</p>
          </div>

          <label className="field">
            <span>主题</span>
            <select
              value={activePet?.path ?? ""}
              onChange={(event) => {
                const candidate = candidates.find((item) => item.path === event.currentTarget.value);
                if (candidate) {
                  selectCandidate(candidate);
                }
              }}
            >
              <option value="">默认</option>
              {candidates.map((candidate) => (
                <option key={candidate.path} value={candidate.path}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>

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

          <div className="split-row">
            <label className="field">
              <span>大小</span>
              <input
                type="range"
                min="150"
                max="330"
                step="5"
                value={petSize}
                onChange={(event) => setPetSize(clampPetSize(Number(event.currentTarget.value)))}
              />
            </label>

            <label className="field">
              <span>渲染</span>
              <select value={renderMode} onChange={(event) => setRenderMode(event.currentTarget.value as RenderMode)}>
                <option value="smooth">平滑</option>
                <option value="pixelated">像素</option>
              </select>
            </label>
          </div>

          <form className="task-form" onSubmit={submitTask}>
            <label className="field">
              <span>工作目录</span>
              <input
                value={workdir}
                onChange={(event) => setWorkdir(event.currentTarget.value)}
                placeholder="留空则使用当前目录"
              />
            </label>

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
    return <img className="pet-image" src={defaultPet} alt="Codex Pet" draggable={false} />;
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
      <div
        key={visualKey}
        className={`pet-atlas-wrap render-${renderMode}`}
        style={style}
        aria-label={`宠物状态 ${state}`}
      >
        <div className="pet-atlas" key={visualKey} />
      </div>
    );
  }

  return (
    <img
      key={`${visual.path}-${state}`}
      className={`pet-image render-${renderMode}`}
      src={isTauriRuntime ? convertFileSrc(visual.path) : defaultPet}
      alt={`宠物状态 ${state}`}
      draggable={false}
    />
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

async function resizeWindow(settingsOpen: boolean, petSize: number) {
  if (!isTauriRuntime) {
    return;
  }

  const size = settingsOpen
    ? new LogicalSize(
        Math.max(settingsWidth, petSize + windowPadding),
        Math.max(settingsHeight, petSize + settingsPanelReserve),
      )
    : new LogicalSize(petSize + windowPadding, petSize + windowPadding);

  await getCurrentWindow().setSize(size);
}

function clampPetSize(value: number) {
  if (!Number.isFinite(value)) {
    return defaultPetSize;
  }
  return Math.max(150, Math.min(330, value));
}

function readPetSize() {
  return clampPetSize(Number(localStorage.getItem(petSizeKey)));
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
