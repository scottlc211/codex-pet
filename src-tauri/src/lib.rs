use chrono::{Datelike, Duration as ChronoDuration, Local, LocalResult, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env,
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_notification::NotificationExt;
use zip::ZipArchive;

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
static REMINDER_SCHEDULER_STARTED: AtomicBool = AtomicBool::new(false);
static IMPORT_RUNNING: AtomicBool = AtomicBool::new(false);

const ACTIVE_SESSION_WINDOW_MS: u128 = 10 * 60 * 1000;
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
const MAX_SESSION_READ_BYTES: u64 = 1024 * 1024;
const MAX_SESSION_LINE_BYTES: usize = 1024 * 1024;
const MAX_SESSION_LINES_PER_POLL: usize = 4096;
const MAX_SESSION_SCAN_ENTRIES: usize = 5000;
const MAX_ACTIVE_SESSION_FILES: usize = 128;
const MAX_CODEX_OUTPUT_LINE_BYTES: usize = 1024 * 1024;
const MAX_EVENT_MESSAGE_CHARS: usize = 4096;
const MAX_ZIP_BYTES: u64 = 80 * 1024 * 1024;
const MAX_EXTRACTED_FILE_BYTES: u64 = 30 * 1024 * 1024;
const MAX_TOTAL_IMPORT_BYTES: u64 = 120 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_IMPORT_FILES: usize = 512;
const MAX_SCANNED_IMPORT_ENTRIES: usize = 4096;
const MAX_IMPORT_DEPTH: usize = 16;
const MAX_PET_SCAN_ENTRIES: usize = 5000;
const MAX_DISCOVERED_PETS: usize = 512;
const MAX_PROMPT_BYTES: usize = 256 * 1024;
const DEFAULT_REMINDER_TITLE: &str = "周报提醒";
const DEFAULT_REMINDER_MESSAGE: &str = "老大，该写周报了。";
const DEFAULT_REMINDER_WEEKDAY: u8 = 5;
const DEFAULT_REMINDER_TIME: &str = "16:00";
const MAX_REMINDER_DURATION_MINUTES: u32 = 24 * 60;
const MAX_REMINDER_MESSAGE_CHARS: usize = 1000;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
fn hide_command_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetCandidate {
    name: String,
    path: String,
    kind: String,
    states: BTreeMap<String, PetVisual>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetVisual {
    kind: String,
    path: String,
    row: Option<u32>,
    frames: Option<u32>,
    total_ms: Option<u32>,
    frame_width: Option<u32>,
    frame_height: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexPetEvent {
    kind: String,
    message: String,
    state: Option<String>,
    session_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOption {
    id: String,
    label: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReminderConfig {
    enabled: bool,
    title: String,
    message: String,
    weekday: u8,
    time: String,
    duration_minutes: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReminderStateSnapshot {
    config: ReminderConfig,
    next_reminder_at: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReminderEvent {
    title: String,
    message: String,
    duration_minutes: u32,
    next_reminder_at: Option<i64>,
}

struct ReminderState {
    config: ReminderConfig,
    next_reminder_at: Option<i64>,
    generation: u64,
}

struct ReminderManager {
    state: Mutex<ReminderState>,
}

struct TaskManager {
    running: Arc<AtomicBool>,
}

struct TaskRunGuard {
    running: Arc<AtomicBool>,
}

struct ImportRunGuard;

#[derive(Default)]
struct ImportBudget {
    files: usize,
    scanned_entries: usize,
    total_bytes: u64,
}

impl TaskManager {
    fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    fn try_start(&self) -> Result<TaskRunGuard, String> {
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "已有 Codex 任务正在运行".to_string())?;
        Ok(TaskRunGuard {
            running: Arc::clone(&self.running),
        })
    }
}

impl Drop for TaskRunGuard {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

impl ImportRunGuard {
    fn try_start() -> Result<Self, String> {
        IMPORT_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "已有宠物资源正在导入".to_string())?;
        Ok(Self)
    }
}

impl Drop for ImportRunGuard {
    fn drop(&mut self) {
        IMPORT_RUNNING.store(false, Ordering::SeqCst);
    }
}

#[derive(Clone, Copy)]
struct AtlasRow {
    key: &'static str,
    row: u32,
    durations: &'static [u32],
}

const ATLAS_FRAME_WIDTH: u32 = 192;
const ATLAS_FRAME_HEIGHT: u32 = 208;
const ATLAS_ROWS: &[AtlasRow] = &[
    AtlasRow {
        key: "idle",
        row: 0,
        durations: &[280, 110, 110, 140, 140, 320],
    },
    AtlasRow {
        key: "running-right",
        row: 1,
        durations: &[120, 120, 120, 120, 120, 120, 120, 220],
    },
    AtlasRow {
        key: "running-left",
        row: 2,
        durations: &[120, 120, 120, 120, 120, 120, 120, 220],
    },
    AtlasRow {
        key: "waving",
        row: 3,
        durations: &[140, 140, 140, 280],
    },
    AtlasRow {
        key: "jumping",
        row: 4,
        durations: &[140, 140, 140, 140, 280],
    },
    AtlasRow {
        key: "failed",
        row: 5,
        durations: &[140, 140, 140, 140, 140, 140, 140, 240],
    },
    AtlasRow {
        key: "waiting",
        row: 6,
        durations: &[150, 150, 150, 150, 150, 260],
    },
    AtlasRow {
        key: "running",
        row: 7,
        durations: &[120, 120, 120, 120, 120, 220],
    },
    AtlasRow {
        key: "review",
        row: 8,
        durations: &[150, 150, 150, 150, 150, 280],
    },
];

impl Default for ReminderConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            title: DEFAULT_REMINDER_TITLE.to_string(),
            message: DEFAULT_REMINDER_MESSAGE.to_string(),
            weekday: DEFAULT_REMINDER_WEEKDAY,
            time: DEFAULT_REMINDER_TIME.to_string(),
            duration_minutes: 0,
        }
    }
}

impl ReminderManager {
    fn new() -> Self {
        let config = read_reminder_config_from_disk().unwrap_or_default();
        let next_reminder_at = next_reminder_timestamp(&config);
        Self {
            state: Mutex::new(ReminderState {
                config,
                next_reminder_at,
                generation: 0,
            }),
        }
    }

    fn snapshot(&self) -> ReminderStateSnapshot {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        ReminderStateSnapshot {
            config: state.config.clone(),
            next_reminder_at: state.next_reminder_at,
        }
    }

    fn save(&self, config: ReminderConfig) -> Result<ReminderStateSnapshot, String> {
        let config = normalize_reminder_config(config);
        write_reminder_config_to_disk(&config)?;
        let next_reminder_at = next_reminder_timestamp(&config);
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.config = config.clone();
        state.next_reminder_at = next_reminder_at;
        state.generation = state.generation.wrapping_add(1);
        Ok(ReminderStateSnapshot {
            config,
            next_reminder_at,
        })
    }
}

#[tauri::command]
fn find_pet_candidates() -> Vec<PetCandidate> {
    let mut candidates = Vec::new();
    let mut package_entries = 0;
    let mut image_entries = 0;

    for root in pet_roots() {
        collect_pet_packages(&root, 0, &mut package_entries, &mut candidates);
        collect_pet_images(&root, 0, &mut image_entries, &mut candidates);
    }

    candidates.sort_by(|a, b| a.name.cmp(&b.name).then(a.path.cmp(&b.path)));
    candidates.dedup_by(|a, b| a.path == b.path);
    candidates
}

#[tauri::command]
async fn import_pet_package(source_path: String) -> Result<PetCandidate, String> {
    tauri::async_runtime::spawn_blocking(move || import_pet_package_blocking(source_path))
        .await
        .map_err(|error| format!("等待导入任务失败：{error}"))?
}

fn import_pet_package_blocking(source_path: String) -> Result<PetCandidate, String> {
    let _import_guard = ImportRunGuard::try_start()?;
    let source = clean_user_path(&source_path)
        .canonicalize()
        .map_err(|error| format!("解析导入路径失败：{error}"))?;
    if source.is_dir() {
        return import_pet_directory(&source);
    }

    if source.is_file()
        && source
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("zip"))
            .unwrap_or(false)
    {
        let metadata = fs::metadata(&source).map_err(|error| format!("读取 zip 失败：{error}"))?;
        if metadata.len() > MAX_ZIP_BYTES {
            return Err("zip 包过大".to_string());
        }

        let target_dir = imported_package_dir(&source)?;
        let result = extract_zip_to_dir(&source, &target_dir).and_then(|()| {
            load_pet_package_from_dir(&target_dir)
                .or_else(|| find_first_pet_package(&target_dir, 0))
                .or_else(|| load_image_as_pet(&target_dir))
                .ok_or_else(|| "zip 包中未找到可识别的宠物资源".to_string())
        });
        if result.is_err() {
            let _ = fs::remove_dir_all(&target_dir);
        }
        return result;
    }

    if source.is_file() {
        return import_pet_image(&source);
    }

    Err("路径不存在".to_string())
}

fn import_pet_directory(source: &Path) -> Result<PetCandidate, String> {
    let target_dir = imported_package_dir(source)?;
    if target_dir
        .canonicalize()
        .is_ok_and(|target| target.starts_with(source))
    {
        let _ = fs::remove_dir_all(&target_dir);
        return Err("不能导入包含宠物存储目录的上级目录".to_string());
    }
    let result = copy_import_directory(source, &target_dir).and_then(|()| {
        load_pet_package_from_dir(&target_dir)
            .or_else(|| find_first_pet_package(&target_dir, 0))
            .or_else(|| load_image_as_pet(&target_dir))
            .ok_or_else(|| "未找到可识别的 pet.json、theme.json 或图片资源".to_string())
    });
    if result.is_err() {
        let _ = fs::remove_dir_all(&target_dir);
    }
    result
}

fn import_pet_image(source: &Path) -> Result<PetCandidate, String> {
    if !is_supported_standalone_theme_image(source) {
        return Err("不支持的文件格式".to_string());
    }

    let target_dir = imported_package_dir(source)?;
    let result = (|| {
        let file_name = source
            .file_name()
            .ok_or_else(|| "无法识别导入文件名".to_string())?;
        let target = target_dir.join(file_name);
        let mut budget = ImportBudget::default();
        copy_import_file(source, &target, &mut budget)?;
        load_image_file_as_pet(&target).ok_or_else(|| "不支持的文件格式".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&target_dir);
    }
    result
}

#[tauri::command]
fn start_codex_session_monitor(app: AppHandle) -> Result<(), String> {
    if MONITOR_STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

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

#[tauri::command]
fn run_codex_task(
    app: AppHandle,
    manager: State<TaskManager>,
    prompt: String,
    cwd: Option<String>,
    codex_path: Option<String>,
) -> Result<(), String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("任务内容不能为空".to_string());
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(format!("任务内容不能超过 {} KiB", MAX_PROMPT_BYTES / 1024));
    }

    let cwd = resolve_work_path(cwd)?;
    let mut command = new_codex_command(codex_path)?;
    let task_guard = manager.try_start()?;

    thread::Builder::new()
        .name("codex-task".to_string())
        .spawn(move || {
            let _task_guard = task_guard;
            emit_codex_event(&app, "started", "Codex CLI 已启动", Some("thinking"), None);

            command.arg("exec").arg("--json");
            if !has_git_root(&cwd) {
                command.arg("--skip-git-repo-check");
            }
            command
                .arg("-")
                .current_dir(&cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            match command.spawn() {
                Ok(mut child) => {
                    let stdout = child.stdout.take();
                    let stderr = child.stderr.take();
                    let stdout_app = app.clone();
                    let stderr_app = app.clone();

                    let stdout_thread = thread::spawn(move || {
                        if let Some(stdout) = stdout {
                            let mut reader = BufReader::new(stdout);
                            while let Ok(Some(line)) =
                                read_bounded_line(&mut reader, MAX_CODEX_OUTPUT_LINE_BYTES)
                            {
                                if !line.is_empty() {
                                    handle_codex_json_line(
                                        &stdout_app,
                                        &String::from_utf8_lossy(&line),
                                    );
                                }
                            }
                        }
                    });

                    let stderr_thread = thread::spawn(move || {
                        if let Some(stderr) = stderr {
                            let mut reader = BufReader::new(stderr);
                            while let Ok(Some(line)) =
                                read_bounded_line(&mut reader, MAX_CODEX_OUTPUT_LINE_BYTES)
                            {
                                let line = String::from_utf8_lossy(&line);
                                let message = line.trim();
                                if !message.is_empty() {
                                    emit_codex_event(&stderr_app, "log", message, None, None);
                                }
                            }
                        }
                    });

                    let prompt_write_error = child
                        .stdin
                        .take()
                        .ok_or_else(|| "无法打开 Codex 标准输入".to_string())
                        .and_then(|mut stdin| {
                            stdin
                                .write_all(prompt.as_bytes())
                                .map_err(|error| format!("写入 Codex 任务失败：{error}"))
                        })
                        .err();
                    if prompt_write_error.is_some() {
                        let _ = child.kill();
                    }

                    let status = child.wait();
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();

                    if let Some(error) = prompt_write_error {
                        emit_codex_event(&app, "error", &error, Some("error"), None);
                        return;
                    }

                    match status {
                        Ok(status) if status.success() => {
                            emit_codex_event(&app, "completed", "任务完成", Some("success"), None);
                        }
                        Ok(status) => {
                            emit_codex_event(
                                &app,
                                "error",
                                &format!("Codex 退出码：{status}"),
                                Some("error"),
                                None,
                            );
                        }
                        Err(error) => {
                            emit_codex_event(
                                &app,
                                "error",
                                &format!("等待 Codex 失败：{error}"),
                                Some("error"),
                                None,
                            );
                        }
                    }
                }
                Err(error) => {
                    emit_codex_event(
                        &app,
                        "error",
                        &format!("无法启动 codex：{error}"),
                        Some("error"),
                        None,
                    );
                }
            }
        })
        .map_err(|error| format!("创建 Codex 任务线程失败：{error}"))?;

    Ok(())
}

#[tauri::command]
fn open_terminal(cwd: Option<String>, terminal: Option<String>) -> Result<(), String> {
    let cwd = resolve_work_path(cwd)?;
    open_terminal_at(&cwd, terminal.as_deref())
}

#[tauri::command]
fn list_terminals() -> Vec<TerminalOption> {
    available_terminal_options()
}

#[tauri::command]
fn get_reminder_state(manager: State<ReminderManager>) -> ReminderStateSnapshot {
    manager.snapshot()
}

#[tauri::command]
fn save_reminder_config(
    app: AppHandle,
    manager: State<ReminderManager>,
    config: ReminderConfig,
) -> Result<ReminderStateSnapshot, String> {
    let snapshot = manager.save(config)?;
    let _ = app.emit("reminder-state-updated", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
fn preview_reminder(app: AppHandle, config: ReminderConfig) -> Result<(), String> {
    let config = normalize_reminder_config(config);
    emit_reminder_event(&app, &config, next_reminder_timestamp(&config), false);
    restore_main_window(app)
}

#[tauri::command]
fn restore_main_window(app: AppHandle) -> Result<(), String> {
    restore_main_window_state(&app)
}

fn emit_codex_event(
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

fn read_bounded_line(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<Vec<u8>>> {
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

fn start_reminder_scheduler(app: AppHandle) {
    if REMINDER_SCHEDULER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    thread::spawn(move || loop {
        let due = {
            let manager = app.state::<ReminderManager>();
            let mut state = manager
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let now = Local::now().timestamp_millis();
            if state.next_reminder_at.is_none() {
                state.next_reminder_at = next_reminder_timestamp(&state.config);
            }

            match state.next_reminder_at {
                Some(trigger_at) if trigger_at <= now => {
                    let config = state.config.clone();
                    let next_reminder_at = next_reminder_timestamp(&config);
                    state.next_reminder_at = next_reminder_at;
                    state.generation = state.generation.wrapping_add(1);
                    Some((config, next_reminder_at))
                }
                _ => None,
            }
        };

        if let Some((config, next_reminder_at)) = due {
            emit_reminder_event(&app, &config, next_reminder_at, true);
        }

        thread::sleep(Duration::from_secs(15));
    });
}

fn emit_reminder_event(
    app: &AppHandle,
    config: &ReminderConfig,
    next_reminder_at: Option<i64>,
    notify: bool,
) {
    let title = normalized_reminder_title(&config.title);
    let message = normalized_reminder_message(&config.message);
    let payload = ReminderEvent {
        title: title.clone(),
        message: message.clone(),
        duration_minutes: config.duration_minutes,
        next_reminder_at,
    };

    let _ = app.emit("reminder-triggered", payload);
    if notify {
        let _ = restore_main_window_state(app);
        let _ = app
            .notification()
            .builder()
            .title(&title)
            .body(&message)
            .show();
    }
}

fn restore_main_window_state(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("未找到主窗口".to_string());
    };

    let _ = window.set_ignore_cursor_events(false);
    let _ = window.set_always_on_top(true);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

fn read_reminder_config_from_disk() -> Option<ReminderConfig> {
    let path = reminder_config_path()?;
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<ReminderConfig>(&text)
        .ok()
        .map(normalize_reminder_config)
}

fn write_reminder_config_to_disk(config: &ReminderConfig) -> Result<(), String> {
    let path = reminder_config_path().ok_or_else(|| "无法定位用户目录".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建提醒配置目录失败：{error}"))?;
    }
    let text = serde_json::to_string_pretty(config)
        .map_err(|error| format!("序列化提醒配置失败：{error}"))?;
    fs::write(path, text).map_err(|error| format!("写入提醒配置失败：{error}"))
}

fn reminder_config_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".codex-pet").join("reminder.json"))
}

fn normalize_reminder_config(config: ReminderConfig) -> ReminderConfig {
    ReminderConfig {
        enabled: config.enabled,
        title: normalized_reminder_title(&config.title),
        message: normalized_reminder_message(&config.message),
        weekday: normalize_reminder_weekday(config.weekday),
        time: normalize_reminder_time(&config.time),
        duration_minutes: config.duration_minutes.min(MAX_REMINDER_DURATION_MINUTES),
    }
}

fn normalized_reminder_title(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        DEFAULT_REMINDER_TITLE.to_string()
    } else {
        value.chars().take(16).collect()
    }
}

fn normalized_reminder_message(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        DEFAULT_REMINDER_MESSAGE.to_string()
    } else {
        value.chars().take(MAX_REMINDER_MESSAGE_CHARS).collect()
    }
}

fn normalize_reminder_weekday(value: u8) -> u8 {
    if value <= 6 {
        value
    } else {
        DEFAULT_REMINDER_WEEKDAY
    }
}

fn normalize_reminder_time(value: &str) -> String {
    if parse_reminder_time(value).is_some() {
        value.to_string()
    } else {
        DEFAULT_REMINDER_TIME.to_string()
    }
}

fn parse_reminder_time(value: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(value.trim(), "%H:%M").ok()
}

fn next_reminder_timestamp(config: &ReminderConfig) -> Option<i64> {
    if !config.enabled {
        return None;
    }

    let time = parse_reminder_time(&config.time)?;
    let weekday = normalize_reminder_weekday(config.weekday) as u32;
    let now = Local::now();
    let today = now.date_naive();

    for offset in 0..=7 {
        let date = today.checked_add_signed(ChronoDuration::days(offset))?;
        if date.weekday().num_days_from_sunday() != weekday {
            continue;
        }

        let candidate = match Local.from_local_datetime(&date.and_time(time)) {
            LocalResult::Single(value) => value,
            LocalResult::Ambiguous(earliest, _) => earliest,
            LocalResult::None => continue,
        };
        if candidate > now {
            return Some(candidate.timestamp_millis());
        }
    }

    None
}

fn handle_codex_json_line(app: &AppHandle, line: &str) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        emit_codex_event(app, "log", line, None, None);
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

    emit_codex_event(app, event_type, &message, state, None);
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

fn new_codex_command(codex_path: Option<String>) -> Result<Command, String> {
    let executable = resolve_codex_executable(codex_path)?;
    command_for_executable(&executable)
}

fn resolve_codex_executable(codex_path: Option<String>) -> Result<PathBuf, String> {
    if let Some(configured_path) = normalize_optional_text(codex_path) {
        return resolve_configured_codex_executable(&configured_path);
    }

    auto_detect_codex_executable().ok_or_else(|| {
        "未找到 Codex CLI，请在设置中填写 Codex CLI 路径，例如 C:\\Program Files\\nodejs\\codex.cmd".to_string()
    })
}

fn resolve_configured_codex_executable(value: &str) -> Result<PathBuf, String> {
    let looks_like_path = value.contains(std::path::MAIN_SEPARATOR)
        || value.contains('/')
        || value.contains('\\')
        || Path::new(value).is_absolute();
    if !looks_like_path {
        if !is_allowed_codex_executable_name(value) {
            return Err("Codex 命令名必须是 codex、codex.exe、codex.cmd 或 codex.bat".to_string());
        }
        return auto_detect_named_executable(value)
            .ok_or_else(|| format!("未找到配置的 Codex 命令：{value}"));
    }

    let mut path = clean_user_path(value);
    #[cfg(target_os = "windows")]
    {
        if path.extension().is_none() {
            if let Some(with_cmd) = sibling_with_extension(&path, "cmd") {
                path = with_cmd;
            } else if let Some(with_exe) = sibling_with_extension(&path, "exe") {
                path = with_exe;
            }
        }
    }
    if !path.exists() {
        return Err(format!("配置的 Codex 路径不存在：{}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("配置的 Codex 路径不是文件：{}", path.display()));
    }
    if !path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(is_allowed_codex_executable_name)
    {
        return Err(
            "Codex 可执行文件名必须是 codex、codex.exe、codex.cmd 或 codex.bat".to_string(),
        );
    }

    Ok(path.canonicalize().unwrap_or(path))
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(target_os = "windows")]
fn command_for_executable(executable: &Path) -> Result<Command, String> {
    let is_cmd_script = executable
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);
    if is_cmd_script {
        let text = executable.to_string_lossy();
        if text.chars().any(is_windows_shell_metacharacter) {
            return Err("Codex 批处理路径包含不安全的 shell 字符".to_string());
        }
        let cmd =
            windows_system_executable("cmd.exe").ok_or_else(|| "未找到系统 cmd.exe".to_string())?;
        let mut command = Command::new(cmd);
        command.arg("/D").arg("/S").arg("/C").arg(executable);
        hide_command_window(&mut command);
        return Ok(command);
    }

    let mut command = Command::new(executable);
    hide_command_window(&mut command);
    Ok(command)
}

#[cfg(not(target_os = "windows"))]
fn command_for_executable(executable: &Path) -> Result<Command, String> {
    Ok(Command::new(executable))
}

fn is_safe_command_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_allowed_codex_executable_name(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "codex" | "codex.exe" | "codex.cmd" | "codex.bat"
    )
}

#[cfg(target_os = "windows")]
fn is_windows_shell_metacharacter(value: char) -> bool {
    matches!(
        value,
        '&' | '|' | '<' | '>' | '^' | '%' | '!' | '(' | ')' | '\r' | '\n' | '"'
    )
}

#[cfg(target_os = "windows")]
fn auto_detect_codex_executable() -> Option<PathBuf> {
    auto_detect_named_executable("codex").or_else(|| {
        let mut candidates = Vec::new();
        if let Some(program_files) = env::var_os("ProgramFiles") {
            let base = PathBuf::from(program_files).join("nodejs");
            candidates.push(base.join("codex.cmd"));
            candidates.push(base.join("codex.exe"));
            candidates.push(base.join("codex"));
        }
        if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
            let base = PathBuf::from(program_files_x86).join("nodejs");
            candidates.push(base.join("codex.cmd"));
            candidates.push(base.join("codex.exe"));
            candidates.push(base.join("codex"));
        }
        if let Some(nvm_symlink) = env::var_os("NVM_SYMLINK") {
            let base = PathBuf::from(nvm_symlink);
            candidates.push(base.join("codex.cmd"));
            candidates.push(base.join("codex.exe"));
            candidates.push(base.join("codex"));
        }
        if let Some(home) = home_dir() {
            let base = home.join(".local").join("bin");
            candidates.push(base.join("codex"));
            candidates.push(base.join("codex.cmd"));
        }
        candidates.into_iter().find(|path| path.is_file())
    })
}

#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
fn auto_detect_codex_executable() -> Option<PathBuf> {
    auto_detect_named_executable("codex").or_else(|| {
        home_dir()
            .map(|home| home.join(".local").join("bin").join("codex"))
            .filter(|path| path.is_file())
    })
}

#[cfg(target_os = "windows")]
fn auto_detect_named_executable(command: &str) -> Option<PathBuf> {
    let with_cmd = format!("{command}.cmd");
    find_windows_executable(&with_cmd)
        .or_else(|| {
            let with_exe = format!("{command}.exe");
            find_windows_executable(&with_exe)
        })
        .or_else(|| {
            let with_bat = format!("{command}.bat");
            find_windows_executable(&with_bat)
        })
}

#[cfg(target_os = "windows")]
fn sibling_with_extension(path: &Path, extension: &str) -> Option<PathBuf> {
    let candidate = path.with_extension(extension);
    candidate.is_file().then_some(candidate)
}

#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
fn auto_detect_named_executable(command: &str) -> Option<PathBuf> {
    find_unix_executable(command)
}

fn pet_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Some(home) = home_dir() {
        roots.push(home.join(".codex").join("pets"));
        roots.push(home.join(".codex-pet").join("pets"));
    }

    roots
}

fn collect_pet_packages(
    root: &Path,
    depth: usize,
    scanned_entries: &mut usize,
    candidates: &mut Vec<PetCandidate>,
) {
    if depth > 5
        || !is_plain_directory(root)
        || *scanned_entries >= MAX_PET_SCAN_ENTRIES
        || candidates.len() >= MAX_DISCOVERED_PETS
    {
        return;
    }

    if let Some(candidate) = load_pet_package_from_dir(root) {
        candidates.push(candidate);
        return;
    }

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        *scanned_entries += 1;
        if *scanned_entries > MAX_PET_SCAN_ENTRIES || candidates.len() >= MAX_DISCOVERED_PETS {
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
            collect_pet_packages(&path, depth + 1, scanned_entries, candidates);
        }
    }
}

