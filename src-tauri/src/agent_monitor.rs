use crate::{
    codex_monitor::start_codex_session_monitor, current_timestamp_ms, diagnostics,
    emit_agent_event, home_dir, storage::write_json_atomically_with_backup_policy,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    thread,
    time::Duration,
};
use tauri::AppHandle;

static HOOK_MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
static HOOK_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const HOOK_SCHEMA_VERSION: u8 = 1;
const HOOK_INBOX_ENV: &str = "CODEX_PET_HOOK_INBOX";
const HOOK_POLL_INTERVAL: Duration = Duration::from_millis(500);
const MAX_HOOK_INPUT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_HOOK_FILES_PER_POLL: usize = 256;
const MAX_HOOK_FILE_AGE_MS: u64 = 10 * 60 * 1000;
const HOOK_DEDUP_WINDOW_MS: u64 = 250;
const MAX_SESSION_ID_CHARS: usize = 256;
const MAX_AGENT_FIELD_CHARS: usize = 256;
const MAX_CWD_CHARS: usize = 4096;

const CLAUDE_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PermissionDenied",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "SubagentStart",
    "SubagentStop",
    "TaskCreated",
    "TaskCompleted",
    "PreCompact",
    "PostCompact",
    "Stop",
    "StopFailure",
    "SessionEnd",
];

const GROK_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionDenied",
    "Notification",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "Stop",
    "StopFailure",
    "SessionEnd",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HookProvider {
    Claude,
    Grok,
}

