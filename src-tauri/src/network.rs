use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

const POLL: Duration = Duration::from_millis(750);

/// Windows Network List Manager `IsConnectedToInternet`, then WinINet.
/// WebView `navigator.onLine` does not flip when the NIC drops, so the UI
/// cannot rely on it.
pub fn is_online() -> bool {
    #[cfg(windows)]
    {
        if let Some(online) = nlm_internet() {
            return online;
        }
        return wininet_online();
    }
    #[cfg(not(windows))]
    {
        true
    }
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        #[cfg(windows)]
        init_com();
        let mut last = None;
        loop {
            let online = is_online();
            if last != Some(online) {
                last = Some(online);
                let _ = app.emit("network-online", online);
                if !online {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.unminimize();
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
            tokio::time::sleep(POLL).await;
        }
    });
}

#[cfg(windows)]
fn init_com() {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

#[cfg(windows)]
fn nlm_internet() -> Option<bool> {
    use windows::Win32::Foundation::VARIANT_TRUE;
    use windows::Win32::Networking::NetworkListManager::{
        INetworkListManager, NetworkListManager,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    unsafe {
        let nlm: INetworkListManager =
            CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL).ok()?;
        let flag = nlm.IsConnectedToInternet().ok()?;
        Some(flag == VARIANT_TRUE)
    }
}

#[cfg(windows)]
fn wininet_online() -> bool {
    #[link(name = "wininet")]
    extern "system" {
        fn InternetGetConnectedState(flags: *mut u32, reserved: u32) -> i32;
    }
    const INTERNET_CONNECTION_OFFLINE: u32 = 0x20;
    let mut flags = 0u32;
    unsafe {
        if InternetGetConnectedState(&mut flags, 0) == 0 {
            return false;
        }
    }
    flags & INTERNET_CONNECTION_OFFLINE == 0
}
