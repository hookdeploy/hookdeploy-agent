# HookDeploy tray — scaffold report

**Date:** 2026-08-29  
**Stopped before:** `tauri dev` (as requested). This machine also has **no Rust toolchain** (`rustc` / `rustup` not on PATH), so `tauri dev` could not have been confirmed here anyway.

Nothing was signed or distributed.

---

## PART 0 — enroll TTY / `-no-tty`

### Current TTY check (quoted in full)

`hookdeployed/internal/enroll/run.go` `RequireInteractiveFile`:

```go
func RequireInteractiveFile(f *os.File) error {
	if f == nil {
		return fmt.Errorf("enroll needs a terminal to enter the code (stdin is not a TTY). Use -token for scripted enrollment")
	}
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeCharDevice == 0 {
		return fmt.Errorf("enroll needs a terminal to enter the code (stdin is not a TTY). Use -token for scripted enrollment")
	}
	return nil
}
```

`ReadUserCode` also returns that same string on EOF with an empty line (piped stdin that closes before a code).

**Yes — enroll needed the same opt-in as `tap`.** Device-code enroll is a TTY-checked prompt. The tray will write the browser code on stdin (`CommandChild::write`), which the sidecar plugin supports; it does **not** need stdin-close (that is tap-only).

### hookdeployed PR

Implemented `-no-tty` on the same pattern as tap: skip `RequireInteractiveFile` when the flag is set; interactive enroll unchanged.

- Commit: `ca81d0f` on `feat/enroll-no-tty`
- PR: **https://github.com/hookdeploy/hookdeployed/pull/27**
- Test: `TestRunDeviceNoTTYSkipsInteractiveCheck` (`go test ./internal/enroll/` passed before commit)

Do not skip review there. Not merged.

### Browser open / opener plugin

The CLI already opens the browser (`tryOpenURL` → `rundll32 url.dll,FileProtocolHandler` on Windows) and **always prints the URL**. The tray does **not** open first.

**Still worth `tauri-plugin-opener` as a fallback:** if `Start()` of rundll32 is silent-fail, the UI shows the printed URL as a clickable link (`openUrl`). Primary path remains the CLI.

### Sequence the tray drives

1. User clicks **Login** → spawn `hookdeployed enroll -no-tty` (sidecar plugin `Command::spawn`, so we keep `CommandChild::write`).
2. Watch stdout/stderr for `Open this URL to enroll this agent:` + the next `https://…` line. UI: “Waiting for you to finish in your browser…” (browser should already be opening). Fallback link if it did not.
3. When `Enter the code from the browser:` appears → show the code field.
4. Submit → `CommandChild::write(code + "\n")`.
5. Success: `enrolled in <org>` (or `enrolled`). Failure: `wrong code — try again` (and friends) → stay on the code field; do not tear down the child.

---

## PART 1 — project init

