use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::parse::{
    is_code_prompt, is_enrolled_plain, is_wrong_code, parse_agent_cn, parse_enrolled_org,
    parse_enrollment_url_block,
    parse_org_list, parse_stopped_tap, parse_tap_list, parse_tapping_line, resolve_created_tap_id,
    strip_agent_prefix, Catalog, ConnectPhase, ConnectStatus, CreatedTap, OrgInfo,
};

/// Wait for `Stopped tap …` after stdin EOF. CLI is usually immediate; 8s
/// covers a slow stop POST without hanging Quit.
pub const TAP_STOP_TIMEOUT: Duration = Duration::from_secs(8);

pub struct AppState {
    pub inner: Mutex<Inner>,
}

pub struct Inner {
    pub status: ConnectStatus,
    pub agent_id: Option<String>,
    pub org_name: Option<String>,
    pub enroll_url: Option<String>,
    pub enroll_phase: EnrollPhase,
    connect: Option<CommandChild>,
    connect_gen: u64,
    taps: HashMap<String, TapProc>,
    enroll: Option<CommandChild>,
    enroll_gen: u64,
}

struct TapProc {
    child: Child,
    lines: std::sync::mpsc::Receiver<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EnrollPhase {
    Idle,
    Starting,
    BrowserOpened { url: String },
    AwaitingCode,
    Submitting,
    WrongCode,
    Succeeded { org: String },
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub status: ConnectStatus,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub org_name: Option<String>,
    pub enroll_url: Option<String>,
    pub enroll_phase: EnrollPhase,
}

#[derive(Debug, Clone, Serialize)]
pub struct TapHandle {
    pub id: String,
    pub endpoint_id: String,
    pub destination_id: Option<String>,
    pub port: u16,
    pub path: String,
    pub target: String,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            status: ConnectStatus::default(),
            agent_id: None,
            org_name: None,
            enroll_url: None,
            enroll_phase: EnrollPhase::Idle,
            connect: None,
            connect_gen: 0,
            taps: HashMap::new(),
            enroll: None,
            enroll_gen: 0,
        }
    }
}

fn local_hostname() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let g = self.inner.lock().expect("state");
        Snapshot {
            status: g.status.clone(),
            agent_id: g.agent_id.clone(),
            agent_name: local_hostname(),
            org_name: g.org_name.clone(),
            enroll_url: g.enroll_url.clone(),
            enroll_phase: g.enroll_phase.clone(),
        }
    }
}

fn emit_status(app: &AppHandle, status: &ConnectStatus) {
    let _ = app.emit("connect-status", status);
    crate::tray::sync(app, status);
}

fn sidecar(
    app: &AppHandle,
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> Result<tauri_plugin_shell::process::Command, String> {
    let args: Vec<String> = args.into_iter().map(|s| s.as_ref().to_string()).collect();
    Ok(app
        .shell()
        .sidecar("hookdeployed")
        .map_err(|e| format!("sidecar hookdeployed: {e}"))?
        .args(args))
}

async fn sidecar_output(app: &AppHandle, args: &[&str]) -> Result<String, String> {
    let out = sidecar(app, args)?
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let code = out.status.code();
    if out.status.success() {
        return Ok(stdout);
    }
    let mut msg = stderr.trim().to_string();
    if msg.is_empty() {
        msg = stdout.trim().to_string();
    }
    if msg.is_empty() {
        msg = format!("hookdeployed exited {}", code.unwrap_or(-1));
    }
    Err(strip_agent_prefix(&msg).to_string())
}

pub async fn rename_agent(app: &AppHandle, name: String) -> Result<String, String> {
    sidecar_output(app, &["rename", "-name", &name]).await?;
    Ok(name)
}

pub async fn list_orgs(app: &AppHandle) -> Result<Vec<OrgInfo>, String> {
    let stdout = sidecar_output(app, &["list"]).await?;
    parse_org_list(&stdout)
}

pub async fn switch_org(app: &AppHandle, id: String) -> Result<Vec<OrgInfo>, String> {
    sidecar_output(app, &["switch", &id]).await?;
    list_orgs(app).await
}

pub async fn unenroll(app: &AppHandle) -> Result<Vec<OrgInfo>, String> {
    // Active org, no positional — Go's flag.Parse stops at the first
    // non-flag, so -yes must be the only extra argv.
    let _ = stop_connect(app);
    tokio::time::sleep(Duration::from_millis(300)).await;
    match tokio::time::timeout(
        Duration::from_secs(25),
        sidecar_output(app, &["unenroll", "-yes"]),
    )
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("unenroll timed out waiting for the agent".into()),
    }
    match list_orgs(app).await {
        Ok(orgs) => Ok(orgs),
        Err(_) => Ok(Vec::new()),
    }
}

