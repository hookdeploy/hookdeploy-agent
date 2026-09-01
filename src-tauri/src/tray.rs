use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
#[cfg(not(target_os = "macos"))]
use tauri::tray::{MouseButton, MouseButtonState};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::parse::{
    enroll_line_looks_leaky, relay_short_name, ConnectPhase, ConnectStatus,
};
use crate::supervisor::{shutdown_all, start_connect, stop_connect, AppState};

struct TrayUi {
    status: MenuItem<Wry>,
    org: MenuItem<Wry>,
    connection: MenuItem<Wry>,
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
    let connection = MenuItem::with_id(app, "connection", "Connect", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = MenuBuilder::new(app)
        .item(&status)
        .item(&org)
        .item(&open)
        .item(&connection)
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
            "connection" => on_connection_click(app),
            "quit" => on_quit(app),
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
        connection,
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

/// Tray Quit: stdin-close taps, stop connect, then exit. The only exit path
/// from this menu item — not a bare `app.exit` / `process::exit`.
pub fn on_quit(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = shutdown_all(&app).await;
        app.exit(0);
    });
}

fn on_connection_click(app: &AppHandle) {
    let phase = app
        .state::<AppState>()
        .inner
        .try_lock()
        .ok()
        .map(|g| g.status.phase)
        .unwrap_or(ConnectPhase::Disconnected);
    match connection_click(phase) {
        Some(ConnectionClick::StopConnect) => {
            let _ = stop_connect(app);
        }
        Some(ConnectionClick::StartConnect) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = start_connect(&app, None).await;
            });
        }
        None => {}
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
                // After Open (index 2): status, org, open, [update], connection, sep, quit.
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
        .and_then(|g| g.org_name.clone());
    let labels = tray_labels(status, org.as_deref());

    if let Some(ui) = TRAY.lock().ok().as_ref().and_then(|t| t.as_ref()) {
        let _ = ui.status.set_text(&labels.status);
        let _ = ui.org.set_text(&labels.org);
        let _ = ui.connection.set_text(labels.connection);
        let _ = ui.connection.set_enabled(labels.connection_enabled);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionToggle {
    Connect,
    Disconnect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionClick {
    StartConnect,
    StopConnect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayLabels {
    pub status: String,
    pub org: String,
    pub connection: &'static str,
    pub connection_enabled: bool,
}

pub fn status_label(status: &ConnectStatus) -> String {
    match status.phase {
        ConnectPhase::Connected => {
            if let Some(relay) = status.relay.as_deref().filter(|s| !s.is_empty()) {
                format!("Connected · {}", relay_short_name(relay))
            } else if let Some(region) = status.region.as_deref().filter(|s| !s.is_empty()) {
                format!("Connected · {region}")
            } else {
                "Connected".into()
            }
        }
        ConnectPhase::Reconnecting => "Reconnecting".into(),
        ConnectPhase::Connecting => "Connecting".into(),
        ConnectPhase::Revoked => "Revoked".into(),
        ConnectPhase::Disconnected => "Disconnected".into(),
    }
}

/// Org menu text: parsed `OrgInfo.name` / enroll org only. First line, leak filter.
pub fn org_label(org_name: Option<&str>) -> String {
    let Some(name) = org_name.map(str::trim).filter(|s| !s.is_empty()) else {
        return "No organization".into();
    };
    let first = name.lines().next().unwrap_or(name).trim();
    if first.is_empty() || first.contains("agent:") || enroll_line_looks_leaky(first) {
        return "No organization".into();
    }
    first.to_string()
}

pub fn connection_toggle(phase: ConnectPhase) -> (ConnectionToggle, bool) {
    match phase {
        ConnectPhase::Connected | ConnectPhase::Connecting | ConnectPhase::Reconnecting => {
            (ConnectionToggle::Disconnect, true)
        }
        ConnectPhase::Disconnected => (ConnectionToggle::Connect, true),
        ConnectPhase::Revoked => (ConnectionToggle::Connect, false),
    }
}

pub fn connection_click(phase: ConnectPhase) -> Option<ConnectionClick> {
    let (toggle, enabled) = connection_toggle(phase);
    if !enabled {
        return None;
    }
    match toggle {
        ConnectionToggle::Connect => Some(ConnectionClick::StartConnect),
        ConnectionToggle::Disconnect => Some(ConnectionClick::StopConnect),
    }
}

pub fn tray_labels(status: &ConnectStatus, org_name: Option<&str>) -> TrayLabels {
    let (toggle, enabled) = connection_toggle(status.phase);
    TrayLabels {
        status: status_label(status),
        org: org_label(org_name),
        connection: match toggle {
            ConnectionToggle::Connect => "Connect",
            ConnectionToggle::Disconnect => "Disconnect",
        },
        connection_enabled: enabled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connected_status() -> ConnectStatus {
        let mut s = ConnectStatus::default();
        s.apply_line("agent: assigned region=us-west hostname=relay-us-west-01.hookdeploy.dev");
        s.apply_line(
            "agent: connected relay=relay-us-west-01.hookdeploy.dev remote=1.2.3.4:9443",
        );
        s
    }

    fn disconnected_status() -> ConnectStatus {
        ConnectStatus::default()
    }

    fn labels_joined(labels: &TrayLabels) -> String {
        format!(
            "{}\n{}\nOpen HookDeploy Agent\n{}\nQuit",
            labels.status, labels.org, labels.connection
        )
    }

    #[test]
    fn connected_menu_uses_relay_short_name_and_clean_org() {
        let labels = tray_labels(&connected_status(), Some("Acme"));
        assert_eq!(labels.status, "Connected · us-west-01");
        assert_eq!(labels.org, "Acme");
        assert_eq!(labels.connection, "Disconnect");
        assert!(labels.connection_enabled);
        let menu = labels_joined(&labels);
        assert!(!menu.contains("stored cert"));
        assert!(!menu.contains("agent:"));
        assert!(!menu.contains("us-west") || menu.contains("us-west-01"));
        assert!(!menu.contains("Connect\n"));
    }

    #[test]
    fn disconnected_menu_shows_connect_and_no_raw_log() {
        let labels = tray_labels(&disconnected_status(), Some("Acme"));
        assert_eq!(labels.status, "Disconnected");
        assert_eq!(labels.org, "Acme");
        assert_eq!(labels.connection, "Connect");
        assert!(labels.connection_enabled);
        let menu = labels_joined(&labels);
        assert!(!menu.contains("stored cert"));
        assert_eq!(labels.connection, "Connect");
        assert_eq!(connection_click(ConnectPhase::Disconnected), Some(ConnectionClick::StartConnect));
        assert_eq!(
            connection_click(ConnectPhase::Connected),
            Some(ConnectionClick::StopConnect)
        );
        assert_ne!(
            connection_click(ConnectPhase::Disconnected),
            connection_click(ConnectPhase::Connected)
        );
    }

    #[test]
    fn never_both_or_neither_connection_item() {
        for phase in [
            ConnectPhase::Disconnected,
            ConnectPhase::Connecting,
            ConnectPhase::Connected,
            ConnectPhase::Reconnecting,
            ConnectPhase::Revoked,
        ] {
            let mut status = ConnectStatus::default();
            status.phase = phase;
            let labels = tray_labels(&status, Some("Acme"));
            let is_connect = labels.connection == "Connect";
            let is_disconnect = labels.connection == "Disconnect";
            assert!(
                is_connect ^ is_disconnect,
                "phase {phase:?} must show exactly one of Connect/Disconnect, got {}",
                labels.connection
            );
        }
        assert_eq!(
            connection_click(ConnectPhase::Connecting),
            Some(ConnectionClick::StopConnect)
        );
        assert_eq!(
            connection_click(ConnectPhase::Reconnecting),
            Some(ConnectionClick::StopConnect)
        );
        assert_eq!(connection_click(ConnectPhase::Revoked), None);
    }

    #[test]
    fn intermediate_states_are_not_misleading() {
        let mut connecting = ConnectStatus::default();
        connecting.phase = ConnectPhase::Connecting;
        connecting.region = Some("us-west".into());
        let labels = tray_labels(&connecting, Some("Acme"));
        assert_eq!(labels.status, "Connecting");
        assert_eq!(labels.connection, "Disconnect");

        let mut reconnecting = connected_status();
        reconnecting.phase = ConnectPhase::Reconnecting;
        let labels = tray_labels(&reconnecting, Some("Acme"));
        assert_eq!(labels.status, "Reconnecting");
        assert_eq!(labels.connection, "Disconnect");

        let mut revoked = ConnectStatus::default();
        revoked.phase = ConnectPhase::Revoked;
        let labels = tray_labels(&revoked, Some("Acme"));
        assert_eq!(labels.status, "Revoked");
        assert_eq!(labels.connection, "Connect");
        assert!(!labels.connection_enabled);

        // Update-pending does not change status or the toggle.
        let labels = tray_labels(&connected_status(), Some("Acme"));
        assert_eq!(labels.status, "Connected · us-west-01");
        assert_eq!(labels.connection, "Disconnect");
    }

    #[test]
    fn stored_cert_stdout_never_appears_in_the_menu() {
        let leak = "Acme\nagent: stored cert in C:\\Users\\x\\.hookdeploy\\certs org=Acme CN=a OU=o";
        let labels = tray_labels(&connected_status(), Some(leak));
        assert_eq!(labels.org, "Acme");
        let menu = labels_joined(&labels);
        assert!(!menu.contains("stored cert"));
        assert!(!menu.contains("C:\\"));
        assert!(!menu.contains("CN="));
        assert!(!menu.contains("certs"));

        let only_leak = "agent: stored cert in /Users/x/.hookdeploy/certs org=Acme CN=a OU=o";
        let labels = tray_labels(&disconnected_status(), Some(only_leak));
        assert_eq!(labels.org, "No organization");
        let menu = labels_joined(&labels);
        assert!(!menu.contains("stored cert"));
        assert!(!menu.contains("/Users/"));
        assert!(!menu.contains("agent:"));
    }

    #[test]
    fn region_is_fallback_when_relay_missing() {
        let mut s = ConnectStatus::default();
        s.apply_line("agent: assigned region=us-west hostname=relay-us-west-01.hookdeploy.dev");
        assert_eq!(s.phase, ConnectPhase::Connecting);
        assert_eq!(status_label(&s), "Connecting");
        s.phase = ConnectPhase::Connected;
        s.relay = None;
        assert_eq!(status_label(&s), "Connected · us-west");
    }

    #[test]
    fn quit_handler_calls_shutdown_all_not_a_bare_exit() {
        let src = include_str!("tray.rs");
        let prod = src.split("#[cfg(test)]").next().unwrap();
        assert!(
            prod.contains("\"quit\" => on_quit(app)"),
            "Quit menu arm must call on_quit"
        );
        let on_quit = prod
            .split("pub fn on_quit")
            .nth(1)
            .expect("on_quit function");
        let on_quit = on_quit.split("fn on_connection_click").next().unwrap();
        assert!(
            on_quit.contains("shutdown_all"),
            "on_quit must call shutdown_all"
        );
        assert!(
            on_quit.contains("app.exit(0)"),
            "on_quit exits only after shutdown_all"
        );
        assert!(
            !prod.contains("process::exit("),
            "tray must not call process::exit"
        );
        let match_arm = prod
            .split("on_menu_event")
            .nth(1)
            .expect("menu events")
            .split(".on_tray_icon_event")
            .next()
            .unwrap();
        assert!(
            !match_arm.contains("app.exit"),
            "menu match must not exit except via on_quit"
        );
        assert!(prod.contains("Some(ConnectionClick::StartConnect) =>"));
        assert!(prod.contains("start_connect(&app, None)"));
        assert!(prod.contains("Some(ConnectionClick::StopConnect) =>"));
        assert!(prod.contains("stop_connect(app)"));
    }
}
