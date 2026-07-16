mod agent_monitor;
mod codex_monitor;
mod diagnostics;
mod pets;
mod reminders;
mod storage;
mod task_queue;
mod tasks;
mod tray;
mod windows;

use pets::{delete_pet_package, find_pet_candidates, import_pet_package};
use reminders::{start_reminder_scheduler, ReminderManager};
use serde::Serialize;
use serde_json::Value;
use std::{
    env, fs,
    io::{self, BufRead},
    path::{Path, PathBuf},
};
use task_queue::TaskManager;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_notification::NotificationExt;

const MAX_EVENT_MESSAGE_CHARS: usize = 4096;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEvent {
    provider: String,
    kind: String,
    message: String,
    state: Option<String>,
    session_id: Option<String>,
    agent_id: Option<String>,
    cwd: Option<String>,
    timestamp: u64,
}

pub(crate) struct ParsedCodexEvent {
    pub(crate) state: Option<String>,
    pub(crate) message: String,
    pub(crate) codex_session_id: Option<String>,
}

pub(crate) fn emit_codex_event(
    app: &AppHandle,
    kind: &str,
    message: &str,
    state: Option<&str>,
    session_id: Option<String>,
) {
    emit_agent_event(app, "codex", kind, message, state, session_id, None, None);
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_agent_event(
    app: &AppHandle,
    provider: &str,
    kind: &str,
    message: &str,
    state: Option<&str>,
    session_id: Option<String>,
    agent_id: Option<String>,
    cwd: Option<String>,
) {
    let _ = app.emit(
        "agent-event",
        AgentEvent {
            provider: provider.to_string(),
            kind: kind.to_string(),
            message: normalize_event_message(message),
            state: state.map(str::to_string),
            session_id,
            agent_id,
            cwd,
            timestamp: current_timestamp_ms(),
        },
    );
}

pub(crate) fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_event_message(value: &str) -> String {
    value
        .chars()
        .filter(|value| !value.is_control() || matches!(value, '\n' | '\t'))
        .take(MAX_EVENT_MESSAGE_CHARS)
        .collect()
}

pub(crate) fn read_bounded_line(
    reader: &mut impl BufRead,
    limit: usize,
) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    let mut saw_data = false;
    let mut oversized = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if saw_data {
                Ok(Some(if oversized { Vec::new() } else { line }))
            } else {
                Ok(None)
            };
        }
        saw_data = true;

        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let content = newline.map_or(&available[..consumed], |index| &available[..index]);
        if !oversized {
            if line.len().saturating_add(content.len()) <= limit {
                line.extend_from_slice(content);
            } else {
                oversized = true;
                line.clear();
            }
        }
        reader.consume(consumed);

        if newline.is_some() {
            return Ok(Some(if oversized { Vec::new() } else { line }));
        }
    }
}

pub(crate) fn handle_codex_json_line(
    app: &AppHandle,
    line: &str,
    session_id: Option<&str>,
) -> Option<ParsedCodexEvent> {
    let Some((event_type, parsed)) = parse_codex_json_event(line) else {
        emit_codex_event(app, "log", line, None, session_id.map(str::to_string));
        return None;
    };

    emit_codex_event(
        app,
        &event_type,
        &parsed.message,
        parsed.state.as_deref(),
        session_id.map(str::to_string),
    );
    Some(parsed)
}

fn parse_codex_json_event(line: &str) -> Option<(String, ParsedCodexEvent)> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("event");

    let (message, state) = match event_type {
        "thread.started" => ("新线程已创建".to_string(), Some("thinking")),
        "turn.started" => ("Codex 正在处理".to_string(), Some("thinking")),
        "turn.completed" => ("Codex 回合完成".to_string(), Some("success")),
        "turn.failed" => ("Codex 回合失败".to_string(), Some("error")),
        "item.started" | "item.completed" => summarize_item(&value),
        _ => (event_type.to_string(), None),
    };

    let message = normalize_event_message(&message);
    Some((
        event_type.to_string(),
        ParsedCodexEvent {
            state: state.map(str::to_string),
            message,
            codex_session_id: value
                .get("thread_id")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
    ))
}

