//! Parsers for `hookdeployed` human stdout/stderr. Exit codes are only 0/1/2;
//! callers distinguish failure by these known strings, not by the code.

use serde::{Deserialize, Serialize};

pub const AGENT_PREFIX: &str = "agent: ";

pub fn strip_agent_prefix(line: &str) -> &str {
    line.strip_prefix(AGENT_PREFIX).unwrap_or(line).trim()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectPhase {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Revoked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectStatus {
    pub phase: ConnectPhase,
    pub region: Option<String>,
    pub relay: Option<String>,
    pub detail: Option<String>,
}

impl Default for ConnectStatus {
    fn default() -> Self {
        Self {
            phase: ConnectPhase::Disconnected,
            region: None,
            relay: None,
            detail: None,
        }
    }
}

impl ConnectStatus {
    pub fn apply_line(&mut self, raw: &str) {
        let line = strip_agent_prefix(raw);
        if line.is_empty() {
            return;
        }

        const REVOKED_USER: &str =
            "this agent was revoked and can no longer connect";
        const REVOKED_ORG: &str = "this organization's credentials were removed";
        const DRAINING: &str = "this relay is draining";

        if line.contains(REVOKED_USER) || line.contains(REVOKED_ORG) {
            self.phase = ConnectPhase::Revoked;
            self.detail = Some(line.to_string());
            return;
        }
        if line.contains(DRAINING) {
            self.phase = ConnectPhase::Reconnecting;
            self.detail = Some(line.to_string());
            return;
        }
        if let Some(rest) = line.strip_prefix("assigned region=") {
            let region = rest.split_whitespace().next().unwrap_or(rest);
            self.region = Some(region.to_string());
            if self.phase != ConnectPhase::Connected {
                self.phase = ConnectPhase::Connecting;
            }
            return;
        }
        if let Some(rest) = line.strip_prefix("connected relay=") {
            let relay = rest.split_whitespace().next().unwrap_or(rest);
            self.relay = Some(relay.to_string());
            self.phase = ConnectPhase::Connected;
            self.detail = None;
            return;
        }
        if line.contains("heartbeat dropped") || line.contains("disconnected relay=")
        {
            if self.phase != ConnectPhase::Revoked {
                self.phase = ConnectPhase::Reconnecting;
            }
            self.detail = Some(line.to_string());
            return;
        }
        if line.contains("renewed leaf") {
            self.detail = Some(line.to_string());
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrgInfo {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub active: bool,
}

/// `store.FormatList`: `"%s %s  %s  %s\n"` → mark, id, name, slug.
pub fn parse_org_list(stdout: &str) -> Result<Vec<OrgInfo>, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err("no enrolled organizations — run `agent enroll`".into());
    }
    if trimmed.contains("no enrolled organizations") {
        return Err(trimmed.to_string());
    }
    let mut orgs = Vec::new();
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let (active, rest) = if let Some(rest) = line.strip_prefix('*') {
            (true, rest)
        } else if let Some(rest) = line.strip_prefix(' ') {
            (false, rest)
        } else {
            (false, line)
        };
        let rest = rest.trim();
        let parts: Vec<&str> = rest.split("  ").filter(|p| !p.is_empty()).collect();
        if parts.len() < 3 {
            continue;
        }
        orgs.push(OrgInfo {
            id: parts[0].trim().to_string(),
            name: parts[1].trim().to_string(),
            slug: parts[2].trim().to_string(),
            active,
        });
    }
    if orgs.is_empty() {
        return Err("could not parse organization list".into());
    }
    Ok(orgs)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DestinationInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    pub destinations: Vec<DestinationInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TapInfo {
    pub id: String,
    pub endpoint: String,
    pub destination: String,
    pub target: String,
    pub expires: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Catalog {
    pub endpoints: Vec<EndpointInfo>,
    pub taps: Vec<TapInfo>,
}

/// Prefer `tap list -json`; fall back to the human RUNNING TAPS text.
pub fn parse_tap_list(stdout: &str) -> Result<Catalog, String> {
    let trimmed = stdout.trim();
    if trimmed.starts_with('{') {
        return parse_tap_list_json(trimmed);
    }
    let (head, tail) = split_running_taps(stdout)
        .ok_or_else(|| "tap list missing RUNNING TAPS section".to_string())?;
    Ok(Catalog {
        endpoints: parse_endpoints_section(head),
        taps: parse_running_taps_section(tail),
    })
}

#[derive(Debug, Deserialize)]
struct TapListJson {
    #[serde(default)]
    endpoints: Vec<EndpointJson>,
    #[serde(default)]
    taps: Vec<TapJson>,
}

#[derive(Debug, Deserialize)]
struct EndpointJson {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    destinations: Vec<DestJson>,
}

#[derive(Debug, Deserialize)]
struct DestJson {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    destination_type: String,
}

#[derive(Debug, Deserialize)]
struct TapJson {
    id: String,
    #[serde(default)]
    endpoint_id: String,
    #[serde(default)]
    destination_id: Option<String>,
    #[serde(default)]
    target_port: i32,
    #[serde(default)]
    target_path: String,
    #[serde(default)]
    expires_at: String,
}

/// Use the worker's region-aware ingest URL (`/a/`, `/e/`, `/p/`, `/o/`).
/// Do not invent a path from slug — the letter is not always `a`.
fn resolve_endpoint_url(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    Some(url.to_string())
}

fn parse_tap_list_json(raw: &str) -> Result<Catalog, String> {
    let parsed: TapListJson =
        serde_json::from_str(raw).map_err(|e| format!("tap list -json: {e}"))?;
    let endpoints: Vec<EndpointInfo> = parsed
        .endpoints
        .iter()
        .map(|ep| {
            let name = if !ep.name.trim().is_empty() {
                ep.name.clone()
            } else if !ep.slug.trim().is_empty() {
                ep.slug.clone()
            } else {
                ep.id.clone()
            };
            let slug = ep.slug.trim();
            EndpointInfo {
                id: ep.id.clone(),
                name,
                slug: if slug.is_empty() {
                    None
                } else {
                    Some(slug.to_string())
                },
                url: resolve_endpoint_url(&ep.url),
                destinations: ep
                    .destinations
                    .iter()
                    .map(|d| DestinationInfo {
                        id: d.id.clone(),
                        name: if d.name.trim().is_empty() {
                            d.id.clone()
                        } else {
                            d.name.clone()
                        },
                        kind: if d.destination_type.trim().is_empty() {
                            "https".into()
                        } else {
                            d.destination_type.clone()
                        },
                    })
                    .collect(),
            }
        })
        .collect();
    let taps = parsed
        .taps
        .into_iter()
        .map(|t| {
            let ep = endpoints.iter().find(|e| e.id == t.endpoint_id);
            let dest_name = t
                .destination_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .and_then(|id| {
                    ep.and_then(|e| {
                        e.destinations
                            .iter()
                            .find(|d| d.id == id)
                            .map(|d| d.name.clone())
                    })
                    .or_else(|| Some(id.to_string()))
                })
                .unwrap_or_else(|| "(endpoint)".into());
            let path = if t.target_path.is_empty() {
                "/"
            } else {
                t.target_path.as_str()
            };
            let expires = t.expires_at.trim();
            TapInfo {
                id: t.id,
                endpoint: ep
                    .map(|e| e.name.clone())
                    .filter(|n| !n.is_empty())
                    .unwrap_or(t.endpoint_id),
                destination: dest_name,
                target: format!("127.0.0.1:{}{}", t.target_port, path),
                expires: if expires.is_empty() {
                    None
                } else {
                    Some(expires.to_string())
                },
            }
        })
        .collect();
    Ok(Catalog { endpoints, taps })
}

fn split_running_taps(stdout: &str) -> Option<(&str, &str)> {
    let idx = stdout.find("RUNNING TAPS")?;
    let (head, rest) = stdout.split_at(idx);
    let tail = rest.strip_prefix("RUNNING TAPS").unwrap_or(rest);
    Some((head, tail))
}

fn parse_endpoints_section(head: &str) -> Vec<EndpointInfo> {
    if head.contains("No endpoints in this organization.") {
        return Vec::new();
    }
    let mut endpoints = Vec::new();
    let mut current: Option<EndpointInfo> = None;
    let mut pending_dest_name: Option<(String, String)> = None;

    for raw in head.lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("    ") {
            if let Some((name, kind)) = pending_dest_name.take() {
                if let Some(ep) = current.as_mut() {
                    ep.destinations.push(DestinationInfo {
                        id: rest.trim().to_string(),
                        name,
                        kind,
                    });
                }
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("  ") {
            let rest = rest.trim();
            if rest == "(no destinations)" {
                pending_dest_name = None;
                continue;
            }
            if rest.starts_with('(') {
                continue;
            }
            if let Some((name, kind)) = dest_name_and_kind(rest) {
                pending_dest_name = Some((name, kind));
                continue;
            }
            if let Some(ep) = current.as_mut() {
                if ep.id.is_empty() {
                    ep.id = rest.to_string();
                    continue;
                }
            }
            continue;
        }
        if let Some(ep) = current.take() {
            endpoints.push(ep);
        }
        pending_dest_name = None;
        current = Some(EndpointInfo {
            id: String::new(),
            name: line.trim().to_string(),
            slug: None,
            url: None,
            destinations: Vec::new(),
        });
    }
    if let Some(ep) = current {
        endpoints.push(ep);
    }
    endpoints
}

fn dest_name_and_kind(line: &str) -> Option<(String, String)> {
    if !line.ends_with(')') {
        return None;
    }
    let start = line.rfind(" (")?;
    let kind = line[start + 2..line.len() - 1].to_string();
    let name = line[..start].to_string();
    if name.is_empty() || kind.is_empty() {
        return None;
    }
    Some((name, kind))
}

fn parse_running_taps_section(tail: &str) -> Vec<TapInfo> {
    let mut taps = Vec::new();
    let mut pending_id: Option<String> = None;
    for raw in tail.lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() || line.trim() == "(none)" {
            continue;
        }
        if let Some(rest) = line.strip_prefix("  ") {
            if let Some(id) = pending_id.take() {
                taps.push(parse_tap_detail_line(id, rest.trim()));
            }
            continue;
        }
        if !line.starts_with(' ') {
            pending_id = Some(line.trim().to_string());
        }
    }
    taps
}

fn parse_tap_detail_line(id: String, rest: &str) -> TapInfo {
    // `<endpoint> / <dest>  127.0.0.1:<port><path>  <expires>`
    let mut endpoint = rest.to_string();
    let mut destination = String::new();
    let mut target = String::new();
    let mut expires = None;
    if let Some((names, after)) = rest.split_once("  ") {
        if let Some((ep, dest)) = names.split_once(" / ") {
            endpoint = ep.trim().to_string();
            destination = dest.trim().to_string();
        }
        let after = after.trim();
        if let Some((tgt, exp)) = after.split_once("  ") {
            target = tgt.trim().to_string();
            let exp = exp.trim();
            if !exp.is_empty() {
                expires = Some(exp.to_string());
            }
        } else {
            target = after.to_string();
        }
    }
    TapInfo {
        id,
        endpoint,
        destination,
        target,
        expires,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedTap {
    pub endpoint_id: String,
    pub destination: String,
    pub target: String,
}

/// `Tapping <endpoint> / <dest|(endpoint)> → 127.0.0.1:port/path`
pub fn parse_tapping_line(line: &str) -> Option<CreatedTap> {
    let line = line.trim();
    let rest = line.strip_prefix("Tapping ")?;
    let (left, target) = rest.split_once(" → ")?;
    let (endpoint_id, destination) = left.split_once(" / ")?;
    Some(CreatedTap {
        endpoint_id: endpoint_id.trim().to_string(),
        destination: destination.trim().to_string(),
        target: target.trim().to_string(),
    })
}

pub fn parse_stopped_tap(line: &str) -> Option<String> {
    let line = line.trim();
    let rest = line.strip_prefix("Stopped tap ")?;
    Some(rest.trim_end_matches('.').trim().to_string())
}

pub fn parse_enrollment_url_block(text: &str) -> Option<String> {
    let mut take_next = false;
    for line in text.lines() {
        if take_next {
            let url = line.trim();
            if url.starts_with("http://") || url.starts_with("https://") {
                return Some(url.to_string());
            }
        }
        if line.contains("Open this URL to enroll this agent:") {
            take_next = true;
        }
    }
    None
}

pub fn parse_agent_cn(line: &str) -> Option<String> {
    let line = strip_agent_prefix(line);
    let idx = line.find("CN=")?;
    let rest = &line[idx + 3..];
    let cn = rest.split_whitespace().next()?.trim();
    if cn.is_empty() {
        return None;
    }
    Some(cn.to_string())
}

pub fn parse_enrolled_org(line: &str) -> Option<String> {
    let line = strip_agent_prefix(line);
    // Prompt has no newline, so success is glued:
    // "Enter the code from the browser: enrolled in Acme"
    let rest = line.find("enrolled in ").map(|i| &line[i + "enrolled in ".len()..])?;
    let org = rest.trim();
    if org.is_empty() {
        return None;
    }
    Some(org.to_string())
}

pub fn is_enrolled_plain(text: &str) -> bool {
    let text = strip_agent_prefix(text);
    text.trim() == "enrolled"
        || text.contains(" enrolled\n")
        || text.ends_with(" enrolled")
        || text.contains(": enrolled")
}

pub fn is_wrong_code(line: &str) -> bool {
    strip_agent_prefix(line).contains("wrong code")
}

pub fn is_code_prompt(line: &str) -> bool {
    strip_agent_prefix(line).contains("Enter the code from the browser:")
}

const ENROLL_FAIL_GENERIC: &str = "Enrollment failed. Check your connection and try again.";
const ENROLL_FAIL_MAX: usize = 160;

fn enroll_line_looks_leaky(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("stored cert")
        || lower.contains("cn=")
        || lower.contains("ou=")
        || lower.contains("token")
        || lower.contains("-----")
        || lower.contains("begin ")
        || lower.contains("client.key")
        || lower.contains("renewal")
        || line.contains(":\\")
        || lower.contains("/home/")
        || lower.contains("/users/")
        || lower.contains("/appdata/")
}

/// Last allowlisted enroll-failure line, or a fixed generic message.
/// Never returns the raw stdout/stderr buffer.
pub fn summarize_enroll_failure(buf: &str, _exit_code: i32) -> String {
    for raw in buf.lines().rev() {
        let line = strip_agent_prefix(raw);
        if line.is_empty() || is_code_prompt(line) || enroll_line_looks_leaky(line) {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        let allowlisted = lower.contains("wrong code")
            || lower.contains("timed out")
            || lower.contains("timeout")
            || lower.contains("connection refused")
            || lower.contains("failed to connect")
            || lower.contains("could not")
            || lower.contains("unable to")
            || lower.contains("unreachable")
            || lower.contains("unauthorized")
            || lower.contains("forbidden")
            || lower.contains("not enrolled")
            || lower.contains("invalid")
            || lower.starts_with("error:");
        if !allowlisted {
            continue;
        }
        if line.len() <= ENROLL_FAIL_MAX {
            return line.to_string();
        }
        let mut truncated: String = line.chars().take(ENROLL_FAIL_MAX).collect();
        truncated.push('…');
        return truncated;
    }
    ENROLL_FAIL_GENERIC.to_string()
}

/// Match a just-created tap in `tap list` by endpoint id or name + target.
pub fn resolve_created_tap_id(catalog: &Catalog, created: &CreatedTap) -> Option<String> {
    catalog
        .taps
        .iter()
        .find(|t| {
            t.target == created.target
                && (t.endpoint == created.endpoint_id
                    || catalog.endpoints.iter().any(|ep| {
                        ep.id == created.endpoint_id && ep.name == t.endpoint
                    }))
        })
        .map(|t| t.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn org_list_star_and_fields() {
        let out = "* org-1  Acme Corp  acme\n  org-2  Other  other\n";
        let orgs = parse_org_list(out).unwrap();
        assert!(orgs[0].active);
        assert_eq!(orgs[0].id, "org-1");
        assert_eq!(orgs[0].name, "Acme Corp");
        assert_eq!(orgs[1].id, "org-2");
        assert!(!orgs[1].active);
    }

    #[test]
    fn tap_list_splits_endpoints_and_running() {
        let out = "\
orders
  ep-orders
  prod-https (https)
    dest-https
  prod-agent (agent)
    dest-agent

billing
  ep-billing
  (no destinations)

RUNNING TAPS
tap-live
  orders / prod-https  127.0.0.1:3000/hooks  2026-08-24 18:00 UTC
";
        let cat = parse_tap_list(out).unwrap();
        assert_eq!(cat.endpoints.len(), 2);
        assert_eq!(cat.endpoints[0].id, "ep-orders");
        assert_eq!(cat.endpoints[0].destinations.len(), 2);
        assert_eq!(cat.endpoints[0].destinations[1].kind, "agent");
        assert_eq!(cat.endpoints[1].destinations.len(), 0);
        assert_eq!(cat.taps.len(), 1);
        assert_eq!(cat.taps[0].id, "tap-live");
        assert_eq!(cat.taps[0].target, "127.0.0.1:3000/hooks");
        assert_eq!(cat.endpoints[0].url, None);
    }

    #[test]
    fn tap_list_json_includes_endpoint_url() {
        let out = r#"{
          "endpoints": [
            {
              "id": "ep-orders",
              "slug": "orders",
              "name": "Orders",
              "url": "https://hookdeploy.dev/a/orders",
              "destinations": [
                {"id": "dest-https", "name": "prod-https", "destination_type": "https", "agent_id": null, "url": "https://hooks.example.com/stripe"},
                {"id": "dest-agent", "name": "prod-agent", "destination_type": "agent", "agent_id": "agent-1", "url": null}
              ]
            },
            {
              "id": "ep-billing",
              "slug": "billing",
              "name": "Billing",
              "url": "https://hookdeploy.dev/a/billing",
              "destinations": []
            }
          ],
          "taps": [
            {
              "id": "tap-live",
              "endpoint_id": "ep-orders",
              "destination_id": "dest-https",
              "target_port": 3000,
              "target_path": "/hooks/stripe",
              "expires_at": "2026-08-24T18:00:00.000Z"
            }
          ]
        }"#;
        let cat = parse_tap_list(out).unwrap();
        assert_eq!(cat.endpoints[0].url.as_deref(), Some("https://hookdeploy.dev/a/orders"));
        assert_eq!(cat.endpoints[0].slug.as_deref(), Some("orders"));
        assert_eq!(cat.endpoints[0].destinations[1].kind, "agent");
        assert_eq!(cat.endpoints[1].destinations.len(), 0);
        assert_eq!(cat.taps[0].endpoint, "Orders");
        assert_eq!(cat.taps[0].destination, "prod-https");
        assert_eq!(cat.taps[0].target, "127.0.0.1:3000/hooks/stripe");
    }

    #[test]
    fn tap_list_json_omits_url_when_worker_did_not_send_one() {
        let cat = parse_tap_list(
            r#"{"endpoints":[{"id":"ep-1","slug":"orders","name":"Orders","url":"","destinations":[]}],"taps":[]}"#,
        )
        .unwrap();
        assert_eq!(cat.endpoints[0].url, None);
    }

    #[test]
    fn tap_list_json_keeps_region_path_from_worker() {
        let cat = parse_tap_list(
            r#"{"endpoints":[{"id":"ep-1","slug":"orders","name":"Orders","url":"https://hookdeploy.dev/e/orders","destinations":[]}],"taps":[]}"#,
        )
        .unwrap();
        assert_eq!(
            cat.endpoints[0].url.as_deref(),
            Some("https://hookdeploy.dev/e/orders")
        );
    }

    #[test]
    fn tap_list_json_empty() {
        let cat = parse_tap_list(r#"{"endpoints":[],"taps":[]}"#).unwrap();
        assert!(cat.endpoints.is_empty());
        assert!(cat.taps.is_empty());
    }

    #[test]
    fn tapping_line_has_no_tap_id() {
        let got = parse_tapping_line(
            "Tapping ep-orders / dest-https → 127.0.0.1:3000/hooks",
        )
        .unwrap();
        assert_eq!(got.endpoint_id, "ep-orders");
        assert_eq!(got.target, "127.0.0.1:3000/hooks");
        assert!(parse_stopped_tap("Stopped tap tap-1.").unwrap() == "tap-1");
    }

    #[test]
    fn connect_status_does_not_treat_disconnect_as_death() {
        let mut s = ConnectStatus::default();
        s.apply_line("agent: assigned region=us-east hostname=relay-us-east-01");
        s.apply_line("agent: connected relay=relay-us-east-01.hookdeploy.dev remote=1.2.3.4:9443");
        assert_eq!(s.phase, ConnectPhase::Connected);
        s.apply_line("agent: heartbeat dropped relay=relay-us-east-01.hookdeploy.dev");
        assert_eq!(s.phase, ConnectPhase::Reconnecting);
        s.apply_line("agent: disconnected relay=relay-us-east-01.hookdeploy.dev; reconnecting");
        assert_eq!(s.phase, ConnectPhase::Reconnecting);
        s.apply_line("agent: connected relay=relay-us-east-01.hookdeploy.dev remote=1.2.3.4:9443");
        assert_eq!(s.phase, ConnectPhase::Connected);
    }

    #[test]
    fn enroll_helpers() {
        let block = "Open this URL to enroll this agent:\n  https://app.hookdeploy.dev/app/cli-auth/s1\n";
        assert_eq!(
            parse_enrollment_url_block(block).unwrap(),
            "https://app.hookdeploy.dev/app/cli-auth/s1"
        );
        assert!(is_code_prompt("Enter the code from the browser: "));
        assert!(is_wrong_code("wrong code — try again"));
        assert_eq!(parse_enrolled_org("enrolled in Acme Corp").unwrap(), "Acme Corp");
        assert_eq!(
            parse_enrolled_org("Enter the code from the browser: enrolled in HOOKDEPLOY").unwrap(),
            "HOOKDEPLOY"
        );
        assert!(is_enrolled_plain("Enter the code from the browser: enrolled"));
        assert_eq!(
            parse_agent_cn("agent: stored cert in C:\\x org=Acme CN=agent-1 OU=org-1").unwrap(),
            "agent-1"
        );
    }

    #[test]
    fn enroll_failure_drops_raw_buffer_and_leaks() {
        assert_eq!(
            summarize_enroll_failure(
                "agent: stored cert in C:\\x org=Acme CN=agent-1 OU=org-1\nEnter the code from the browser:\n",
                1,
            ),
            ENROLL_FAIL_GENERIC
        );
        assert_eq!(
            summarize_enroll_failure(
                "agent: stored cert in C:\\x\ncould not reach enroll server\n",
                1,
            ),
            "could not reach enroll server"
        );
        assert_eq!(
            summarize_enroll_failure("wrong code — try again\n", 1),
            "wrong code — try again"
        );
    }
}
