use std::net::IpAddr;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub port: u16,
    pub address: String,
    pub process: String,
    pub pid: u32,
}

/// Process names that commonly bind loopback on a dev machine but are never a
/// webhook target. Compared case-insensitively; a trailing `.exe` is ignored.
/// Tune this after live runs — keep it in one place.
const PROCESS_DENYLIST: &[&str] = &[
    // Windows system / service hosts
    "svchost",
    "system",
    "services",
    "lsass",
    "csrss",
    "wininit",
    "winlogon",
    "smss",
    "dwm",
    "conhost",
    "dllhost",
    "runtimebroker",
    "searchhost",
    "searchindexer",
    "sihost",
    "taskhostw",
    "ctfmon",
    "wmiprvse",
    // Browsers (local helper listeners, not webhook targets)
    "chrome",
    "msedge",
    "msedgewebview2",
    "firefox",
    "opera",
    "brave",
    "chromium",
    "iexplore",
    // Docker / WSL proxies
    "dockerd",
    "com.docker.backend",
    "com.docker.build",
    "vpnkit",
    "docker-proxy",
    "wslrelay",
    "wslhost",
    // Agents
    "ssh-agent",
    "msmpeng",
    "nissrv",
    "securityhealthservice",
    "mssense",
    "csfalconservice",
    "sentinelagent",
    // macOS system / menu-bar noise. Starting set from the macOS port audit
    // (rapportd, ControlCenter, sharingd). PLACEHOLDER: tune after a live
    // `listeners::get_all()` run on a real Mac, same as the Windows list.
    "rapportd",
    "controlcenter",
    "sharingd",
    "wifiagent",
    "mdnsresponder",
    "coreaudiod",
    "identityservicesd",
    "usernotificationcenter",
];

/// Snapshot of TCP LISTEN sockets that look like a local high-port dev server.
/// No timer — call only from the UI open path or the Refresh button.
pub fn list_ports() -> Result<Vec<PortInfo>, String> {
    let found = listeners::get_all().map_err(|e| e.to_string())?;
    let mut out: Vec<PortInfo> = found
        .into_iter()
        .filter(|l| l.protocol == listeners::Protocol::TCP)
        .filter(|l| l.state == listeners::SocketState::Listen)
        .filter_map(|l| {
            let name = l.process.name.trim();
            let process = if name.is_empty() {
                "Unknown".into()
            } else {
                name.to_string()
            };
            keep_dev_listener(l.socket.ip(), l.socket.port(), &process).then(|| PortInfo {
                port: l.socket.port(),
                address: l.socket.to_string(),
                process,
                pid: l.process.pid,
            })
        })
        .collect();
    out.sort_by_key(|p| p.port);
    Ok(out)
}

/// Keep only loopback-bound, high-port listeners that are not a known-noise process.
/// `Unknown` is never dropped for the deny-list (resolution failure ≠ noise).
fn keep_dev_listener(ip: IpAddr, port: u16, process: &str) -> bool {
    is_loopback_only(ip) && port >= 1024 && !is_denied_process(process)
}

/// `127.0.0.0/8` or `::1` (and IPv4-mapped loopback). Not `0.0.0.0` / `::`.
fn is_loopback_only(ip: IpAddr) -> bool {
    if ip.is_loopback() {
        return true;
    }
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
        IpAddr::V4(_) => false,
    }
}

fn is_denied_process(name: &str) -> bool {
    if name.eq_ignore_ascii_case("Unknown") {
        return false;
    }
    let lower = name.trim().to_ascii_lowercase();
    let key = lower.strip_suffix(".exe").unwrap_or(lower.as_str());
    PROCESS_DENYLIST.iter().any(|denied| key == *denied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn loopback_only_excludes_unspecified() {
        assert!(is_loopback_only(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(is_loopback_only(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_loopback_only(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))));
        assert!(!is_loopback_only(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(!is_loopback_only(IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
        assert!(!is_loopback_only(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10))));
        let mapped = Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x7f00, 1);
        assert!(is_loopback_only(IpAddr::V6(mapped)));
    }

    #[test]
    fn keep_requires_high_port_and_allow_unknown() {
        let lo = IpAddr::V4(Ipv4Addr::LOCALHOST);
        assert!(!keep_dev_listener(lo, 80, "node"));
        assert!(!keep_dev_listener(lo, 443, "Unknown"));
        assert!(keep_dev_listener(lo, 3000, "node"));
        assert!(keep_dev_listener(lo, 5173, "Unknown"));
        assert!(!keep_dev_listener(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 3000, "node"));
        assert!(!keep_dev_listener(lo, 3000, "svchost.exe"));
        assert!(!keep_dev_listener(lo, 3000, "Chrome"));
        assert!(!keep_dev_listener(lo, 3000, "com.docker.backend"));
        assert!(!keep_dev_listener(lo, 3000, "MsMpEng.exe"));
    }
}
