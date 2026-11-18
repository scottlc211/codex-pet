import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { isTauriRuntime } from "../../runtime/tauri";
import { agentProviderLabels, type AgentEvent, type AgentHookStatus, type HookProvider } from "./model";

type UseAgentHooksOptions = {
  enabled: boolean;
  pushEvent: (event: AgentEvent) => void;
};

/** 装/卸监听后需要重启对应宿主才生效的说明。 */
const restartHints: Partial<Record<HookProvider, string>> = {
  grok: "请重启 Grok Build，或在 /hooks 中按 r 重新加载",
  // DSH 的监听是一个 host 插件，只有重启 dsh 才会加载新插件。
  dsh: "请重启 DSH 使其加载桥接插件",
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

  async function setHookInstalled(provider: HookProvider, installed: boolean) {
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
      const hint = installed ? restartHints[provider] : undefined;
      pushEvent({
        provider: "system",
        kind: installed ? "hook.installed" : "hook.uninstalled",
        message: `${agentProviderLabels[provider]} 监听已${
          installed ? "启用" : "停用"
        }${hint ? `；${hint}` : ""}`,
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