impl HookProvider {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "grok" => Some(Self::Grok),
            _ => None,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Grok => "grok",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Grok => "Grok Build",
        }
    }

    #[cfg(test)]
    fn events(self) -> &'static [&'static str] {
        match self {
            Self::Claude => CLAUDE_HOOK_EVENTS,
            Self::Grok => GROK_HOOK_EVENTS,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturedHookEvent {
    schema_version: u8,
    provider: String,
    event_name: String,
    session_id: String,
    agent_id: Option<String>,
    agent_type: Option<String>,
    cwd: Option<String>,
    tool_name: Option<String>,
    notification_type: Option<String>,
    received_at: u64,
}

struct MappedHookEvent {
    state: Option<&'static str>,
    message: String,
}

#[derive(Default)]
struct HookInboxMonitor {
    recent_events: HashMap<u64, u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentHookStatus {
    provider: String,
    installed: bool,
    config_path: String,
    error: Option<String>,
}

#[tauri::command]
pub(crate) fn start_agent_monitor(app: AppHandle) -> Result<(), String> {
    start_codex_session_monitor(app.clone())?;
    start_hook_monitor(app)
}

fn start_hook_monitor(app: AppHandle) -> Result<(), String> {
    if HOOK_MONITOR_STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let inbox = hook_inbox_dir().ok_or_else(|| "无法确定 Agent Hook 收件箱路径".to_string())?;
    fs::create_dir_all(&inbox).map_err(|error| {
        HOOK_MONITOR_STARTED.store(false, Ordering::SeqCst);
        format!("创建 Agent Hook 收件箱失败：{error}")
    })?;

    thread::Builder::new()
        .name("agent-hook-monitor".to_string())
        .spawn(move || {
            diagnostics::info("monitor", "started Agent hook monitor");
            emit_agent_event(
                &app,
                "system",
                "monitor.started",
                "已开始监听 Codex、Claude Code 与 Grok Build",
                Some("idle"),
                None,
                None,
                None,
            );
            let mut monitor = HookInboxMonitor::default();
            loop {
                monitor.poll(&app, &inbox);
                thread::sleep(HOOK_POLL_INTERVAL);
            }
        })
        .map(|_| ())
        .map_err(|error| {
            HOOK_MONITOR_STARTED.store(false, Ordering::SeqCst);
            format!("启动 Agent Hook 监听线程失败：{error}")
        })
}

pub(crate) fn run_agent_hook_cli() -> Option<Result<(), String>> {
    let mut args = env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--agent-hook")) {
        return None;
    }

    let provider = args
        .next()
        .and_then(|value| value.into_string().ok())
        .and_then(|value| HookProvider::parse(&value));
    if args.next().is_some() {
        return Some(Err("Agent Hook 参数过多".to_string()));
    }
    let Some(provider) = provider else {
        return Some(Err("Agent Hook provider 只能是 claude 或 grok".to_string()));
    };

    Some(capture_hook_from_reader(
        provider,
        io::stdin().lock(),
        hook_inbox_dir(),
    ))
}

fn capture_hook_from_reader(
    provider_hint: HookProvider,
    reader: impl Read,
    inbox: Option<PathBuf>,
) -> Result<(), String> {
    let inbox = inbox.ok_or_else(|| "无法确定 Agent Hook 收件箱路径".to_string())?;
    let mut input = Vec::new();
    reader
        .take(MAX_HOOK_INPUT_BYTES + 1)
        .read_to_end(&mut input)
        .map_err(|error| format!("读取 Hook 输入失败：{error}"))?;
    if input.len() as u64 > MAX_HOOK_INPUT_BYTES {
        return Err("Hook 输入超过 4 MiB 限制".to_string());
    }

    let value = serde_json::from_slice::<Value>(&input)
        .map_err(|error| format!("Hook 输入不是有效 JSON：{error}"))?;
    let captured = parse_hook_payload(provider_hint, &value)?;
    persist_captured_hook(&inbox, &captured)
}

fn parse_hook_payload(
    provider_hint: HookProvider,
    value: &Value,
) -> Result<CapturedHookEvent, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Hook JSON 必须是对象".to_string())?;

    // Grok 默认会读取 Claude Hook 配置，因此以官方字段命名识别真实来源，参数只作兜底。
    let provider = if object
        .get("hook_event_name")
        .and_then(Value::as_str)
        .is_some()
    {
        HookProvider::Claude
    } else if object
        .get("hookEventName")
        .and_then(Value::as_str)
        .is_some()
    {
        HookProvider::Grok
    } else {
        provider_hint
    };

    let (event_key, session_key) = match provider {
        HookProvider::Claude => ("hook_event_name", "session_id"),
        HookProvider::Grok => ("hookEventName", "sessionId"),
    };
    let event_name = required_bounded_text(object, event_key, MAX_AGENT_FIELD_CHARS)?;
    // Grok 的配置事件名使用 PascalCase，但 Hook stdin 中使用 snake_case。
    let event_name = match provider {
        HookProvider::Claude => event_name,
        HookProvider::Grok => normalize_grok_event_name(&event_name).to_string(),
    };
    let session_id = required_bounded_text(object, session_key, MAX_SESSION_ID_CHARS)?;

    let (agent_id, agent_type, tool_name, notification_type) = match provider {
        HookProvider::Claude => (
            optional_bounded_text(object, "agent_id", MAX_AGENT_FIELD_CHARS),
            optional_bounded_text(object, "agent_type", MAX_AGENT_FIELD_CHARS),
            optional_bounded_text(object, "tool_name", MAX_AGENT_FIELD_CHARS),
            optional_bounded_text(object, "notification_type", MAX_AGENT_FIELD_CHARS),
        ),
        // Grok 当前公开契约只保证下列状态字段；子 Agent 标识待上游明确后再接入。
        HookProvider::Grok => (
            None,
            None,
            optional_bounded_text(object, "toolName", MAX_AGENT_FIELD_CHARS),
            None,
        ),
    };

    Ok(CapturedHookEvent {
        schema_version: HOOK_SCHEMA_VERSION,
        provider: provider.id().to_string(),
        event_name,
        session_id,
        agent_id,
        agent_type,
        cwd: optional_bounded_text(object, "cwd", MAX_CWD_CHARS),
        tool_name,
        notification_type,
        received_at: current_timestamp_ms(),
    })
}

fn normalize_grok_event_name(event_name: &str) -> &str {
    match event_name {
        "session_start" => "SessionStart",
        "user_prompt_submit" => "UserPromptSubmit",
        "pre_tool_use" => "PreToolUse",
        "post_tool_use" => "PostToolUse",
        "post_tool_use_failure" => "PostToolUseFailure",
        "permission_denied" => "PermissionDenied",
        "notification" => "Notification",
        "subagent_start" => "SubagentStart",
        "subagent_stop" | "subagent_end" => "SubagentStop",
        "pre_compact" => "PreCompact",
        "post_compact" => "PostCompact",
        "stop" => "Stop",
        "stop_failure" => "StopFailure",
        "session_end" => "SessionEnd",
        _ => event_name,
    }
}

fn required_bounded_text(
    object: &Map<String, Value>,
    key: &str,
    limit: usize,
) -> Result<String, String> {
    optional_bounded_text(object, key, limit)
        .ok_or_else(|| format!("Hook JSON 缺少有效字段：{key}"))
}

fn optional_bounded_text(object: &Map<String, Value>, key: &str, limit: usize) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(|value| {
            value
                .trim()
                .chars()
                .filter(|character| !character.is_control())
                .take(limit)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
}

fn persist_captured_hook(inbox: &Path, captured: &CapturedHookEvent) -> Result<(), String> {
    fs::create_dir_all(inbox).map_err(|error| format!("创建 Hook 收件箱失败：{error}"))?;
    let sequence = HOOK_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let target = inbox.join(format!(
        "{:016x}-{:08x}-{sequence:016x}.json",
        captured.received_at,
        std::process::id()
    ));
    let mut temp = tempfile::Builder::new()
        .prefix(&format!("hook-{}-{sequence}-", std::process::id()))
        .tempfile_in(inbox)
        .map_err(|error| format!("创建 Hook 临时文件失败：{error}"))?;
    serde_json::to_writer(&mut temp, captured)
        .map_err(|error| format!("序列化 Hook 状态失败：{error}"))?;
    temp.write_all(b"\n")
        .map_err(|error| format!("写入 Hook 状态失败：{error}"))?;
    temp.as_file_mut()
        .sync_all()
        .map_err(|error| format!("同步 Hook 状态失败：{error}"))?;
    match temp.persist_noclobber(&target) {
        Ok(_) => Ok(()),
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(format!("提交 Hook 状态失败：{}", error.error)),
    }
}

fn stable_hash(bytes: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    bytes.iter().fold(OFFSET, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(PRIME)
    })
}

impl HookInboxMonitor {
    fn poll(&mut self, app: &AppHandle, inbox: &Path) {
        let Ok(entries) = fs::read_dir(inbox) else {
            return;
        };
        let mut files = entries
            .flatten()
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                let path = entry.path();
                (file_type.is_file() && path.extension().is_some_and(|value| value == "json"))
                    .then_some(path)
            })
            .collect::<Vec<_>>();
        files.sort();
        files.truncate(MAX_HOOK_FILES_PER_POLL);

        let mut pending = files
            .into_iter()
            .filter_map(|path| match read_captured_hook(&path) {
                Ok(captured) => Some((path, captured)),
                Err(error) => {
                    diagnostics::warn(
                        "monitor",
                        &format!(
                            "ignored invalid Agent hook file {}: {error}",
                            path.display()
                        ),
                    );
                    remove_hook_file(&path);
                    None
                }
            })
            .collect::<Vec<_>>();
        pending.sort_by(|left, right| {
            left.1
                .received_at
                .cmp(&right.1.received_at)
                .then_with(|| left.0.cmp(&right.0))
        });

        for (path, captured) in pending {
            if !self.is_duplicate(&captured) {
                process_captured_hook(app, captured);
            }
            remove_hook_file(&path);
        }

        let cutoff = current_timestamp_ms().saturating_sub(HOOK_DEDUP_WINDOW_MS * 4);
        self.recent_events
            .retain(|_, received_at| *received_at >= cutoff);
    }

    fn is_duplicate(&mut self, captured: &CapturedHookEvent) -> bool {
        let identity = hook_identity(captured);
        let duplicate = self
            .recent_events
            .get(&identity)
            .is_some_and(|received_at| {
                captured.received_at.saturating_sub(*received_at) <= HOOK_DEDUP_WINDOW_MS
            });
        if !duplicate {
            self.recent_events.insert(identity, captured.received_at);
        }
        duplicate
    }
}