pub async fn list_catalog(app: &AppHandle) -> Result<Catalog, String> {
    if let Ok(stdout) = sidecar_output(app, &["tap", "list", "-json"]).await {
        if stdout.trim().starts_with('{') {
            return parse_tap_list(&stdout);
        }
    }
    // Tauri sidecar `.output()` can miss stdout; the exe next to us is the same binary.
    if let Ok(stdout) = tap_list_json_direct() {
        if stdout.trim().starts_with('{') {
            return parse_tap_list(&stdout);
        }
    }
    let stdout = sidecar_output(app, &["tap", "list"]).await?;
    parse_tap_list(&stdout)
}

fn tap_list_json_direct() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or_else(|| "no executable directory".to_string())?;
    let sidecar = ["hookdeployed.exe", "hookdeployed"]
        .into_iter()
        .map(|name| dir.join(name))
        .find(|p| p.exists())
        .ok_or_else(|| "sidecar hookdeployed not found next to the tray".to_string())?;
    let out = StdCommand::new(sidecar)
        .args(["tap", "list", "-json"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if msg.is_empty() {
            msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
        return Err(msg);
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub async fn start_connect(app: &AppHandle, region: Option<String>) -> Result<(), String> {
    let mut args = vec!["connect".to_string()];
    if let Some(r) = region.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        args.push("-region".into());
        args.push(r.to_string());
    }

    {
        let state = app.state::<AppState>();
        if state.inner.lock().expect("state").connect.is_some() {
            return Ok(());
        }
    }

    let (rx, child) = sidecar(app, args)?.spawn().map_err(|e| e.to_string())?;

    let gen = {
        let state = app.state::<AppState>();
        let mut g = state.inner.lock().expect("state");
        if g.connect.is_some() {
            drop(g);
            let _ = child.kill();
            return Ok(());
        }
        g.connect_gen += 1;
        g.connect = Some(child);
        g.status.phase = ConnectPhase::Connecting;
        g.status.detail = None;
        let gen = g.connect_gen;
        let status = g.status.clone();
        drop(g);
        emit_status(app, &status);
        gen
    };

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        watch_connect(handle, rx, gen).await;
    });
    Ok(())
}

async fn watch_connect(
    app: AppHandle,
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    gen: u64,
) {
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if line.is_empty() {
                    continue;
                }
                let _ = app.emit("connect-log", &line);
                let state = app.state::<AppState>();
                let mut g = state.inner.lock().expect("state");
                if g.connect_gen != gen {
                    break;
                }
                if let Some(cn) = parse_agent_cn(&line) {
                    g.agent_id = Some(cn);
                }
                g.status.apply_line(&line);
                let status = g.status.clone();
                drop(g);
                emit_status(&app, &status);
            }
            CommandEvent::Terminated(_) => {
                let state = app.state::<AppState>();
                let mut g = state.inner.lock().expect("state");
                if g.connect_gen != gen {
                    break;
                }
                g.connect = None;
                if g.status.phase != ConnectPhase::Revoked {
                    g.status.phase = ConnectPhase::Disconnected;
                    g.status.detail = Some("connect process exited".into());
                }
                let status = g.status.clone();
                drop(g);
                emit_status(&app, &status);
                break;
            }
            CommandEvent::Error(err) => {
                let _ = app.emit("connect-log", format!("error: {err}"));
            }
            _ => {}
        }
    }
}

/// Kill the `connect` child. Called from Disconnect and Quit only — never
/// from window-close. Uses `CommandChild::kill()` (Windows: terminate).
pub fn stop_connect(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut g = state.inner.lock().expect("state");
    g.connect_gen += 1;
    if let Some(child) = g.connect.take() {
        child.kill().map_err(|e| e.to_string())?;
    }
    if g.status.phase != ConnectPhase::Revoked {
        g.status.phase = ConnectPhase::Disconnected;
        g.status.detail = None;
    }
    let status = g.status.clone();
    drop(g);
    emit_status(app, &status);
    Ok(())
}

