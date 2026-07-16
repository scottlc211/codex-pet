import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { PreferencesLoadStatus } from "../../config/preferences";
import type { AgentEvent } from "../agents/model";
import { recordDiagnosticEvent } from "../../runtime/diagnostics";
import { isTauriRuntime } from "../../runtime/tauri";

export type DiagnosticsInfo = {
  version: string;
  platform: string;
  logDirectory: string;
  logPath: string;
  logSizeBytes: number;
};

export type ReminderConfigStatus =
  | "healthy"
  | "recoveredFromBackup"
  | "defaultsAfterMissing"
  | "defaultsAfterInvalid";

export type ReminderConfigHealth = {
  status: ReminderConfigStatus;
  path: string;
};

type UseDiagnosticsOptions = {
  settingsWindow: boolean;
  preferencesStatus: PreferencesLoadStatus;
  pushEvent: (event: AgentEvent) => void;
};

export function useDiagnostics({
  settingsWindow,
  preferencesStatus,
  pushEvent,
}: UseDiagnosticsOptions) {
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const [reminderHealth, setReminderHealth] = useState<ReminderConfigHealth | null>(null);
  const [busy, setBusy] = useState(false);

  const recordEvent = useCallback(
    (level: "info" | "warn" | "error", component: string, message: string) => {
      recordDiagnosticEvent(level, component, message);
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!isTauriRuntime) {
      return;
    }
    const [nextInfo, nextHealth] = await Promise.all([
      invoke<DiagnosticsInfo>("get_diagnostics_info"),
      invoke<ReminderConfigHealth>("get_reminder_config_health"),
    ]);
    setInfo(nextInfo);
    setReminderHealth(nextHealth);
  }, []);

  useEffect(() => {
    if (!settingsWindow || !isTauriRuntime) {
      return;
    }

    void refresh().catch((error) => {
      pushEvent({ kind: "diagnostics.load.error", message: String(error), state: "error" });
    });
    if (preferencesStatus !== "healthy" && preferencesStatus !== "defaultsAfterMissing") {
      recordEvent(
        preferencesStatus === "storageUnavailable" ? "error" : "warn",
        "preferences",
        `preferences load status: ${preferencesStatus}`,
      );
    }
  }, [preferencesStatus, pushEvent, recordEvent, refresh, settingsWindow]);

  async function openDiagnosticsDirectory() {
    if (!isTauriRuntime) {
      pushEvent({ kind: "diagnostics.browser", message: "浏览器预览没有本地日志目录", state: "idle" });
      return;
    }
    try {
      await invoke("open_diagnostics_directory");
    } catch (error) {
      pushEvent({ kind: "diagnostics.open.error", message: String(error), state: "error" });
    }
  }

  async function repairReminderConfiguration() {
    if (!isTauriRuntime || busy) {
      return;
    }
    setBusy(true);
    try {
      await invoke("repair_reminder_config");
      await refresh();
      pushEvent({ kind: "reminder.repaired", message: "提醒配置已重写", state: "idle" });
    } catch (error) {
      pushEvent({ kind: "reminder.repair.error", message: String(error), state: "error" });
    } finally {
      setBusy(false);
    }
  }

  return {
    info,
    reminderHealth,
    busy,
    recordEvent,
    openDiagnosticsDirectory,
    repairReminderConfiguration,
  };
}
