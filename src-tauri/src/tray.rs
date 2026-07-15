use crate::{
    diagnostics,
    windows::{open_settings_window_state, restore_main_window_state, toggle_main_window_state},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Emitter,
};

pub(crate) fn setup_tray(app: &mut App) -> tauri::Result<()> {
    diagnostics::info("tray", "setting up system tray");
    let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let toggle_pet_item =
        MenuItem::with_id(app, "toggle-pet", "显示/隐藏桌宠", true, None::<&str>)?;
    let click_through_item =
        MenuItem::with_id(app, "click-through", "鼠标穿透", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let tray_menu = Menu::with_items(
        app,
        &[
            &settings_item,
            &toggle_pet_item,
            &click_through_item,
            &quit_item,
        ],
    )?;
    let mut tray_builder = TrayIconBuilder::with_id("main")
        .tooltip("Codex Pet")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => {
                if let Err(error) = open_settings_window_state(app) {
                    diagnostics::error("tray", &format!("failed to open settings: {error}"));
                } else {
                    diagnostics::info("tray", "settings selected from tray");
                }
            }
            "toggle-pet" => {
                if let Err(error) = toggle_main_window_state(app) {
                    diagnostics::error("tray", &format!("failed to toggle main window: {error}"));
                } else {
                    diagnostics::info("tray", "main window toggled from tray");
                }
            }
            "click-through" => {
                if let Err(error) = app.emit_to("main", "tray-toggle-click-through", ()) {
                    diagnostics::error("tray", &format!("failed to toggle click-through: {error}"));
                } else {
                    diagnostics::info("tray", "click-through toggled from tray");
                }
            }
            "quit" => {
                diagnostics::info("tray", "quit selected from tray");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Err(error) = restore_main_window_state(tray.app_handle()) {
                    diagnostics::error("tray", &format!("failed to restore main window: {error}"));
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }
    let _tray = tray_builder.build(app)?;
    diagnostics::info("tray", "system tray ready");
    Ok(())
}