pub async fn create_tap(
    app: &AppHandle,
    endpoint_id: String,
    destination_id: Option<String>,
    port: u16,
    path: String,
) -> Result<TapHandle, String> {
    let path = if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    };
    let mut args = vec![
        "tap".into(),
        endpoint_id.clone(),
    ];
    if let Some(dest) = destination_id.as_ref().filter(|s| !s.is_empty()) {
        args.push(dest.clone());
    }
    args.extend([
        "-port".into(),
        port.to_string(),
        "-path".into(),
        path.clone(),
        "-no-tty".into(),
    ]);

    let shell = sidecar(app, &args)?;
    let mut std_cmd = StdCommand::from(shell);
    std_cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = std_cmd.spawn().map_err(|e| e.to_string())?;

    let stdout = child.stdout.take().ok_or("tap stdout not piped")?;
    let stderr = child.stderr.take().ok_or("tap stderr not piped")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let tx_err = tx.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().flatten() {
            let _ = tx.send(line);
        }
    });
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().flatten() {
            let _ = tx_err.send(line);
        }
    });

    let created = wait_for_tapping(&rx, Duration::from_secs(15))?;
    let catalog = list_catalog(app).await?;
    let id = resolve_created_tap_id(&catalog, &created).ok_or_else(|| {
        format!(
            "tap started ({}) but tap list did not include a matching id",
            created.target
        )
    })?;

    let handle = TapHandle {
        id: id.clone(),
        endpoint_id,
        destination_id,
        port,
        path,
        target: created.target,
    };

    let state = app.state::<AppState>();
    let mut g = state.inner.lock().expect("state");
    g.taps.insert(id, TapProc { child, lines: rx });
    Ok(handle)
}

fn wait_for_tapping(
    rx: &std::sync::mpsc::Receiver<String>,
    timeout: Duration,
) -> Result<CreatedTap, String> {
    let deadline = Instant::now() + timeout;
    let mut err_bits = String::new();
    while Instant::now() < deadline {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left.min(Duration::from_millis(200))) {
            Ok(line) => {
                if let Some(created) = parse_tapping_line(&line) {
                    return Ok(created);
                }
                let plain = strip_agent_prefix(&line);
                if !plain.is_empty() {
                    if !err_bits.is_empty() {
                        err_bits.push('\n');
                    }
                    err_bits.push_str(plain);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(if err_bits.is_empty() {
                    "tap process exited before Tapping line".into()
                } else {
                    err_bits
                });
            }
        }
    }
    Err(if err_bits.is_empty() {
        "timed out waiting for Tapping line".into()
    } else {
        err_bits
    })
}

pub async fn stop_tap(app: &AppHandle, tap_id: String) -> Result<(), String> {
    let proc = {
        let state = app.state::<AppState>();
        let mut g = state.inner.lock().expect("state");
        g.taps.remove(&tap_id)
    };
    if let Some(mut proc) = proc {
        let id = tap_id.clone();
        let local = tauri::async_runtime::spawn_blocking(move || {
            close_stdin_and_wait(&mut proc, &id, TAP_STOP_TIMEOUT, true)
        })
        .await
        .map_err(|e| e.to_string())?;
        if local.is_ok() {
            return Ok(());
        }
    }
    sidecar_output(app, &["tap", "stop", &tap_id]).await?;
    Ok(())
}

fn close_stdin_and_wait(
    proc: &mut TapProc,
    tap_id: &str,
    timeout: Duration,
    kill_after_timeout: bool,
) -> Result<(), String> {
    drop(proc.child.stdin.take());
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        while let Ok(line) = proc.lines.try_recv() {
            let _ = parse_stopped_tap(&line);
        }
        match proc.child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(e.to_string()),
        }
    }
    if kill_after_timeout {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
        return Ok(());
    }
    Err(format!(
        "tap {tap_id} did not exit within {}s after stdin close",
        timeout.as_secs()
    ))
}

