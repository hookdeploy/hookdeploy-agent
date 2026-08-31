# HookDeploy Agent (tray) — macOS port audit

**Repo reviewed:** `hookdeploy-tray` (Windows-proven source of truth)  
**CLI cross-check:** `hookdeployed` (`store.DefaultDir()`, `tap -no-tty` stdin-EOF)  
**Date:** 2026-08-30  
**Mode:** research + existing-code review. **No code.**

**Docs vintage:** Apple Developer documentation and Tauri 2.x as published on this date.

| Source | URL |
| --- | --- |
| Apple — certificates overview | https://developer.apple.com/help/account/certificates/certificates-overview/ |
| Apple — Developer ID certificates | https://developer.apple.com/help/account/certificates/create-developer-id-certificates/ |
| Apple — notarizing macOS software | https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution |
| Apple — resolving notarization issues | https://developer.apple.com/documentation/security/resolving-common-notarization-issues |
| Apple — TN3147 (`notarytool`) | https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool |
| Apple — App Store Connect API keys | https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api |
| Apple — placing content in a bundle | https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle |
| Apple — App Sandbox | https://developer.apple.com/documentation/security/app-sandbox |
| Apple — TN2206 (archive, nested signing) | https://developer.apple.com/library/archive/technotes/tn2206/_index.html |
| Tauri — macOS code signing | https://v2.tauri.app/distribute/sign/macos/ |
| Tauri — macOS application bundle | https://v2.tauri.app/distribute/macos-application-bundle/ |
| Tauri — sidecar | https://v2.tauri.app/develop/sidecar/ |
| Tauri — system tray | https://v2.tauri.app/learn/system-tray/ |
| Tauri — `TrayIconBuilder` (docs.rs 2.11.5) | https://docs.rs/tauri/2.11.5/tauri/tray/struct.TrayIconBuilder.html |
| Tauri — config `MacConfig` | https://v2.tauri.app/reference/config/#macconfig |
| Tauri — updater | https://v2.tauri.app/plugin/updater/ |
| Tauri — GitHub / `tauri-action` | https://v2.tauri.app/distribute/pipelines/github/ |
| Go — `os.UserConfigDir` (darwin) | https://pkg.go.dev/os?GOOS=darwin |

This audit does **not** re-derive the Windows tray’s argv spawn discipline, stdin-close tap-stop, CSP, self-hosted fonts, or frontend. Those are the reuse baseline. Earlier Windows console / `CREATE_NO_WINDOW` findings are cited from `hookdeployed/docs/tauri-foundation-audit.md` (Tauri shell-plugin source), not re-proven here.

---

## Distribution model (do not assume Windows-direct is automatically right)

**Direct distribution (Developer ID + notarization, `/mac/latest`) is the correct model for this app.** App Store distribution is not easier on macOS for a sidecar agent, and would be a harder product, not a shortcut around signing.

Apple is explicit that App Store submission already includes equivalent security checks, so **App Store apps are not notarized** ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)):

> you aren’t required to notarize software that you distribute through the Mac App Store because the App Store submission process already includes equivalent security checks.

That sounds like “Apple review replaces your pipeline.” The real tradeoff:

| | Direct (`/mac/latest`) | Mac App Store |
| --- | --- | --- |
| Certificate | **Developer ID Application** | **Mac App Distribution** (+ Mac Installer Distribution if you ship a `.pkg`) |
| Gatekeeper path | You sign + notarize + staple | App Store review; no `notarytool` |
| Sandbox | **Not required.** Hardened Runtime **is** required for notarization | **Required.** “To distribute a macOS app through the Mac App Store, you must enable the App Sandbox capability.” ([App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)) |
| Sidecar | Spawn a signed sibling in `Contents/MacOS/` under hardened runtime, no sandbox inherit dance | Helper **must** be sandboxed and signed with **exactly** `com.apple.security.app-sandbox` + `com.apple.security.inherit` ([Enabling App Sandbox](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html)). Extra entitlements on the child abort it. The child can only run when the parent sublaunches it. |
| Network / cert store | Unrestricted (subject to TCC / local-network prompts on recent macOS) | Needs `network.client` / possibly `network.server`, plus file-access entitlements for `~/Library/Application Support/hookdeploy/certs` |
| Updater | `tauri-plugin-updater` + your `/mac/latest` (same pattern as Windows) | **Forbidden to replace the App Store updater.** Tauri’s updater is the wrong mechanism |
| Review | None after notarization | Human review of a local-port webhook agent that enrolls orgs and holds client certs. Category / guideline risk, not a pipeline win |
| What membership already gives you | Ability to **create** a Developer ID Application cert and notarize. Membership alone is not a cert | Ability to submit; still a different cert, sandbox, and review queue |

