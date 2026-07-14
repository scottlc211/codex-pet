use crate::home_dir;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

static LOG_LOCK: Mutex<()> = Mutex::new(());

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_COMPONENT_CHARS: usize = 48;
const MAX_MESSAGE_CHARS: usize = 2048;
const LOG_FILE_NAME: &str = "codex-pet.log";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticEntry<'a> {
    timestamp_ms: u128,
    level: &'a str,
    component: &'a str,
    message: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsInfo {
    version: &'static str,
    platform: &'static str,
    log_directory: String,
    log_path: String,
    log_size_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticEvent {
    level: String,
    component: String,
    message: String,
}

pub(crate) fn init() {
    info("app", "application starting");
}

pub(crate) fn info(component: &str, message: &str) {
    let _ = record("info", component, message);
}

pub(crate) fn warn(component: &str, message: &str) {
    let _ = record("warn", component, message);
}

pub(crate) fn error(component: &str, message: &str) {
    let _ = record("error", component, message);
}

fn record(level: &str, component: &str, message: &str) -> Result<(), String> {
    let level = normalize_level(level);
    let component = normalize_text(component, MAX_COMPONENT_CHARS, "app");
    let message = normalize_text(message, MAX_MESSAGE_CHARS, "no details");
    let path = log_path()?;
    let _guard = LOG_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| format!("创建日志目录失败：{error}"))?;
    rotate_log_if_needed(&path)?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("打开日志文件失败：{error}"))?;
    let entry = DiagnosticEntry {
        timestamp_ms: now_ms(),
        level,
        component: &component,
        message: &message,
    };
    serde_json::to_writer(&mut file, &entry).map_err(|error| format!("写入日志失败：{error}"))?;
    file.write_all(b"\n")
        .map_err(|error| format!("写入日志换行失败：{error}"))
}

fn diagnostics_directory() -> Result<PathBuf, String> {
    home_dir()
        .map(|home| home.join(".codex-pet").join("logs"))
        .ok_or_else(|| "无法定位用户目录".to_string())
}

fn log_path() -> Result<PathBuf, String> {
    Ok(diagnostics_directory()?.join(LOG_FILE_NAME))
}

fn rotate_log_if_needed(path: &Path) -> Result<(), String> {
    if fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
        < MAX_LOG_BYTES
    {
        return Ok(());
    }

    let rotated = rotated_log_path(path);
    if rotated.exists() {
        fs::remove_file(&rotated).map_err(|error| format!("删除旧日志失败：{error}"))?;
    }
    fs::rename(path, rotated).map_err(|error| format!("轮换日志失败：{error}"))
}

fn rotated_log_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(LOG_FILE_NAME);
    path.with_file_name(format!("{name}.1"))
}

fn normalize_level(value: &str) -> &'static str {
    match value.to_ascii_lowercase().as_str() {
        "debug" => "debug",
        "warn" | "warning" => "warn",
        "error" => "error",
        _ => "info",
    }
}

fn normalize_text(value: &str, limit: usize, fallback: &str) -> String {
    let text = value
        .trim()
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\t'))
        .take(limit)
        .collect::<String>();
    if text.is_empty() {
        fallback.to_string()
    } else {
        text
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[tauri::command]
pub(crate) fn get_diagnostics_info() -> Result<DiagnosticsInfo, String> {
    let directory = diagnostics_directory()?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建日志目录失败：{error}"))?;
    let path = directory.join(LOG_FILE_NAME);
    Ok(DiagnosticsInfo {
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        log_directory: directory.to_string_lossy().to_string(),
        log_path: path.to_string_lossy().to_string(),
        log_size_bytes: fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0),
    })
}

#[tauri::command]
pub(crate) fn record_diagnostic_event(event: DiagnosticEvent) -> Result<(), String> {
    record(&event.level, &event.component, &event.message)
}

#[tauri::command]
pub(crate) fn open_diagnostics_directory() -> Result<(), String> {
    let directory = diagnostics_directory()?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建日志目录失败：{error}"))?;
    open_directory(&directory)?;
    info("diagnostics", "opened diagnostics directory");
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_directory(path: &Path) -> Result<(), String> {
    let explorer = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .map(|root| root.join("explorer.exe"))
        .filter(|candidate| candidate.is_file())
        .ok_or_else(|| "未找到系统 explorer.exe".to_string())?;
    Command::new(explorer)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开日志目录失败：{error}"))
}

#[cfg(target_os = "macos")]
fn open_directory(path: &Path) -> Result<(), String> {
    Command::new("/usr/bin/open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开日志目录失败：{error}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_directory(path: &Path) -> Result<(), String> {
    let executable = ["/usr/bin/xdg-open", "/bin/xdg-open"]
        .iter()
        .map(Path::new)
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "未找到系统 xdg-open 命令".to_string())?;
    Command::new(executable)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开日志目录失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_text_removes_controls_and_applies_limit() {
        assert_eq!(normalize_text(" ok\nnext ", 20, "fallback"), "oknext");
        assert_eq!(normalize_text("abcdef", 3, "fallback"), "abc");
        assert_eq!(normalize_text("\n", 3, "fallback"), "fallback");
    }

    #[test]
    fn rotated_log_keeps_original_file_name() {
        assert_eq!(
            rotated_log_path(Path::new("/tmp/codex-pet.log")),
            PathBuf::from("/tmp/codex-pet.log.1")
        );
    }
}
