use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
#[cfg(not(target_os = "macos"))]
use tauri::tray::{MouseButton, MouseButtonState};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::parse::{ConnectPhase, ConnectStatus};
use crate::supervisor::{shutdown_all, stop_connect, AppState};

struct TrayUi {
    status: MenuItem<Wry>,
    org: MenuItem<Wry>,
    disconnect: MenuItem<Wry>,
    update: MenuItem<Wry>,
    menu: Menu<Wry>,
    update_shown: bool,
}

static TRAY: Mutex<Option<TrayUi>> = Mutex::new(None);

fn tray_png() -> Image<'static> {
    // macOS menu bar wants a template (alpha mask). tray-template.png is a
    // PLACEHOLDER grayscale conversion of the brand mark — swap for a real
    // 22pt template asset before shipping.
    #[cfg(target_os = "macos")]
    {
        Image::from_bytes(include_bytes!("../icons/tray-template.png")).expect("tray template png")
    }
    #[cfg(not(target_os = "macos"))]
    {
        Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("tray png")
    }
}

pub fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let status = MenuItem::with_id(app, "status", "Disconnected", false, None::<&str>)?;
    let org = MenuItem::with_id(app, "org", "No organization", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open HookDeploy Agent", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Update available", true, None::<&str>)?;
    let disconnect = MenuItem::with_id(app, "disconnect", "Disconnect", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = MenuBuilder::new(app)
        .item(&status)
        .item(&org)
        .item(&open)
        .item(&disconnect)
        .separator()
        .item(&quit)
        .build()?;

    let icon = tray_png();
    let builder = TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .tooltip("HookDeploy Agent")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "update" => {
                let _ = app.emit("update-tray-clicked", ());
                show_main(app);
            }
            "disconnect" => {
                let _ = stop_connect(app);
            }
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = shutdown_all(&app).await;
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Windows: left-click opens the window; menu is the other button.
            // macOS: left-click shows the menu (show_menu_on_left_click).
            #[cfg(not(target_os = "macos"))]
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
            #[cfg(target_os = "macos")]
            {
                let _ = (tray, event);
            }
        });

    #[cfg(target_os = "macos")]
    let builder = builder
        .icon_as_template(true)
        .show_menu_on_left_click(true);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.show_menu_on_left_click(false);

    builder.build(app)?;

    *TRAY.lock().expect("tray") = Some(TrayUi {
        status,
        org,
        disconnect,
        update,
        menu,
        update_shown: false,
    });
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Insert or remove the tray "Update available" item. `None` hides it.
pub fn set_update_available(version: Option<&str>) {
    let mut guard = match TRAY.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(ui) = guard.as_mut() else {
        return;
    };
    match version {
        Some(v) if !v.is_empty() => {
            let label = format!("Update available · {v}");
            let _ = ui.update.set_text(&label);
            if !ui.update_shown {
                // After Open (index 2): status, org, open, [update], disconnect, sep, quit.
                let _ = ui.menu.insert(&ui.update, 3);
                ui.update_shown = true;
            }
        }
        _ => {
            if ui.update_shown {
                let _ = ui.menu.remove(&ui.update);
                ui.update_shown = false;
            }
        }
    }
}

pub fn sync(app: &AppHandle, status: &ConnectStatus) {
    let org = app
        .state::<AppState>()
        .inner
        .try_lock()
        .ok()
        .and_then(|g| g.org_name.clone())
        .unwrap_or_else(|| "No organization".into());

    let label = match status.phase {
        ConnectPhase::Connected => status
            .region
            .as_deref()
            .map(|r| format!("Connected · {r}"))
            .unwrap_or_else(|| "Connected".into()),
        ConnectPhase::Reconnecting => "Reconnecting".into(),
        ConnectPhase::Connecting => "Connecting".into(),
        ConnectPhase::Revoked => "Revoked".into(),
        ConnectPhase::Disconnected => "Disconnected".into(),
    };
    let live = matches!(
        status.phase,
        ConnectPhase::Connected | ConnectPhase::Reconnecting | ConnectPhase::Connecting
    );

    if let Some(ui) = TRAY.lock().ok().as_ref().and_then(|t| t.as_ref()) {
        let _ = ui.status.set_text(label);
        let _ = ui.org.set_text(org);
        let _ = ui.disconnect.set_enabled(live);
    }
}