fn collect_pet_images(
    root: &Path,
    depth: usize,
    scanned_entries: &mut usize,
    candidates: &mut Vec<PetCandidate>,
) {
    if depth > 3
        || !is_plain_directory(root)
        || *scanned_entries >= MAX_PET_SCAN_ENTRIES
        || candidates.len() >= MAX_DISCOVERED_PETS
    {
        return;
    }
    if load_pet_package_from_dir(root).is_some() {
        return;
    }

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        *scanned_entries += 1;
        if *scanned_entries > MAX_PET_SCAN_ENTRIES || candidates.len() >= MAX_DISCOVERED_PETS {
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
            collect_pet_images(&path, depth + 1, scanned_entries, candidates);
            continue;
        }

        if file_type.is_file() {
            if let Some(candidate) = load_image_file_as_pet(&path) {
                candidates.push(candidate);
            }
        }
    }
}

fn load_pet_package_from_dir(package_dir: &Path) -> Option<PetCandidate> {
    let manifest_path = ["pet.json", "theme.json"]
        .iter()
        .map(|name| package_dir.join(name))
        .find(|path| path.is_file())?;

    let manifest = read_text_file_limited(&manifest_path, MAX_MANIFEST_BYTES)?;
    let manifest: Value = serde_json::from_str(&manifest).ok()?;
    let raw_name = manifest
        .get("displayName")
        .or_else(|| manifest.get("name"))
        .or_else(|| manifest.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            package_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Pet")
        });
    let name = normalize_pet_name(raw_name);

    if let Some(states) = manifest.get("states").and_then(Value::as_object) {
        let mut resolved_states = BTreeMap::new();
        for (state, value) in states {
            if let Some(visual) = parse_state_visual(package_dir, value) {
                resolved_states.insert(normalize_state_name(state), visual);
            }
        }
        resolve_missing_state_aliases(&mut resolved_states);
        if !resolved_states.is_empty() {
            return Some(PetCandidate {
                name,
                path: package_dir.to_string_lossy().to_string(),
                kind: "state-package".to_string(),
                states: resolved_states,
            });
        }
    }

    let spritesheet_path = manifest.get("spritesheetPath").and_then(Value::as_str)?;
    let spritesheet = resolve_package_file(package_dir, spritesheet_path)?;
    Some(PetCandidate {
        name,
        path: package_dir.to_string_lossy().to_string(),
        kind: "codex-pet-atlas".to_string(),
        states: codex_atlas_states(&spritesheet),
    })
}