This app’s job is: stay in the menu bar, spawn `hookdeployed` as a long-running child, keep a private-key cert store, make outbound TLS to the relay, and bind local high ports for taps. That is a Developer ID product. Sandboxing it for the App Store is a redesign of the supervisor, not a cheaper signing path.

**What membership does not give you (must still be created / wired):**

1. A **Developer ID Application** certificate (Account Holder; max five per team).
2. An **App Store Connect Team API key** (Developer role is enough for notarization; **Individual keys cannot use `notaryTool`** — Apple’s words, cited in Part C).
3. A `bundle.macOS` signing/notarization config (or the equivalent env vars) and a `macos-*` CI job that imports a `.p12`.
4. Darwin sidecar binaries with the target-triple suffix.
5. A one-line `certs_dir()` fix so the tray and CLI share a store (Part A4). That is the only supervisor change that is required for correctness, not taste.

Developer ID **Installer** is not needed if the download is a `.dmg` (or a dragged `.app`). It is only for a signed `.pkg`.

---

## Part A — process / tray mechanics

### A1. Visible console on spawn — Windows-only; no macOS equivalent

**There is no macOS equivalent of the Windows “spawned process flashes a console window” problem. No `CREATE_NO_WINDOW`-style flag is needed.**

Unix `fork`/`exec` does not allocate a Terminal.app window. A child becomes visible only if it is a GUI app (`LSUIElement` / `NSApplication`) or if something explicitly opens Terminal. `hookdeployed` is a Go CLI. The tray already pipes stdin/stdout/stderr (`supervisor.rs` `create_tap` 432–435; sidecar plugin `spawn()` for connect/enroll). Piped stdio + no TTY = a background process.

