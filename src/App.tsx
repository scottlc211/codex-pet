import { useEffect, useMemo, useState, type FormEvent, type PointerEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  CheckCircle2,
  LoaderCircle,
  Play,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import defaultPet from "./assets/default-pet.svg";
import "./App.css";

type PetCandidate = {
  name: string;
  path: string;
  kind: string;
};

type CodexEvent = {
  kind: string;
  message: string;
};

const petPathKey = "codex-pet:pet-path";
const workdirKey = "codex-pet:workdir";
const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function App() {
  const [petPath, setPetPath] = useState(() => localStorage.getItem(petPathKey) ?? "");
  const [workdir, setWorkdir] = useState(() => localStorage.getItem(workdirKey) ?? "");
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [candidates, setCandidates] = useState<PetCandidate[]>([]);
  const [events, setEvents] = useState<CodexEvent[]>([
    { kind: "idle", message: "准备就绪" },
  ]);

  const petSource = useMemo(() => {
    if (!petPath || !isTauriRuntime) {
      return defaultPet;
    }

    return convertFileSrc(petPath);
  }, [petPath]);

  const headline = running ? "Codex 正在处理" : "轻量桌宠待命";
  const latestMessage = events[events.length - 1]?.message ?? "准备就绪";

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    const unlistenPromise = listen<CodexEvent>("codex-event", (event) => {
      const next = event.payload;
      setEvents((current) => [...current.slice(-5), next]);

      if (next.kind === "started" || next.kind === "turn.started") {
        setRunning(true);
      }

      if (
        next.kind === "completed" ||
        next.kind === "turn.completed" ||
        next.kind === "turn.failed" ||
        next.kind === "error"
      ) {
        setRunning(false);
      }
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (petPath) {
      localStorage.setItem(petPathKey, petPath);
    } else {
      localStorage.removeItem(petPathKey);
    }
  }, [petPath]);

  useEffect(() => {
    if (workdir) {
      localStorage.setItem(workdirKey, workdir);
    } else {
      localStorage.removeItem(workdirKey);
    }
  }, [workdir]);

  async function refreshCandidates() {
    if (!isTauriRuntime) {
      setEvents((current) => [
        ...current.slice(-5),
        { kind: "browser", message: "请在 Tauri 桌面窗口中刷新本地宠物" },
      ]);
      return;
    }

    const found = await invoke<PetCandidate[]>("find_pet_candidates");
    setCandidates(found);
    setEvents((current) => [
      ...current.slice(-5),
      { kind: "scan", message: `发现 ${found.length} 个可用宠物资源` },
    ]);
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!task.trim() || running) {
      return;
    }

    if (!isTauriRuntime) {
      setEvents((current) => [
        ...current.slice(-5),
        { kind: "browser", message: "浏览器预览不支持启动 Codex CLI" },
      ]);
      return;
    }

    setRunning(true);
    setEvents((current) => [
      ...current.slice(-5),
      { kind: "queued", message: "任务已发送" },
    ]);

    try {
      await invoke("run_codex_task", {
        prompt: task,
        cwd: workdir || null,
      });
      setTask("");
    } catch (error) {
      setRunning(false);
      setEvents((current) => [
        ...current.slice(-5),
        { kind: "error", message: String(error) },
      ]);
    }
  }

  async function startWindowDrag(event: PointerEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button,input,textarea,.no-drag")) {
      return;
    }

    if (isTauriRuntime) {
      await getCurrentWindow().startDragging();
    }
  }

  return (
    <main className="pet-shell" onPointerDown={startWindowDrag}>
      <section className={`pet-stage ${running ? "is-running" : ""}`} aria-label="桌宠">
        <img className="pet-image" src={petSource} alt="Codex Pet" draggable={false} />
        <div className="status-pill">
          {running ? <LoaderCircle size={14} /> : <CheckCircle2 size={14} />}
          <span>{running ? "运行中" : "空闲"}</span>
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
          <span>宠物文件</span>
          <input
            value={petPath}
            onChange={(event) => setPetPath(event.currentTarget.value)}
            placeholder={"D:\\A_STUDY\\pets\\pet-assets\\pet.webp"}
          />
        </label>

        {candidates.length > 0 && (
          <div className="candidate-row" aria-label="宠物候选列表">
            {candidates.slice(0, 4).map((candidate) => (
              <button
                key={candidate.path}
                className="candidate-button"
                type="button"
                title={candidate.path}
                onClick={() => setPetPath(candidate.path)}
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
              <li key={`${event.kind}-${index}`}>{event.message}</li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}

export default App;