fn parse_state_visual(package_dir: &Path, value: &Value) -> Option<PetVisual> {
    if let Some(file) = value.as_str() {
        return image_visual(package_dir, file);
    }

    if let Some(items) = value.as_array() {
        return items.iter().find_map(|item| {
            item.as_str()
                .and_then(|file| image_visual(package_dir, file))
        });
    }

    let object = value.as_object()?;
    if let Some(files) = object.get("files").and_then(Value::as_array) {
        return files.iter().find_map(|item| {
            item.as_str()
                .and_then(|file| image_visual(package_dir, file))
        });
    }
    if let Some(file) = object.get("file").and_then(Value::as_str) {
        return image_visual(package_dir, file);
    }

    None
}

fn image_visual(package_dir: &Path, relative_path: &str) -> Option<PetVisual> {
    let path = resolve_package_file(package_dir, relative_path)?;
    if !is_supported_image(&path) {
        return None;
    }

    Some(PetVisual {
        kind: "image".to_string(),
        path: path.to_string_lossy().to_string(),
        row: None,
        frames: None,
        total_ms: None,
        frame_width: None,
        frame_height: None,
    })
}

fn codex_atlas_states(spritesheet: &Path) -> BTreeMap<String, PetVisual> {
    let mut states = BTreeMap::new();
    for (state, row_key) in [
        ("idle", "idle"),
        ("thinking", "review"),
        ("working", "running"),
        ("running_command", "running"),
        ("editing_file", "running"),
        ("waiting_input", "waiting"),
        ("notification", "waiting"),
        ("success", "jumping"),
        ("attention", "jumping"),
        ("error", "failed"),
        ("dragging", "running"),
        ("dragging_left", "running-left"),
        ("dragging_right", "running-right"),
        ("sleeping", "idle"),
        ("sweeping", "running"),
        ("carrying", "running"),
    ] {
        if let Some(visual) = atlas_visual(spritesheet, row_key) {
            states.insert(state.to_string(), visual);
        }
    }
    states
}

