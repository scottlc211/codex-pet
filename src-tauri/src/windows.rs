use crate::diagnostics;
use tauri::{AppHandle, Emitter, Manager};

const MAIN_WINDOW_VISIBILITY_EVENT: &str = "main-window-visibility-changed";

#[tauri::command]
pub(crate) fn restore_main_window(app: AppHandle) -> Result<(), String> {
    restore_main_window_state(&app)
        .inspect(|()| diagnostics::info("windows", "restored main window"))
        .inspect_err(|error| diagnostics::error("windows", error))
}

#[tauri::command]
pub(crate) fn get_main_window_visibility(app: AppHandle) -> Result<bool, String> {
    main_window_visibility_state(&app).inspect_err(|error| diagnostics::error("windows", error))
}

#[tauri::command]
pub(crate) fn hide_main_window(app: AppHandle) -> Result<bool, String> {
    set_main_window_visibility_state(&app, false)
        .inspect(|_| diagnostics::info("windows", "hid main window"))
        .inspect_err(|error| diagnostics::error("windows", error))
}

#[tauri::command]
pub(crate) fn toggle_main_window(app: AppHandle) -> Result<bool, String> {
    toggle_main_window_state(&app)
        .inspect(|visible| {
            diagnostics::info(
                "windows",
                if *visible {
                    "showed main window"
                } else {
                    "hid main window"
                },
            );
        })
        .inspect_err(|error| diagnostics::error("windows", error))
}

#[tauri::command]
pub(crate) fn open_settings_window(app: AppHandle) -> Result<(), String> {
    open_settings_window_state(&app)
        .inspect(|()| diagnostics::info("windows", "opened settings window"))
        .inspect_err(|error| diagnostics::error("windows", error))
}

#[tauri::command]
pub(crate) fn hide_settings_window(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("settings") else {
        return Err("未找到设置窗口".to_string());
    };
    window
        .hide()
        .map_err(|error| format!("隐藏设置窗口失败：{error}"))
        .inspect(|()| diagnostics::info("windows", "hid settings window"))
        .inspect_err(|error| diagnostics::error("windows", error))
}

#[tauri::command]
pub(crate) fn quit_app(app: AppHandle) {
    diagnostics::info("app", "application exit requested");
    app.exit(0);
}

pub(crate) fn restore_main_window_state(app: &AppHandle) -> Result<(), String> {
    set_main_window_visibility_state(app, true).map(|_| ())
}

pub(crate) fn toggle_main_window_state(app: &AppHandle) -> Result<bool, String> {
    let visible = main_window_visibility_state(app)?;
    set_main_window_visibility_state(app, !visible)
}

fn main_window_visibility_state(app: &AppHandle) -> Result<bool, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("未找到主窗口".to_string());
    };

    window
        .is_visible()
        .map_err(|error| format!("读取桌宠显示状态失败：{error}"))
}

fn set_main_window_visibility_state(app: &AppHandle, visible: bool) -> Result<bool, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("未找到主窗口".to_string());
    };

    if visible {
        let _ = window.set_always_on_top(true);
        let _ = window.unminimize();
        window
            .show()
            .map_err(|error| format!("显示桌宠失败：{error}"))?;
        let _ = window.set_focus();
    } else {
        window
            .hide()
            .map_err(|error| format!("隐藏桌宠失败：{error}"))?;
    }

    if let Err(error) = app.emit(MAIN_WINDOW_VISIBILITY_EVENT, visible) {
        diagnostics::warn(
            "windows",
            &format!("failed to emit main window visibility: {error}"),
        );
    }
    Ok(visible)
}

pub(crate) fn open_settings_window_state(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("settings") else {
        return Err("未找到设置窗口".to_string());
    };
    let _ = window.unminimize();
    window
        .show()
        .map_err(|error| format!("显示设置窗口失败：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("聚焦设置窗口失败：{error}"))
}
