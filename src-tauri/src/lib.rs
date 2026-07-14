mod codex_monitor;
mod diagnostics;
mod pets;
mod reminders;
mod storage;
mod task_queue;
mod tasks;
mod tray;
mod windows;

use codex_monitor::start_codex_session_monitor;
use pets::{find_pet_candidates, import_pet_package};
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
struct CodexPetEvent {
    kind: String,
    message: String,
    state: Option<String>,
    session_id: Option<String>,
}

pub(crate) fn emit_codex_event(
    app: &AppHandle,
    kind: &str,
    message: &str,
    state: Option<&str>,
    session_id: Option<String>,
) {
    let _ = app.emit(
        "codex-event",
        CodexPetEvent {
            kind: kind.to_string(),
            message: normalize_event_message(message),
            state: state.map(str::to_string),
            session_id,
        },
    );
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

pub(crate) fn handle_codex_json_line(app: &AppHandle, line: &str, session_id: Option<&str>) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        emit_codex_event(app, "log", line, None, session_id.map(str::to_string));
        return;
    };

    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("event");

    let (message, state) = match event_type {
        "thread.started" => ("新线程已创建".to_string(), Some("thinking")),
        "turn.started" => ("Codex 正在处理".to_string(), Some("thinking")),
        "turn.completed" => ("Codex 回合完成".to_string(), Some("success")),
        "turn.failed" => ("Codex 回合失败".to_string(), Some("error")),
        "item.started" | "item.completed" => summarize_item(&value),
        _ => (event_type.to_string(), None),
    };

    emit_codex_event(
        app,
        event_type,
        &message,
        state,
        session_id.map(str::to_string),
    );
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
            start_codex_session_monitor,
            task_queue::run_codex_task,
            task_queue::get_task_state,
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
}