fn atlas_visual(spritesheet: &Path, row_key: &str) -> Option<PetVisual> {
    let row = ATLAS_ROWS.iter().find(|row| row.key == row_key)?;
    Some(PetVisual {
        kind: "atlas".to_string(),
        path: spritesheet.to_string_lossy().to_string(),
        row: Some(row.row),
        frames: Some(row.durations.len() as u32),
        total_ms: Some(row.durations.iter().sum()),
        frame_width: Some(ATLAS_FRAME_WIDTH),
        frame_height: Some(ATLAS_FRAME_HEIGHT),
    })
}

fn resolve_missing_state_aliases(states: &mut BTreeMap<String, PetVisual>) {
    let aliases = [
        ("thinking", "idle"),
        ("working", "thinking"),
        ("running_command", "working"),
        ("editing_file", "working"),
        ("waiting_input", "notification"),
        ("success", "attention"),
        ("error", "idle"),
        ("dragging", "working"),
        ("dragging_left", "dragging"),
        ("dragging_right", "dragging"),
    ];

    for (state, fallback) in aliases {
        if states.contains_key(state) {
            continue;
        }
        if let Some(visual) = states
            .get(fallback)
            .cloned()
            .or_else(|| states.get("idle").cloned())
        {
            states.insert(state.to_string(), visual);
        }
    }
}