fn summarize_item(value: &Value) -> (String, Option<&'static str>) {
    let Some(item) = value.get("item") else {
        return ("收到 Codex 事件".to_string(), Some("thinking"));
    };

    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("item");

    match item_type {
        "agent_message" => (
            item.get("text")
                .and_then(Value::as_str)
                .unwrap_or("Codex 返回了消息")
                .to_string(),
            Some("thinking"),
        ),
        "command_execution" => (
            item.get("command")
                .and_then(Value::as_str)
                .map(|command| format!("运行命令：{command}"))
                .unwrap_or_else(|| "运行命令".to_string()),
            Some("running_command"),
        ),
        "file_change" => (
            item.get("path")
                .and_then(Value::as_str)
                .map(|path| format!("修改文件：{path}"))
                .unwrap_or_else(|| "修改文件".to_string()),
            Some("editing_file"),
        ),
        other => (other.to_string(), Some("working")),
    }
}

fn is_plain_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false)
}

fn clean_user_path(source_path: &str) -> PathBuf {
    let trimmed = source_path.trim().trim_matches('"');
    PathBuf::from(trimmed)
}
pub(crate) fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

pub fn run_agent_hook_cli() -> Option<Result<(), String>> {
    agent_monitor::run_agent_hook_cli()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    diagnostics::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ReminderManager::new())
        .manage(TaskManager::new())
        .setup(|app| {
            diagnostics::info("app", "Tauri setup started");
            let _ = app.notification().request_permission();
            app.state::<TaskManager>().start(app.handle().clone());
            start_reminder_scheduler(app.handle().clone());
            tray::setup_tray(app)?;
            diagnostics::info("app", "Tauri setup completed");
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "settings" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    diagnostics::info("windows", "settings close request converted to hide");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            find_pet_candidates,
            import_pet_package,
            delete_pet_package,
            agent_monitor::start_agent_monitor,
            agent_monitor::get_agent_hook_statuses,
            agent_monitor::install_agent_hook,
            agent_monitor::uninstall_agent_hook,
            task_queue::run_codex_task,
            task_queue::get_task_state,
            task_queue::open_task_terminal,
            task_queue::cancel_codex_task,
            task_queue::clear_task_history,
            tasks::open_terminal,
            tasks::list_terminals,
            reminders::get_reminder_state,
            reminders::get_reminder_config_health,
            reminders::repair_reminder_config,
            reminders::save_reminder_config,
            reminders::delete_reminder_config,
            reminders::preview_reminder,
            windows::restore_main_window,
            windows::get_main_window_visibility,
            windows::hide_main_window,
            windows::toggle_main_window,
            windows::open_settings_window,
            windows::hide_settings_window,
            windows::quit_app,
            diagnostics::get_diagnostics_info,
            diagnostics::record_diagnostic_event,
            diagnostics::open_diagnostics_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    #[test]
    fn bounded_line_reader_discards_oversized_lines_and_recovers() {
        let input = b"first\ntoolong\nlast";
        let mut reader = BufReader::new(std::io::Cursor::new(input));

        assert_eq!(
            read_bounded_line(&mut reader, 5).unwrap(),
            Some(b"first".to_vec())
        );
        assert_eq!(read_bounded_line(&mut reader, 5).unwrap(), Some(Vec::new()));
        assert_eq!(
            read_bounded_line(&mut reader, 5).unwrap(),
            Some(b"last".to_vec())
        );
        assert_eq!(read_bounded_line(&mut reader, 5).unwrap(), None);
    }

    #[test]
    fn event_messages_remove_controls_and_are_bounded() {
        assert_eq!(
            normalize_event_message("ok\u{1b}[31m\nnext"),
            "ok[31m\nnext"
        );
        let long = "x".repeat(MAX_EVENT_MESSAGE_CHARS + 1);
        assert_eq!(
            normalize_event_message(&long).len(),
            MAX_EVENT_MESSAGE_CHARS
        );
    }

    #[test]
    fn codex_json_events_keep_per_task_activity_and_session_id() {
        let (_, started) =
            parse_codex_json_event(r#"{"type":"thread.started","thread_id":"session-123"}"#)
                .expect("parse thread event");
        assert_eq!(started.state.as_deref(), Some("thinking"));
        assert_eq!(started.codex_session_id.as_deref(), Some("session-123"));

        let (_, command) = parse_codex_json_event(
            r#"{"type":"item.started","item":{"type":"command_execution","command":"pnpm test"}}"#,
        )
        .expect("parse command event");
        assert_eq!(command.state.as_deref(), Some("running_command"));
        assert_eq!(command.message, "运行命令：pnpm test");
    }
}
