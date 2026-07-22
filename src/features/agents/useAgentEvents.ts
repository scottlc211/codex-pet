import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { normalizeEventState, type PetState } from "../pet/model";
import { isTauriRuntime, releaseTauriListener } from "../../runtime/tauri";
import {
  aggregateAgentSessions,
  resolveAgentPresentation,
  updateAgentSessions,
  type AgentEvent,
  type AgentSession,
} from "./model";

type UseAgentEventsOptions = {
  settingsWindow: boolean;
  isDragging: () => boolean;
  onStateMessage: (state: PetState, message: string) => void;
};

type UseAgentEventsResult = {
  events: AgentEvent[];
  sessions: AgentSession[];
  currentState: PetState;
  running: boolean;
  dismissTerminalState: () => void;
  pushEvent: (event: AgentEvent) => void;
  setCurrentState: Dispatch<SetStateAction<PetState>>;
};

export function useAgentEvents({
  settingsWindow,
  isDragging,
  onStateMessage,
}: UseAgentEventsOptions): UseAgentEventsResult {
  const [events, setEvents] = useState<AgentEvent[]>([
    { provider: "system", kind: "idle", message: "准备就绪", state: "idle" },
  ]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [currentState, setCurrentState] = useState<PetState>("idle");
  const [running, setRunning] = useState(false);
  const sessionsRef = useRef<AgentSession[]>([]);
  const terminalDismissedRef = useRef(false);
  const callbacksRef = useRef({ isDragging, onStateMessage });
  callbacksRef.current = { isDragging, onStateMessage };

  const pushEvent = useCallback((event: AgentEvent) => {
    setEvents((current) => [...current.slice(-11), event]);
  }, []);

  const dismissTerminalState = useCallback(() => {
    terminalDismissedRef.current = true;
    setCurrentState((current) =>
      current === "success" || current === "error" ? "idle" : current,
    );
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    const unlistenPromise = listen<AgentEvent>("agent-event", (event) => {
      const next = event.payload;
      const nextState = normalizeEventState(next);
      pushEvent(next);

      const nextSessions = updateAgentSessions(sessionsRef.current, next);
      const aggregate = aggregateAgentSessions(nextSessions);
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      setRunning(aggregate.running);

      if (nextState === null) {
        return;
      }
      const presentation = resolveAgentPresentation(
        terminalDismissedRef.current,
        nextState,
        aggregate.state,
      );
      terminalDismissedRef.current = presentation.terminalDismissed;
      if (presentation.suppress) {
        return;
      }
      if (!callbacksRef.current.isDragging()) {
        setCurrentState(aggregate.state);
      }
      if (!settingsWindow) {
        callbacksRef.current.onStateMessage(
          aggregate.state,
          aggregate.primary?.message ?? next.message,
        );
      }
    });

    return () => releaseTauriListener(unlistenPromise);
  }, [pushEvent, settingsWindow]);

  useEffect(() => {
    if (!isTauriRuntime || settingsWindow) {
      return;
    }

    void invoke("start_agent_monitor").catch((error) => {
      pushEvent({
        provider: "system",
        kind: "monitor.error",
        message: String(error),
        state: "error",
      });
    });
  }, [pushEvent, settingsWindow]);

  return {
    events,
    sessions,
    currentState,
    running,
    dismissTerminalState,
    pushEvent,
    setCurrentState,
  };
}