Scaffold command actually used (from `create-tauri-app --help` / [Tauri create-project](https://v2.tauri.app/start/create-project/)):

```text
npm create tauri-app@latest hookdeploy-tray -- --yes --manager npm --template vanilla-ts --identifier com.hookdeploy.tray --tauri-version 2
```

Vanilla TypeScript: agreed. Connection / org / endpoint / port / tap state is a handful of lists. No React/Vue.

Added:

- `tauri-plugin-shell` (Rust + `@tauri-apps/plugin-shell` on the JS side). **Webview capabilities do not include `shell:*`.** JS never calls the plugin. Rust uses `app.shell().sidecar("hookdeployed")`.
- `listeners = "0.6"`
- `tauri-plugin-opener` (already in the template) — fallback URL only
- `tauri` features: `tray-icon`, `image-png`
- `bundle.externalBin`: `["binaries/hookdeployed"]`
- Window: `"label": "main"`, `"visible": false`, `"create": true`, 420×760
- Capabilities (`capabilities/default.json`): `core:default`, `opener:default`. **No `shell:*`.** Window show/hide is Rust-only (tray + close handler), so no extra `core:window:*` / `core:tray:*` on the webview.

### Dev-mode sidecar

| | |
| --- | --- |
| Config name | `binaries/hookdeployed` |
| Rust sidecar id | `"hookdeployed"` |
| **Local Windows filename** | `hookdeploy-tray/src-tauri/binaries/hookdeployed-x86_64-pc-windows-msvc.exe` |
| Sourced from | `C:\hookdeploy\hookdeployed\hookdeployed.exe` (already built), copied and renamed |

`rustc --print host-tuple` was unavailable here; `x86_64-pc-windows-msvc` is the standard Windows MSVC triple. Re-copy after rebuilding the CLI.

---

## PART 2 — process supervision

Module: `src-tauri/src/supervisor.rs`. At most one `connect` child; `HashMap<String, TapProc>` keyed by tap id; one enroll `CommandChild` at a time.

### connect

- `start_connect(region)` → `sidecar("hookdeployed").args(["connect", … optional -region])` → plugin `spawn()`.
- Async loop on `CommandEvent::Stdout` / `Stderr` → `app.emit("connect-log", line)` **and** parse into `ConnectStatus` (`disconnected` / `connecting` / `connected` / `reconnecting` / `revoked`). Frontend binds the header to that struct, not raw strings.
- `heartbeat dropped` / `disconnected relay=` → **Reconnecting**. Never respawn. Only `CommandEvent::Terminated` means the process is gone → `Disconnected` (unless already `Revoked`).

### `stop_connect`

Calls **`CommandChild::kill()`** on the plugin handle (Windows: terminate). Used from:

- tray **Disconnect** (explicit)
- tray **Quit** (after taps)

**Never** from window-close (close is hide only).

Deviation vs the brief’s “Quit path only”: Disconnect is also a kill, because a Disconnect item that did not stop `connect` would be a lie. Window-close still never kills.

### tap create / id

`create_tap` always passes `-no-tty`. Spawn path:

`app.shell().sidecar("hookdeployed")` → `StdCommand::from(Command)` (`From<Command> for StdCommand`) → `std::process::Child` with piped stdin.

**Tap id is not on the create success line.** `FormatCreated` is:

```text
Tapping <endpoint-id> / <dest|(endpoint)> → 127.0.0.1:<port><path>
Expires …
```

No id. First place the id appears for a live tap is **`tap list` → `RUNNING TAPS`** (id on its own line). After the `Tapping` line we run `tap list` and match `127.0.0.1:port/path` plus endpoint. The id on `Stopped tap <id>.` is only available at stop — too late to key the map.

`stop_tap`: `drop(child.stdin.take())`, wait **8 seconds**, require `Stopped tap <id>.` then exit. Timeout error on the Stop button; on **Quit**, same stdin-close then last-resort `Child::kill()` so we do not leak.

### `tap list` split

One stdout blob, two UI lists. Split on the heading `RUNNING TAPS`:

| Section | Parser |
| --- | --- |
| Above | Endpoints: display name / 2-space id / dest `name (kind)` + 4-space dest id |
| Below | Taps: id line, then `name / dest  127.0.0.1:…  expires` |

`list_endpoints` returns the **full `Catalog`** (both halves) so the UI does not spawn `tap list` twice. `list_taps` still exists and returns only the tap vec.

### enroll / one-shots

`list` / `switch <id>` / `unenroll <id> -yes` / `tap list` via sidecar `.output()`. Failures distinguished by stderr/stdout strings, not exit code.

`enroll_start` / `enroll_submit_code` as above.

### ports

`listeners::get_all()` → TCP + `SocketState::Listen` + `ip.is_loopback() || ip.is_unspecified()` (`127.0.0.1`, `::1`, `0.0.0.0`, `::`). Empty process name → **`Unknown`**, row kept. No backend timer.

---

## PART 3 — tray + window

**Four tray PNGs** (minimum for connected / disconnected / reconnecting / revoked):

- `src-tauri/icons/tray-connected.png` (green)
- `src-tauri/icons/tray-disconnected.png` (gray; also used while Connecting)
- `src-tauri/icons/tray-reconnecting.png` (amber)
- `src-tauri/icons/tray-revoked.png` (red)

Menu: disabled status label, disabled org label, **Open HookDeploy**, **Disconnect** (enabled only while connecting/connected/reconnecting), separator, **Quit**.

`show_menu_on_left_click(false)` + left-click Up → `show()` + `set_focus()`.

Window `CloseRequested`: `prevent_default()` + `hide()`. Does not destroy, does not exit, does not touch sidecars.

### Quit sequence (only path that is supposed to end sidecars)

1. Every active tap: stdin EOF, wait 8s, kill if still alive  
2. `stop_connect()` → `CommandChild::kill()`  
3. `app.exit(0)` (Tauri `AppHandle::exit`)

Rust-spawned children are **not** auto-killed by the shell plugin’s `RunEvent::Exit` handler. This sequence is what stops them. JS never spawned them.

---

## PART 4 — frontend

Vanilla TS matching the mockup shape: `#0a0a0a` / `#f97316` / `#22c55e`, Archivo + JetBrains Mono, single narrow column.

- Status header: dot + phase + region/relay  
- Org name button → switch list + **Add organization**  
- Enroll panel when `list` fails / is empty, or via Add organization  
- This agent / endpoints / port snapshot + Refresh / Start tap / active taps + Stop  

### How the UI knows “this agent”

**`list` (`FormatList`) does not print an agent id** — only `* id  name  slug`.  
**`tap list` dest lines are `name (type)` + dest uuid** — no bound `agent_id` (the JSON field exists on the server object but is not formatted).

Agent id is taken from the enroll confirm line `stored cert … CN=<id>` when that appears on the enroll process. Until then the UI shows “agent id unknown”.

**This-agent section lists every destination whose kind is `agent`.** We cannot match “pointing at *this* box” from CLI text alone. Reported as a CLI gap, not hidden.

---

## Confirmed working

| Check | Result |
| --- | --- |
| `tauri dev` tray icon | **Not run** (stop requested + no `rustc`) |
| Left-click opens / X hides | **Not run** — implemented; unverified |
| `list_ports()` real data | **Not run** — implemented against `listeners` 0.6; unverified on this machine |

Install Rust (`rustup`) before the joint `tauri dev` pass.

---

## Deviations

1. **`stop_connect` also from Disconnect**, not only Quit. Window-close still never calls it.  
2. **`list_endpoints` returns `{ endpoints, taps }`** so one `tap list` feeds both UI lists.  
3. **Auto-`start_connect` after a successful `list`** (and after enroll). The header is useless if connect never starts.  
4. **This-agent = all `(agent)` dests**, not dest.agent_id == self — CLI text has no dest agent id.  
5. **No `icon.icns` generation from scratch** — create-tauri-app already shipped one; left in the icon list.  
6. **Placeholder tray/app icons** (flat colored dots), not product art.  
7. **Vanilla TS** as specified (no disagreement).  
8. **Did not run `tauri dev`.**  
9. **`hookdeploy-tray` is not a git repo yet** (create-tauri-app did not leave one). Full tray source is the tree below, not a commit range.

---

## File inventory (`hookdeploy-tray`)

Authored / replaced:

```
docs/scaffold-report.md
index.html
src/main.ts
src/styles.css
package.json
README.md
src-tauri/Cargo.toml
src-tauri/tauri.conf.json
src-tauri/capabilities/default.json
src-tauri/.gitignore
src-tauri/binaries/README.md
src-tauri/src/lib.rs
src-tauri/src/main.rs          (template)
src-tauri/src/parse.rs
src-tauri/src/ports.rs
src-tauri/src/supervisor.rs
src-tauri/src/tray.rs
src-tauri/icons/tray-*.png
```

Local-only (gitignored): `src-tauri/binaries/hookdeployed-x86_64-pc-windows-msvc.exe`
