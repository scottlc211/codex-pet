use crate::{
    diagnostics, emit_codex_event, handle_codex_json_line, home_dir, read_bounded_line,
    storage::{read_with_backup_status, write_json_atomically_with_backup_policy, RecoverySource},
    tasks::{
        command_for_executable, has_git_root, open_task_terminal_at, resolve_codex_executable,
        resolve_task_terminal_id, resolve_work_path,
    },
};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    collections::VecDeque,
    io::{BufReader, Write},
    path::PathBuf,
    process::{Child, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

static TASK_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const MAX_PROMPT_BYTES: usize = 256 * 1024;
const MAX_OUTPUT_LINE_BYTES: usize = 1024 * 1024;
const MAX_PROMPT_PREVIEW_CHARS: usize = 160;
const MAX_TASK_ERROR_CHARS: usize = 1000;
const MAX_QUEUED_TASKS: usize = 20;
const MAX_TASK_HISTORY: usize = 100;
const MAX_CONCURRENT_TASKS: usize = 3;
const DEFAULT_TIMEOUT_MINUTES: u32 = 30;
const MAX_TIMEOUT_MINUTES: u32 = 240;
const MAX_RETRIES: u32 = 3;
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const RETRY_DELAY: Duration = Duration::from_secs(1);

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskStatus {
    Queued,
    Running,
    Retrying,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
}

impl TaskStatus {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::TimedOut
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskRecord {
    id: String,
    prompt_preview: String,
    cwd: String,
    // 记录任务关联的具体终端程序，不把终端窗口句柄写入持久化历史。
    #[serde(default = "default_terminal_id")]
    terminal_id: String,
    status: TaskStatus,
    #[serde(default)]
    activity: Option<String>,
    #[serde(default)]
    status_message: String,
    #[serde(default)]
    session_id: Option<String>,
    attempts: u32,
    max_attempts: u32,
    timeout_minutes: u32,
    created_at: u64,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskStateSnapshot {
    tasks: Vec<TaskRecord>,
    running_task_ids: Vec<String>,
    queued_count: usize,
    max_concurrent_tasks: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSubmission {
    task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunCodexTaskRequest {
    prompt: String,
    cwd: Option<String>,
    codex_path: Option<String>,
    terminal_id: Option<String>,
    timeout_minutes: Option<u32>,
    max_retries: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskTerminalOpenResult {
    task_id: String,
    terminal_id: String,
    focused_existing: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskHistoryStore {
    schema_version: u8,
    tasks: Vec<TaskRecord>,
}

struct TaskRequest {
    id: String,
    prompt: String,
    cwd: PathBuf,
    executable: PathBuf,
    timeout: Duration,
    max_attempts: u32,
}

struct RunningTask {
    id: String,
    cancel_requested: Arc<AtomicBool>,
}

struct TaskState {
    queue: VecDeque<TaskRequest>,
    records: VecDeque<TaskRecord>,
    running: Vec<RunningTask>,
    history_source: RecoverySource,
}

struct TaskShared {
    state: Mutex<TaskState>,
    wake_worker: Condvar,
    worker_started: AtomicBool,
}

pub(crate) struct TaskManager {
    shared: Arc<TaskShared>,
}

enum TaskOutcome {
    Completed,
    Failed(String),
    Cancelled,
    TimedOut,
}

enum CancelAction {
    Queued,
    Running(Arc<AtomicBool>),
}

impl TaskManager {
    pub(crate) fn new() -> Self {
        let (mut records, history_source) = load_task_history();
        let interrupted = mark_interrupted_tasks(&mut records);
        let manager = Self {
            shared: Arc::new(TaskShared {
                state: Mutex::new(TaskState {
                    queue: VecDeque::new(),
                    records,
                    running: Vec::new(),
                    history_source,
                }),
                wake_worker: Condvar::new(),
                worker_started: AtomicBool::new(false),
            }),
        };
        if interrupted {
            let mut state = manager
                .shared
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            persist_history(&mut state);
        }
        manager
    }

    pub(crate) fn start(&self, app: AppHandle) {
        if self.shared.worker_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut started_workers = 0;
        for worker_index in 0..MAX_CONCURRENT_TASKS {
            let app = app.clone();
            let shared = Arc::clone(&self.shared);
            match thread::Builder::new()
                .name(format!("codex-task-worker-{}", worker_index + 1))
                .spawn(move || task_worker_loop(app, shared))
            {
                Ok(_) => started_workers += 1,
                Err(error) => diagnostics::error(
                    "tasks",
                    &format!("failed to start task worker {}: {error}", worker_index + 1),
                ),
            }
        }
        if started_workers == 0 {
            self.shared.worker_started.store(false, Ordering::SeqCst);
        } else {
            diagnostics::info("tasks", &format!("started {started_workers} task workers"));
        }
    }

    fn snapshot(&self) -> TaskStateSnapshot {
        snapshot_from_state(
            &self
                .shared
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }
}

#[tauri::command]
pub(crate) fn run_codex_task(
    app: AppHandle,
    manager: State<TaskManager>,
    request: RunCodexTaskRequest,
) -> Result<TaskSubmission, String> {
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        diagnostics::warn("tasks", "rejected empty task");
        return Err("任务内容不能为空".to_string());
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        diagnostics::warn("tasks", "rejected oversized task");
        return Err(format!("任务内容不能超过 {} KiB", MAX_PROMPT_BYTES / 1024));
    }

    let cwd = resolve_work_path(request.cwd)?;
    let executable = resolve_codex_executable(request.codex_path)?;
    let terminal_id = resolve_task_terminal_id(request.terminal_id.as_deref());
    let timeout_minutes = normalize_timeout_minutes(request.timeout_minutes);
    let max_attempts = normalize_max_retries(request.max_retries) + 1;
    let task_id = new_task_id();
    let request = TaskRequest {
        id: task_id.clone(),
        prompt: prompt.clone(),
        cwd: cwd.clone(),
        executable,
        timeout: Duration::from_secs(u64::from(timeout_minutes) * 60),
        max_attempts,
    };
    let record = TaskRecord {
        id: task_id.clone(),
        prompt_preview: prompt_preview(&prompt),
        cwd: cwd.to_string_lossy().to_string(),
        terminal_id,
        status: TaskStatus::Queued,
        activity: Some("queued".to_string()),
        status_message: "等待可用执行槽".to_string(),
        session_id: None,
        attempts: 0,
        max_attempts,
        timeout_minutes,
        created_at: now_ms(),
        started_at: None,
        finished_at: None,
        error: None,
    };

    manager.start(app.clone());
    let snapshot = {
        let mut state = manager
            .shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.queue.len() >= MAX_QUEUED_TASKS {
            return Err(format!("任务队列最多保留 {MAX_QUEUED_TASKS} 个等待任务"));
        }
        state.queue.push_back(request);
        push_record(&mut state.records, record);
        persist_history(&mut state);
        snapshot_from_state(&state)
    };
    manager.shared.wake_worker.notify_one();
    emit_task_snapshot(&app, &snapshot);
    emit_codex_event(
        &app,
        "task.queued",
        "任务已加入队列",
        Some("thinking"),
        Some(task_id.clone()),
    );
    diagnostics::info("tasks", &format!("queued task {task_id}"));
    Ok(TaskSubmission { task_id })
}

#[tauri::command]
pub(crate) fn get_task_state(manager: State<TaskManager>) -> TaskStateSnapshot {
    manager.snapshot()
}

#[tauri::command]
pub(crate) fn open_task_terminal(
    manager: State<TaskManager>,
    task_id: String,
) -> Result<TaskTerminalOpenResult, String> {
    let (cwd, terminal_id) = {
        let state = manager
            .shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let record = state
            .records
            .iter()
            .find(|record| record.id == task_id)
            .ok_or_else(|| "未找到任务".to_string())?;
        (PathBuf::from(&record.cwd), record.terminal_id.clone())
    };
    if !cwd.is_dir() {
        return Err("任务项目目录已不存在".to_string());
    }

    let launch = open_task_terminal_at(&cwd, &terminal_id, &task_id).inspect_err(|error| {
        diagnostics::error(
            "terminal",
            &format!("failed to open terminal for task {task_id}: {error}"),
        );
    })?;
    diagnostics::info("terminal", &format!("opened terminal for task {task_id}"));
    Ok(TaskTerminalOpenResult {
        task_id,
        terminal_id: launch.terminal_id,
        focused_existing: launch.focused_existing,
    })
}

#[tauri::command]
pub(crate) fn cancel_codex_task(
    app: AppHandle,
    manager: State<TaskManager>,
    task_id: String,
) -> Result<TaskStateSnapshot, String> {
    let (action, snapshot) = {
        let mut state = manager
            .shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let action = cancel_task_in_state(&mut state, &task_id)?;
        persist_history(&mut state);
        (action, snapshot_from_state(&state))
    };

    match action {
        CancelAction::Queued => {
            emit_codex_event(
                &app,
                "task.cancelled",
                "排队任务已取消",
                Some("idle"),
                Some(task_id.clone()),
            );
        }
        CancelAction::Running(cancel_requested) => {
            cancel_requested.store(true, Ordering::SeqCst);
            emit_codex_event(
                &app,
                "task.cancelling",
                "正在取消任务",
                Some("waiting_input"),
                Some(task_id.clone()),
            );
        }
    }
    diagnostics::info("tasks", &format!("cancel requested for task {task_id}"));
    emit_task_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn clear_task_history(app: AppHandle, manager: State<TaskManager>) -> TaskStateSnapshot {
    let snapshot = {
        let mut state = manager
            .shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.records.retain(|record| !record.status.is_terminal());
        persist_history(&mut state);
        snapshot_from_state(&state)
    };
    diagnostics::info("tasks", "cleared completed task history");
    emit_task_snapshot(&app, &snapshot);
    snapshot
}

fn cancel_task_in_state(state: &mut TaskState, task_id: &str) -> Result<CancelAction, String> {
    if let Some(index) = state.queue.iter().position(|request| request.id == task_id) {
        state.queue.remove(index);
        if let Some(record) = find_record_mut(&mut state.records, task_id) {
            record.status = TaskStatus::Cancelled;
            record.activity = Some("idle".to_string());
            record.status_message = "排队任务已取消".to_string();
            record.finished_at = Some(now_ms());
            record.error = None;
        }
        return Ok(CancelAction::Queued);
    }

    if let Some(running) = state.running.iter().find(|running| running.id == task_id) {
        let cancel_requested = Arc::clone(&running.cancel_requested);
        if let Some(record) = find_record_mut(&mut state.records, task_id) {
            if record.status == TaskStatus::Cancelling {
                return Err("任务正在取消".to_string());
            }
            record.status = TaskStatus::Cancelling;
            record.activity = Some("waiting_input".to_string());
            record.status_message = "正在取消任务".to_string();
        }
        return Ok(CancelAction::Running(cancel_requested));
    }

    match state.records.iter().find(|record| record.id == task_id) {
        Some(record) if record.status.is_terminal() => Err("任务已结束".to_string()),
        _ => Err("未找到任务".to_string()),
    }
}

fn task_worker_loop(app: AppHandle, shared: Arc<TaskShared>) {
    loop {
        let (request, cancel_requested) = {
            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            while state.queue.is_empty() {
                state = shared
                    .wake_worker
                    .wait(state)
                    .unwrap_or_else(|error| error.into_inner());
            }
            let request = state.queue.pop_front().expect("task queue is not empty");
            let cancel_requested = Arc::new(AtomicBool::new(false));
            state.running.push(RunningTask {
                id: request.id.clone(),
                cancel_requested: Arc::clone(&cancel_requested),
            });
            (request, cancel_requested)
        };
        execute_request(&app, &shared, request, cancel_requested);
    }
}

fn execute_request(
    app: &AppHandle,
    shared: &Arc<TaskShared>,
    request: TaskRequest,
    cancel_requested: Arc<AtomicBool>,
) {
    let mut final_outcome = TaskOutcome::Failed("任务未启动".to_string());
    for attempt in 1..=request.max_attempts {
        if cancel_requested.load(Ordering::SeqCst) {
            final_outcome = TaskOutcome::Cancelled;
            break;
        }

        let snapshot = update_attempt_state(shared, &request.id, attempt);
        if cancel_requested.load(Ordering::SeqCst) {
            final_outcome = TaskOutcome::Cancelled;
            break;
        }
        emit_task_snapshot(app, &snapshot);
        emit_codex_event(
            app,
            "task.started",
            if attempt == 1 {
                "Codex CLI 已启动"
            } else {
                "Codex CLI 正在重试"
            },
            Some("thinking"),
            Some(request.id.clone()),
        );
        diagnostics::info(
            "tasks",
            &format!("started task {} attempt {attempt}", request.id),
        );

        let outcome = run_task_attempt(app, shared, &request, &cancel_requested);
        if matches!(outcome, TaskOutcome::Failed(_)) && attempt < request.max_attempts {
            let message = match &outcome {
                TaskOutcome::Failed(message) => message.clone(),
                _ => String::new(),
            };
            let snapshot = update_retry_state(shared, &request.id, &message);
            emit_task_snapshot(app, &snapshot);
            emit_codex_event(
                app,
                "task.retrying",
                &format!("任务失败，准备第 {} 次尝试", attempt + 1),
                Some("thinking"),
                Some(request.id.clone()),
            );
            diagnostics::warn(
                "tasks",
                &format!("retrying task {} after failure: {message}", request.id),
            );
            if wait_for_retry(&cancel_requested) {
                final_outcome = TaskOutcome::Cancelled;
                break;
            }
            continue;
        }

        final_outcome = outcome;
        break;
    }

    finish_task(app, shared, &request.id, final_outcome);
}

fn update_attempt_state(shared: &TaskShared, task_id: &str, attempt: u32) -> TaskStateSnapshot {
    let mut state = shared
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(record) = find_record_mut(&mut state.records, task_id) {
        record.status = TaskStatus::Running;
        record.activity = Some("thinking".to_string());
        record.status_message = if attempt == 1 {
            "Codex CLI 已启动".to_string()
        } else {
            "Codex CLI 正在重试".to_string()
        };
        record.attempts = attempt;
        record.started_at.get_or_insert_with(now_ms);
        record.error = None;
    }
    persist_history(&mut state);
    snapshot_from_state(&state)
}

fn update_retry_state(shared: &TaskShared, task_id: &str, message: &str) -> TaskStateSnapshot {
    let mut state = shared
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(record) = find_record_mut(&mut state.records, task_id) {
        record.status = TaskStatus::Retrying;
        record.activity = Some("thinking".to_string());
        record.status_message = "等待下一次尝试".to_string();
        record.error = Some(normalize_task_error(message));
    }
    persist_history(&mut state);
    snapshot_from_state(&state)
}

fn run_task_attempt(
    app: &AppHandle,
    shared: &Arc<TaskShared>,
    request: &TaskRequest,
    cancel_requested: &AtomicBool,
) -> TaskOutcome {
    let mut command = match command_for_executable(&request.executable) {
        Ok(command) => command,
        Err(error) => return TaskOutcome::Failed(error),
    };
    command.arg("exec").arg("--json");
    if !has_git_root(&request.cwd) {
        command.arg("--skip-git-repo-check");
    }
    command
        .arg("-")
        .current_dir(&request.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return TaskOutcome::Failed(format!("无法启动 codex：{error}")),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_app = app.clone();
    let stdout_shared = Arc::clone(shared);
    let stderr_app = app.clone();
    let stdout_task_id = request.id.clone();
    let stderr_task_id = request.id.clone();
    let stdout_thread = thread::spawn(move || {
        if let Some(stdout) = stdout {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(line)) = read_bounded_line(&mut reader, MAX_OUTPUT_LINE_BYTES) {
                if !line.is_empty() {
                    if let Some(event) = handle_codex_json_line(
                        &stdout_app,
                        &String::from_utf8_lossy(&line),
                        Some(&stdout_task_id),
                    ) {
                        update_task_activity(&stdout_app, &stdout_shared, &stdout_task_id, event);
                    }
                }
            }
        }
    });
    let stderr_thread = thread::spawn(move || {
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr);
            while let Ok(Some(line)) = read_bounded_line(&mut reader, MAX_OUTPUT_LINE_BYTES) {
                let line = String::from_utf8_lossy(&line);
                let message = line.trim();
                if !message.is_empty() {
                    emit_codex_event(
                        &stderr_app,
                        "log",
                        message,
                        None,
                        Some(stderr_task_id.clone()),
                    );
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
                .write_all(request.prompt.as_bytes())
                .map_err(|error| format!("写入 Codex 任务失败：{error}"))
        })
        .err();
    if let Some(error) = prompt_write_error {
        terminate_child(&mut child);
        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        return TaskOutcome::Failed(error);
    }

    let started = Instant::now();
    let outcome = loop {
        if cancel_requested.load(Ordering::SeqCst) {
            terminate_child(&mut child);
            break TaskOutcome::Cancelled;
        }
        if started.elapsed() >= request.timeout {
            terminate_child(&mut child);
            break TaskOutcome::TimedOut;
        }

        match child.try_wait() {
            Ok(Some(status)) if status.success() => break TaskOutcome::Completed,
            Ok(Some(status)) => {
                break TaskOutcome::Failed(format!("Codex 退出码：{status}"));
            }
            Ok(None) => thread::sleep(PROCESS_POLL_INTERVAL),
            Err(error) => {
                terminate_child(&mut child);
                break TaskOutcome::Failed(format!("等待 Codex 失败：{error}"));
            }
        }
    };
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    outcome
}

fn update_task_activity(
    app: &AppHandle,
    shared: &TaskShared,
    task_id: &str,
    event: crate::ParsedCodexEvent,
) {
    let snapshot = {
        let mut state = shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(record) = find_record_mut(&mut state.records, task_id) else {
            return;
        };
        let mut changed = false;
        if let Some(session_id) = event.codex_session_id {
            if record.session_id.as_deref() != Some(session_id.as_str()) {
                record.session_id = Some(session_id);
                changed = true;
            }
        }
        if matches!(record.status, TaskStatus::Running | TaskStatus::Retrying) {
            if let Some(activity) = event.state {
                if record.activity.as_deref() != Some(activity.as_str()) {
                    record.activity = Some(activity);
                    changed = true;
                }
            }
            let message = normalize_task_status_message(&event.message);
            if !message.is_empty() && record.status_message != message {
                record.status_message = message;
                changed = true;
            }
        }
        changed.then(|| snapshot_from_state(&state))
    };
    if let Some(snapshot) = snapshot {
        emit_task_snapshot(app, &snapshot);
    }
}

fn terminate_child(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let taskkill = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .map(|root| root.join("System32").join("taskkill.exe"))
            .filter(|candidate| candidate.is_file());
        if let Some(taskkill) = taskkill {
            let mut command = std::process::Command::new(taskkill);
            command.creation_flags(CREATE_NO_WINDOW);
            let status = command
                .arg("/PID")
                .arg(child.id().to_string())
                .arg("/T")
                .arg("/F")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if status.is_ok_and(|status| status.success()) {
                let _ = child.wait();
                return;
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
}

fn wait_for_retry(cancel_requested: &AtomicBool) -> bool {
    let started = Instant::now();
    while started.elapsed() < RETRY_DELAY {
        if cancel_requested.load(Ordering::SeqCst) {
            return true;
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
    false
}

fn finish_task(app: &AppHandle, shared: &TaskShared, task_id: &str, outcome: TaskOutcome) {
    let (status, error, kind, message, pet_state) = match outcome {
        TaskOutcome::Completed => (
            TaskStatus::Completed,
            None,
            "task.completed",
            "任务完成",
            "success",
        ),
        TaskOutcome::Failed(error) => (
            TaskStatus::Failed,
            Some(normalize_task_error(&error)),
            "task.failed",
            "任务失败",
            "error",
        ),
        TaskOutcome::Cancelled => (
            TaskStatus::Cancelled,
            None,
            "task.cancelled",
            "任务已取消",
            "idle",
        ),
        TaskOutcome::TimedOut => (
            TaskStatus::TimedOut,
            Some("任务执行超时".to_string()),
            "task.timedOut",
            "任务执行超时",
            "error",
        ),
    };
    let event_message = error.as_deref().unwrap_or(message).to_string();
    let snapshot = {
        let mut state = shared
            .state
            .lock()
            .unwrap_or_else(|lock_error| lock_error.into_inner());
        if let Some(record) = find_record_mut(&mut state.records, task_id) {
            record.status = status;
            record.activity = Some(pet_state.to_string());
            record.status_message = event_message.clone();
            record.finished_at = Some(now_ms());
            record.error = error;
        }
        state.running.retain(|running| running.id != task_id);
        persist_history(&mut state);
        snapshot_from_state(&state)
    };
    emit_task_snapshot(app, &snapshot);
    emit_codex_event(
        app,
        kind,
        &event_message,
        Some(pet_state),
        Some(task_id.to_string()),
    );
    match status {
        TaskStatus::Completed | TaskStatus::Cancelled => {
            diagnostics::info("tasks", &format!("task {task_id} finished as {status:?}"));
        }
        _ => diagnostics::error("tasks", &format!("task {task_id} finished as {status:?}")),
    }
}

fn snapshot_from_state(state: &TaskState) -> TaskStateSnapshot {
    TaskStateSnapshot {
        tasks: state.records.iter().cloned().collect(),
        running_task_ids: state
            .running
            .iter()
            .map(|running| running.id.clone())
            .collect(),
        queued_count: state.queue.len(),
        max_concurrent_tasks: MAX_CONCURRENT_TASKS,
    }
}

fn emit_task_snapshot(app: &AppHandle, snapshot: &TaskStateSnapshot) {
    let _ = app.emit("task-state-updated", snapshot);
}

fn find_record_mut<'a>(
    records: &'a mut VecDeque<TaskRecord>,
    task_id: &str,
) -> Option<&'a mut TaskRecord> {
    records.iter_mut().find(|record| record.id == task_id)
}

fn push_record(records: &mut VecDeque<TaskRecord>, record: TaskRecord) {
    records.push_front(record);
    records.truncate(MAX_TASK_HISTORY);
}

fn normalize_timeout_minutes(value: Option<u32>) -> u32 {
    value
        .unwrap_or(DEFAULT_TIMEOUT_MINUTES)
        .clamp(1, MAX_TIMEOUT_MINUTES)
}

fn normalize_max_retries(value: Option<u32>) -> u32 {
    value.unwrap_or(0).min(MAX_RETRIES)
}

fn default_terminal_id() -> String {
    "auto".to_string()
}

fn prompt_preview(prompt: &str) -> String {
    let preview = prompt
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_PROMPT_PREVIEW_CHARS)
        .collect::<String>();
    if preview.is_empty() {
        "Codex task".to_string()
    } else {
        preview
    }
}

fn normalize_task_error(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(MAX_TASK_ERROR_CHARS)
        .collect()
}

fn normalize_task_status_message(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(MAX_PROMPT_PREVIEW_CHARS)
        .collect()
}

fn new_task_id() -> String {
    let sequence = TASK_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("task-{timestamp}-{sequence}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn task_history_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".codex-pet").join("task-history.json"))
}

fn load_task_history() -> (VecDeque<TaskRecord>, RecoverySource) {
    let Some(path) = task_history_path() else {
        return (VecDeque::new(), RecoverySource::Missing);
    };
    let recovered = read_with_backup_status(&path, |text| {
        let store = serde_json::from_str::<TaskHistoryStore>(text).ok()?;
        (store.schema_version == 1).then_some(store.tasks)
    });
    match recovered.source {
        RecoverySource::Backup => diagnostics::warn("tasks", "recovered task history from backup"),
        RecoverySource::Invalid => diagnostics::error("tasks", "task history is invalid"),
        _ => {}
    }
    let records = recovered
        .value
        .unwrap_or_default()
        .into_iter()
        .take(MAX_TASK_HISTORY)
        .collect();
    (records, recovered.source)
}

fn mark_interrupted_tasks(records: &mut VecDeque<TaskRecord>) -> bool {
    let mut changed = false;
    for record in records {
        if !record.status.is_terminal() {
            record.status = TaskStatus::Failed;
            record.activity = Some("error".to_string());
            record.status_message = "应用上次退出时任务未完成".to_string();
            record.finished_at = Some(now_ms());
            record.error = Some("应用上次退出时任务未完成".to_string());
            changed = true;
        }
    }
    changed
}

fn persist_history(state: &mut TaskState) {
    let Some(path) = task_history_path() else {
        diagnostics::error("tasks", "cannot locate task history path");
        return;
    };
    let store = TaskHistoryStore {
        schema_version: 1,
        tasks: state.records.iter().cloned().collect(),
    };
    let backup_current = matches!(state.history_source, RecoverySource::Primary);
    match write_json_atomically_with_backup_policy(&path, &store, backup_current) {
        Ok(()) => state.history_source = RecoverySource::Primary,
        Err(error) => {
            diagnostics::error("tasks", &format!("failed to persist task history: {error}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_record(id: &str, status: TaskStatus) -> TaskRecord {
        TaskRecord {
            id: id.to_string(),
            prompt_preview: "test".to_string(),
            cwd: ".".to_string(),
            terminal_id: default_terminal_id(),
            status,
            activity: None,
            status_message: String::new(),
            session_id: None,
            attempts: 0,
            max_attempts: 1,
            timeout_minutes: 30,
            created_at: 1,
            started_at: None,
            finished_at: None,
            error: None,
        }
    }

    fn test_request(id: &str) -> TaskRequest {
        TaskRequest {
            id: id.to_string(),
            prompt: "test".to_string(),
            cwd: PathBuf::from("."),
            executable: PathBuf::from("codex"),
            timeout: Duration::from_secs(60),
            max_attempts: 1,
        }
    }

    #[test]
    fn task_ids_are_unique_and_prefixed() {
        let first = new_task_id();
        let second = new_task_id();
        assert!(first.starts_with("task-"));
        assert_ne!(first, second);
    }

    #[test]
    fn task_options_are_bounded() {
        assert_eq!(normalize_timeout_minutes(None), DEFAULT_TIMEOUT_MINUTES);
        assert_eq!(normalize_timeout_minutes(Some(0)), 1);
        assert_eq!(normalize_timeout_minutes(Some(999)), MAX_TIMEOUT_MINUTES);
        assert_eq!(normalize_max_retries(Some(99)), MAX_RETRIES);
    }

    #[test]
    fn prompt_preview_removes_extra_whitespace_and_is_bounded() {
        assert_eq!(
            prompt_preview("  inspect\n this   project "),
            "inspect this project"
        );
        assert_eq!(prompt_preview(&"x".repeat(200)).chars().count(), 160);
    }

    #[test]
    fn queued_task_can_be_cancelled_without_touching_other_tasks() {
        let mut state = TaskState {
            queue: VecDeque::from([test_request("one"), test_request("two")]),
            records: VecDeque::from([
                test_record("two", TaskStatus::Queued),
                test_record("one", TaskStatus::Queued),
            ]),
            running: Vec::new(),
            history_source: RecoverySource::Missing,
        };

        assert!(matches!(
            cancel_task_in_state(&mut state, "one"),
            Ok(CancelAction::Queued)
        ));
        assert_eq!(state.queue.len(), 1);
        assert_eq!(state.queue[0].id, "two");
        assert_eq!(
            state
                .records
                .iter()
                .find(|record| record.id == "one")
                .unwrap()
                .status,
            TaskStatus::Cancelled
        );
    }

    #[test]
    fn running_tasks_are_tracked_and_cancelled_independently() {
        let first_cancel = Arc::new(AtomicBool::new(false));
        let second_cancel = Arc::new(AtomicBool::new(false));
        let mut state = TaskState {
            queue: VecDeque::new(),
            records: VecDeque::from([
                test_record("two", TaskStatus::Running),
                test_record("one", TaskStatus::Running),
            ]),
            running: vec![
                RunningTask {
                    id: "one".to_string(),
                    cancel_requested: Arc::clone(&first_cancel),
                },
                RunningTask {
                    id: "two".to_string(),
                    cancel_requested: Arc::clone(&second_cancel),
                },
            ],
            history_source: RecoverySource::Missing,
        };

        let action = cancel_task_in_state(&mut state, "one").expect("cancel first task");
        let CancelAction::Running(cancel_requested) = action else {
            panic!("running task should return its cancellation token");
        };
        cancel_requested.store(true, Ordering::SeqCst);

        assert!(first_cancel.load(Ordering::SeqCst));
        assert!(!second_cancel.load(Ordering::SeqCst));
        assert_eq!(state.running.len(), 2);
        assert_eq!(
            state
                .records
                .iter()
                .find(|record| record.id == "one")
                .expect("first record")
                .status,
            TaskStatus::Cancelling
        );
        assert_eq!(
            snapshot_from_state(&state).running_task_ids,
            vec!["one".to_string(), "two".to_string()]
        );
    }

    #[test]
    fn legacy_task_history_receives_terminal_and_activity_defaults() {
        let record: TaskRecord = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "promptPreview": "test",
            "cwd": ".",
            "status": "completed",
            "attempts": 1,
            "maxAttempts": 1,
            "timeoutMinutes": 30,
            "createdAt": 1,
            "startedAt": 1,
            "finishedAt": 2,
            "error": null
        }))
        .expect("deserialize legacy record");

        assert_eq!(record.terminal_id, "auto");
        assert_eq!(record.activity, None);
        assert!(record.status_message.is_empty());
        assert_eq!(record.session_id, None);
    }

    #[test]
    fn active_history_is_marked_failed_after_restart() {
        let mut records = VecDeque::from([
            test_record("running", TaskStatus::Running),
            test_record("done", TaskStatus::Completed),
        ]);
        assert!(mark_interrupted_tasks(&mut records));
        assert_eq!(records[0].status, TaskStatus::Failed);
        assert_eq!(records[1].status, TaskStatus::Completed);
    }
}
