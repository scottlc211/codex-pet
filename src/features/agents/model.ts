import { normalizeEventState, type PetState } from "../pet/model";

export type AgentProvider = "codex" | "claude" | "grok" | "system";
export type TrackableAgentProvider = Exclude<AgentProvider, "system">;

export type AgentEvent = {
  provider?: AgentProvider;
  kind: string;
  message: string;
  state?: PetState;
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  timestamp?: number;
};

export type AgentSession = {
  key: string;
  provider: TrackableAgentProvider;
  sessionId: string;
  agentId: string | null;
  cwd: string | null;
  state: PetState;
  message: string;
  updatedAt: number;
};

export type AgentHookStatus = {
  provider: "claude" | "grok";
  installed: boolean;
  configPath: string;
  error: string | null;
};

export const agentProviderLabels: Record<AgentProvider, string> = {
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok Build",
  system: "系统",
};

const activeAgentStates = new Set<PetState>([
  "thinking",
  "working",
  "running_command",
  "editing_file",
  "waiting_input",
  "sweeping",
  "carrying",
]);

const statePriority: Partial<Record<PetState, number>> = {
  waiting_input: 90,
  editing_file: 80,
  running_command: 70,
  working: 60,
  sweeping: 55,
  carrying: 50,
  thinking: 40,
};

const maxSessionAgeMs = 30 * 60 * 1000;

export type AgentPresentation = {
  terminalDismissed: boolean;
  suppress: boolean;
};

export function isAgentSessionActive(session: AgentSession) {
  return activeAgentStates.has(session.state);
}

export function resolveAgentPresentation(
  terminalDismissed: boolean,
  eventState: PetState,
  aggregateState: PetState,
): AgentPresentation {
  const nextTerminalDismissed = activeAgentStates.has(eventState) ? false : terminalDismissed;
  return {
    terminalDismissed: nextTerminalDismissed,
    suppress:
      nextTerminalDismissed && (aggregateState === "success" || aggregateState === "error"),
  };
}

export function updateAgentSessions(
  current: AgentSession[],
  event: AgentEvent,
  now = event.timestamp ?? Date.now(),
) {
  const provider = event.provider ?? "system";
  const recent = current.filter((session) => now - session.updatedAt <= maxSessionAgeMs);
  if (provider === "system" || !event.sessionId) {
    return recent;
  }

  if (event.kind === "hook.SessionEnd") {
    return recent.filter(
      (session) => session.provider !== provider || session.sessionId !== event.sessionId,
    );
  }
  if (event.kind === "hook.SubagentStop" && event.agentId) {
    return recent.filter(
      (session) =>
        session.provider !== provider ||
        session.sessionId !== event.sessionId ||
        session.agentId !== event.agentId,
    );
  }

  const state = normalizeEventState(event);
  if (!state) {
    return recent;
  }
  const agentId = event.agentId ?? null;
  const key = agentSessionKey(provider, event.sessionId, agentId);
  const next: AgentSession = {
    key,
    provider,
    sessionId: event.sessionId,
    agentId,
    cwd: event.cwd ?? recent.find((session) => session.key === key)?.cwd ?? null,
    state,
    message: event.message,
    updatedAt: now,
  };
  return [next, ...recent.filter((session) => session.key !== key)];
}

export function aggregateAgentSessions(sessions: AgentSession[]) {
  const active = sessions.filter(isAgentSessionActive);
  if (active.length > 0) {
    const primary = [...active].sort(
      (left, right) =>
        (statePriority[right.state] ?? 0) - (statePriority[left.state] ?? 0) ||
        right.updatedAt - left.updatedAt,
    )[0];
    return { state: primary.state, running: true, primary };
  }

  const primary = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  return {
    state: primary?.state ?? ("idle" as const),
    running: false,
    primary,
  };
}

export function agentSessionProject(session: AgentSession) {
  const normalized = session.cwd?.trim().replace(/[\\/]+$/, "") ?? "";
  return normalized.split(/[\\/]/).pop() || normalized || "外部会话";
}

function agentSessionKey(
  provider: TrackableAgentProvider,
  sessionId: string,
  agentId: string | null,
) {
  return `${provider}:${sessionId}:${agentId ?? "root"}`;
}