fn read_captured_hook(path: &Path) -> Result<CapturedHookEvent, String> {
    fs::read(path)
        .map_err(|error| error.to_string())
        .and_then(|bytes| {
            serde_json::from_slice::<CapturedHookEvent>(&bytes).map_err(|error| error.to_string())
        })
}

fn remove_hook_file(path: &Path) {
    if let Err(error) = fs::remove_file(path) {
        diagnostics::warn(
            "monitor",
            &format!(
                "failed to remove Agent hook file {}: {error}",
                path.display()
            ),
        );
    }
}

fn hook_identity(captured: &CapturedHookEvent) -> u64 {
    stable_hash(
        format!(
            "{}|{}|{}|{}|{}|{}",
            captured.provider,
            captured.session_id,
            captured.event_name,
            captured.agent_id.as_deref().unwrap_or(""),
            captured.tool_name.as_deref().unwrap_or(""),
            captured.notification_type.as_deref().unwrap_or("")
        )
        .as_bytes(),
    )
}

fn process_captured_hook(app: &AppHandle, captured: CapturedHookEvent) {
    if captured.schema_version != HOOK_SCHEMA_VERSION
        || current_timestamp_ms().saturating_sub(captured.received_at) > MAX_HOOK_FILE_AGE_MS
    {
        return;
    }
    let Some(provider) = HookProvider::parse(&captured.provider) else {
        return;
    };
    let Some(mapped) = map_hook_event(provider, &captured) else {
        diagnostics::warn(
            "monitor",
            &format!(
                "ignored unsupported {} hook event {}",
                provider.label(),
                captured.event_name
            ),
        );
        return;
    };

    emit_agent_event(
        app,
        provider.id(),
        &format!("hook.{}", captured.event_name),
        &mapped.message,
        mapped.state,
        Some(captured.session_id),
        captured.agent_id,
        captured.cwd,
    );
}

