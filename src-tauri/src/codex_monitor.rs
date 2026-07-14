use crate::{diagnostics, emit_codex_event, home_dir, is_plain_directory};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);

const ACTIVE_SESSION_WINDOW_MS: u128 = 10 * 60 * 1000;
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
const MAX_SESSION_READ_BYTES: u64 = 1024 * 1024;
const MAX_SESSION_LINE_BYTES: usize = 1024 * 1024;
const MAX_SESSION_LINES_PER_POLL: usize = 4096;
const MAX_SESSION_SCAN_ENTRIES: usize = 5000;
const MAX_ACTIVE_SESSION_FILES: usize = 128;

#[tauri::command]
pub(crate) fn start_codex_session_monitor(app: AppHandle) -> Result<(), String> {
    if MONITOR_STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    diagnostics::info("monitor", "started Codex session monitor");

    thread::spawn(move || {
        emit_codex_event(
            &app,
            "monitor.started",
            "已开始监听 Codex sessions",
            Some("idle"),
            None,
        );
        let mut monitor = CodexSessionMonitor::new();
        loop {
            monitor.poll(&app);
            thread::sleep(POLL_INTERVAL);
        }
    });

    Ok(())
}

struct CodexSessionMonitor {
    offsets: HashMap<PathBuf, u64>,
    pending_lines: HashMap<PathBuf, Vec<u8>>,
    started_at_ms: u128,
}

impl CodexSessionMonitor {
    fn new() -> Self {
        Self {
            offsets: HashMap::new(),
            pending_lines: HashMap::new(),
            started_at_ms: now_ms(),
        }
    }

    fn poll(&mut self, app: &AppHandle) {
        let files = self.active_rollout_files();
        let active: HashSet<&Path> = files.iter().map(PathBuf::as_path).collect();
        self.offsets
            .retain(|path, _| active.contains(path.as_path()));
        self.pending_lines
            .retain(|path, _| active.contains(path.as_path()));

        for file_path in files {
            self.poll_file(app, &file_path);
        }
    }

    fn active_rollout_files(&self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        let mut scanned_entries = 0;
        for sessions_dir in codex_sessions_dirs() {
            collect_recent_rollout_files(&sessions_dir, 0, &mut scanned_entries, &mut files);
        }
        files.sort();
        files.dedup();
        files
    }

    fn poll_file(&mut self, app: &AppHandle, file_path: &Path) {
        let Ok(metadata) = fs::metadata(file_path) else {
            return;
        };
        let size = metadata.len();
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis())
            .unwrap_or(0);

        if !self.offsets.contains_key(file_path) {
            if mtime.saturating_add(POLL_INTERVAL.as_millis()) < self.started_at_ms {
                self.offsets.insert(file_path.to_path_buf(), size);
                return;
            }
            self.offsets.insert(file_path.to_path_buf(), 0);
        }

        let offset = self.offsets.entry(file_path.to_path_buf()).or_insert(0);
        if size < *offset {
            *offset = 0;
            self.pending_lines.remove(file_path);
        }
        if size == *offset {
            return;
        }

        let Ok(mut file) = File::open(file_path) else {
            return;
        };
        if file.seek(SeekFrom::Start(*offset)).is_err() {
            return;
        }
        let bytes_to_read = size.saturating_sub(*offset).min(MAX_SESSION_READ_BYTES);
        let mut bytes = Vec::with_capacity(bytes_to_read as usize);
        if file.take(bytes_to_read).read_to_end(&mut bytes).is_err() {
            return;
        }
        *offset = offset.saturating_add(bytes.len() as u64);

        let complete_lines = {
            let pending = self
                .pending_lines
                .entry(file_path.to_path_buf())
                .or_default();
            pending.extend_from_slice(&bytes);
            let complete = pending
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map(|newline| pending.drain(..=newline).collect::<Vec<_>>())
                .unwrap_or_default();
            if pending.len() > MAX_SESSION_LINE_BYTES {
                pending.clear();
            }
            complete
        };

