import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { isTauriRuntime } from "../../runtime/tauri";
import type { AgentEvent, AgentHookStatus } from "./model";

type UseAgentHooksOptions = {
  enabled: boolean;
  pushEvent: (event: AgentEvent) => void;
};

export function useAgentHooks({ enabled, pushEvent }: UseAgentHooksOptions) {
  const [statuses, setStatuses] = useState<AgentHookStatus[]>([]);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauriRuntime || !enabled) {
      return;
    }
    try {
      setStatuses(await invoke<AgentHookStatus[]>("get_agent_hook_statuses"));
    } catch (error) {
      pushEvent({
        provider: "system",
        kind: "hook.status.error",
        message: String(error),
        state: "error",
      });
    }
  }, [enabled, pushEvent]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function setHookInstalled(provider: "claude" | "grok", installed: boolean) {
    if (!isTauriRuntime || busyProvider) {
      return;
    }
    setBusyProvider(provider);
    try {
      const status = await invoke<AgentHookStatus>(
        installed ? "install_agent_hook" : "uninstall_agent_hook",
        { provider },
      );
      setStatuses((current) => [
        status,
        ...current.filter((item) => item.provider !== provider),
      ]);
      pushEvent({
        provider: "system",
        kind: installed ? "hook.installed" : "hook.uninstalled",
        message: `${provider === "claude" ? "Claude Code" : "Grok Build"} 监听已${
          installed ? "启用" : "停用"
        }`,
        state: "idle",
      });
    } catch (error) {
      pushEvent({
        provider: "system",
        kind: "hook.configure.error",
        message: String(error),
        state: "error",
      });
    } finally {
      setBusyProvider(null);
      void refresh();
    }
  }

  return { statuses, busyProvider, setHookInstalled, refresh };
}