fn map_hook_event(provider: HookProvider, captured: &CapturedHookEvent) -> Option<MappedHookEvent> {
    let label = provider.label();
    let mapped = match captured.event_name.as_str() {
        "SessionStart" => (Some("idle"), format!("{label} 会话已连接")),
        "UserPromptSubmit" => (Some("thinking"), format!("{label} 正在思考")),
        "PreToolUse" => {
            let tool = captured.tool_name.as_deref().unwrap_or("工具");
            let state = match tool {
                "Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "search_replace" => {
                    "editing_file"
                }
                "Bash" | "run_terminal_command" => "running_command",
                _ => "working",
            };
            (Some(state), format!("{label} 正在运行 {tool}"))
        }
        "PostToolUse" => (Some("thinking"), format!("{label} 工具执行完成")),
        "PostToolUseFailure" => (Some("working"), format!("{label} 工具执行失败，正在处理")),
        "PermissionRequest" => (Some("waiting_input"), format!("{label} 等待权限确认")),
        "PermissionDenied" => (Some("thinking"), format!("{label} 权限请求被拒绝")),
        "Notification" => match captured.notification_type.as_deref() {
            Some("permission_prompt") => (Some("waiting_input"), format!("{label} 等待权限确认")),
            Some("agent_needs_input" | "elicitation_dialog") => {
                (Some("waiting_input"), format!("{label} 等待输入"))
            }
            Some("idle_prompt") => (Some("success"), format!("{label} 回合完成")),
            Some("agent_completed") => (Some("success"), format!("{label} 后台任务已完成")),
            Some("elicitation_complete" | "elicitation_response") => {
                (Some("thinking"), format!("{label} 已收到输入，继续处理"))
            }
            _ => (None, format!("{label} 发出通知")),
        },
        "SubagentStart" => {
            let agent = captured.agent_type.as_deref().unwrap_or("子 Agent");
            (Some("working"), format!("{label} {agent} 已启动"))
        }
        "SubagentStop" => (Some("thinking"), format!("{label} 子 Agent 已完成")),
        "TaskCreated" => (Some("working"), format!("{label} 已创建子任务")),
        "TaskCompleted" => (Some("thinking"), format!("{label} 子任务已完成")),
        "PreCompact" => (Some("sweeping"), format!("{label} 正在压缩上下文")),
        "PostCompact" => (Some("thinking"), format!("{label} 上下文压缩完成")),
        "Stop" => (Some("success"), format!("{label} 回合完成")),
        "StopFailure" => (Some("error"), format!("{label} 回合失败")),
        "SessionEnd" => (Some("idle"), format!("{label} 会话已结束")),
        _ => return None,
    };
    Some(MappedHookEvent {
        state: mapped.0,
        message: mapped.1,
    })
}

#[tauri::command]
pub(crate) fn get_agent_hook_statuses() -> Vec<AgentHookStatus> {
    [HookProvider::Claude, HookProvider::Grok]
        .into_iter()
        .map(hook_status)
        .collect()
}

#[tauri::command]
pub(crate) fn install_agent_hook(provider: String) -> Result<AgentHookStatus, String> {
    let provider = HookProvider::parse(&provider)
        .ok_or_else(|| "Agent provider 只能是 claude 或 grok".to_string())?;
    let path = hook_config_path(provider)
        .ok_or_else(|| format!("无法确定 {} Hook 配置路径", provider.label()))?;
    let executable = hook_executable_path()?;
    match provider {
        HookProvider::Claude => install_claude_hooks(&path, &executable)?,
        HookProvider::Grok => {
            let command = hook_command(&executable, provider)?;
            let inbox = hook_inbox_dir()
                .ok_or_else(|| "无法确定 Grok Build Hook 收件箱路径".to_string())?;
            install_grok_hooks(&path, &command, &inbox)?;
        }
    }
    diagnostics::info("monitor", &format!("installed {} hooks", provider.label()));
    Ok(hook_status(provider))
}

#[tauri::command]
pub(crate) fn uninstall_agent_hook(provider: String) -> Result<AgentHookStatus, String> {
    let provider = HookProvider::parse(&provider)
        .ok_or_else(|| "Agent provider 只能是 claude 或 grok".to_string())?;
    let path = hook_config_path(provider)
        .ok_or_else(|| format!("无法确定 {} Hook 配置路径", provider.label()))?;
    match provider {
        HookProvider::Claude => uninstall_claude_hooks(&path)?,
        HookProvider::Grok => {
            if path.exists() {
                fs::remove_file(&path)
                    .map_err(|error| format!("删除 Grok Hook 配置失败：{error}"))?;
            }
        }
    }
    diagnostics::info(
        "monitor",
        &format!("uninstalled {} hooks", provider.label()),
    );
    Ok(hook_status(provider))
}

fn hook_status(provider: HookProvider) -> AgentHookStatus {
    let Some(path) = hook_config_path(provider) else {
        return AgentHookStatus {
            provider: provider.id().to_string(),
            installed: false,
            config_path: String::new(),
            error: Some("无法确定用户目录".to_string()),
        };
    };
    match config_is_current(&path, provider) {
        Ok(installed) => AgentHookStatus {
            provider: provider.id().to_string(),
            installed,
            config_path: path.to_string_lossy().into_owned(),
            error: None,
        },
        Err(error) => AgentHookStatus {
            provider: provider.id().to_string(),
            installed: false,
            config_path: path.to_string_lossy().into_owned(),
            error: Some(error),
        },
    }
}

fn hook_inbox_dir() -> Option<PathBuf> {
    let configured = env::var_os(HOOK_INBOX_ENV).map(PathBuf::from);
    let path = select_hook_inbox_dir(configured, home_dir())?;
    if path.is_absolute() {
        Some(path)
    } else {
        env::current_dir().ok().map(|current| current.join(path))
    }
}

fn select_hook_inbox_dir(configured: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    configured
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| home.map(|path| path.join(".codex-pet").join("agent-events")))
}