        for line in complete_lines
            .split(|byte| *byte == b'\n')
            .take(MAX_SESSION_LINES_PER_POLL)
        {
            if line.len() > MAX_SESSION_LINE_BYTES {
                continue;
            }
            if let Ok(line) = std::str::from_utf8(line) {
                self.process_line(app, file_path, line.trim_end_matches('\r'));
            }
        }
    }

    fn process_line(&self, app: &AppHandle, file_path: &Path, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if let Some(timestamp) = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_time_ms)
        {
            if timestamp.saturating_add(1500) < self.started_at_ms {
                return;
            }
        }

        let typ = value.get("type").and_then(Value::as_str).unwrap_or("");
        let payload_type = value
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let key = if payload_type.is_empty() {
            typ.to_string()
        } else {
            format!("{typ}:{payload_type}")
        };

        let Some((state, message)) = map_codex_session_key(&key) else {
            return;
        };

        emit_codex_event(
            app,
            &key,
            message,
            Some(state),
            rollout_session_id(file_path),
        );
    }
}

fn codex_sessions_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(codex_home) = env::var("CODEX_HOME") {
        dirs.push(PathBuf::from(codex_home).join("sessions"));
    }
    if let Some(home) = home_dir() {
        dirs.push(home.join(".codex").join("sessions"));
    }
    dirs
}

fn collect_recent_rollout_files(
    root: &Path,
    depth: usize,
    scanned_entries: &mut usize,
    files: &mut Vec<PathBuf>,
) {
    if depth > 4
        || !is_plain_directory(root)
        || *scanned_entries >= MAX_SESSION_SCAN_ENTRIES
        || files.len() >= MAX_ACTIVE_SESSION_FILES
    {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        *scanned_entries += 1;
        if *scanned_entries > MAX_SESSION_SCAN_ENTRIES || files.len() >= MAX_ACTIVE_SESSION_FILES {
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_recent_rollout_files(&path, depth + 1, scanned_entries, files);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_name.starts_with("rollout-") || !file_name.ends_with(".jsonl") {
            continue;
        }
        let recent = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|modified| {
                now_ms().saturating_sub(modified.as_millis()) < ACTIVE_SESSION_WINDOW_MS
            })
            .unwrap_or(false);
        if recent {
            files.push(path);
        }
    }
}

fn map_codex_session_key(key: &str) -> Option<(&'static str, &'static str)> {
    match key {
        "session_meta" => Some(("idle", "Codex session 已发现")),
        "event_msg:task_started" | "event_msg:user_message" => Some(("thinking", "Codex 正在思考")),
        "event_msg:agent_message" => None,
        "event_msg:guardian_assessment" => Some(("waiting_input", "Codex 等待确认")),
        "event_msg:exec_command_end"
        | "event_msg:patch_apply_end"
        | "event_msg:custom_tool_call_output"
        | "response_item:function_call"
        | "response_item:custom_tool_call"
        | "response_item:web_search_call" => Some(("running_command", "Codex 正在执行工具")),
        "event_msg:context_compacted" => Some(("sweeping", "Codex 正在压缩上下文")),
        "event_msg:task_complete" => Some(("success", "Codex 任务完成")),
        "event_msg:turn_aborted" => Some(("idle", "Codex 回合已中止")),
        _ => None,
    }
}

fn rollout_session_id(file_path: &Path) -> Option<String> {
    let file = file_path.file_name()?.to_str()?;
    let stem = file.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    Some(format!("codex:{stem}"))
}

fn parse_time_ms(value: &str) -> Option<u128> {
    value.parse::<u128>().ok().or_else(|| {
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .and_then(|parsed| u128::try_from(parsed.timestamp_millis()).ok())
    })
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_keys_map_only_supported_events() {
        assert_eq!(
            map_codex_session_key("event_msg:task_started"),
            Some(("thinking", "Codex 正在思考"))
        );
        assert_eq!(map_codex_session_key("event_msg:agent_message"), None);
        assert_eq!(map_codex_session_key("unknown"), None);
    }

    #[test]
    fn rollout_file_name_becomes_stable_session_id() {
        assert_eq!(
            rollout_session_id(Path::new("rollout-2026-07-14.jsonl")),
            Some("codex:2026-07-14".to_string())
        );
        assert_eq!(rollout_session_id(Path::new("events.jsonl")), None);
    }
}
