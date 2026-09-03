mod network;
mod parse;
mod ports;
mod supervisor;
mod tray;

use tauri::WindowEvent;

use supervisor::AppState;

#[tauri::command]
fn get_snapshot(state: tauri::State<AppState>) -> supervisor::Snapshot {
    state.snapshot()
}

#[tauri::command]
async fn start_connect(app: tauri::AppHandle, region: Option<String>) -> Result<(), String> {
    supervisor::start_connect(&app, region).await
}

#[tauri::command]
fn stop_connect(app: tauri::AppHandle) -> Result<(), String> {
    supervisor::stop_connect(&app)
}

#[tauri::command]
async fn create_tap(
    app: tauri::AppHandle,
    endpoint_id: String,
    destination_id: Option<String>,
    port: u16,
    path: String,
    no_tty: Option<bool>,
) -> Result<supervisor::TapHandle, String> {
    let _ = no_tty.unwrap_or(true);
    supervisor::create_tap(&app, endpoint_id, destination_id, port, path).await
}

#[tauri::command]
async fn stop_tap(app: tauri::AppHandle, tap_id: String) -> Result<(), String> {
    supervisor::stop_tap(&app, tap_id).await
}

#[tauri::command]
async fn rename_agent(app: tauri::AppHandle, name: String) -> Result<String, String> {
    supervisor::rename_agent(&app, name).await
}

#[tauri::command]
async fn list_orgs(app: tauri::AppHandle) -> Result<Vec<parse::OrgInfo>, String> {
    supervisor::list_orgs(&app).await
}

#[tauri::command]
async fn switch_org(app: tauri::AppHandle, id: String) -> Result<Vec<parse::OrgInfo>, String> {
    supervisor::switch_org(&app, id).await
}

#[tauri::command]
async fn unenroll(app: tauri::AppHandle) -> Result<Vec<parse::OrgInfo>, String> {
    supervisor::unenroll(&app).await
}

#[tauri::command]
async fn list_endpoints(app: tauri::AppHandle) -> Result<parse::Catalog, String> {
    supervisor::list_catalog(&app).await
}

#[tauri::command]
async fn list_taps(app: tauri::AppHandle) -> Result<Vec<parse::TapInfo>, String> {
    Ok(supervisor::list_catalog(&app).await?.taps)
}

#[tauri::command]
async fn enroll_start(app: tauri::AppHandle) -> Result<supervisor::EnrollPhase, String> {
    supervisor::enroll_start(&app).await
}

#[tauri::command]
async fn enroll_submit_code(
    app: tauri::AppHandle,
    code: String,
) -> Result<supervisor::EnrollPhase, String> {
    supervisor::enroll_submit_code(&app, code).await
}

#[tauri::command]
fn list_ports() -> Result<Vec<ports::PortInfo>, String> {
    ports::list_ports()
}

#[tauri::command]
async fn shutdown_all(app: tauri::AppHandle) -> Result<(), String> {
    supervisor::shutdown_all(&app).await
}

#[tauri::command]
fn set_update_available(version: Option<String>) {
    tray::set_update_available(version.as_deref());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            start_connect,
            stop_connect,
            create_tap,
            stop_tap,
            rename_agent,
            list_orgs,
            switch_org,
            unenroll,
            list_endpoints,
            list_taps,
            enroll_start,
            enroll_submit_code,
            list_ports,
            shutdown_all,
            set_update_available
        ])
        .setup(|app| {
            // Status item first, then Accessory. Installed builds also get
            // LSUIElement via Info.plist; this call covers `tauri dev`. Do not
            // discard the policy Result via AppHandle — use App::set_activation_policy.
            tray::install(app.handle())?;
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            network::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running HookDeploy Agent");
}

#[cfg(test)]
mod tests {
    #[test]
    fn setup_installs_tray_before_accessory_and_does_not_swallow_policy() {
        let src = include_str!("lib.rs");
        let setup = src
            .split(".setup(|app| {")
            .nth(1)
            .expect("setup closure")
            .split(".on_window_event")
            .next()
            .unwrap();
        let tray_pos = setup.find("tray::install").expect("tray::install in setup");
        let policy_pos = setup
            .find("app.set_activation_policy")
            .expect("app.set_activation_policy in setup");
        assert!(
            tray_pos < policy_pos,
            "tray must be installed before ActivationPolicy::Accessory"
        );
        assert!(
            !setup.contains("let _ = app.handle()")
                && !setup.contains("let _ = app\n")
                && !setup.contains("let _ = app\r"),
            "activation policy must not be discarded with let _ = on AppHandle"
        );
        assert!(
            setup.contains("app.set_activation_policy"),
            "use App::set_activation_policy, not a swallowed AppHandle Result"
        );
    }
}
