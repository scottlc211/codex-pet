use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    env,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter};
use zip::ZipArchive;

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);

const ACTIVE_SESSION_WINDOW_MS: u128 = 10 * 60 * 1000;
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
const MAX_ZIP_BYTES: u64 = 80 * 1024 * 1024;
const MAX_EXTRACTED_FILE_BYTES: u64 = 30 * 1024 * 1024;

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

#[derive(Clone, Copy)]
struct AtlasRow {
    key: &'static str,
    row: u32,
    durations: &'static [u32],
}

const ATLAS_FRAME_WIDTH: u32 = 192;
const ATLAS_FRAME_HEIGHT: u32 = 208;
const ATLAS_ROWS: &[AtlasRow] = &[
    AtlasRow { key: "idle", row: 0, durations: &[280, 110, 110, 140, 140, 320] },
    AtlasRow { key: "running-right", row: 1, durations: &[120, 120, 120, 120, 120, 120, 120, 220] },
    AtlasRow { key: "running-left", row: 2, durations: &[120, 120, 120, 120, 120, 120, 120, 220] },
    AtlasRow { key: "waving", row: 3, durations: &[140, 140, 140, 280] },
    AtlasRow { key: "jumping", row: 4, durations: &[140, 140, 140, 140, 280] },
    AtlasRow { key: "failed", row: 5, durations: &[140, 140, 140, 140, 140, 140, 140, 240] },
    AtlasRow { key: "waiting", row: 6, durations: &[150, 150, 150, 150, 150, 260] },
    AtlasRow { key: "running", row: 7, durations: &[120, 120, 120, 120, 120, 220] },
    AtlasRow { key: "review", row: 8, durations: &[150, 150, 150, 150, 150, 280] },
];

#[tauri::command]
fn find_pet_candidates() -> Vec<PetCandidate> {
    let mut candidates = Vec::new();

    for root in pet_roots() {
        collect_pet_packages(&root, 0, &mut candidates);
        collect_pet_images(&root, 0, &mut candidates);
    }

    candidates.sort_by(|a, b| a.name.cmp(&b.name).then(a.path.cmp(&b.path)));
    candidates.dedup_by(|a, b| a.path == b.path);
    candidates
}

#[tauri::command]
fn import_pet_package(source_path: String) -> Result<PetCandidate, String> {
    let source = clean_user_path(&source_path);
    if source.is_dir() {
        return load_pet_package_from_dir(&source)
            .or_else(|| load_image_as_pet(&source))
            .ok_or_else(|| "未找到可识别的 pet.json、theme.json 或图片资源".to_string());
    }

    if source.is_file() && source.extension().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("zip")).unwrap_or(false) {
        let metadata = fs::metadata(&source).map_err(|error| format!("读取 zip 失败：{error}"))?;
        if metadata.len() > MAX_ZIP_BYTES {
            return Err("zip 包过大".to_string());
        }

        let target_dir = imported_package_dir(&source)?;
        extract_zip_to_dir(&source, &target_dir)?;
        return load_pet_package_from_dir(&target_dir)
            .or_else(|| find_first_pet_package(&target_dir))
            .ok_or_else(|| "zip 包中未找到可识别的 pet.json 或 theme.json".to_string());
    }

    if source.is_file() {
        return load_image_file_as_pet(&source).ok_or_else(|| "不支持的文件格式".to_string());
    }

    Err("路径不存在".to_string())
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
    prompt: String,
    cwd: Option<String>,
    codex_path: Option<String>,
) -> Result<(), String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("任务内容不能为空".to_string());
    }

    let cwd = resolve_work_path(cwd)?;
    let codex_path = codex_path.clone();

    thread::spawn(move || {
        emit_codex_event(&app, "started", "Codex CLI 已启动", Some("thinking"), None);

        let mut command = match new_codex_command(codex_path) {
            Ok(command) => command,
            Err(error) => {
                emit_codex_event(
                    &app,
                    "error",
                    &format!("无法启动 codex：{error}"),
                    Some("error"),
                    None,
                );
                return;
            }
        };
        command.arg("exec").arg("--json");
        if !has_git_root(&cwd) {
            command.arg("--skip-git-repo-check");
        }
        command
            .arg(prompt)
            .current_dir(&cwd)
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
                        let reader = BufReader::new(stdout);
                        for line in reader.lines().map_while(Result::ok) {
                            handle_codex_json_line(&stdout_app, &line);
                        }
                    }
                });

                let stderr_thread = thread::spawn(move || {
                    if let Some(stderr) = stderr {
                        let reader = BufReader::new(stderr);
                        for line in reader.lines().map_while(Result::ok) {
                            let message = line.trim();
                            if !message.is_empty() {
                                emit_codex_event(&stderr_app, "log", message, None, None);
                            }
                        }
                    }
                });

                let status = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();

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
    });

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
            message: message.to_string(),
            state: state.map(str::to_string),
            session_id,
        },
    );
}

