use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::parse::{ConnectPhase, ConnectStatus};
use crate::supervisor::{shutdown_all, stop_connect, AppState};

struct TrayUi {
    status: MenuItem<Wry>,
    org: MenuItem<Wry>,
    disconnect: MenuItem<Wry>,
}

static TRAY: Mutex<Option<TrayUi>> = Mutex::new(None);

fn tray_png() -> Image<'static> {
    Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("tray png")
}

pub fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let status = MenuItem::with_id(app, "status", "Disconnected", false, None::<&str>)?;
    let org = MenuItem::with_id(app, "org", "No organization", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open HookDeploy Agent", true, None::<&str>)?;
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
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("HookDeploy Agent")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
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
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    *TRAY.lock().expect("tray") = Some(TrayUi {
        status,
        org,
        disconnect,
    });
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
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