fn hook_config_path(provider: HookProvider) -> Option<PathBuf> {
    match provider {
        HookProvider::Claude => home_dir().map(|home| home.join(".claude").join("settings.json")),
        HookProvider::Grok => env::var_os("GROK_HOME")
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|home| home.join(".grok")))
            .map(|root| root.join("hooks").join("codex-pet.json")),
    }
}

fn hook_executable_path() -> Result<PathBuf, String> {
    if let Some(appimage) = env::var_os("APPIMAGE").map(PathBuf::from) {
        if appimage.is_file() {
            return Ok(appimage);
        }
    }
    env::current_exe().map_err(|error| format!("无法确定 Codex Pet 可执行文件路径：{error}"))
}

fn hook_command(executable: &Path, provider: HookProvider) -> Result<String, String> {
    let path = executable.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        windows_hook_command(&path, provider)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let quoted = format!("'{}'", path.replace('\'', "'\"'\"'"));
        Ok(format!("{quoted} --agent-hook {}", provider.id()))
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_hook_command(path: &str, provider: HookProvider) -> Result<String, String> {
    if path.contains(['"', '%', '!']) {
        return Err("Codex Pet 安装路径包含 Hook 命令不支持的字符".to_string());
    }
    // Grok Build 在 Windows 上通过 PowerShell 执行 command，带空格的路径需要调用运算符。
    Ok(format!("& \"{path}\" --agent-hook {}", provider.id()))
}

fn install_claude_hooks(path: &Path, executable: &Path) -> Result<(), String> {
    let mut root = read_json_object_or_default(path, "Claude settings")?;
    remove_managed_hooks(&mut root, HookProvider::Claude)?;
    let hooks = ensure_object_field(&mut root, "hooks", "Claude settings.hooks")?;
    let handler = claude_hook_handler(executable);
    for event in CLAUDE_HOOK_EVENTS {
        append_hook_group(hooks, event, &handler)?;
    }
    write_json_atomically_with_backup_policy(path, &root, path.exists())
}

fn install_grok_hooks(path: &Path, command: &str, inbox: &Path) -> Result<(), String> {
    let handler = shell_hook_handler(command, inbox);
    let mut hooks = Map::new();
    for event in GROK_HOOK_EVENTS {
        hooks.insert(
            (*event).to_string(),
            Value::Array(vec![hook_group(&handler)]),
        );
    }
    let root = json!({ "hooks": hooks });
    write_json_atomically_with_backup_policy(path, &root, path.exists())
}

fn uninstall_claude_hooks(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_json_object_or_default(path, "Claude settings")?;
    if remove_managed_hooks(&mut root, HookProvider::Claude)? {
        write_json_atomically_with_backup_policy(path, &root, true)?;
    }
    Ok(())
}

fn read_json_object_or_default(path: &Path, label: &str) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let text = fs::read_to_string(path).map_err(|error| format!("读取 {label} 失败：{error}"))?;
    let value = serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("{label} 不是有效 JSON：{error}"))?;
    if !value.is_object() {
        return Err(format!("{label} 顶层必须是 JSON 对象"));
    }
    Ok(value)
}

fn ensure_object_field<'a>(
    root: &'a mut Value,
    key: &str,
    label: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    let object = root
        .as_object_mut()
        .ok_or_else(|| format!("{label} 顶层必须是 JSON 对象"))?;
    let value = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    value
        .as_object_mut()
        .ok_or_else(|| format!("{label} 必须是 JSON 对象"))
}

fn append_hook_group(
    hooks: &mut Map<String, Value>,
    event: &str,
    handler: &Value,
) -> Result<(), String> {
    let groups = hooks
        .entry(event.to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| format!("Claude hooks.{event} 必须是数组"))?;
    groups.push(hook_group(handler));
    Ok(())
}

fn claude_hook_handler(executable: &Path) -> Value {
    json!({
        "type": "command",
        "command": executable.to_string_lossy(),
        "args": ["--agent-hook", HookProvider::Claude.id()],
        "timeout": 5
    })
}

fn shell_hook_handler(command: &str, inbox: &Path) -> Value {
    json!({
        "type": "command",
        "command": command,
        "env": {
            (HOOK_INBOX_ENV): inbox.to_string_lossy()
        },
        "timeout": 5
    })
}

fn hook_group(handler: &Value) -> Value {
    json!({ "hooks": [handler.clone()] })
}

fn config_contains_managed_hook(path: &Path, provider: HookProvider) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let root = read_json_object_or_default(path, "Agent Hook 配置")?;
    Ok(root
        .get("hooks")
        .and_then(Value::as_object)
        .is_some_and(|hooks| {
            hooks.values().any(|groups| {
                groups.as_array().is_some_and(|groups| {
                    groups
                        .iter()
                        .any(|group| group_contains_managed_hook(group, provider))
                })
            })
        }))
}