fn load_image_as_pet(dir: &Path) -> Option<PetCandidate> {
    let mut images = Vec::new();
    collect_image_paths(dir, 0, &mut images);
    images
        .into_iter()
        .next()
        .and_then(|path| load_image_file_as_pet(&path))
}

fn load_image_file_as_pet(path: &Path) -> Option<PetCandidate> {
    if !is_supported_standalone_theme_image(path) {
        return None;
    }

    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("pet")
        .to_string();
    let visual = PetVisual {
        kind: "image".to_string(),
        path: path.to_string_lossy().to_string(),
        row: None,
        frames: None,
        total_ms: None,
        frame_width: None,
        frame_height: None,
    };

    let mut states = BTreeMap::new();
    for state in [
        "idle",
        "thinking",
        "working",
        "running_command",
        "editing_file",
        "waiting_input",
        "success",
        "error",
        "dragging",
    ] {
        states.insert(state.to_string(), visual.clone());
    }

    Some(PetCandidate {
        name,
        path: path.to_string_lossy().to_string(),
        kind: "image".to_string(),
        states,
    })
}

fn find_first_pet_package(root: &Path, depth: usize) -> Option<PetCandidate> {
    if depth > MAX_IMPORT_DEPTH || !is_plain_directory(root) {
        return None;
    }
    if let Some(candidate) = load_pet_package_from_dir(root) {
        return Some(candidate);
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        if let Some(candidate) = find_first_pet_package(&path, depth + 1) {
            return Some(candidate);
        }
    }
    None
}

fn collect_image_paths(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 || !root.exists() {
        return;
    }
    if root.is_file() {
        if is_supported_standalone_theme_image(root) {
            out.push(root.to_path_buf());
        }
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_image_paths(&path, depth + 1, out);
        } else if file_type.is_file() && is_supported_standalone_theme_image(&path) {
            out.push(path);
        }
    }
}

fn resolve_package_file(package_dir: &Path, relative_path: &str) -> Option<PathBuf> {
    let root = package_dir.canonicalize().ok()?;
    let relative = safe_relative_path(relative_path)?;
    for base in [root.clone(), root.join("assets")] {
        if let Ok(candidate) = base.join(&relative).canonicalize() {
            if candidate.is_file() && candidate.starts_with(&root) {
                return Some(candidate);
            }
        }
    }
    None
}

fn normalize_state_name(state: &str) -> String {
    match state {
        "attention" | "happy" => "success",
        "notification" => "waiting_input",
        "working" => "working",
        "typing" => "running_command",
        other => other,
    }
    .to_string()
}

fn is_supported_image(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "apng"
    )
}

fn is_supported_standalone_theme_image(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "apng"
    )
}

fn imported_package_dir(source: &Path) -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let root = home.join(".codex-pet").join("pets");
    fs::create_dir_all(&root).map_err(|error| format!("创建导入目录失败：{error}"))?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("pet");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let base_name = format!("{}-{timestamp}", slugify(stem));
    for suffix in 0..100 {
        let name = if suffix == 0 {
            base_name.clone()
        } else {
            format!("{base_name}-{suffix}")
        };
        let candidate = root.join(name);
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建导入目录失败：{error}")),
        }
    }
    Err("无法创建唯一的导入目录".to_string())
}

