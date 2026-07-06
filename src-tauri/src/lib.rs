use serde::Serialize;
use serde_json::Value;
use std::{
    env,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct PetCandidate {
    name: String,
    path: String,
    kind: String,
}

#[derive(Clone, Serialize)]
struct CodexPetEvent {
    kind: String,
    message: String,
}

#[tauri::command]
fn find_pet_candidates() -> Vec<PetCandidate> {
    let mut candidates = Vec::new();

    for root in pet_roots() {
        collect_pet_images(&root, 0, &mut candidates);
    }

    candidates.sort_by(|a, b| a.name.cmp(&b.name).then(a.path.cmp(&b.path)));
    candidates.dedup_by(|a, b| a.path == b.path);
    candidates
}

#[tauri::command]
fn run_codex_task(app: AppHandle, prompt: String, cwd: Option<String>) -> Result<(), String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("任务内容不能为空".to_string());
    }

    let cwd = cwd
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    thread::spawn(move || {
        emit_codex_event(&app, "started", "Codex CLI 已启动");

        let mut command = Command::new("codex");
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
                                emit_codex_event(&stderr_app, "log", message);
                            }
                        }
                    }
                });

                let status = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();

                match status {
                    Ok(status) if status.success() => {
                        emit_codex_event(&app, "completed", "任务完成");
                    }
                    Ok(status) => {
                        emit_codex_event(&app, "error", &format!("Codex 退出码：{status}"));
                    }
                    Err(error) => {
                        emit_codex_event(&app, "error", &format!("等待 Codex 失败：{error}"));
                    }
                }
            }
            Err(error) => {
                emit_codex_event(&app, "error", &format!("无法启动 codex：{error}"));
            }
        }
    });

    Ok(())
}

fn emit_codex_event(app: &AppHandle, kind: &str, message: &str) {
    let _ = app.emit(
        "codex-event",
        CodexPetEvent {
            kind: kind.to_string(),
            message: message.to_string(),
        },
    );
}

fn handle_codex_json_line(app: &AppHandle, line: &str) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        emit_codex_event(app, "log", line);
        return;
    };

    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("event");

    let message = match event_type {
        "thread.started" => "新线程已创建".to_string(),
        "turn.started" => "Codex 正在处理".to_string(),
        "turn.completed" => "Codex 回合完成".to_string(),
        "turn.failed" => "Codex 回合失败".to_string(),
        "item.started" | "item.completed" => summarize_item(&value),
        _ => event_type.to_string(),
    };

    emit_codex_event(app, event_type, &message);
}

fn summarize_item(value: &Value) -> String {
    let Some(item) = value.get("item") else {
        return "收到 Codex 事件".to_string();
    };

    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("item");

    match item_type {
        "agent_message" => item
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("Codex 返回了消息")
            .to_string(),
        "command_execution" => item
            .get("command")
            .and_then(Value::as_str)
            .map(|command| format!("运行命令：{command}"))
            .unwrap_or_else(|| "运行命令".to_string()),
        "file_change" => item
            .get("path")
            .and_then(Value::as_str)
            .map(|path| format!("修改文件：{path}"))
            .unwrap_or_else(|| "修改文件".to_string()),
        other => other.to_string(),
    }
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
    }

    if let Ok(current_dir) = env::current_dir() {
        roots.push(current_dir.join("pet-assets"));
    }

    roots
}

fn collect_pet_images(root: &Path, depth: usize, candidates: &mut Vec<PetCandidate>) {
    if depth > 4 || !root.exists() {
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

        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        let extension = extension.to_ascii_lowercase();

        if !matches!(
            extension.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "apng"
        ) {
            continue;
        }

        let name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("pet")
            .to_string();

        candidates.push(PetCandidate {
            name,
            path: path.to_string_lossy().to_string(),
            kind: extension,
        });
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            find_pet_candidates,
            run_codex_task
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