Tauri’s shell plugin applies `CREATE_NO_WINDOW` **only under `#[cfg(windows)]`**. From `tauri-plugin-shell` `Command::new` (cited in `hookdeployed/docs/tauri-foundation-audit.md` against [process/mod.rs](https://docs.rs/tauri-plugin-shell/2.3.5/src/tauri_plugin_shell/process/mod.rs.html)):

```rust
#[cfg(windows)]
command.creation_flags(CREATE_NO_WINDOW);
```

The current sidecar guide ([Embedding External Binaries](https://v2.tauri.app/develop/sidecar/)) documents `spawn()` with piped events. It does not mention a macOS window-hiding flag because there is nothing to hide.

`std::process::Command` (used for taps via `StdCommand::from(shell)`) is the same: on macOS it does not create a window. The `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` line in `main.rs` is a Windows PE subsystem attribute; it is a no-op on Darwin.

**Verdict:** do not add a macOS branch for “hide the console.” If a window ever appears, the child itself opened one (it will not).

### A2. Stop mechanism — keep stdin-close on both platforms

**Recommendation: keep the existing stdin-close path on macOS. Do not switch the tray to SIGTERM/SIGINT on Darwin.**

macOS is POSIX. `kill(pid, SIGTERM)` works. The CLI already listens for it: `runTapStart` / `runConnect` use `signal.NotifyContext(..., os.Interrupt, syscall.SIGTERM)` (`hookdeployed/cmd/agent/main.go`). `tap.StartOpts.NoTTY` documents both stops:

```287:289:hookdeployed/internal/tap/tap.go
	// NoTTY skips the interactive-TTY requirement. The tap stays up
	// until stdin hits EOF or the wait context is cancelled (SIGINT /
	// SIGTERM on platforms that deliver them).
```

`waitUntilStop` is platform-neutral. It is `io.Copy(io.Discard, stdin)` until EOF, raced with `ctx.Done()`. There is no Windows-specific syscall in that function. Stdin-EOF is a Go `io.Reader` event. The `-no-tty` flag and the “Closing stdin stops the tap.” hint were built so a GUI supervisor works **including on Windows**, not *only* on Windows.

A macOS-only SIGTERM path would:

- Split the tray into two stop implementations.
- Still need a timeout + `kill` fallback (same as today).
- Risk missing the server-side `Stopped tap` POST if the signal lands before the CLI’s wait loop is ready — the stdin-close path is the one already tested against that race.

`close_stdin_and_wait` (`supervisor.rs` 545–571) is already `drop(stdin)` + `try_wait`. That is POSIX-correct. `Child::kill()` on Unix is SIGKILL; keep it as last resort only (already the case).

Connect stop today is whatever `stop_connect` does to the shell-plugin `CommandChild` (plugin kill, not stdin). That is fine: `connect` is not in the `-no-tty` stdin-EOF contract. On macOS the plugin can deliver a real signal; that is a free upgrade, not a reason to rewrite tap stop.

**CLI stdin-close is not Windows-specific.** Reuse it.

### A3. Menu bar vs system tray — same Rust API, different conventions

`TrayIconBuilder` is the same cross-platform Rust type ([docs.rs 2.11.5](https://docs.rs/tauri/2.11.5/tauri/tray/struct.TrayIconBuilder.html), [System Tray](https://v2.tauri.app/learn/system-tray/)). The current installer (`tray.rs` 40–69) will compile on macOS unchanged.

It will look and behave like a Windows port unless you configure two macOS-only knobs:

| API | Current tray | macOS convention |
| --- | --- | --- |
| `show_menu_on_left_click` | `false` (left-up opens the window; menu is the other button) | Menu-bar extras are **left-click = menu**. Right-click is not the Windows affordance. Default in Tauri is `true`. Linux: unsupported. |
| `icon_as_template(true)` | not called | **macOS only.** Template image: alpha mask, system tints it for light/dark menu bar. Without this, a color 32×32 PNG looks like a blob. |
| Icon size | `icons/32x32.png` embedded | Menu bar is ~18–22 pt. Ship a template (black + alpha) at 22×22 / 44×44, not the Windows 32×32 color PNG. |
| `tooltip` | set | Works on macOS. Unsupported on Linux. |
| `title` | unused | macOS-only text next to the icon. Do not use unless you have a reason; Apple’s HIG treats it as optional and space-hungry. |

Current click handler (left-up → `show_main`) is a valid extra, but on macOS users expect the menu from a left click. Practical port: `#[cfg(target_os = "macos")]` set `icon_as_template(true)` and `show_menu_on_left_click(true)`, and keep “Open HookDeploy Agent” as the first enabled menu item (already present). Do not delete the Windows left-click-opens-window path.

The official tray guide does not spell out template images; the Rust/JS APIs do (`icon_as_template` / `iconAsTemplate`: “Use the icon as a template. macOS only.”).

### A4. `certs_dir()` — current code does **not** land in the idiomatic macOS path

This is the one supervisor correctness bug the port must fix. The comment is Windows-true and Darwin-false.

Current tray logic (`supervisor.rs` 145–160):

1. `HOOKDEPLOY_CERT_DIR` if non-empty (same as the CLI).
2. `APPDATA`
3. else `XDG_CONFIG_HOME`
4. else `HOME` + `.config`
5. else relative `"certs"`

On a normal Mac, `APPDATA` and `XDG_CONFIG_HOME` are unset. `HOME` is set. **Resolved path today:**

```text
$HOME/.config/hookdeploy/certs
```

example: `/Users/you/.config/hookdeploy/certs`

`hookdeployed` `store.DefaultDir()` is:

```45:54:hookdeployed/internal/store/store.go
func DefaultDir() string {
	if env := os.Getenv("HOOKDEPLOY_CERT_DIR"); env != "" {
		return env
	}
	home, err := os.UserConfigDir()
	if err != nil || home == "" {
		return "certs"
	}
	return filepath.Join(home, "hookdeploy", "certs")
}
```

Go’s `os.UserConfigDir` on Darwin is **`$HOME/Library/Application Support`**, not `$HOME/.config`. Official godoc ([pkg.go.dev/os?GOOS=darwin](https://pkg.go.dev/os?GOOS=darwin)):

> On Darwin, it returns `$HOME/Library/Application Support`.

So the CLI default on macOS is:

```text
~/Library/Application Support/hookdeploy/certs
```

The tray always injects `-certs <certs_dir()>` (`with_certs`). Tray-spawned sidecars would enroll into `~/.config/hookdeploy/certs`. A user who later runs `hookdeployed list` in Terminal would see an empty store in Application Support. That is a split-brain, not a cosmetic mismatch.

**`certs_dir()` does not resolve correctly on macOS without a code change.** Prefer matching the CLI: `dirs`/equivalent of `UserConfigDir` + `hookdeploy/certs`, i.e. Application Support. That is also Apple’s File System Programming Guide location for app-managed data (the same reason Go moved Darwin `UserConfigDir` off `~/Library/Preferences`).

`HOOKDEPLOY_CERT_DIR` stays the override on both sides. No change there.

`tap_list_json_direct` already tries `hookdeployed.exe` then `hookdeployed` next to `current_exe()`. On a bundled Mac app that is `HookDeploy Agent.app/Contents/MacOS/hookdeployed`. That lookup is already Darwin-safe.

---

## Part B — code signing and notarization

### B5. Certificate type for direct distribution

**Developer ID Application.** Still the correct type in Apple’s current account help.

From [Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview/):

| Type | Purpose |
| --- | --- |
| **Developer ID Application** | Sign a Mac app before distributing it **outside** the Mac App Store. |
| **Developer ID Installer** | Sign and distribute a Mac **Installer Package** (`.pkg`), containing your signed app, outside the Mac App Store. |
| **Mac App Distribution** | Sign a Mac app before submitting it to the **Mac App Store**. |
| **Mac Installer Distribution** | Sign the installer package you submit to the Mac App Store. |

[Create Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/): Account Holder (or cloud-managed Developer ID access). Up to five Application and five Installer certs per team.

Tauri’s signing page says the same when creating the cert: choose **Developer ID Application** to ship outside the App Store, **Apple Distribution** to submit to the App Store ([macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)).

Notarization **rejects** a Mac App Distribution (or ad-hoc / Apple Development) signature ([Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)):

> The binary is not signed with a valid Developer ID certificate.

and:

> When code signing items like Mach-O files, disk images, bundles, apps, command line tools … sign with a **Developer ID Application** certificate. Sign installer packages with a **Developer ID Installer** certificate.

For a `.dmg` + `.app` (Tauri’s default), **Application only**. Do not mint an Installer cert unless you later ship a `.pkg`.

Local identity string (what `security find-identity -v -p codesigning` prints) is typically:

```text
Developer ID Application: HookDeploy, Inc. (TEAMID)
```

Set that as `bundle.macOS.signingIdentity` or `APPLE_SIGNING_IDENTITY`. Tauri’s sample CI greps for `"Apple Development"` after import — that is the **wrong** identity for shipping. Grep for `Developer ID Application`.

### B6. Notarization, `notarytool`, hardened runtime, entitlements

**Notarization is required** for Developer ID software on current macOS. Apple ([Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)):

> Beginning in macOS 10.15, all software built after June 1, 2019, and distributed with Developer ID must be notarized.

`altool` for notarization is dead. Same page:

> Starting November 1, 2023, the Apple notary service no longer accepts uploads from `altool` or Xcode 13 or earlier. … transition to the `notarytool` command-line utility or upgrade to Xcode 14 or later.

[TN3147](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool) is the migration note. Submit shape:

```text
xcrun notarytool submit <file> --wait \
  --key PATH_TO.p8 --key-id KEY_ID --issuer ISSUER_UUID
```

or `--apple-id` + `--password` (app-specific password) + `--team-id`.

Tauri invokes this for you when the env vars in B8 are set. You should not hand-roll `notarytool` unless debugging a failed submission.

**Hardened Runtime is mandatory.** Without it, notarization fails with ([Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)):

> The executable does not have the hardened runtime enabled.

Tauri’s `MacConfig.hardenedRuntime` **defaults to `true`** ([config reference](https://v2.tauri.app/reference/config/#macconfig)). Do not turn it off. Enabling it is `--options runtime` on `codesign`.

Also required by the notary service (same two Apple pages): valid Developer ID signature on **every executable**, secure timestamp, no `com.apple.security.get-task-allow`, SDK ≥ 10.9, well-formed XML entitlements.

**Entitlements this app actually needs**

Do **not** cargo-cult Node/Electron JIT entitlements. Those exist because V8/JSC allocate RWX pages under hardened runtime. Community crashes (`allow-jit` missing → sidecar `SIGTRAP` at `v8::Isolate::Initialize`) are about **Node/Bun sidecars**, not a Go CLI.

`hookdeployed` is `CGO_ENABLED=0` Go. It does not JIT. WKWebView runs in Apple’s WebContent process with Apple’s entitlements; Tauri’s official entitlements page ([macOS Application Bundle](https://v2.tauri.app/distribute/macos-application-bundle/)) shows an `Entitlements.plist` example of **App Sandbox**, not `allow-jit`. A standard Developer ID Tauri app with a Go sidecar does not need:

- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.disable-library-validation`
- `com.apple.security.cs.disable-executable-page-protection`

Apple’s own hardened-runtime exception list is for plug-in hosts and JS engines ([Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) — “Add the entitlements needed by plug-ins”). This app does not host plug-ins.

**Spawning a subprocess does not require a hardened-runtime entitlement.** Hardened Runtime restricts memory, library loading, and debugging — not `posix_spawn`. Library validation (on by default) requires the **child** to be signed with the same team; that is the sidecar-signing problem in B7, not an entitlement on the parent.

Start with **no entitlements file** (Tauri default: hardened runtime, empty entitlement set). Add a plist only if a notarized build fails a specific check. If you later add one, do not attach JIT exceptions to the Go sidecar.

App Sandbox (`com.apple.security.app-sandbox`) is for App Store, not this product.

### B7. Headline — sidecar Gatekeeper / nested signing

**Notarizing the outer `.app` does not bless an unsigned helper.** Every Mach-O inside the bundle must be independently signed **before** the outer signature is created. If that is missed, notarization fails in CI, or Gatekeeper refuses the app (or kills the child) on first launch.

Apple [Placing content in a bundle](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle):

> helper tool → `Contents/MacOS/` or `Contents/Helpers/`

> If you put content in the wrong location, you may encounter hard-to-debug code signing and distribution problems. … incorrectly placed code might work during day-to-day development, but might cause problems during notarization.

TN2206 (still the nested-signing rule, even as an archive note):

> when a code signature is created, all nested code must already be signed correctly or the signing attempt will fail.

Tauri places `externalBin` next to the main executable in `Contents/MacOS/` (observed in [tauri#11992](https://github.com/tauri-apps/tauri/issues/11992): `…/Contents/MacOS/test_binary`). That is a legal helper location. The bundler then runs, **inside-out**:

```text
codesign --force -s "Developer ID Application: …" --options runtime \
  HookDeploy Agent.app/Contents/MacOS/hookdeployed
codesign --force -s "…" --options runtime \
  HookDeploy Agent.app/Contents/MacOS/<main>
codesign … HookDeploy Agent.app
```

So: **you do not need to pre-sign the darwin `hookdeployed` binary before dropping it in `src-tauri/binaries/`**, provided the Tauri CLI / `tauri-action` signing env is set. The bundler signs the sidecar as its own Mach-O, then seals the bundle.

You **do** need:

1. A real `hookdeployed-aarch64-apple-darwin` (and `hookdeployed-x86_64-apple-darwin` if you ship Intel) — [sidecar naming](https://v2.tauri.app/develop/sidecar/).
2. Signing identity + notarization credentials so that `codesign --options runtime` actually runs on **both** binaries.
3. After any post-sign mutation of the sidecar, re-sign inside-out. The failure mode in tauri#11992 was “nested code is modified or invalid” on the main binary after the sidecar changed.

**What a user sees if this is missed**

| Stage | What happens | What they see / what you grep |
| --- | --- | --- |
| Notarization | Notary inspects every Mach-O | `"The signature of the binary is invalid."` for `Contents/MacOS/hookdeployed` ([Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)). Or `"The executable does not have the hardened runtime enabled."` if the sidecar was signed without `--options runtime`. |
| First launch (quarantine, unsigned / unnotarized `.app`) | Gatekeeper blocks the bundle | **“HookDeploy Agent” cannot be opened because Apple cannot check it for malicious software.** (or older: **…because the developer cannot be verified.**) |
| First launch (outer signed, nested signature broken / helper treated as data) | Gatekeeper treats the bundle as tampered | **“HookDeploy Agent” is damaged and can’t be opened. You should move it to the Trash.** This is the classic nested-code failure and is easy to misread as a corrupt download. |
| App launches, sidecar spawn blocked | AMFI refuses the unsigned child | Child dies immediately. Console / `log show` : **Code Signature Invalid**, often `syspolicyd` / `AMFI`. Tray shows a sidecar spawn error, not a Gatekeeper sheet — easy to file as “CLI crash.” |

Debug commands Apple documents:

```text
codesign -vvv --deep --strict "/path/HookDeploy Agent.app"
spctl -vvv --assess --type exec "/path/HookDeploy Agent.app"
codesign -dvv "/path/HookDeploy Agent.app/Contents/MacOS/hookdeployed"
```

Look for `in subcomponent:` (TN2206). That line names the helper.

**Do not** put `hookdeployed` under `Contents/Resources/`. Apple seals that as data; Gatekeeper then sees unsigned code in a resource directory.

### B8. Tauri config and `tauri-action` — same “env vars, CLI does the rest” model as Windows

`tauri.conf.json` has **no** `bundle.macOS` section today. Defaults still apply (`hardenedRuntime: true`, `minimumSystemVersion: "10.13"`). For shipping, set:

```json
"bundle": {
  "macOS": {
    "signingIdentity": "Developer ID Application: … (TEAMID)",
    "hardenedRuntime": true,
    "entitlements": null
  }
}
```

`MacConfig` fields that matter ([config](https://v2.tauri.app/reference/config/#macconfig)):

| Field | Role |
| --- | --- |
| `signingIdentity` | Keychain identity. Overridden by `APPLE_SIGNING_IDENTITY`. `"-"` is ad-hoc (Apple Silicon will run it locally; **not** notarizable). |
| `entitlements` | Path to a plist, or omit. |
| `hardenedRuntime` | Default `true`. Leave it. |
| `minimumSystemVersion` | Default `"10.13"`. Raise only if you take a newer API. |
| `providerShortName` | Notarization provider short name; usually unused if Team ID / API key is set. |

Tauri’s CLI, given credentials, runs `codesign` and `notarytool` and staples. From [macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/):

> After setting these environment variables, rerun your Tauri build … `pnpm tauri build --bundles dmg`.

**Signing (local keychain):** identity in config or `APPLE_SIGNING_IDENTITY`.

**Signing (CI):** export the Developer ID cert as `.p12`, then:

- `APPLE_CERTIFICATE` — base64 of the `.p12` (`openssl base64 -A -in cert.p12 -out certificate-base64.txt`)
- `APPLE_CERTIFICATE_PASSWORD` — the export password

Tauri documents those two as what the CLI consumes. The same page also shows an explicit `security create-keychain` / `security import` workflow (Part C) and passing the vars into `tauri-apps/tauri-action`. That is the macOS analogue of “Windows signing via environment variables” — different mechanism (keychain import vs Azure Trusted Signing API), same idea: set secrets once, the action/CLI drives `codesign`.

**Notarization (preferred — API key):**

- `APPLE_API_ISSUER` — issuer UUID above the keys table
- `APPLE_API_KEY` — Key ID column
- `APPLE_API_KEY_PATH` — filesystem path to the downloaded `.p8`

**Notarization (Apple ID fallback):**

- `APPLE_ID`
- `APPLE_PASSWORD` — [app-specific password](https://support.apple.com/en-us/102654), not the account password
- `APPLE_TEAM_ID`

`--skip-stapling` exists for a first notarization debug pass. Production DMGs should be stapled so Gatekeeper works offline.

`tauri-action` does **not** invent Apple credentials. It runs `tauri build` with the env you pass. Same as Windows: the action is the orchestrator, not the authority.

---

## Part C — CI (GitHub Actions)

### C9. `macos-latest` is a standard hosted runner

Yes. [GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners): Ubuntu, Windows, and macOS are the standard images. No extra signup. Larger / GPU runners are Team/Enterprise only; **standard `macos-latest` is not**.

Tauri’s own publish workflow ([GitHub pipeline](https://v2.tauri.app/distribute/pipelines/github/)) uses `runs-on: macos-latest` twice — once with `--target aarch64-apple-darwin`, once with `--target x86_64-apple-darwin`.

As of mid-2026, `macos-latest` is the Apple Silicon macOS 26 image ([runner-images #14167](https://github.com/actions/runner-images/issues/14167); [changelog 2026-02-26](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/)). Intel is a **cross-compile** from that runner (`--target x86_64-apple-darwin`), not a second physical Mac, matching Tauri’s example. Pin `macos-26` / `macos-15` only if a future `latest` jump breaks Xcode/`notarytool`.

macOS minutes cost more than Linux/Windows on **private** repos ([Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)). Public standard runners stay in the free bucket. Two Mac jobs per release is expected, not a special SKU.

Xcode / `notarytool` ship on the image. No extra “Apple CI” product.

### C10. Getting a Developer ID cert into the runner keychain

This is not Azure Trusted Signing. The runner has no access to your login keychain. You import a `.p12` into an ephemeral keychain each job.

Tauri’s documented commands ([macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/) — “Example GitHub Actions configuration”):

```bash
echo $APPLE_CERTIFICATE | base64 --decode > certificate.p12
security create-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
security default-keychain -s build.keychain
security unlock-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
security set-keychain-settings -t 3600 -u build.keychain
security import certificate.p12 -k build.keychain \
  -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$KEYCHAIN_PASSWORD" build.keychain
security find-identity -v -p codesigning build.keychain
```

`KEYCHAIN_PASSWORD` is a random secret you invent for that ephemeral keychain. It is not an Apple credential. `set-key-partition-list` is required or `codesign` blocks on a GUI password prompt that CI cannot see (this is the failure behind [tauri-action#941](https://github.com/tauri-apps/tauri-action/issues/941)).

`set-keychain-settings -t 3600` stops the keychain locking mid-notarization.

You can *also* pass `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` into `tauri-action` so the CLI imports if the explicit step is omitted. Keep the explicit `security` block; it is what Tauri publishes, and it is inspectable when signing fails.

### C11. Notarization credentials in CI — Team API key, not an app-specific password

Apple documents both. **Use a Team App Store Connect API key.**

Reasons, from Apple, not folklore:

1. [Creating API Keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api): **Individual keys “aren’t able to use … `notaryTool`.”** A personal key from Edit Profile will authenticate to other APIs and then fail notarization in a confusing way.
2. API keys are revocable, not tied to one person’s 2FA or Apple ID, and do not require an app-specific password that dies when the account holder rotates credentials.
3. [TN3147](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool): `notarytool` takes `--issuer` + `--key-id` + `--key`; no Apple ID needed. Tauri maps that to `APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH`.
4. The `.p8` is downloadable **once**. Store it in GitHub Secrets immediately; Apple does not keep a copy.

Role: Tauri says pick **Developer** on the Integrations tab. Admin is unnecessary. Account Holder must enable the App Store Connect API if it is not already on.

CI pattern: put the `.p8` bytes in a secret, write them to a file in the job, set `APPLE_API_KEY_PATH` to that path. Do not commit `AuthKey_*.p8`.

App-specific password (`APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`) is the fallback Tauri still documents. Worse for automation: it is a person’s Apple ID, and GitHub’s secret list then includes that password.

### C12. GitHub secrets list (macOS equivalent of the Windows “set up once” pile)

macOS-only secrets (signing + notarization):

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` — or derive it after import and write to `GITHUB_ENV` |
| `KEYCHAIN_PASSWORD` | Random password for the job’s `build.keychain` |
| `APPLE_API_ISSUER` | App Store Connect issuer UUID |
| `APPLE_API_KEY` | Key ID (10-char) |
| `APPLE_API_KEY_P8` | Contents of `AuthKey_<id>.p8` (write to a file; Tauri wants `APPLE_API_KEY_PATH`) |

If you refuse the API key and use an Apple ID instead, replace the last three with `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`. Do not keep both sets.

Shared with the Windows updater pipeline (same keys, already planned there; not macOS-specific):

| Secret | What it is |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Minisign private key from `tauri signer generate` ([Updater](https://v2.tauri.app/plugin/updater/)) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Optional passphrase for that key |

Automatic, not a secret you create:

| Name | What it is |
| --- | --- |
| `GITHUB_TOKEN` | Issued per workflow. Needs **contents: write** for release upload ([Tauri GitHub guide](https://v2.tauri.app/distribute/pipelines/github/)). |

**macOS job: 7 Apple secrets + 2 shared updater secrets + `GITHUB_TOKEN`.**  
If Windows Trusted Signing is already on the repo, those Azure secrets stay Windows-only; they are not reused here.

That is the whole list. Set it once. There is no per-build Apple portal click after the Team key exists.

---

## Part D — output format and updater

### D13. What Tauri produces; what `/mac/latest` vs the updater consume

With `bundle.targets: "all"` (current config) a Mac build emits both a disk image and an app bundle. With `createUpdaterArtifacts: true` it also packs the `.app` for the updater ([Updater — Building](https://v2.tauri.app/plugin/updater/)):

| Artifact | Folder | Role |
| --- | --- | --- |
| `HookDeploy Agent.app` | `target/…/bundle/macos/` | The runnable bundle |
| `HookDeploy Agent.app.tar.gz` | same | **Updater payload** |
| `HookDeploy Agent.app.tar.gz.sig` | same | Updater signature (minisign) |
| `HookDeploy Agent_x.y.z_*.dmg` | `target/…/bundle/dmg/` | **First-install download** |

(a) **`/mac/latest`** should serve the **`.dmg`**. That is the user-facing installer: open, drag to Applications. Same job as Windows `/windows/latest` serving the NSIS/MSI.

(b) **`tauri-plugin-updater` consumes the `.app.tar.gz` + `.sig`, not the DMG.** Official text:

> On macOS, Tauri will create a .tar.gz archive from the application bundle … `myapp.app.tar.gz` — The updater bundle.

This is the macOS analogue of the Windows split (installer for first download, signed installer **reused** as the updater payload on Windows). On Mac the formats **diverge**: DMG for humans, tarball for the plugin. Pointing `latest.json` at the DMG will not apply an in-app update.

### D14. `latest.json` keys and architectures

The static manifest is **one multi-platform file**. No macOS-only schema. Platform keys are `OS-ARCH` ([Updater — Static JSON File](https://v2.tauri.app/plugin/updater/)):

> `OS` is one of `linux`, `darwin` or `windows`, and `ARCH` is one of `x86_64`, `aarch64`, `i686` or `armv7`.

Required Mac entries:

```json
"platforms": {
  "darwin-aarch64": {
    "url": "https://…/HookDeploy.Agent.app.tar.gz",
    "signature": "<contents of .sig>"
  },
  "darwin-x86_64": {
    "url": "https://…/HookDeploy.Agent-x64.app.tar.gz",
    "signature": "<contents of that .sig>"
  }
}
```

Endpoint template variables are `{{target}}` = `darwin` and `{{arch}}` = `aarch64` | `x86_64`.

**Apple Silicon and Intel need separate signed builds** unless you invest in a universal binary. Tauri’s official matrix is two jobs, two triples, two sidecars:

| Arch | Rust/Go triple | Sidecar filename |
| --- | --- | --- |
| Apple Silicon | `aarch64-apple-darwin` | `hookdeployed-aarch64-apple-darwin` |
| Intel | `x86_64-apple-darwin` | `hookdeployed-x86_64-apple-darwin` |

A universal `.app` is possible (`lipo` on the Rust binary **and** the sidecar). The updater then needs a custom target (the plugin’s `target: 'macos-universal'` example). Two-arch matrix is the documented path and matches `/mac/latest` offering the right DMG (or a single Silicon DMG plus Rosetta for Intel — Rosetta is a product decision; the updater still wants a `darwin-x86_64` entry if you claim Intel support).

`icon.icns` is already listed in `tauri.conf.json`. The darwin sidecar names are already in `src-tauri/binaries/README.md`. Neither is wired in CI yet.

---

## Part E — scope verdict

**This is a days-scale port of the app plus a real (but bounded) signing/CI project. It is not a second product.**

### Zero-change reuse (builds on `macos-*` once a darwin sidecar exists)

| Piece | Why |
| --- | --- |
| Almost all of `supervisor.rs` | argv `sidecar()` / `with_certs`, connect spawn, enroll `-no-tty` + stdin write, tap `StdCommand` + piped stdio, stdin-close stop, quit teardown |
| `parse.rs` | CLI line grammar is OS-agnostic |
| Frontend (`src/main.ts`, `styles.css`) | No Windows strings, no `win32` APIs. CSP and self-hosted fonts transfer |
| Capabilities, opener plugin, no `shell:*` | Already correct |
| `tap_list_json_direct` name probe | Already tries `hookdeployed` without `.exe` |
| `listeners` 0.6 `list_ports()` | Crate supports macOS ([docs.rs](https://docs.rs/listeners/0.6.0/listeners/)) |
| `windows_subsystem` in `main.rs` | Compiles away |
| `Cargo.toml` `windows` dep | Already `cfg(windows)` |

### Small `#[cfg(target_os = "macos")]` / portable fixes (hours, not a rewrite)

| Piece | Work |
| --- | --- |
| **`certs_dir()`** | **Required.** Today → `~/.config/hookdeploy/certs`. Must match CLI `~/Library/Application Support/hookdeploy/certs`. One function. |
| `tray.rs` | `icon_as_template(true)`, left-click menu, template PNG. Keep Windows behavior behind `cfg`. |
| `network.rs` | Non-Windows stub returns `true` always. Need a real reachability probe (or accept “always online” for v1 — honest, but the offline sheet will never fire). |
| `ports.rs` denylist | Windows-heavy (`svchost`, `msedgewebview2`, …). Add macOS noise (`rapportd`, `ControlCenter`, `sharingd`, …) after one live run. Logic stays. |
| `tauri.conf.json` | `bundle.macOS.signingIdentity` / entitlements path when you have them. |
| Sidecar files | Copy `hookdeployed` to the two darwin triple names. Already documented. |

### Genuinely new (the schedule risk)

| Work | Size |
| --- | --- |
| Developer ID Application cert + `.p12` export | One-time Apple portal, Account Holder |
| Team API key for `notarytool` | One-time; `.p8` stored as secrets |
| `macos-latest` matrix in the publish workflow | Follow Tauri’s example; add the `security` import step they publish |
| First notarization fight | Usually one or two log-driven fixes (nested sign order, timestamp, identity grep). Budget a day. |
| `/mac/latest` DMG + `latest.json` `darwin-*` entries | Same static-hosting work as Windows, different artifact names |
| Template menu-bar icon | Design, not engineering |

### What is *not* in scope

- Rewriting spawn, tap-stop, enroll, or the UI.
- App Store, sandbox, or `inherit` entitlements.
- JIT / `allow-unsigned-executable-memory`.
- A macOS-only SIGTERM stop path.
- Pre-signing the sidecar by hand if Tauri’s bundler is signing (verify with `codesign -dvv` on the first CI artifact).

**Honest size:** supervisor + frontend ≈ **90% reuse**. The correctness fix is `certs_dir()`. The calendar is dominated by Apple’s pipeline (cert, keychain import, notarization, two-arch artifacts) — comparable to standing up Windows Trusted Signing, not to writing the tray again. A first notarized Silicon DMG is a short project if the Windows app stays the source of truth. A polished Intel+Silicon updater with a template menu-bar icon and a real offline detector is still days, not a second repo.

---

## Stop-mechanism recommendation (A2, restated)

Keep stdin-close on macOS. The CLI’s `-no-tty` handler is POSIX-neutral. Signals work on Darwin and are already a second stop path inside `hookdeployed`; the tray does not need to switch to them.

## Sidecar Gatekeeper recommendation (B7, restated)

Sign every Mach-O in `Contents/MacOS/` with Developer ID Application + hardened runtime, inside-out. Tauri’s bundler does this when `APPLE_*` signing env is set. Notarization of the `.app` / `.dmg` does **not** substitute for an unsigned `hookdeployed`. The user-facing miss is **“is damaged and can’t be opened”** or **“Apple cannot check it for malicious software.”** The runtime miss (app up, child dead) is **Code Signature Invalid** in Console.

STOP. No code in this pass.
