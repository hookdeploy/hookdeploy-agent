# HookDeploy Agent (tray) — security and quality audit

**Repo:** `hookdeploy-tray`  
**Date:** 2026-08-30  
**Method:** read-only pass against current source. Earlier scaffold/audit docs were not treated as truth.

---

## Priority list

### Fix before shipping (real issues)

1. **`connect-log` emits raw sidecar stdout/stderr onto the Tauri event bus** (`supervisor.rs` 338, 369). The webview does not subscribe today, but any future listener (or a compromised webview that can `listen`) gets unfiltered CLI lines. Enroll failure also dumps the entire enroll buffer into `EnrollPhase::Failed.message` and then the UI (`supervisor.rs` 673–679). CLI lines can include cert-store paths and `CN=` / `OU=` (`parse.rs` 507–516). Not a renewal token, but it is more than “display status.”
2. **CSP is explicitly disabled** (`tauri.conf.json` 28–29: `"csp": null`) while the UI loads **remote Google Fonts** (`styles.css` 1). Combined with `opener:default`, a webview XSS (or a malicious injected script in `tauri dev`) can open arbitrary URLs. Production still has no CSP net.
3. **`stop_tap` force-kill after 8s reports success and skips the server stop** (`supervisor.rs` 507–525, 546–549). If stdin-close does not finish the CLI’s stop POST in time, the local child is killed, `Ok(())` is returned, and `tap stop` is never called. The dashboard can still show a live tap until the 8h server ceiling.

### UX / defense-in-depth (fine to defer, but do not forget)

4. **No client-side port blocklist.** Server policy (`BLOCKED_TARGET_PORTS`: 22, 23, 25, 135, 139, 445, 3389, 5432, 6379, 11211, 27017) is not mirrored. The picker already drops ports `< 1024` (`ports.rs` 93), so 22/23/25/135/139/445 never appear — but **3389, 5432, 6379, 11211, 27017 can**. Recommendation: filter those in the picker **and** reject them in `create_tap` before spawn. Rejection today is whatever `hookdeployed` prints (`wrapAPIError` → API `message`), shown via `showError` — usually readable if the worker sends the blocked-port copy, otherwise a generic string.
5. **IPC commands trust the webview** for org id, tap id, endpoint/destination ids, rename text, enroll code, and tap path. Port is typed `u16` (good). Path/name have no length or charset checks on the Rust side. Safe against shell injection (argv is separate); not a second validation layer.
6. **`HOOKDEPLOY_CERT_DIR` overrides the cert store** (`supervisor.rs` 135–139). The webview cannot set it, but any process env (installer, shortcut, parent shell) can point the sidecar at another directory. Acceptable if documented; do not expose a Tauri command for it.
7. **`@tauri-apps/plugin-shell` is a frontend npm dependency** (`package.json` 16) even though the webview never imports it and capabilities grant no `shell:*`. Dead weight; remove later so it cannot be wired by accident.

### Already fine (no action for v1)

8. **No shell-string command construction.** Every sidecar spawn uses a `Vec` / `&[&str]` of argv passed to `.args(...)`. User text is one argv element, not concatenated into a shell line.
9. **No `shell:*` in capabilities.** Sidecar spawn is Rust-only via `tauri_plugin_shell::init()` + `app.shell().sidecar(...)`.
10. **No renewal token, cert PEM, or private key in `localStorage`, `console.log`, or `connect-status` / `enroll-progress` payloads** (aside from enroll URL, org name, agent CN, and raw CLI lines on `connect-log` — see item 1).
11. **No tray-side sleep/wake double-spawn.** No power/network handler exists. `start_connect` no-ops if a connect child is already held.
12. **Tap/connect orphans after a crash** are bounded: server tap expires (max 8h); connect reconnect is the CLI’s job, not the tray’s. Same “keep running until expiry/disconnect” decision as connect.
13. **Updater / Azure Trusted Signing:** not found. No half-built plugin or signing config to conflict with a later build-out.

---

## Part A — process spawning / command injection

### Headline