fn extract_zip_to_dir(source: &Path, target_dir: &Path) -> Result<(), String> {
    let file = File::open(source).map_err(|error| format!("打开 zip 失败：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("读取 zip 失败：{error}"))?;
    if archive.len() > MAX_IMPORT_FILES {
        return Err(format!("zip 条目数不能超过 {MAX_IMPORT_FILES}"));
    }
    let mut budget = ImportBudget::default();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 zip 条目失败：{error}"))?;
        if entry.is_dir() {
            continue;
        }

        let relative = safe_relative_path(entry.name())
            .ok_or_else(|| format!("zip 包含不安全路径：{}", entry.name()))?;

        if !is_allowed_import_file(&relative) {
            continue;
        }

        let out_path = target_dir.join(relative);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
        }
        copy_import_reader(&mut entry, &out_path, &mut budget)?;
    }

    if budget.files == 0 {
        return Err("zip 包中没有可导入的文件".to_string());
    }
    Ok(())
}

fn safe_relative_path(name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    let path = Path::new(&normalized);
    let mut out = PathBuf::new();
    let mut depth = 0;
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                depth += 1;
                if depth > MAX_IMPORT_DEPTH {
                    return None;
                }
                out.push(part);
            }
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn copy_import_directory(source: &Path, target: &Path) -> Result<(), String> {
    let mut budget = ImportBudget::default();
    copy_import_directory_inner(source, source, target, 0, &mut budget)?;
    if budget.files == 0 {
        return Err("目录中没有可导入的文件".to_string());
    }
    Ok(())
}

fn copy_import_directory_inner(
    root: &Path,
    current: &Path,
    target: &Path,
    depth: usize,
    budget: &mut ImportBudget,
) -> Result<(), String> {
    if depth > MAX_IMPORT_DEPTH {
        return Err(format!("导入目录层级不能超过 {MAX_IMPORT_DEPTH}"));
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(current).map_err(|error| format!("读取导入目录失败：{error}"))?
    {
        budget.scanned_entries += 1;
        if budget.scanned_entries > MAX_SCANNED_IMPORT_ENTRIES {
            return Err(format!(
                "导入目录条目数不能超过 {MAX_SCANNED_IMPORT_ENTRIES}"
            ));
        }
        entries.push(entry.map_err(|error| format!("读取导入目录条目失败：{error}"))?);
    }
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取导入条目类型失败：{error}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "导入目录不能包含符号链接：{}",
                entry.path().display()
            ));
        }

        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "导入路径越过源目录边界".to_string())?;
        if file_type.is_dir() {
            copy_import_directory_inner(root, &path, target, depth + 1, budget)?;
        } else if file_type.is_file() && is_allowed_import_file(relative) {
            let out_path = target.join(relative);
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("创建导入目录失败：{error}"))?;
            }
            copy_import_file(&path, &out_path, budget)?;
        }
    }
    Ok(())
}

fn copy_import_file(source: &Path, target: &Path, budget: &mut ImportBudget) -> Result<(), String> {
    let mut input = File::open(source).map_err(|error| format!("打开导入文件失败：{error}"))?;
    copy_import_reader(&mut input, target, budget)
}

fn copy_import_reader(
    input: &mut impl Read,
    target: &Path,
    budget: &mut ImportBudget,
) -> Result<(), String> {
    if budget.files >= MAX_IMPORT_FILES {
        return Err(format!("导入文件数不能超过 {MAX_IMPORT_FILES}"));
    }

    let file_limit = if target
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| matches!(name, "pet.json" | "theme.json"))
    {
        MAX_MANIFEST_BYTES
    } else {
        MAX_EXTRACTED_FILE_BYTES
    };
    let remaining = MAX_TOTAL_IMPORT_BYTES.saturating_sub(budget.total_bytes);
    let limit = file_limit.min(remaining);
    if limit == 0 {
        return Err("导入文件总大小超出限制".to_string());
    }

    let mut output = File::create(target).map_err(|error| format!("创建导入文件失败：{error}"))?;
    let copied = std::io::copy(&mut input.take(limit + 1), &mut output)
        .map_err(|error| format!("复制导入文件失败：{error}"))?;
    if copied > limit {
        return Err(if file_limit <= remaining {
            if file_limit == MAX_MANIFEST_BYTES {
                format!("宠物清单不能超过 {} KiB", file_limit / 1024)
            } else {
                format!("单个导入文件不能超过 {} MiB", file_limit / 1024 / 1024)
            }
        } else {
            format!(
                "导入文件总大小不能超过 {} MiB",
                MAX_TOTAL_IMPORT_BYTES / 1024 / 1024
            )
        });
    }

    budget.files += 1;
    budget.total_bytes += copied;
    Ok(())
}

fn read_text_file_limited(path: &Path, limit: u64) -> Option<String> {
    let file = File::open(path).ok()?;
    if file.metadata().ok()?.len() > limit {
        return None;
    }
    let mut text = String::new();
    file.take(limit + 1).read_to_string(&mut text).ok()?;
    (text.len() as u64 <= limit).then_some(text)
}

fn normalize_pet_name(value: &str) -> String {
    let name: String = value
        .trim()
        .chars()
        .filter(|value| !value.is_control())
        .take(64)
        .collect();
    if name.is_empty() {
        "Pet".to_string()
    } else {
        name
    }
}

fn is_plain_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false)
}

fn is_allowed_import_file(path: &Path) -> bool {
    if let Some(file_name) = path.file_name().and_then(|value| value.to_str()) {
        if matches!(file_name, "pet.json" | "theme.json") {
            return true;
        }
    }
    is_supported_image(path)
}

fn clean_user_path(source_path: &str) -> PathBuf {
    let trimmed = source_path.trim().trim_matches('"');
    PathBuf::from(trimmed)
}

fn slugify(value: &str) -> String {
    let slug: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "pet".to_string()
    } else {
        slug.to_string()
    }
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

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn has_git_root(path: &Path) -> bool {
    let mut current = Some(path);
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return true;
        }
        current = dir.parent();
    }
    false
}

fn resolve_work_path(cwd: Option<String>) -> Result<PathBuf, String> {
    let path = cwd
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| clean_user_path(&value))
        .unwrap_or_else(|| {
            home_dir().unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        });

    if !path.exists() {
        return Err("工作路径不存在".to_string());
    }
    let cwd = if path.is_dir() {
        path
    } else {
        path.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "无法从文件路径定位父目录".to_string())?
    };
    cwd.canonicalize()
        .map_err(|error| format!("解析工作路径失败：{error}"))
}

#[cfg(target_os = "windows")]
fn open_terminal_at(cwd: &Path, terminal: Option<&str>) -> Result<(), String> {
    let selected = terminal
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto");

    if selected == "auto" {
        for terminal_id in ["windows-terminal", "pwsh", "powershell", "cmd", "git-bash"] {
            if open_windows_terminal(terminal_id, cwd).is_ok() {
                return Ok(());
            }
        }
        return Err("未找到可用终端程序".to_string());
    }

    open_windows_terminal(selected, cwd)
}

