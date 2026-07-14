use crate::{
    diagnostics, home_dir,
    storage::{read_with_backup_status, write_json_atomically_with_backup_policy, RecoverySource},
    windows::restore_main_window_state,
};
use chrono::{
    DateTime, Datelike, Duration as ChronoDuration, Local, LocalResult, NaiveTime, TimeZone,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

static SCHEDULER_STARTED: AtomicBool = AtomicBool::new(false);
static ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const DEFAULT_TITLE: &str = "周报提醒";
const DEFAULT_MESSAGE: &str = "老大，该写周报了。";
const DEFAULT_WEEKDAY: u8 = 5;
const DEFAULT_TIME: &str = "16:00";
const MAX_DURATION_MINUTES: u32 = 24 * 60;
const MAX_MESSAGE_CHARS: usize = 1000;
const ON_TIME_WINDOW_MS: i64 = 60 * 1000;
const CATCH_UP_WINDOW_MS: i64 = 30 * 60 * 1000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReminderConfig {
    #[serde(default = "new_reminder_id")]
    id: String,
    enabled: bool,
    title: String,
    message: String,
    weekday: u8,
    time: String,
    duration_minutes: u32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReminderStore {
    reminders: Vec<StoredReminder>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredReminder {
    #[serde(flatten)]
    config: ReminderConfig,
    #[serde(default)]
    last_handled_at: Option<i64>,
    #[serde(default)]
    last_status: ReminderRunStatus,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ReminderRunStatus {
    #[default]
    Never,
    Triggered,
    CaughtUp,
    Missed,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReminderSnapshot {
    config: ReminderConfig,
    next_reminder_at: Option<i64>,
    last_handled_at: Option<i64>,
    last_status: ReminderRunStatus,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReminderStateSnapshot {
    reminders: Vec<ReminderSnapshot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReminderConfigHealth {
    status: &'static str,
    path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReminderEvent {
    reminder_id: String,
    title: String,
    message: String,
    duration_minutes: u32,
    next_reminder_at: Option<i64>,
    triggered_at: i64,
    trigger_kind: &'static str,
}

#[derive(Clone)]
struct ScheduledReminder {
    config: ReminderConfig,
    next_reminder_at: Option<i64>,
    last_handled_at: Option<i64>,
    last_status: ReminderRunStatus,
}

type DueReminder = (ReminderConfig, Option<i64>, i64, &'static str);

struct ReminderState {
    reminders: Vec<ScheduledReminder>,
    generation: u64,
    config_source: RecoverySource,
}

pub(crate) struct ReminderManager {
    state: Mutex<ReminderState>,
}

impl Default for ReminderConfig {
    fn default() -> Self {
        Self {
            id: new_reminder_id(),
            enabled: false,
            title: DEFAULT_TITLE.to_string(),
            message: DEFAULT_MESSAGE.to_string(),
            weekday: DEFAULT_WEEKDAY,
            time: DEFAULT_TIME.to_string(),
            duration_minutes: 0,
        }
    }
}

impl ReminderManager {
    pub(crate) fn new() -> Self {
        let (stored_reminders, config_source) = read_reminder_configs_from_disk();
        match config_source {
            RecoverySource::Primary => diagnostics::info("reminders", "loaded reminder config"),
            RecoverySource::Backup => {
                diagnostics::warn("reminders", "recovered reminder config from backup")
            }
            RecoverySource::Missing => {
                diagnostics::info("reminders", "reminder config missing; using defaults")
            }
            RecoverySource::Invalid => diagnostics::error(
                "reminders",
                "reminder config and backup are invalid; using defaults",
            ),
        }
        let now = Local::now();
        let needs_runtime_migration = stored_reminders
            .iter()
            .any(|stored| stored.config.enabled && stored.last_handled_at.is_none());
        let reminders = stored_reminders
            .into_iter()
            .map(|stored| scheduled_reminder_from_stored(stored, &now))
            .collect();
        let manager = Self {
            state: Mutex::new(ReminderState {
                reminders,
                generation: 0,
                config_source,
            }),
        };
        if needs_runtime_migration {
            let mut state = manager
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            persist_reminder_state(&mut state);
        }
        manager
    }

    fn snapshot(&self) -> ReminderStateSnapshot {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        reminder_state_snapshot(&state)
    }

    fn upsert(&self, config: ReminderConfig) -> Result<ReminderStateSnapshot, String> {
        let config = normalize_reminder_config(config);
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let mut reminders = state.reminders.clone();
        let now = Local::now();
        if let Some(existing) = reminders
            .iter_mut()
            .find(|existing| existing.config.id == config.id)
        {
            let schedule_changed = existing.config.enabled != config.enabled
                || existing.config.weekday != config.weekday
                || existing.config.time != config.time;
            existing.config = config;
            if schedule_changed {
                existing.next_reminder_at = next_reminder_timestamp_from(&existing.config, &now);
                existing.last_handled_at = Some(now.timestamp_millis());
                existing.last_status = ReminderRunStatus::Never;
            }
        } else {
            reminders.push(ScheduledReminder {
                next_reminder_at: next_reminder_timestamp_from(&config, &now),
                config,
                last_handled_at: Some(now.timestamp_millis()),
                last_status: ReminderRunStatus::Never,
            });
        }
        write_reminders_to_disk(
            &reminders,
            matches!(state.config_source, RecoverySource::Primary),
        )?;
        state.reminders = reminders;
        state.generation = state.generation.wrapping_add(1);
        state.config_source = RecoverySource::Primary;
        Ok(reminder_state_snapshot(&state))
    }

    fn delete(&self, reminder_id: &str) -> Result<ReminderStateSnapshot, String> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let reminders = state
            .reminders
            .iter()
            .filter(|reminder| reminder.config.id != reminder_id)
            .cloned()
            .collect::<Vec<_>>();
        if reminders.len() == state.reminders.len() {
            return Err("未找到要删除的提醒任务".to_string());
        }
        write_reminders_to_disk(
            &reminders,
            matches!(state.config_source, RecoverySource::Primary),
        )?;
        state.reminders = reminders;
        state.generation = state.generation.wrapping_add(1);
        state.config_source = RecoverySource::Primary;
        Ok(reminder_state_snapshot(&state))
    }

    fn repair(&self) -> Result<ReminderStateSnapshot, String> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        write_reminders_to_disk(
            &state.reminders,
            matches!(state.config_source, RecoverySource::Primary),
        )?;
        state.config_source = RecoverySource::Primary;
        state.generation = state.generation.wrapping_add(1);
        Ok(reminder_state_snapshot(&state))
    }

    fn config_source(&self) -> RecoverySource {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .config_source
    }
}

fn reminder_state_snapshot(state: &ReminderState) -> ReminderStateSnapshot {
    ReminderStateSnapshot {
        reminders: state
            .reminders
            .iter()
            .map(|reminder| ReminderSnapshot {
                config: reminder.config.clone(),
                next_reminder_at: reminder.next_reminder_at,
                last_handled_at: reminder.last_handled_at,
                last_status: reminder.last_status,
            })
            .collect(),
    }
}

#[tauri::command]
pub(crate) fn get_reminder_state(manager: State<ReminderManager>) -> ReminderStateSnapshot {
    manager.snapshot()
}

#[tauri::command]
pub(crate) fn get_reminder_config_health(manager: State<ReminderManager>) -> ReminderConfigHealth {
    let status = match manager.config_source() {
        RecoverySource::Primary => "healthy",
        RecoverySource::Backup => "recoveredFromBackup",
        RecoverySource::Missing => "defaultsAfterMissing",
        RecoverySource::Invalid => "defaultsAfterInvalid",
    };
    ReminderConfigHealth {
        status,
        path: reminder_config_path()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

#[tauri::command]
pub(crate) fn repair_reminder_config(
    app: AppHandle,
    manager: State<ReminderManager>,
) -> Result<ReminderStateSnapshot, String> {
    let snapshot = manager.repair().inspect_err(|error| {
        diagnostics::error(
            "reminders",
            &format!("failed to repair reminder config: {error}"),
        );
    })?;
    diagnostics::info("reminders", "repaired reminder config");
    let _ = app.emit("reminder-state-updated", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn save_reminder_config(
    app: AppHandle,
    manager: State<ReminderManager>,
    config: ReminderConfig,
) -> Result<ReminderStateSnapshot, String> {
    let reminder_id = config.id.clone();
    let snapshot = manager.upsert(config).inspect_err(|error| {
        diagnostics::error(
            "reminders",
            &format!("failed to save reminder {reminder_id}: {error}"),
        );
    })?;
    diagnostics::info("reminders", &format!("saved reminder {reminder_id}"));
    let _ = app.emit("reminder-state-updated", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn delete_reminder_config(
    app: AppHandle,
    manager: State<ReminderManager>,
    reminder_id: String,
) -> Result<ReminderStateSnapshot, String> {
    let snapshot = manager.delete(&reminder_id).inspect_err(|error| {
        diagnostics::error(
            "reminders",
            &format!("failed to delete reminder {reminder_id}: {error}"),
        );
    })?;
    diagnostics::info("reminders", &format!("deleted reminder {reminder_id}"));
    let _ = app.emit("reminder-state-updated", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn preview_reminder(app: AppHandle, config: ReminderConfig) -> Result<(), String> {
    let config = normalize_reminder_config(config);
    diagnostics::info("reminders", &format!("previewed reminder {}", config.id));
    let now = Local::now();
    emit_reminder_event(
        &app,
        &config,
        next_reminder_timestamp_from(&config, &now),
        now.timestamp_millis(),
        "preview",
        false,
    );
    restore_main_window_state(&app)
}

pub(crate) fn start_reminder_scheduler(app: AppHandle) {
    if SCHEDULER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    diagnostics::info("reminders", "started reminder scheduler");

    thread::spawn(move || loop {
        let (due_reminders, snapshot) = {
            let manager = app.state::<ReminderManager>();
            let mut state = manager
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let now = Local::now();
            let (due, changed) = process_due_reminders(&mut state.reminders, &now);
            if changed {
                state.generation = state.generation.wrapping_add(1);
                persist_reminder_state(&mut state);
            }
            let snapshot = changed.then(|| reminder_state_snapshot(&state));
            (due, snapshot)
        };

        if let Some(snapshot) = snapshot {
            let _ = app.emit("reminder-state-updated", snapshot);
        }
        for (config, next_reminder_at, triggered_at, trigger_kind) in due_reminders {
            emit_reminder_event(
                &app,
                &config,
                next_reminder_at,
                triggered_at,
                trigger_kind,
                true,
            );
        }

        thread::sleep(Duration::from_secs(15));
    });
}

fn process_due_reminders(
    reminders: &mut [ScheduledReminder],
    now: &DateTime<Local>,
) -> (Vec<DueReminder>, bool) {
    let now_ms = now.timestamp_millis();
    let mut due = Vec::new();
    let mut changed = false;
    for reminder in reminders {
        if !reminder.config.enabled {
            reminder.next_reminder_at = None;
            continue;
        }
        if reminder.next_reminder_at.is_none() {
            reminder.next_reminder_at = next_reminder_timestamp_from(&reminder.config, now);
        }
        let Some(trigger_at) = reminder
            .next_reminder_at
            .filter(|trigger_at| *trigger_at <= now_ms)
        else {
            continue;
        };
        if reminder
            .last_handled_at
            .is_some_and(|handled_at| handled_at >= trigger_at)
        {
            reminder.next_reminder_at = next_reminder_timestamp_from(&reminder.config, now);
            changed = true;
            continue;
        }

        let (status, trigger_kind) = classify_due_reminder(now_ms - trigger_at);
        reminder.last_handled_at = Some(trigger_at);
        reminder.last_status = status;
        reminder.next_reminder_at = next_reminder_timestamp_from(&reminder.config, now);
        changed = true;
        if let Some(trigger_kind) = trigger_kind {
            due.push((
                reminder.config.clone(),
                reminder.next_reminder_at,
                trigger_at,
                trigger_kind,
            ));
        }
    }
    (due, changed)
}

fn emit_reminder_event(
    app: &AppHandle,
    config: &ReminderConfig,
    next_reminder_at: Option<i64>,
    triggered_at: i64,
    trigger_kind: &'static str,
    notify: bool,
) {
    diagnostics::info(
        "reminders",
        &format!("emitted reminder {} (notification={notify})", config.id),
    );
    let title = normalized_reminder_title(&config.title);
    let message = normalized_reminder_message(&config.message);
    let payload = ReminderEvent {
        reminder_id: config.id.clone(),
        title: title.clone(),
        message: message.clone(),
        duration_minutes: config.duration_minutes,
        next_reminder_at,
        triggered_at,
        trigger_kind,
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

fn read_reminder_configs_from_disk() -> (Vec<StoredReminder>, RecoverySource) {
    let Some(path) = reminder_config_path() else {
        return (
            vec![StoredReminder {
                config: ReminderConfig::default(),
                last_handled_at: None,
                last_status: ReminderRunStatus::Never,
            }],
            RecoverySource::Missing,
        );
    };
    let recovered = read_with_backup_status(&path, parse_reminder_configs);
    (
        recovered.value.unwrap_or_else(|| {
            vec![StoredReminder {
                config: ReminderConfig::default(),
                last_handled_at: None,
                last_status: ReminderRunStatus::Never,
            }]
        }),
        recovered.source,
    )
}

fn parse_reminder_configs(text: &str) -> Option<Vec<StoredReminder>> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    let configs = if value.get("reminders").is_some() {
        serde_json::from_value::<ReminderStore>(value)
            .ok()?
            .reminders
    } else {
        vec![StoredReminder {
            config: serde_json::from_value::<ReminderConfig>(value).ok()?,
            last_handled_at: None,
            last_status: ReminderRunStatus::Never,
        }]
    };
    Some(normalize_stored_reminders(configs))
}

fn write_reminders_to_disk(
    reminders: &[ScheduledReminder],
    backup_current: bool,
) -> Result<(), String> {
    let path = reminder_config_path().ok_or_else(|| "无法定位用户目录".to_string())?;
    let store = ReminderStore {
        reminders: reminders.iter().map(stored_reminder).collect(),
    };
    write_json_atomically_with_backup_policy(&path, &store, backup_current)
}

fn reminder_config_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".codex-pet").join("reminder.json"))
}

fn normalize_reminder_config(config: ReminderConfig) -> ReminderConfig {
    ReminderConfig {
        id: normalize_reminder_id(&config.id),
        enabled: config.enabled,
        title: normalized_reminder_title(&config.title),
        message: normalized_reminder_message(&config.message),
        weekday: normalize_reminder_weekday(config.weekday),
        time: normalize_reminder_time(&config.time),
        duration_minutes: config.duration_minutes.min(MAX_DURATION_MINUTES),
    }
}

fn stored_reminder(reminder: &ScheduledReminder) -> StoredReminder {
    StoredReminder {
        config: reminder.config.clone(),
        last_handled_at: reminder.last_handled_at,
        last_status: reminder.last_status,
    }
}

fn scheduled_reminder_from_stored(
    stored: StoredReminder,
    now: &DateTime<Local>,
) -> ScheduledReminder {
    let config = normalize_reminder_config(stored.config);
    let last_handled_at = stored
        .last_handled_at
        .or_else(|| Some(now.timestamp_millis()));
    let next_reminder_at = if config.enabled {
        let previous = previous_reminder_timestamp_from(&config, now);
        if previous.is_some_and(|scheduled_at| {
            stored
                .last_handled_at
                .is_some_and(|handled_at| handled_at < scheduled_at)
        }) {
            previous
        } else {
            next_reminder_timestamp_from(&config, now)
        }
    } else {
        None
    };
    ScheduledReminder {
        config,
        next_reminder_at,
        last_handled_at,
        last_status: stored.last_status,
    }
}

fn normalize_stored_reminders(reminders: Vec<StoredReminder>) -> Vec<StoredReminder> {
    let mut ids = HashSet::new();
    reminders
        .into_iter()
        .map(|stored| StoredReminder {
            config: normalize_reminder_config(stored.config),
            last_handled_at: stored.last_handled_at,
            last_status: stored.last_status,
        })
        .filter(|stored| ids.insert(stored.config.id.clone()))
        .collect()
}

fn classify_due_reminder(lateness_ms: i64) -> (ReminderRunStatus, Option<&'static str>) {
    if lateness_ms <= ON_TIME_WINDOW_MS {
        (ReminderRunStatus::Triggered, Some("triggered"))
    } else if lateness_ms <= CATCH_UP_WINDOW_MS {
        (ReminderRunStatus::CaughtUp, Some("caughtUp"))
    } else {
        (ReminderRunStatus::Missed, None)
    }
}

fn persist_reminder_state(state: &mut ReminderState) {
    let backup_current = matches!(state.config_source, RecoverySource::Primary);
    match write_reminders_to_disk(&state.reminders, backup_current) {
        Ok(()) => state.config_source = RecoverySource::Primary,
        Err(error) => diagnostics::error(
            "reminders",
            &format!("failed to persist reminder runtime state: {error}"),
        ),
    }
}

fn normalize_reminder_id(value: &str) -> String {
    let normalized = value
        .trim()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(64)
        .collect::<String>();
    if normalized.is_empty() {
        new_reminder_id()
    } else {
        normalized
    }
}

fn new_reminder_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let sequence = ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("reminder-{timestamp}-{sequence}")
}

fn normalized_reminder_title(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        DEFAULT_TITLE.to_string()
    } else {
        value.chars().take(16).collect()
    }
}

fn normalized_reminder_message(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        DEFAULT_MESSAGE.to_string()
    } else {
        value.chars().take(MAX_MESSAGE_CHARS).collect()
    }
}

fn normalize_reminder_weekday(value: u8) -> u8 {
    if value <= 6 {
        value
    } else {
        DEFAULT_WEEKDAY
    }
}

fn normalize_reminder_time(value: &str) -> String {
    if parse_reminder_time(value).is_some() {
        value.to_string()
    } else {
        DEFAULT_TIME.to_string()
    }
}

fn parse_reminder_time(value: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(value.trim(), "%H:%M").ok()
}

fn next_reminder_timestamp_from(config: &ReminderConfig, now: &DateTime<Local>) -> Option<i64> {
    if !config.enabled {
        return None;
    }

    let time = parse_reminder_time(&config.time)?;
    let weekday = normalize_reminder_weekday(config.weekday) as u32;
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
        if candidate > *now {
            return Some(candidate.timestamp_millis());
        }
    }

    None
}

fn previous_reminder_timestamp_from(config: &ReminderConfig, now: &DateTime<Local>) -> Option<i64> {
    if !config.enabled {
        return None;
    }

    let time = parse_reminder_time(&config.time)?;
    let weekday = normalize_reminder_weekday(config.weekday) as u32;
    let today = now.date_naive();

    for offset in 0..=7 {
        let date = today.checked_sub_signed(ChronoDuration::days(offset))?;
        if date.weekday().num_days_from_sunday() != weekday {
            continue;
        }

        let candidate = match Local.from_local_datetime(&date.and_time(time)) {
            LocalResult::Single(value) => value,
            LocalResult::Ambiguous(_, latest) => latest,
            LocalResult::None => continue,
        };
        if candidate <= *now {
            return Some(candidate.timestamp_millis());
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_migrates_legacy_single_config() {
        let legacy = r#"{
            "enabled": true,
            "title": "旧提醒",
            "message": "保留原有配置",
            "weekday": 3,
            "time": "09:30",
            "durationMinutes": 5
        }"#;
        let reminders = parse_reminder_configs(legacy).expect("parse legacy reminder");
        assert_eq!(reminders.len(), 1);
        assert_eq!(reminders[0].config.title, "旧提醒");
        assert_eq!(reminders[0].config.weekday, 3);
        assert!(!reminders[0].config.id.is_empty());
    }

    #[test]
    fn parser_keeps_multiple_configs_and_empty_store() {
        let multiple = r#"{
            "reminders": [
                {
                    "id": "morning",
                    "enabled": true,
                    "title": "晨会",
                    "message": "准备晨会",
                    "weekday": 1,
                    "time": "09:00",
                    "durationMinutes": 0
                },
                {
                    "id": "review",
                    "enabled": false,
                    "title": "复盘",
                    "message": "整理本周进展",
                    "weekday": 5,
                    "time": "17:30",
                    "durationMinutes": 10
                }
            ]
        }"#;
        let reminders = parse_reminder_configs(multiple).expect("parse reminder list");
        assert_eq!(reminders.len(), 2);
        assert_eq!(reminders[0].config.id, "morning");
        assert_eq!(reminders[1].config.id, "review");

        let empty =
            parse_reminder_configs(r#"{"reminders": []}"#).expect("parse empty reminder list");
        assert!(empty.is_empty());
    }

    #[test]
    fn parser_keeps_runtime_status_metadata() {
        let stored = r#"{
            "reminders": [{
                "id": "weekly",
                "enabled": true,
                "title": "周报",
                "message": "提交周报",
                "weekday": 5,
                "time": "16:00",
                "durationMinutes": 0,
                "lastHandledAt": 123456,
                "lastStatus": "caughtUp"
            }]
        }"#;
        let reminders = parse_reminder_configs(stored).expect("parse stored reminder");
        assert_eq!(reminders[0].last_handled_at, Some(123456));
        assert_eq!(reminders[0].last_status, ReminderRunStatus::CaughtUp);
    }

    #[test]
    fn due_reminders_are_caught_up_once_within_the_grace_window() {
        assert_eq!(
            classify_due_reminder(ON_TIME_WINDOW_MS),
            (ReminderRunStatus::Triggered, Some("triggered"))
        );
        assert_eq!(
            classify_due_reminder(ON_TIME_WINDOW_MS + 1),
            (ReminderRunStatus::CaughtUp, Some("caughtUp"))
        );
        assert_eq!(
            classify_due_reminder(CATCH_UP_WINDOW_MS + 1),
            (ReminderRunStatus::Missed, None)
        );
    }

    #[test]
    fn reminders_with_the_same_schedule_all_fire_once() {
        let now = Local::now();
        let trigger_at = now.timestamp_millis() - 10_000;
        let config = ReminderConfig {
            enabled: true,
            weekday: now.weekday().num_days_from_sunday() as u8,
            time: now.format("%H:%M").to_string(),
            ..ReminderConfig::default()
        };
        let mut reminders = vec![
            ScheduledReminder {
                config: config.clone(),
                next_reminder_at: Some(trigger_at),
                last_handled_at: None,
                last_status: ReminderRunStatus::Never,
            },
            ScheduledReminder {
                config: ReminderConfig {
                    id: "same-time".to_string(),
                    ..config
                },
                next_reminder_at: Some(trigger_at),
                last_handled_at: None,
                last_status: ReminderRunStatus::Never,
            },
        ];

        let (first_due, changed) = process_due_reminders(&mut reminders, &now);
        let (second_due, _) = process_due_reminders(&mut reminders, &now);

        assert!(changed);
        assert_eq!(first_due.len(), 2);
        assert!(second_due.is_empty());
        assert!(reminders
            .iter()
            .all(|reminder| reminder.last_status == ReminderRunStatus::Triggered));
    }
}