**No shell-interpreted command string exists in this repo.** Every spawn builds a `Vec<String>` or `&[&str]` and passes it to `.args(...)`. `sidecar()` always wraps args with `with_certs` (inserts `-certs` + path as two extra argv elements). `StdCommand::from(shell)` for taps keeps that argv list; it does not go through `cmd.exe`.

`CommandExt::creation_flags` / `CREATE_NO_WINDOW`: **not found** in `hookdeploy-tray`. No user input reaches process-creation flags. If the Tauri shell plugin sets `CREATE_NO_WINDOW` internally, that is an integer constant inside the plugin, not this tree.

### Spawn helper

```177:187:src-tauri/src/supervisor.rs
fn sidecar(
    app: &AppHandle,
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> Result<tauri_plugin_shell::process::Command, String> {
    let args = with_certs(args);
    Ok(app
        .shell()
        .sidecar("hookdeployed")
        .map_err(|e| format!("sidecar hookdeployed: {e}"))?
        .args(args))
}
```

```154:175:src-tauri/src/supervisor.rs
pub fn with_certs(args: impl IntoIterator<Item = impl AsRef<str>>) -> Vec<String> {
    // ...
    out.push("-certs".into());
    out.push(dir);
    out.extend(rest.iter().cloned());
    out
}
```

`dir` is `certs_dir()`, not webview input.

### Call sites

| Function | Call | User-supplied argv? | Concatenated string? |
| --- | --- | --- | --- |
| `rename_agent` | `sidecar_output(app, &["rename", "-name", &name])` (210–212) | `name` is its own element after `-name` | No |
| `list_orgs` | `&["list"]` (215–217) | None | No |
| `switch_org` | `&["switch", &id]` then `list` (220–222) | `id` own element | No |
| `unenroll` | `&["unenroll", "-yes"]` (232) | None | No |
| `list_catalog` | `&["tap", "list", "-json"]` then `&["tap", "list"]` (247, 258) | None | No |
| `tap_list_json_direct` | `StdCommand::new(sidecar).args(with_certs(["tap", "list", "-json"]))` (270–272) | None. Sidecar path is `current_exe().parent()` + `hookdeployed.exe` (262–269), not user text | No |
| `start_connect` | `sidecar(app, args)` where `args` is `["connect"]` or `["connect", "-region", r]` (284–298) | Optional `region` own element | No |
| `create_tap` | `sidecar(app, &args)` then `StdCommand::from(shell)` (407–428). Args: `tap`, `endpoint_id`, optional dest, `-port`, `port.to_string()`, `-path`, `path`, `-no-tty` | endpoint/dest/path as separate elements; port is `u16` then decimal string | No |
| `stop_tap` | `&["tap", "stop", &tap_id]` (524) | `tap_id` own element | No |
| `enroll_start` | `sidecar(app, ["enroll", "-no-tty"])` (558) | None | No |

No additional spawn sites since that list, except `StdCommand::from(shell)` for the tap child (same argv as `sidecar`).

### Port, path, rename — validation vs argv

**Port (`create_tap`)**  
Rust command takes `port: u16` (`lib.rs` 30). `; malicious` cannot deserialize into `u16`. Frontend does `Number(...)` and `if (!port) return` (`main.ts` 1524–1526). No blocklist. Arbitrary numeric ports 1–65535 (including blocked high ports) are passed as one argv (`port.to_string()` at 416).

**Path**  
Frontend prefixes `/` (`main.ts` 749). Rust prefixes `/` if missing (`supervisor.rs` 402–406). No max length, no rejection of spaces, quotes, newlines, or `;`. Those characters remain **one argv element**. Go’s `flag` parser will receive them as `-path`’s value. That is **not** shell injection. It can still be a weird HTTP path or a huge string.

**Rename**  
Frontend `trim()` only (`main.ts` 1550). Rust `rename_agent` forwards `name` unchanged (`supervisor.rs` 210–212). `;`, quotes, newlines: **one argv** after `-name`. Safe vs shell; no 100-char cap on this side (server is supposed to enforce that).

**Endpoint / destination ids**  
Passed as their own argv. CLI (`hookdeployed` `Start`) rejects non-UUIDs. Tray does not.

---

## Part B — credential and secret handling

### `certs_dir` / `HOOKDEPLOY_CERT_DIR`