pub async fn enroll_start(app: &AppHandle) -> Result<EnrollPhase, String> {
    let (rx, child) = sidecar(app, ["enroll", "-no-tty"])?
        .spawn()
        .map_err(|e| e.to_string())?;

    let gen = {
        let state = app.state::<AppState>();
        let mut g = state.inner.lock().expect("state");
        if let Some(old) = g.enroll.take() {
            let _ = old.kill();
        }
        g.enroll_gen += 1;
        g.enroll = Some(child);
        g.enroll_url = None;
        g.enroll_phase = EnrollPhase::Starting;
        g.enroll_gen
    };
    let _ = app.emit("enroll-progress", EnrollPhase::Starting);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        watch_enroll(handle, rx, gen).await;
    });

    // Catch an immediate failure (unknown flag, TTY refusal). Do not block
    // the webview for the full device-start + browser open.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let state = app.state::<AppState>();
        let phase = state.inner.lock().expect("state").enroll_phase.clone();
        match &phase {
            EnrollPhase::BrowserOpened { .. } | EnrollPhase::AwaitingCode => return Ok(phase),
            EnrollPhase::Failed { message } => return Err(message.clone()),
            _ => {}
        }
        if Instant::now() >= deadline {
            return Ok(phase);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn watch_enroll(
    app: AppHandle,
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    gen: u64,
) {
    let mut buf = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                buf.push_str(&chunk);
                let line = chunk.trim().to_string();
                let state = app.state::<AppState>();
                let mut g = state.inner.lock().expect("state");
                if g.enroll_gen != gen {
                    break;
                }
                if let Some(url) = parse_enrollment_url_block(&buf) {
                    g.enroll_url = Some(url.clone());
                    if !matches!(g.enroll_phase, EnrollPhase::AwaitingCode) {
                        g.enroll_phase = EnrollPhase::BrowserOpened { url };
                    }
                }
                if let Some(org) = parse_enrolled_org(&buf).or_else(|| parse_enrolled_org(&line)) {
                    g.org_name = Some(org.clone());
                    g.enroll_phase = EnrollPhase::Succeeded { org };
                    g.enroll = None;
                } else if is_enrolled_plain(&buf) || is_enrolled_plain(&line) {
                    g.enroll_phase = EnrollPhase::Succeeded {
                        org: g.org_name.clone().unwrap_or_default(),
                    };
                    g.enroll = None;
                } else if is_wrong_code(&line) {
                    g.enroll_phase = EnrollPhase::WrongCode;
                } else if !matches!(g.enroll_phase, EnrollPhase::Succeeded { .. })
                    && (is_code_prompt(&line) || buf.contains("Enter the code from the browser:"))
                {
                    g.enroll_phase = EnrollPhase::AwaitingCode;
                }
                if let Some(cn) = parse_agent_cn(&line) {
                    g.agent_id = Some(cn);
                }
                let phase = g.enroll_phase.clone();
                drop(g);
                let _ = app.emit("enroll-progress", phase);
            }
            CommandEvent::Terminated(payload) => {
                let state = app.state::<AppState>();
                let mut g = state.inner.lock().expect("state");
                if g.enroll_gen != gen {
                    break;
                }
                g.enroll = None;
                if let Some(org) = parse_enrolled_org(&buf) {
                    g.org_name = Some(org.clone());
                    g.enroll_phase = EnrollPhase::Succeeded { org };
                } else if is_enrolled_plain(&buf) {
                    g.enroll_phase = EnrollPhase::Succeeded {
                        org: g.org_name.clone().unwrap_or_default(),
                    };
                } else if payload.code == Some(0)
                    && matches!(
                        g.enroll_phase,
                        EnrollPhase::Submitting | EnrollPhase::AwaitingCode
                    )
                {
                    g.enroll_phase = EnrollPhase::Succeeded {
                        org: g.org_name.clone().unwrap_or_default(),
                    };
                } else if !matches!(
                    g.enroll_phase,
                    EnrollPhase::Succeeded { .. } | EnrollPhase::Failed { .. }
                ) {
                    let code = payload.code.unwrap_or(-1);
                    g.enroll_phase = EnrollPhase::Failed {
                        message: format!("enroll exited {code}"),
                    };
                }
                let phase = g.enroll_phase.clone();
                drop(g);
                let _ = app.emit("enroll-progress", phase);
                break;
            }
            CommandEvent::Error(err) => {
                let state = app.state::<AppState>();
                let mut g = state.inner.lock().expect("state");
                if g.enroll_gen != gen {
                    break;
                }
                g.enroll_phase = EnrollPhase::Failed { message: err };
                let phase = g.enroll_phase.clone();
                drop(g);
                let _ = app.emit("enroll-progress", phase);
            }
            _ => {}
        }
    }
}

pub async fn enroll_submit_code(app: &AppHandle, code: String) -> Result<EnrollPhase, String> {
    {
        let state = app.state::<AppState>();
        let mut g = state.inner.lock().expect("state");
        let child = g
            .enroll
            .as_mut()
            .ok_or("no enroll in progress — call enroll_start first")?;
        let payload = format!("{}\n", code.trim());
        child.write(payload.as_bytes()).map_err(|e| e.to_string())?;
        g.enroll_phase = EnrollPhase::Submitting;
    }
    let _ = app.emit("enroll-progress", EnrollPhase::Submitting);

    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let state = app.state::<AppState>();
        let phase = state.inner.lock().expect("state").enroll_phase.clone();
        match &phase {
            EnrollPhase::Succeeded { .. } | EnrollPhase::WrongCode => return Ok(phase),
            EnrollPhase::Failed { message } => return Err(message.clone()),
            EnrollPhase::AwaitingCode => return Ok(phase),
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err("timed out waiting for enroll result".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Quit-only teardown: stdin-close every tap, then kill connect, then the
/// caller invokes `app.exit(0)`.
pub async fn shutdown_all(app: &AppHandle) -> Result<(), String> {
    let ids: Vec<String> = {
        let state = app.state::<AppState>();
        let g = state.inner.lock().expect("state");
        g.taps.keys().cloned().collect()
    };
    for id in ids {
        let state = app.state::<AppState>();
        let mut g = state.inner.lock().expect("state");
        if let Some(mut proc) = g.taps.remove(&id) {
            drop(g);
            let _ = close_stdin_and_wait(&mut proc, &id, TAP_STOP_TIMEOUT, true);
        }
    }
    stop_connect(app)?;
    Ok(())
}

