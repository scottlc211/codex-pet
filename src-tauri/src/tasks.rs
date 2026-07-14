use crate::{clean_user_path, diagnostics, home_dir};
use serde::Serialize;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(unix)]
use std::fs;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
fn hide_command_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalOption {
    id: String,
    label: String,
}

#[tauri::command]
pub(crate) fn open_terminal(cwd: Option<String>, terminal: Option<String>) -> Result<(), String> {
    let cwd = resolve_work_path(cwd)?;
    open_terminal_at(&cwd, terminal.as_deref())
        .inspect(|()| diagnostics::info("terminal", "opened terminal"))
        .inspect_err(|error| {
            diagnostics::error("terminal", &format!("failed to open terminal: {error}"));
        })
}

#[tauri::command]
pub(crate) fn list_terminals() -> Vec<TerminalOption> {
    available_terminal_options()
}

pub(crate) fn resolve_codex_executable(codex_path: Option<String>) -> Result<PathBuf, String> {
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
pub(crate) fn command_for_executable(executable: &Path) -> Result<Command, String> {
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
pub(crate) fn command_for_executable(executable: &Path) -> Result<Command, String> {
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

pub(crate) fn has_git_root(path: &Path) -> bool {
    let mut current = Some(path);
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return true;
        }
        current = dir.parent();
    }
    false
}

pub(crate) fn resolve_work_path(cwd: Option<String>) -> Result<PathBuf, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
