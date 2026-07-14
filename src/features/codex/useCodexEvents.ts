import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  activeTaskStates,
  normalizeEventState,
  type CodexEvent,
  type PetState,
} from "../pet/model";
import { isTauriRuntime, releaseTauriListener } from "../../runtime/tauri";

type UseCodexEventsOptions = {
  settingsWindow: boolean;
  isDragging: () => boolean;
  onStateMessage: (state: PetState, message: string) => void;
};

type UseCodexEventsResult = {
  events: CodexEvent[];
  currentState: PetState;
  running: boolean;
  pushEvent: (event: CodexEvent) => void;
  setCurrentState: Dispatch<SetStateAction<PetState>>;
  setRunning: Dispatch<SetStateAction<boolean>>;
};

export function useCodexEvents({
  settingsWindow,
  isDragging,
  onStateMessage,
}: UseCodexEventsOptions): UseCodexEventsResult {
  const [events, setEvents] = useState<CodexEvent[]>([
    { kind: "idle", message: "准备就绪", state: "idle" },
  ]);
  const [currentState, setCurrentState] = useState<PetState>("idle");
  const [running, setRunning] = useState(false);
  const callbacksRef = useRef({ isDragging, onStateMessage });
  callbacksRef.current = { isDragging, onStateMessage };

  const pushEvent = useCallback((event: CodexEvent) => {
    setEvents((current) => [...current.slice(-5), event]);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    const unlistenPromise = listen<CodexEvent>("codex-event", (event) => {
      const next = event.payload;
      const nextState = normalizeEventState(next);
      pushEvent(next);

      if (nextState && !callbacksRef.current.isDragging()) {
        setCurrentState(nextState);
      }

      if (nextState === null) {
        return;
      }
      if (!settingsWindow) {
        callbacksRef.current.onStateMessage(nextState, next.message);
      }
      if (activeTaskStates.has(nextState)) {
        setRunning(true);
      }
      if (nextState === "idle" || nextState === "success" || nextState === "error") {
        setRunning(false);
      }
    });

    return () => releaseTauriListener(unlistenPromise);
  }, [pushEvent, settingsWindow]);

  useEffect(() => {
    if (!isTauriRuntime || settingsWindow) {
      return;
    }

    void invoke("start_codex_session_monitor").catch((error) => {
      pushEvent({ kind: "monitor.error", message: String(error), state: "error" });
    });
  }, [pushEvent, settingsWindow]);

  return {
    events,
    currentState,
    running,
    pushEvent,
    setCurrentState,
    setRunning,
  };
}