fn handle_codex_json_line(app: &AppHandle, line: &str) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        emit_codex_event(app, "log", line, None, None);
        return;
    };

    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("event");

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
    Ok(command_for_executable(&executable))
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

    path.canonicalize()
        .or_else(|_| Ok(path))
        .map_err(|error: std::io::Error| format!("解析 Codex 路径失败：{error}"))
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(target_os = "windows")]
fn command_for_executable(executable: &Path) -> Command {
    let is_cmd_script = executable
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);
    if is_cmd_script {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(executable);
        hide_command_window(&mut command);
        return command;
    }

    let mut command = Command::new(executable);
    hide_command_window(&mut command);
    command
}

#[cfg(not(target_os = "windows"))]
fn command_for_executable(executable: &Path) -> Command {
    Command::new(executable)
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
    find_windows_executable(&with_cmd).or_else(|| {
        let with_exe = format!("{command}.exe");
        find_windows_executable(&with_exe)
    }).or_else(|| {
        find_windows_executable(command)
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

    if let Ok(codex_home) = env::var("CODEX_HOME") {
        roots.push(PathBuf::from(&codex_home).join("pets"));
        roots.push(PathBuf::from(codex_home));
    }

    if let Some(home) = home_dir() {
        roots.push(home.join(".codex").join("pets"));
        roots.push(home.join(".codex"));
        roots.push(home.join(".codex-pet").join("pets"));
    }

    if let Ok(current_dir) = env::current_dir() {
        roots.push(current_dir.join("pet-assets"));
    }

    roots
}

fn collect_pet_packages(root: &Path, depth: usize, candidates: &mut Vec<PetCandidate>) {
    if depth > 5 || !root.exists() {
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
        let path = entry.path();
        if path.is_dir() {
            collect_pet_packages(&path, depth + 1, candidates);
        }
    }
}

fn collect_pet_images(root: &Path, depth: usize, candidates: &mut Vec<PetCandidate>) {
    if depth > 3 || !root.exists() {
        return;
    }

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_pet_images(&path, depth + 1, candidates);
            continue;
        }

        if let Some(candidate) = load_image_file_as_pet(&path) {
            candidates.push(candidate);
        }
    }
}

fn load_pet_package_from_dir(package_dir: &Path) -> Option<PetCandidate> {
    let manifest_path = ["pet.json", "theme.json"]
        .iter()
        .map(|name| package_dir.join(name))
        .find(|path| path.is_file())?;

    let manifest = fs::read_to_string(&manifest_path).ok()?;
    let manifest: Value = serde_json::from_str(&manifest).ok()?;
    let name = manifest
        .get("displayName")
        .or_else(|| manifest.get("name"))
        .or_else(|| manifest.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| package_dir.file_name().and_then(|value| value.to_str()).unwrap_or("Pet"))
        .to_string();

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
        return items.iter().find_map(|item| item.as_str().and_then(|file| image_visual(package_dir, file)));
    }

    let object = value.as_object()?;
    if let Some(files) = object.get("files").and_then(Value::as_array) {
        return files.iter().find_map(|item| item.as_str().and_then(|file| image_visual(package_dir, file)));
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
        if let Some(visual) = states.get(fallback).cloned().or_else(|| states.get("idle").cloned()) {
            states.insert(state.to_string(), visual);
        }
    }
}