```134:149:src-tauri/src/supervisor.rs
pub fn certs_dir() -> PathBuf {
    if let Ok(env) = std::env::var("HOOKDEPLOY_CERT_DIR") {
        let trimmed = env.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let config = std::env::var_os("APPDATA")
        // ...
    match config {
        Some(base) => base.join("hookdeploy").join("certs"),
        None => PathBuf::from("certs"),
    }
}
```

Reads: **only** `certs_dir()` (134–149) and tests (767–775).  
Sets: **not found.** No Tauri command writes this env. The webview cannot override the path.

Default on this machine is `%APPDATA%\hookdeploy\certs` (absolute; test asserts that). Fallback `certs` (relative to cwd) if `APPDATA` / `XDG_CONFIG_HOME` / `HOME` are all missing — not webview-controlled.

`HOOKDEPLOY_CERT_DIR` is process-environment, same as the CLI. An attacker who can set the tray’s environment is already outside the webview.

### `app.emit` (complete)

| Site | Event | Payload |
| --- | --- | --- |
| `supervisor.rs` 126 | `connect-status` | `ConnectStatus` { phase, region, relay, detail } |
| `supervisor.rs` 338 | `connect-log` | **raw CLI line** |
| `supervisor.rs` 369 | `connect-log` | `error: {err}` |
| `supervisor.rs` 574, 643, 684, 696, 715 | `enroll-progress` | `EnrollPhase` (url, org, or failure `message`) |

Frontend listens only to `connect-status` and `enroll-progress` (`main.ts` 1592–1593). **`connect-log`: no frontend listener found.** Still emitted.

`ConnectStatus.detail` can be a full CLI line (revoked / draining / heartbeat / `renewed leaf`) (`parse.rs` 53–87). Those lines are status copy, not PEMs.

`EnrollPhase::BrowserOpened { url }` is the public device-auth URL (expected).  
`Failed { message }` can be the **entire enroll stdout/stderr buffer** (`supervisor.rs` 673–676).

### `console.log` / `eprintln!` / `println!`

**not found** in `src/` or `src-tauri/src/`.

### `localStorage.setItem` (complete)

| Key | Written | Contents |
| --- | --- | --- |
| `hookdeploy.agentName` (`NAME_KEY`, `main.ts` 85, 1555) | Settings “Save name” | Display name string only |
| `hookdeploy.savedTaps` (`SAVED_KEY`, 86, 248) | After start/favorite/forget | Per-org array of `{ id, endpointId, endpointName, destId, destName, port, path, favorite? }` |

**No token, cert, or key.** Saved taps store catalog ids/names and local port/path shortcuts.

`localStorage.getItem` is only those two keys (162, 174, 238, 246).

### Sidecar stdout/stderr vs frontend

- **Connect:** every non-empty stdout/stderr line is `emit("connect-log", &line)` unfiltered (`supervisor.rs` 333–338). Parsed subset becomes `connect-status`.
- **Tap create:** lines stay in an in-process channel; on failure they become the invoke `Err` string (`wait_for_tapping` 478–496) and `showError` (`main.ts` 794–796).
- **Enroll:** buffer is parsed; on failure the **whole buffer** can become the UI error.

**What `hookdeployed` actually prints (cross-check):**

- Connect: `assigned region=`, `connected relay=`, heartbeat / disconnect, revoke/drain sentences, `renewed leaf` (`parse.rs` 42–88).  
- Enroll confirm: `stored cert in <path> org=… CN=… OU=…` — **path + agent id + org id, not the renewal token.** Tray parses `CN=` into `agent_id` (`parse.rs` 507–516, `supervisor.rs` 344–345, 638–639).  
- Tap: `Tapping …`, `Expires …`, `Stopped tap <id>.`, API `message` via `wrapAPIError` (`hookdeployed/internal/tap/tap.go` 128–141, 337; `format.go` created/expires copy).  
- Token is loaded in-process (`loadToken`) and **not** written to stdout in these paths.

Renewal token / client.key / cert PEM: **not found** on tray emit/log/localStorage paths. Closest leaks: cert **directory path**, agent **CN**, enroll **session URL**, and raw CLI lines on `connect-log`.