fn config_is_current(path: &Path, provider: HookProvider) -> Result<bool, String> {
    if provider == HookProvider::Claude {
        return config_contains_managed_hook(path, provider);
    }

    let executable = hook_executable_path()?;
    let command = hook_command(&executable, provider)?;
    let inbox =
        hook_inbox_dir().ok_or_else(|| "无法确定 Grok Build Hook 收件箱路径".to_string())?;
    let inbox = inbox.to_string_lossy();
    config_contains_current_grok_hooks(path, &command, inbox.as_ref())
}

fn config_contains_current_grok_hooks(
    path: &Path,
    command: &str,
    inbox: &str,
) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }

    let root = read_json_object_or_default(path, "Agent Hook 配置")?;
    let Some(hooks) = root.get("hooks").and_then(Value::as_object) else {
        return Ok(false);
    };

    Ok(GROK_HOOK_EVENTS.iter().all(|event| {
        hooks
            .get(*event)
            .and_then(Value::as_array)
            .is_some_and(|groups| {
                groups.iter().any(|group| {
                    group
                        .get("hooks")
                        .and_then(Value::as_array)
                        .is_some_and(|handlers| {
                            handlers
                                .iter()
                                .any(|handler| is_current_grok_handler(handler, command, inbox))
                        })
                })
            })
    }))
}

fn is_current_grok_handler(handler: &Value, command: &str, inbox: &str) -> bool {
    handler.get("type").and_then(Value::as_str) == Some("command")
        && handler.get("command").and_then(Value::as_str) == Some(command)
        && handler
            .get("env")
            .and_then(Value::as_object)
            .and_then(|env| env.get(HOOK_INBOX_ENV))
            .and_then(Value::as_str)
            == Some(inbox)
}

fn group_contains_managed_hook(group: &Value, provider: HookProvider) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|handlers| {
            handlers
                .iter()
                .any(|handler| is_managed_handler(handler, provider))
        })
}

fn is_managed_handler(handler: &Value, provider: HookProvider) -> bool {
    let legacy_marker = format!("--agent-hook {}", provider.id());
    let legacy_shell_form = handler
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains(&legacy_marker));
    let exec_form = handler
        .get("args")
        .and_then(Value::as_array)
        .is_some_and(|args| {
            args.len() == 2
                && args[0].as_str() == Some("--agent-hook")
                && args[1].as_str() == Some(provider.id())
        });
    legacy_shell_form || exec_form
}