fn load_image_as_pet(dir: &Path) -> Option<PetCandidate> {
    let mut images = Vec::new();
    collect_image_paths(dir, 0, &mut images);
    images.into_iter().next().and_then(|path| load_image_file_as_pet(&path))
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

fn find_first_pet_package(root: &Path) -> Option<PetCandidate> {
    if let Some(candidate) = load_pet_package_from_dir(root) {
        return Some(candidate);
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(candidate) = find_first_pet_package(&path) {
                return Some(candidate);
            }
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
        let path = entry.path();
        if path.is_dir() {
            collect_image_paths(&path, depth + 1, out);
        } else if is_supported_standalone_theme_image(&path) {
            out.push(path);
        }
    }
}

fn resolve_package_file(package_dir: &Path, relative_path: &str) -> Option<PathBuf> {
    let direct = package_dir.join(relative_path);
    if direct.is_file() {
        return Some(direct);
    }
    let assets = package_dir.join("assets").join(relative_path);
    if assets.is_file() {
        return Some(assets);
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
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "apng"
    )
}

fn imported_package_dir(source: &Path) -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let root = home.join(".codex-pet").join("pets");
    fs::create_dir_all(&root).map_err(|error| format!("创建导入目录失败：{error}"))?;
    let stem = source.file_stem().and_then(|value| value.to_str()).unwrap_or("pet");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    Ok(root.join(format!("{}-{}", slugify(stem), timestamp)))
}