---

## Part C — Tauri capabilities and IPC

### Capabilities (full file)

`src-tauri/capabilities/default.json` is the only capabilities file:

```1:10:src-tauri/capabilities/default.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Main window: invoke custom commands only. No shell:* — sidecar spawn is Rust-owned.",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default"
  ]
}
```

**`shell:*` is absent.** Rust still calls `tauri_plugin_shell::init()` (`lib.rs` 94) so **Rust** can `app.shell().sidecar("hookdeployed")`. The webview cannot spawn.

`opener:default` is granted. Frontend uses it only for enroll URLs (`main.ts` 3, 1585–1588).

Frontend **does not import** `@tauri-apps/plugin-shell` (`src/`: not found). The npm package is unused.

### `#[tauri::command]` list and validation

All registered in `lib.rs` 97–112.

| Command | Input validation on Rust side | Trusts frontend? |
| --- | --- | --- |
| `get_snapshot` | none | N/A (read) |
| `start_connect` | `region` trimmed; empty dropped (`supervisor.rs` 286–288) | Yes; no region allow-list |
| `stop_connect` | none | N/A |
| `create_tap` | `port: u16` (type); path leading `/` only. `no_tty` ignored (`lib.rs` 32–35). No UUID / path length / blocklist | **Yes**, except port type |
| `stop_tap` | none | Yes (`tap_id` any string) |
| `rename_agent` | none | Yes |
| `list_orgs` | none | N/A |
| `switch_org` | none | Yes (`id` any string) |
| `unenroll` | none | N/A |
| `list_endpoints` / `list_taps` | none | N/A |
| `enroll_start` | none | N/A |
| `enroll_submit_code` | `code.trim()` + newline to stdin (`supervisor.rs` 711–712). No charset/length | Yes (HTML `maxlength="12"` only) |
| `list_ports` | none | N/A |

Privilege boundary is “webview can spawn/stop real `hookdeployed` processes.” Injection into a shell is not the risk; **confused-deputy** (start a tap to a blocked port, rename with garbage, switch to a guessed org id) is.

### CSP and remote loads

```27:29:src-tauri/tauri.conf.json
    "security": {
      "csp": null
    }
```

Tauri 2: if `csp` is unset/null, **no Content-Security-Policy is injected**.

**Not “local bundled content only”:**

- `src/styles.css` line 1: `@import url("https://fonts.googleapis.com/css2?family=Inter:…&family=JetBrains+Mono:…")` — remote CSS and fonts (`fonts.gstatic.com`).
- `index.html` scripts/styles: `/src/styles.css`, `/src/main.ts`, `/src/assets/icon.png` — local.
- Dev: `devUrl` `http://localhost:1420` (`tauri.conf.json` 8) — Vite, HMR. Acceptable for `tauri dev` only.
- No analytics package found. No remote `<script src=…>` in `index.html`.

Default/implicit policy with `csp: null`: **none**. For a signed production app that still pulls Google Fonts, that is weaker than typical Tauri guidance (self-host fonts + a CSP that allows only `tauri:` / `asset:` / self). Not an injection bug by itself; it removes a safety net.

---

## Part D — tap port/path vs server blocklist

Server policy (`shared/target-port.ts` in the platform tree): blocked 22, 23, 25, 135, 139, 445, 3389, 5432, 6379, 11211, 27017. Comment there: *“The agent honors whatever port it is given and does not import this list.”* Confirmed for `hookdeployed` `Start` (`tap.go` 293–315): port required, path must start with `/`, UUIDs — **no blocklist**.

Tray:

- `create_tap`: **no blocklist** (`supervisor.rs` 395–420).
- Port picker: loopback + `port >= 1024` + process denylist (`ports.rs` 16–61, 92–94).  
  - Privileged/system ports in the server list that are `< 1024` never appear.  
  - **RDP 3389, Postgres 5432, Redis 6379, Memcached 11211, Mongo 27017 can appear** if something listens on loopback (process denylist does not include `postgres`, `redis-server`, `mongod`, `memcached`, `TermService`).
- Manual port field: any `Number > 0` (`main.ts` 1524–1526).

