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
  Check,
  FolderOpen,
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

type ModalDragSession = {
  pointerId: number;
  startPointerX: number;
  startPointerY: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
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
  previousState: PetState;
  latestState: PetState;
  pendingFrame: number | null;
};

const packagePathKey = "codex-pet:package-path";
const workdirKey = "codex-pet:workdir";
const petSizeKey = "codex-pet:pet-size";
const renderModeKey = "codex-pet:render-mode";
const defaultPetSize = 236;
const settingsWidth = 980;
const settingsHeight = 640;
const themePreviewPetSize = 112;
const themePreviewCanvasSize = 156;
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
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsModalPosition, setSettingsModalPosition] = useState<ModalPosition | null>(null);
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
  const modalDragRef = useRef<ModalDragSession | null>(null);
  const settingsReturnPositionRef = useRef<PhysicalPosition | null>(null);

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
    const returnPosition = settingsReturnPositionRef.current;
    void resizeWindow(settingsOpen, petSize, returnPosition)
      .then(() => {
        if (!settingsOpen && returnPosition) {
          settingsReturnPositionRef.current = null;
        }
      })
      .catch((error) => {
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
      });
      pushEvent({ kind: "terminal.opened", message: "已打开终端", state: "idle" });
    } catch (error) {
      setCurrentState("error");
      pushEvent({ kind: "terminal.error", message: String(error), state: "error" });
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
    const rect = event.currentTarget.getBoundingClientRect();
    modalDragRef.current = {
      pointerId: event.pointerId,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startX: rect.left,
      startY: rect.top,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSettingsModalPosition({ x: rect.left, y: rect.top });
  }

  function moveSettingsModal(event: PointerEvent<HTMLElement>) {
    const drag = modalDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const nextX = drag.startX + event.clientX - drag.startPointerX;
    const nextY = drag.startY + event.clientY - drag.startPointerY;
    setSettingsModalPosition({
      x: clamp(nextX, 8, window.innerWidth - drag.width - 8),
      y: clamp(nextY, 8, window.innerHeight - drag.height - 8),
    });
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
        className={`pet-stage state-${currentState} render-${renderMode}`}
        aria-label="桌宠"
        onPointerDown={startPetDrag}
        onPointerMove={movePet}
        onPointerUp={endPetDrag}
        onPointerCancel={endPetDrag}
        onContextMenu={openContextMenu}
      >
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
                      onChange={(event) => setPetSize(clampPetSize(Number(event.currentTarget.value)))}
                    />
                    <output>{petSize}px</output>
                  </div>
                </label>
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
                  <span>工作目录</span>
                  <div className="path-row wide-action">
                    <input
                      value={workdir}
                      onChange={(event) => setWorkdir(event.currentTarget.value)}
                      placeholder="留空则使用当前目录"
                    />
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

async function resizeWindow(settingsOpen: boolean, petSize: number, returnPosition: PhysicalPosition | null) {
  if (!isTauriRuntime) {
    return;
  }

  const size = settingsOpen
    ? new LogicalSize(settingsWidth, settingsHeight)
    : new LogicalSize(petSize + windowPadding, petSize + windowPadding);

  const appWindow = getCurrentWindow();
  await appWindow.setSize(size);
  if (settingsOpen) {
    await appWindow.center();
  } else if (returnPosition) {
    await appWindow.setPosition(returnPosition);
  }
}

function clampPetSize(value: number) {
  if (!Number.isFinite(value)) {
    return defaultPetSize;
  }
  return clamp(value, 150, 330);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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