fn extract_zip_to_dir(source: &Path, target_dir: &Path) -> Result<(), String> {
    let file = File::open(source).map_err(|error| format!("打开 zip 失败：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("读取 zip 失败：{error}"))?;
    fs::create_dir_all(target_dir).map_err(|error| format!("创建解压目录失败：{error}"))?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| format!("读取 zip 条目失败：{error}"))?;
        if entry.is_dir() {
            continue;
        }
        if entry.size() > MAX_EXTRACTED_FILE_BYTES {
            return Err("zip 中存在过大的文件".to_string());
        }

        let Some(relative) = safe_zip_path(entry.name()) else {
            continue;
        };

        if !is_allowed_import_file(&relative) {
            continue;
        }

        let out_path = target_dir.join(relative);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
        }
        let mut out = File::create(&out_path).map_err(|error| format!("写入解压文件失败：{error}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|error| format!("解压文件失败：{error}"))?;
    }

    Ok(())
}

fn safe_zip_path(name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    let path = Path::new(&normalized);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
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
    started_at_ms: u128,
}

impl CodexSessionMonitor {
    fn new() -> Self {
        Self {
            offsets: HashMap::new(),
            started_at_ms: now_ms(),
        }
    }

    fn poll(&mut self, app: &AppHandle) {
        for file_path in self.active_rollout_files() {
            self.poll_file(app, &file_path);
        }
    }

    fn active_rollout_files(&self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        for sessions_dir in codex_sessions_dirs() {
            collect_recent_rollout_files(&sessions_dir, 0, &mut files);
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

        if !self.offsets.contains_key(file_path) && now_ms().saturating_sub(mtime) > ACTIVE_SESSION_WINDOW_MS {
            self.offsets.insert(file_path.to_path_buf(), size);
            return;
        }

        let offset = self.offsets.entry(file_path.to_path_buf()).or_insert(0);
        if *offset == 0 && size > 0 {
            *offset = size;
            return;
        }
        if size <= *offset {
            return;
        }

        let Ok(mut file) = File::open(file_path) else {
            return;
        };
        if file.seek(SeekFrom::Start(*offset)).is_err() {
            return;
        }
        let mut text = String::new();
        if file.read_to_string(&mut text).is_err() {
            return;
        }
        *offset = size;

        for line in text.lines() {
            self.process_line(app, file_path, line);
        }
    }

    fn process_line(&self, app: &AppHandle, file_path: &Path, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str).and_then(parse_time_ms) {
            if timestamp + 1500 < self.started_at_ms {
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

fn collect_recent_rollout_files(root: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    if depth > 4 || !root.exists() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_recent_rollout_files(&path, depth + 1, files);
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
            .map(|modified| now_ms().saturating_sub(modified.as_millis()) < ACTIVE_SESSION_WINDOW_MS)
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
    let parsed = value.parse::<u128>().ok();
    if parsed.is_some() {
        return parsed;
    }
    None
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
        .unwrap_or_else(|| home_dir().unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from("."))));

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
            ensure_windows_command("wt.exe")?;
            spawn_windows_start("wt", &["-d".to_string(), cwd_text])
        }
        "pwsh" => {
            ensure_windows_command("pwsh.exe")?;
            spawn_windows_start("pwsh", &powershell_location_args(cwd))
        }
        "powershell" => {
            ensure_windows_command("powershell.exe")?;
            spawn_windows_start("powershell", &powershell_location_args(cwd))
        }
        "cmd" => {
            ensure_windows_command("cmd.exe")?;
            spawn_windows_start(
                "cmd",
                &["/K".to_string(), format!("cd /d \"{cwd_text}\"")],
            )
        }
        "git-bash" => {
            let executable = find_git_bash().ok_or_else(|| "未找到 Git Bash".to_string())?;
            spawn_windows_start(
                &executable.to_string_lossy(),
                &[format!("--cd={cwd_text}")],
            )
        }
        _ => Err("未知终端类型".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn spawn_windows_start(program: &str, args: &[String]) -> Result<(), String> {
    let mut command = Command::new("cmd");
    hide_command_window(&mut command);
    command
        .arg("/C")
        .arg("start")
        .arg("")
        .arg(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开终端失败：{error}"))
}

#[cfg(target_os = "windows")]
fn open_warp_terminal(cwd: &Path) -> Result<(), String> {
    let mut command = Command::new("rundll32.exe");
    hide_command_window(&mut command);
    command
        .arg("url.dll,FileProtocolHandler")
        .arg(warp_new_window_uri(cwd))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开 Warp 失败：{error}"))
}

#[cfg(target_os = "windows")]
fn powershell_location_args(cwd: &Path) -> Vec<String> {
    let escaped = terminal_path_text(cwd).replace('\'', "''");
    vec![
        "-NoExit".to_string(),
        "-Command".to_string(),
        format!("Set-Location -LiteralPath '{escaped}'"),
    ]
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

    Command::new("open")
        .arg("-a")
        .arg(app)
        .arg(cwd)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开终端失败：{error}"))
}

#[cfg(target_os = "macos")]
fn open_warp_terminal(cwd: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(warp_new_window_uri(cwd))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开 Warp 失败：{error}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal_at(cwd: &Path, terminal: Option<&str>) -> Result<(), String> {
    let selected = terminal.unwrap_or("auto");
    let candidates: Vec<&str> = if selected == "auto" {
        vec!["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal"]
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
    match terminal_id {
        "warp-terminal" => return open_warp_terminal(cwd),
        "konsole" => Command::new("konsole").arg("--workdir").arg(cwd).spawn(),
        "xfce4-terminal" => Command::new("xfce4-terminal")
            .arg("--working-directory")
            .arg(cwd)
            .spawn(),
        terminal => Command::new(terminal).current_dir(cwd).spawn(),
    }
    .map(|_| ())
    .map_err(|error| format!("打开终端失败：{error}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_warp_terminal(cwd: &Path) -> Result<(), String> {
    Command::new("xdg-open")
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
fn ensure_windows_command(command: &str) -> Result<(), String> {
    if windows_command_exists(command) {
        Ok(())
    } else {
        Err(format!("未找到终端程序：{command}"))
    }
}

#[cfg(target_os = "windows")]
fn windows_command_exists(command: &str) -> bool {
    find_windows_executable(command).is_some()
}

#[cfg(target_os = "windows")]
fn find_windows_executable(command: &str) -> Option<PathBuf> {
    let mut where_command = Command::new("cmd");
    hide_command_window(&mut where_command);
    let output = where_command
        .arg("/C")
        .arg("where")
        .arg(command)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .next()
}

#[cfg(target_os = "windows")]
fn find_git_bash() -> Option<PathBuf> {
    find_windows_executable("git-bash.exe").or_else(|| {
        let mut candidates = Vec::new();
        if let Some(program_files) = env::var_os("ProgramFiles") {
            candidates.push(PathBuf::from(program_files).join("Git").join("git-bash.exe"));
        }
        if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
            candidates.push(PathBuf::from(program_files_x86).join("Git").join("git-bash.exe"));
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
    let output = Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {command}"))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            find_pet_candidates,
            import_pet_package,
            start_codex_session_monitor,
            run_codex_task,
            open_terminal,
            list_terminals
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