#[cfg(target_os = "windows")]
fn open_windows_terminal(terminal_id: &str, cwd: &Path) -> Result<(), String> {
    let cwd_text = terminal_path_text(cwd);
    match terminal_id {
        "warp" => open_warp_terminal(cwd),
        "windows-terminal" => {
            let executable = require_windows_command("wt.exe")?;
            spawn_windows_program(&executable, &["-d".to_string(), cwd_text], cwd)
        }
        "pwsh" => {
            let executable = require_windows_command("pwsh.exe")?;
            spawn_windows_program(&executable, &["-NoExit".to_string()], cwd)
        }
        "powershell" => {
            let executable = require_windows_command("powershell.exe")?;
            spawn_windows_program(&executable, &["-NoExit".to_string()], cwd)
        }
        "cmd" => {
            let executable = require_windows_command("cmd.exe")?;
            spawn_windows_program(&executable, &[], cwd)
        }
        "git-bash" => {
            let executable = find_git_bash().ok_or_else(|| "未找到 Git Bash".to_string())?;
            spawn_windows_program(&executable, &[format!("--cd={cwd_text}")], cwd)
        }
        _ => Err("未知终端类型".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn spawn_windows_program(program: &Path, args: &[String], cwd: &Path) -> Result<(), String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开终端失败：{error}"))
}

#[cfg(target_os = "windows")]
fn open_warp_terminal(cwd: &Path) -> Result<(), String> {
    let executable = windows_system_executable("rundll32.exe")
        .ok_or_else(|| "未找到系统 rundll32.exe".to_string())?;
    let mut command = Command::new(executable);
    hide_command_window(&mut command);
    command
        .arg("url.dll,FileProtocolHandler")
        .arg(warp_new_window_uri(cwd))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开 Warp 失败：{error}"))
}

#[cfg(target_os = "macos")]
fn open_terminal_at(cwd: &Path, terminal: Option<&str>) -> Result<(), String> {
    if terminal == Some("warp") {
        return open_warp_terminal(cwd);
    }

    let app = match terminal.unwrap_or("auto") {
        "auto" | "terminal" => "Terminal",
        "iterm" => "iTerm",
        _ => return Err("未知终端类型".to_string()),
    };

    let executable =
        find_unix_executable("open").ok_or_else(|| "未找到系统 open 命令".to_string())?;
    Command::new(executable)
        .arg("-a")
        .arg(app)
        .arg(cwd)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开终端失败：{error}"))
}

#[cfg(target_os = "macos")]
fn open_warp_terminal(cwd: &Path) -> Result<(), String> {
    let executable =
        find_unix_executable("open").ok_or_else(|| "未找到系统 open 命令".to_string())?;
    Command::new(executable)
        .arg(warp_new_window_uri(cwd))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开 Warp 失败：{error}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal_at(cwd: &Path, terminal: Option<&str>) -> Result<(), String> {
    let selected = terminal.unwrap_or("auto");
    let candidates: Vec<&str> = if selected == "auto" {
        vec![
            "x-terminal-emulator",
            "gnome-terminal",
            "konsole",
            "xfce4-terminal",
        ]
    } else {
        vec![selected]
    };

    for terminal_id in candidates {
        if spawn_unix_terminal(terminal_id, cwd).is_ok() {
            return Ok(());
        }
    }
    Err("未找到可用终端程序".to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_unix_terminal(terminal_id: &str, cwd: &Path) -> Result<(), String> {
    let executable = find_unix_executable(terminal_id)
        .ok_or_else(|| format!("未找到终端程序：{terminal_id}"))?;
    match terminal_id {
        "warp-terminal" => return open_warp_terminal(cwd),
        "konsole" => Command::new(executable).arg("--workdir").arg(cwd).spawn(),
        "xfce4-terminal" => Command::new(executable)
            .arg("--working-directory")
            .arg(cwd)
            .spawn(),
        "x-terminal-emulator" | "gnome-terminal" => {
            Command::new(executable).current_dir(cwd).spawn()
        }
        _ => return Err("未知终端类型".to_string()),
    }
    .map(|_| ())
    .map_err(|error| format!("打开终端失败：{error}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_warp_terminal(cwd: &Path) -> Result<(), String> {
    let executable =
        find_unix_executable("xdg-open").ok_or_else(|| "未找到系统 xdg-open 命令".to_string())?;
    Command::new(executable)
        .arg(warp_new_window_uri(cwd))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开 Warp 失败：{error}"))
}

#[cfg(target_os = "windows")]
fn available_terminal_options() -> Vec<TerminalOption> {
    let mut terminals = vec![terminal_option("auto", "自动选择")];
    terminals.push(terminal_option("warp", "Warp"));
    if windows_command_exists("wt.exe") {
        terminals.push(terminal_option("windows-terminal", "Windows Terminal"));
    }
    if windows_command_exists("pwsh.exe") {
        terminals.push(terminal_option("pwsh", "PowerShell 7"));
    }
    if windows_command_exists("powershell.exe") {
        terminals.push(terminal_option("powershell", "Windows PowerShell"));
    }
    if windows_command_exists("cmd.exe") {
        terminals.push(terminal_option("cmd", "命令提示符"));
    }
    if find_git_bash().is_some() {
        terminals.push(terminal_option("git-bash", "Git Bash"));
    }
    terminals
}

#[cfg(target_os = "macos")]
fn available_terminal_options() -> Vec<TerminalOption> {
    vec![
        terminal_option("auto", "自动选择"),
        terminal_option("warp", "Warp"),
        terminal_option("terminal", "Terminal"),
        terminal_option("iterm", "iTerm"),
    ]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn available_terminal_options() -> Vec<TerminalOption> {
    let mut terminals = vec![terminal_option("auto", "自动选择")];
    for (id, label) in [
        ("warp-terminal", "Warp"),
        ("x-terminal-emulator", "系统默认终端"),
        ("gnome-terminal", "GNOME Terminal"),
        ("konsole", "Konsole"),
        ("xfce4-terminal", "Xfce Terminal"),
    ] {
        if unix_command_exists(id) {
            terminals.push(terminal_option(id, label));
        }
    }
    terminals
}

fn terminal_option(id: &str, label: &str) -> TerminalOption {
    TerminalOption {
        id: id.to_string(),
        label: label.to_string(),
    }
}

fn warp_new_window_uri(cwd: &Path) -> String {
    format!(
        "warp://action/new_window?path={}",
        percent_encode_uri_component(&terminal_path_text(cwd))
    )
}

#[cfg(target_os = "windows")]
fn terminal_path_text(path: &Path) -> String {
    let text = path.to_string_lossy();
    strip_windows_verbatim_prefix(text.as_ref())
}

#[cfg(not(target_os = "windows"))]
fn terminal_path_text(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(target_os = "windows")]
fn strip_windows_verbatim_prefix(path: &str) -> String {
    const UNC_PREFIX: &str = "\\\\?\\UNC\\";
    const VERBATIM_PREFIX: &str = "\\\\?\\";

    if let Some(rest) = path.strip_prefix(UNC_PREFIX) {
        format!("\\\\{rest}")
    } else if let Some(rest) = path.strip_prefix(VERBATIM_PREFIX) {
        rest.to_string()
    } else {
        path.to_string()
    }
}

fn percent_encode_uri_component(value: &str) -> String {
    let mut encoded = String::new();
    for &byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(target_os = "windows")]
fn require_windows_command(command: &str) -> Result<PathBuf, String> {
    let executable = if command.eq_ignore_ascii_case("cmd.exe") {
        windows_system_executable(command)
    } else {
        find_windows_executable(command)
    };
    executable.ok_or_else(|| format!("未找到终端程序：{command}"))
}

#[cfg(target_os = "windows")]
fn windows_system_executable(command: &str) -> Option<PathBuf> {
    if !is_safe_command_name(command) {
        return None;
    }
    let path = PathBuf::from(env::var_os("SystemRoot")?)
        .join("System32")
        .join(command);
    path.is_file().then_some(path)
}

#[cfg(target_os = "windows")]
fn windows_command_exists(command: &str) -> bool {
    if command.eq_ignore_ascii_case("cmd.exe") {
        windows_system_executable(command).is_some()
    } else {
        find_windows_executable(command).is_some()
    }
}

#[cfg(target_os = "windows")]
fn find_windows_executable(command: &str) -> Option<PathBuf> {
    if !is_safe_command_name(command) {
        return None;
    }

    let path = env::var_os("PATH")?;
    let extensions = windows_executable_extensions(command);
    for directory in env::split_paths(&path) {
        if !directory.is_absolute() {
            continue;
        }
        for extension in &extensions {
            let candidate = directory.join(format!("{command}{extension}"));
            if candidate.is_file() {
                return candidate.canonicalize().ok().or(Some(candidate));
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn windows_executable_extensions(command: &str) -> Vec<String> {
    if Path::new(command).extension().is_some() {
        return vec![String::new()];
    }

    env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

#[cfg(target_os = "windows")]
fn find_git_bash() -> Option<PathBuf> {
    find_windows_executable("git-bash.exe").or_else(|| {
        let mut candidates = Vec::new();
        if let Some(program_files) = env::var_os("ProgramFiles") {
            candidates.push(
                PathBuf::from(program_files)
                    .join("Git")
                    .join("git-bash.exe"),
            );
        }
        if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
            candidates.push(
                PathBuf::from(program_files_x86)
                    .join("Git")
                    .join("git-bash.exe"),
            );
        }
        candidates.into_iter().find(|path| path.is_file())
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn unix_command_exists(command: &str) -> bool {
    find_unix_executable(command).is_some()
}

#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
fn find_unix_executable(command: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    if !is_safe_command_name(command) {
        return None;
    }

    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        if !directory.is_absolute() {
            continue;
        }
        let candidate = directory.join(command);
        let Ok(metadata) = fs::metadata(&candidate) else {
            continue;
        };
        if metadata.is_file() && metadata.permissions().mode() & 0o111 != 0 {
            return candidate.canonicalize().ok().or(Some(candidate));
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ReminderManager::new())
        .manage(TaskManager::new())
        .setup(|app| {
            let _ = app.notification().request_permission();
            start_reminder_scheduler(app.handle().clone());
            let _tray = TrayIconBuilder::new()
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let _ = restore_main_window_state(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            find_pet_candidates,
            import_pet_package,
            start_codex_session_monitor,
            run_codex_task,
            open_terminal,
            list_terminals,
            get_reminder_state,
            save_reminder_config,
            preview_reminder,
            restore_main_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0);
            let path =
                env::temp_dir().join(format!("codex-pet-{name}-{}-{unique}", std::process::id()));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn safe_relative_path_rejects_traversal_and_excessive_depth() {
        assert_eq!(
            safe_relative_path("states/idle.webp"),
            Some(PathBuf::from("states/idle.webp"))
        );
        assert_eq!(
            safe_relative_path("states\\idle.webp"),
            Some(PathBuf::from("states/idle.webp"))
        );
        assert!(safe_relative_path("../secret.png").is_none());
        assert!(safe_relative_path("/etc/passwd").is_none());
        assert!(safe_relative_path(".").is_none());

        let too_deep = (0..=MAX_IMPORT_DEPTH)
            .map(|index| format!("level-{index}"))
            .collect::<Vec<_>>()
            .join("/");
        assert!(safe_relative_path(&too_deep).is_none());
    }

    #[test]
    fn package_resources_must_stay_inside_package_directory() {
        let temp = TestDirectory::new("package-boundary");
        let package = temp.0.join("package");
        fs::create_dir_all(&package).expect("create package");
        fs::write(package.join("idle.png"), b"inside").expect("write inside image");
        fs::write(temp.0.join("outside.png"), b"outside").expect("write outside image");

        let resolved = resolve_package_file(&package, "idle.png").expect("resolve package image");
        assert_eq!(
            resolved,
            package
                .join("idle.png")
                .canonicalize()
                .expect("canonical image")
        );
        assert!(resolve_package_file(&package, "../outside.png").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn package_resources_cannot_escape_through_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = TestDirectory::new("package-symlink");
        let package = temp.0.join("package");
        fs::create_dir_all(&package).expect("create package");
        let outside = temp.0.join("outside.png");
        fs::write(&outside, b"outside").expect("write outside image");
        symlink(&outside, package.join("idle.png")).expect("create image symlink");

        assert!(resolve_package_file(&package, "idle.png").is_none());
    }

    #[test]
    fn command_names_reject_shell_syntax() {
        assert!(is_safe_command_name("codex"));
        assert!(is_safe_command_name("codex-preview_1.0"));
        assert!(!is_safe_command_name("codex;touch-pwned"));
        assert!(!is_safe_command_name("codex && calc"));
        assert!(!is_safe_command_name("../codex"));

        assert!(is_allowed_codex_executable_name("codex"));
        assert!(is_allowed_codex_executable_name("CODEX.EXE"));
        assert!(!is_allowed_codex_executable_name("codex-preview"));
        assert!(!is_allowed_codex_executable_name("powershell.exe"));
    }

    #[test]
    fn task_manager_allows_only_one_active_task() {
        let manager = TaskManager::new();
        let first = manager.try_start().expect("start first task");
        assert!(manager.try_start().is_err());
        drop(first);
        assert!(manager.try_start().is_ok());
    }

    #[test]
    fn import_reader_enforces_manifest_and_file_count_limits() {
        let temp = TestDirectory::new("import-limits");
        let oversized_manifest = vec![b'x'; MAX_MANIFEST_BYTES as usize + 1];
        let mut input = oversized_manifest.as_slice();
        let mut budget = ImportBudget::default();
        assert!(copy_import_reader(&mut input, &temp.0.join("pet.json"), &mut budget).is_err());

        let mut input = b"x".as_slice();
        let mut full_budget = ImportBudget {
            files: MAX_IMPORT_FILES,
            ..ImportBudget::default()
        };
        assert!(
            copy_import_reader(&mut input, &temp.0.join("idle.png"), &mut full_budget).is_err()
        );
    }

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
