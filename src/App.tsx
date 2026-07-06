import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
} from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  CheckCircle2,
  Grip,
  Import,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  Shrink,
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
  | "sweeping"
  | "carrying";

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

const packagePathKey = "codex-pet:package-path";
const workdirKey = "codex-pet:workdir";
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
  sweeping: "压缩",
  carrying: "搬运",
};

function App() {
  const [packagePath, setPackagePath] = useState(() => localStorage.getItem(packagePathKey) ?? "");
  const [workdir, setWorkdir] = useState(() => localStorage.getItem(workdirKey) ?? "");
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [compact, setCompact] = useState(false);
  const [currentState, setCurrentState] = useState<PetState>("idle");
  const [activePet, setActivePet] = useState<PetCandidate | null>(null);
  const [candidates, setCandidates] = useState<PetCandidate[]>([]);
  const [events, setEvents] = useState<CodexEvent[]>([
    { kind: "idle", message: "准备就绪", state: "idle" },
  ]);
  const idleTimerRef = useRef<number | null>(null);

  const visual = useMemo(() => {
    if (!activePet) {
      return null;
    }

    return resolveVisual(activePet, currentState);
  }, [activePet, currentState]);

  const headline = running ? "Codex 正在处理" : "轻量桌宠待命";
  const latestMessage = events[events.length - 1]?.message ?? "准备就绪";
  const statusLabel = stateLabels[currentState] ?? "空闲";

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    void invoke("start_codex_session_monitor").catch((error) => {
      pushEvent({ kind: "monitor.error", message: String(error), state: "error" });
    });

    const unlistenPromise = listen<CodexEvent>("codex-event", (event) => {
      const next = event.payload;
      pushEvent(next);
      const nextState = normalizeEventState(next);

      if (nextState) {
        setCurrentState(nextState);
      }

      if (nextState === "thinking" || nextState === "working" || nextState === "running_command" || nextState === "editing_file") {
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
      setCurrentState("idle");
      idleTimerRef.current = null;
    }, 2600);
  }

  async function startWindowDrag(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    const wantsDrag = Boolean(target.closest(".drag-handle"));
    if (!wantsDrag && target.closest("button,input,textarea,.no-drag")) {
      return;
    }

    if (isTauriRuntime) {
      event.preventDefault();
      setCurrentState("dragging");
      await getCurrentWindow().startDragging();
    }
  }

  async function toggleCompact() {
    const next = !compact;
    setCompact(next);
    if (isTauriRuntime) {
      const size = next ? new LogicalSize(236, 282) : new LogicalSize(380, 540);
      await getCurrentWindow().setSize(size);
    }
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
    <main className={`pet-shell ${compact ? "is-compact" : ""}`} onMouseDown={startWindowDrag}>
      <section className={`pet-stage state-${currentState}`} aria-label="桌宠">
        <div className="window-controls no-drag">
          <button className="icon-button drag-handle" type="button" title="拖动窗口" onMouseDown={startWindowDrag}>
            <Grip size={16} />
          </button>
          <button className="icon-button" type="button" title={compact ? "展开" : "缩小"} onClick={toggleCompact}>
            {compact ? <Maximize2 size={15} /> : <Shrink size={15} />}
          </button>
          <button className="icon-button" type="button" title="最小化" onClick={minimizeWindow}>
            <Minimize2 size={15} />
          </button>
          <button className="icon-button danger" type="button" title="关闭" onClick={closeWindow}>
            <X size={15} />
          </button>
        </div>

        <PetVisualView visual={visual} state={currentState} />

        <div className="status-pill">
          {running ? <LoaderCircle size={14} /> : <CheckCircle2 size={14} />}
          <span>{statusLabel}</span>
        </div>
      </section>

      <section className="control-panel no-drag">
        <header className="panel-header">
          <div>
            <span className="eyebrow">Codex Pet</span>
            <h1>{headline}</h1>
          </div>
          <button
            className="icon-button"
            type="button"
            title="刷新本地宠物"
            onClick={refreshCandidates}
          >
            <RefreshCw size={17} />
          </button>
        </header>

        <p className="latest-message">{latestMessage}</p>

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

        {candidates.length > 0 && (
          <div className="candidate-row" aria-label="宠物候选列表">
            {candidates.slice(0, 4).map((candidate) => (
              <button
                key={candidate.path}
                className="candidate-button"
                type="button"
                title={candidate.path}
                onClick={() => selectCandidate(candidate)}
              >
                {candidate.name}
                <span>{candidate.kind}</span>
              </button>
            ))}
          </div>
        )}

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
    </main>
  );
}

function PetVisualView({ visual, state }: { visual: PetVisual | null; state: PetState }) {
  if (!visual) {
    return <img className="pet-image" src={defaultPet} alt="Codex Pet" draggable={false} />;
  }

  if (visual.kind === "atlas") {
    const frameWidth = visual.frameWidth ?? 192;
    const frameHeight = visual.frameHeight ?? 208;
    const frames = Math.max(1, visual.frames ?? 1);
    const row = visual.row ?? 0;
    const totalMs = Math.max(1, visual.totalMs ?? 1000);
    const style = {
      "--atlas-url": `url("${convertFileSrc(visual.path)}")`,
      "--frame-width": `${frameWidth}px`,
      "--frame-height": `${frameHeight}px`,
      "--atlas-width": `${frameWidth * 8}px`,
      "--atlas-height": `${frameHeight * 9}px`,
      "--atlas-frames": frames,
      "--atlas-duration": `${totalMs}ms`,
      "--atlas-row-offset": `${row * frameHeight * -1}px`,
      "--atlas-end-x": `${frames * frameWidth * -1}px`,
    } as CSSProperties;

    return (
      <div className="pet-atlas-wrap" style={style} aria-label={`宠物状态 ${state}`}>
        <div className="pet-atlas" />
      </div>
    );
  }

  return (
    <img
      key={`${visual.path}-${state}`}
      className="pet-image"
      src={isTauriRuntime ? convertFileSrc(visual.path) : defaultPet}
      alt={`宠物状态 ${state}`}
      draggable={false}
    />
  );
}

function resolveVisual(pet: PetCandidate, state: PetState): PetVisual | null {
  return (
    pet.states[state] ??
    pet.states.working ??
    pet.states.thinking ??
    pet.states.idle ??
    null
  );
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

function shortSession(sessionId: string) {
  if (sessionId.length <= 14) {
    return sessionId;
  }
  return sessionId.slice(0, 11);
}

export default App;
