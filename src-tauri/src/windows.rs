use crate::diagnostics;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub(crate) fn restore_main_window(app: AppHandle) -> Result<(), String> {
    restore_main_window_state(&app)
        .inspect(|()| diagnostics::info("windows", "restored main window"))
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
    let Some(window) = app.get_webview_window("main") else {
        return Err("未找到主窗口".to_string());
    };

    let _ = window.set_always_on_top(true);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
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
