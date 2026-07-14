import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./tauri";

export type DiagnosticLevel = "info" | "warn" | "error";

export function recordDiagnosticEvent(
  level: DiagnosticLevel,
  component: string,
  message: string,
) {
  if (!isTauriRuntime) {
    return;
  }
  void invoke("record_diagnostic_event", {
    event: { level, component, message },
  }).catch(() => undefined);
}