fn remove_managed_hooks(root: &mut Value, provider: HookProvider) -> Result<bool, String> {
    let Some(hooks_value) = root.get_mut("hooks") else {
        return Ok(false);
    };
    let hooks = hooks_value
        .as_object_mut()
        .ok_or_else(|| "Claude settings.hooks 必须是 JSON 对象".to_string())?;
    let mut changed = false;
    for groups_value in hooks.values_mut() {
        let groups = groups_value
            .as_array_mut()
            .ok_or_else(|| "Claude Hook 事件配置必须是数组".to_string())?;
        groups.retain_mut(|group| {
            let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let original_len = handlers.len();
            handlers.retain(|handler| !is_managed_handler(handler, provider));
            if handlers.len() != original_len {
                changed = true;
            }
            !handlers.is_empty() || original_len == 0
        });
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captured(provider: HookProvider, event_name: &str) -> CapturedHookEvent {
        CapturedHookEvent {
            schema_version: HOOK_SCHEMA_VERSION,
            provider: provider.id().to_string(),
            event_name: event_name.to_string(),
            session_id: "session-1".to_string(),
            agent_id: None,
            agent_type: None,
            cwd: Some("/workspace".to_string()),
            tool_name: None,
            notification_type: None,
            received_at: current_timestamp_ms(),
        }
    }

    #[test]
    fn parses_claude_hook_without_persisting_prompt_or_tool_input() {
        let value = json!({
            "hook_event_name": "PreToolUse",
            "session_id": "claude-session",
            "agent_id": "agent-1",
            "agent_type": "reviewer",
            "cwd": "/workspace/project",
            "tool_name": "Edit",
            "tool_input": { "file_path": "/workspace/project/secret.txt" }
        });
        let event = parse_hook_payload(HookProvider::Claude, &value).expect("parse Claude hook");
        assert_eq!(event.provider, "claude");
        assert_eq!(event.session_id, "claude-session");
        assert_eq!(event.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(event.tool_name.as_deref(), Some("Edit"));
        let serialized = serde_json::to_string(&event).expect("serialize capture");
        assert!(!serialized.contains("secret.txt"));
    }

    #[test]
    fn detects_grok_payload_loaded_through_claude_compatible_hook() {
        let value = json!({
            "hookEventName": "user_prompt_submit",
            "sessionId": "grok-session",
            "cwd": "/workspace/project"
        });
        let event = parse_hook_payload(HookProvider::Claude, &value).expect("parse Grok hook");
        assert_eq!(event.provider, "grok");
        assert_eq!(event.event_name, "UserPromptSubmit");
    }

    #[test]
    fn normalizes_documented_grok_event_names() {
        let cases = [
            ("session_start", "SessionStart"),
            ("user_prompt_submit", "UserPromptSubmit"),
            ("pre_tool_use", "PreToolUse"),
            ("post_tool_use", "PostToolUse"),
            ("post_tool_use_failure", "PostToolUseFailure"),
            ("permission_denied", "PermissionDenied"),
            ("notification", "Notification"),
            ("subagent_start", "SubagentStart"),
            ("subagent_stop", "SubagentStop"),
            ("pre_compact", "PreCompact"),
            ("post_compact", "PostCompact"),
            ("stop", "Stop"),
            ("stop_failure", "StopFailure"),
            ("session_end", "SessionEnd"),
        ];

        for (native, canonical) in cases {
            assert_eq!(normalize_grok_event_name(native), canonical);
        }
    }

    #[test]
    fn parses_documented_grok_payload_and_maps_native_tool_names() {
        let value = json!({
            "hookEventName": "pre_tool_use",
            "sessionId": "grok-session",
            "cwd": "/workspace/project",
            "workspaceRoot": "/workspace/project",
            "toolName": "run_terminal_command",
            "toolUseId": "tool-1",
            "toolInputTruncated": false,
            "timestamp": "2026-04-14T12:00:00Z"
        });
        let command = parse_hook_payload(HookProvider::Grok, &value).expect("parse Grok hook");
        assert_eq!(command.provider, "grok");
        assert_eq!(command.event_name, "PreToolUse");
        assert_eq!(command.session_id, "grok-session");
        assert_eq!(command.cwd.as_deref(), Some("/workspace/project"));
        assert_eq!(command.tool_name.as_deref(), Some("run_terminal_command"));
        assert_eq!(
            map_hook_event(HookProvider::Grok, &command)
                .expect("map Grok command")
                .state,
            Some("running_command")
        );

        let mut edit = command;
        edit.tool_name = Some("search_replace".to_string());
        assert_eq!(
            map_hook_event(HookProvider::Grok, &edit)
                .expect("map Grok edit")
                .state,
            Some("editing_file")
        );
    }

    #[test]
    fn configured_hook_inbox_takes_precedence_over_home() {
        let configured = PathBuf::from("/configured/agent-events");
        let home = PathBuf::from("/home/user");

        assert_eq!(
            select_hook_inbox_dir(Some(configured.clone()), Some(home.clone())),
            Some(configured)
        );
        assert_eq!(
            select_hook_inbox_dir(None, Some(home.clone())),
            Some(home.join(".codex-pet").join("agent-events"))
        );
    }

    #[test]
    fn windows_grok_hook_command_uses_powershell_call_operator() {
        let command =
            windows_hook_command(r"D:\AI_studio\Codex Pet\codex-pet.exe", HookProvider::Grok)
                .expect("build Windows hook command");

        assert_eq!(
            command,
            r#"& "D:\AI_studio\Codex Pet\codex-pet.exe" --agent-hook grok"#
        );
    }

    #[test]
    fn grok_install_injects_explicit_inbox_for_every_event() {
        let directory = tempfile::tempdir().expect("create temp dir");
        let path = directory.path().join("codex-pet.json");
        let inbox = directory.path().join("agent-events");
        let command = r#"& "C:\Program Files\Codex Pet\codex-pet.exe" --agent-hook grok"#;

        install_grok_hooks(&path, command, &inbox).expect("install Grok hooks");
        let mut value: Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("read hooks"))
                .expect("parse hooks");
        let expected_inbox = inbox.to_string_lossy();

        for event in GROK_HOOK_EVENTS {
            let handler = &value["hooks"][*event][0]["hooks"][0];
            assert_eq!(
                handler["env"][HOOK_INBOX_ENV].as_str(),
                Some(expected_inbox.as_ref())
            );
            assert!(is_current_grok_handler(
                handler,
                command,
                expected_inbox.as_ref()
            ));
        }
        assert!(
            config_contains_current_grok_hooks(&path, command, expected_inbox.as_ref())
                .expect("check current Grok config")
        );

        let legacy = json!({
            "type": "command",
            "command": command,
            "timeout": 5
        });
        assert!(!is_current_grok_handler(
            &legacy,
            command,
            expected_inbox.as_ref()
        ));

        let legacy_windows_command = json!({
            "type": "command",
            "command": r#""C:\Program Files\Codex Pet\codex-pet.exe" --agent-hook grok"#,
            "env": { (HOOK_INBOX_ENV): expected_inbox.as_ref() },
            "timeout": 5
        });
        assert!(!is_current_grok_handler(
            &legacy_windows_command,
            command,
            expected_inbox.as_ref()
        ));

        let wrong_type = json!({
            "type": "http",
            "command": command,
            "env": { (HOOK_INBOX_ENV): expected_inbox.as_ref() },
            "timeout": 5
        });
        assert!(!is_current_grok_handler(
            &wrong_type,
            command,
            expected_inbox.as_ref()
        ));

        value["hooks"]["SessionStart"][0]["hooks"][0]
            .as_object_mut()
            .expect("SessionStart handler")
            .remove("env");
        fs::write(
            &path,
            serde_json::to_vec(&value).expect("serialize legacy hooks"),
        )
        .expect("write legacy hooks");
        assert!(
            !config_contains_current_grok_hooks(&path, command, expected_inbox.as_ref())
                .expect("check legacy Grok config")
        );
    }

    #[test]
    fn maps_tool_and_terminal_events_to_shared_states() {
        let mut edit = captured(HookProvider::Claude, "PreToolUse");
        edit.tool_name = Some("Edit".to_string());
        assert_eq!(
            map_hook_event(HookProvider::Claude, &edit)
                .expect("map edit")
                .state,
            Some("editing_file")
        );
        assert_eq!(
            map_hook_event(
                HookProvider::Grok,
                &captured(HookProvider::Grok, "StopFailure")
            )
            .expect("map failure")
            .state,
            Some("error")
        );
    }

    #[test]
    fn maps_claude_completion_notifications_to_terminal_states() {
        let mut idle = captured(HookProvider::Claude, "Notification");
        idle.notification_type = Some("idle_prompt".to_string());
        assert_eq!(
            map_hook_event(HookProvider::Claude, &idle)
                .expect("map idle notification")
                .state,
            Some("success")
        );

        let mut completed = idle.clone();
        completed.notification_type = Some("agent_completed".to_string());
        assert_eq!(
            map_hook_event(HookProvider::Claude, &completed)
                .expect("map completed notification")
                .state,
            Some("success")
        );

        let mut needs_input = idle;
        needs_input.notification_type = Some("agent_needs_input".to_string());
        assert_eq!(
            map_hook_event(HookProvider::Claude, &needs_input)
                .expect("map input notification")
                .state,
            Some("waiting_input")
        );
    }

    #[test]
    fn claude_install_is_idempotent_and_preserves_existing_hooks() {
        let directory = tempfile::tempdir().expect("create temp dir");
        let path = directory.path().join("settings.json");
        fs::write(
            &path,
            r#"{"theme":"dark","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"check.sh"}]},{"hooks":[{"type":"command","command":"'/old/codex pet' --agent-hook claude"}]}]}}"#,
        )
        .expect("write settings");

        install_claude_hooks(&path, Path::new("/app/codex pet")).expect("install hooks");
        install_claude_hooks(&path, Path::new("/app/codex pet")).expect("reinstall hooks");
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).expect("read settings"))
            .expect("parse settings");
        assert_eq!(value.get("theme").and_then(Value::as_str), Some("dark"));
        let pre_tool = value["hooks"]["PreToolUse"]
            .as_array()
            .expect("pre tool hooks");
        assert_eq!(pre_tool.len(), 2);
        let managed = pre_tool
            .iter()
            .find(|group| group_contains_managed_hook(group, HookProvider::Claude))
            .expect("managed hook");
        let handler = &managed["hooks"][0];
        assert_eq!(handler["command"].as_str(), Some("/app/codex pet"));
        assert_eq!(
            handler["args"],
            json!(["--agent-hook", HookProvider::Claude.id()])
        );
        assert!(config_contains_managed_hook(&path, HookProvider::Claude).expect("hook status"));

        uninstall_claude_hooks(&path).expect("uninstall hooks");
        assert!(!config_contains_managed_hook(&path, HookProvider::Claude).expect("hook status"));
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).expect("read settings"))
            .expect("parse settings");
        assert_eq!(
            value["hooks"]["PreToolUse"].as_array().map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn captured_hooks_are_written_atomically() {
        let directory = tempfile::tempdir().expect("create temp dir");
        let event = captured(HookProvider::Claude, "Stop");
        persist_captured_hook(directory.path(), &event).expect("persist hook");
        persist_captured_hook(directory.path(), &event).expect("persist another hook");
        assert_eq!(
            fs::read_dir(directory.path()).expect("read inbox").count(),
            2
        );
    }

    #[test]
    fn inbox_monitor_deduplicates_compatible_hooks_without_reordering_lifecycle() {
        let mut monitor = HookInboxMonitor::default();
        let first = captured(HookProvider::Grok, "PreToolUse");
        let mut duplicate = first.clone();
        duplicate.received_at += 1;
        let mut stop = first.clone();
        stop.event_name = "Stop".to_string();
        stop.received_at += 2;

        assert!(!monitor.is_duplicate(&first));
        assert!(monitor.is_duplicate(&duplicate));
        assert!(!monitor.is_duplicate(&stop));
    }

    #[test]
    fn hook_event_lists_only_contain_supported_mappings() {
        for provider in [HookProvider::Claude, HookProvider::Grok] {
            for event in provider.events() {
                assert!(
                    map_hook_event(provider, &captured(provider, event)).is_some(),
                    "missing mapping for {event}"
                );
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unix_hook_command_quotes_single_quotes() {
        let command = hook_command(Path::new("/tmp/codex pet's/app"), HookProvider::Grok)
            .expect("build hook command");
        assert_eq!(command, "'/tmp/codex pet'\"'\"'s/app' --agent-hook grok");
    }
}