**When create is rejected:** CLI prints `APIError.Message` (`tap.go` 136–137). Tray `wait_for_tapping` concatenates non-Tapping lines into the invoke error (`supervisor.rs` 478–503). UI: `showError(invokeError(e))` (`main.ts` 794–796) — red banner, same as any other failure. If the worker sends `Port 3389 is used by RDP and can't receive webhooks.`, the user sees that. If they get `invalid` / a generic 400, it looks like a generic failure.

**Recommendation:** filter the picker and reject in `create_tap` with the same list/messages. Do not rely on “create then fail.” Cheap, matches server policy, avoids a live child + error toast. Server remains the real enforcement.

---

## Part E — process lifecycle

### 13. Tray crash (not Quit)

Taps are `std::process::Child` with piped stdin (`supervisor.rs` 42–45, 422–428), not the shell plugin’s `CommandChild`. **No Windows Job Object** found. If the tray process dies, Windows does **not** automatically kill those children. The tap process keeps running (and the CLI stays in its `-no-tty` wait) until:

- someone closes its stdin / SIGTERM (won’t happen if the parent is gone), or
- the **server tap expires** (create copy: “server default, max 8h” — `hookdeployed` `format.go` / `-duration` help), or
- connect dies and deliveries stop (tap row may still exist server-side until expiry).

Same class of orphan as `connect` after a crash: leftover child, **8h server ceiling is the safety net**. Acceptable if that was the connect decision; not a new unbounded hole. Document it. Job objects would be a later hardening, not a v1 blocker.

### 14. Sleep / resume / NIC change

**not found:** no `WM_POWERBROADCAST`, resume, or interface listener in the tray.

Reconnect is **entirely the CLI** (`start_connect` starts one child; `watch_connect` on that child).  

Double-spawn: `start_connect` returns `Ok(())` if `connect.is_some()` (291–295, 303–306). The UI “Connected” action calls the same command. Nothing on resume calls it automatically. **No tray-side double-spawn on wake.**

### 15. `stop_tap` timeout

```21:23:src-tauri/src/supervisor.rs
pub const TAP_STOP_TIMEOUT: Duration = Duration::from_secs(8);
```

`close_stdin_and_wait(..., TAP_STOP_TIMEOUT, true)` (515–516): drop stdin, poll `try_wait` for 8s. On timeout with `kill_after_timeout: true`: `child.kill()` + `wait()`, **`return Ok(())`** (546–549). That `Ok` makes `stop_tap` **return success and skip** `tap stop` (520–522).

User-visible: stop looks successful. Server tap may still be live. No copy that says “force-killed; check the dashboard.”

If there was **no** local child (already gone), it does call `tap stop` (524). That path is fine.

**Assessment:** 8s + kill is reasonable so Quit cannot hang. Returning `Ok` without a server stop after kill is the bug. Either always `tap stop` after a local kill, or surface a warning. Not an injection issue; it *is* a “I clicked Stop and traffic still flows” issue.

Quit (`shutdown_all`, 736–751) uses the same 8s+kill and then `stop_connect`. Same local-kill-without-API-stop risk for each tap.

---

## Part F — updater / signing

Searched `hookdeploy-tray` for `updater`, `tauri-plugin-updater`, `trusted signing`, `signtool`, Azure signing: **not found** in app source, `Cargo.toml`, `tauri.conf.json`, or `package.json`.

`Cargo.toml` plugins: `tauri` (tray-icon, image-png), `tauri-plugin-opener`, `tauri-plugin-shell` only.

Nothing half-implemented that would fight a later updater or Azure Trusted Signing pass.

---

## Appendix — frontend remote / storage map

**`localStorage` today**

- `hookdeploy.agentName` — optional display name  
- `hookdeploy.savedTaps` — `{ [orgId]: SavedTap[] }` shortcuts (ids, names, port, path, favorite)

**Remote network from UI**

- Google Fonts CSS/fonts (`styles.css` 1)  
- Enroll / ingest URLs opened or displayed (user/CLI, not baked analytics)  
- Sidecar → enroll.hookdeploy.dev (not the webview)

**IPC events the UI handles**

- `connect-status`  
- `enroll-progress`  
- not `connect-log`
