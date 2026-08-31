# HookDeploy Agent — cross-platform unify (Windows + macOS)

**Date:** 2026-08-31  
**Working tree:** `c:\hookdeploy\hookdeploy-tray` (folder name unchanged)  
**Package/repo name target:** `hookdeploy-agent`  
**Mode:** code + report. **No commit. No push. No GitHub rename. No secrets set. Workflow not triggered.**

Product-facing name stays **HookDeploy Agent**. Bundle identifier stays `com.hookdeploy.tray` (not user-visible; changing it would mint a new signing identity).

---

## PART 0 — repo rename

### Current git (this is the same tree committed earlier)

| | |
| --- | --- |
| `git rev-parse HEAD` | `98d99d1c7fe92ab6009a24f2a9056661f16b2341` |
| Date | 2026-08-29 22:35:28 -0700 |
| Message | `feat: agent self-rename in Settings` |
| Branch | `main` |
| **Remote** | **none.** `git remote -v` is empty. `origin` does not exist. |

`gh repo view hookdeploy/hookdeploy-tray` and `hookdeploy/hookdeploy-agent` both 404. There is **no GitHub repository to rename**. History is real and local (one commit); it has never been pushed.

### Human action — do not do this from Cursor without an explicit go-ahead

Because nothing exists on GitHub yet, a Settings-rename is not available. Two honest options:

**A (preferred): create `hookdeploy/hookdeploy-agent` directly**

1. GitHub → org `hookdeploy` → **New repository**.
2. Name: `hookdeploy-agent`. Private unless you intend otherwise.
3. **Do not** initialize with README (this tree already has history).
4. After it exists, from this folder:

```powershell
git remote add origin https://github.com/hookdeploy/hookdeploy-agent.git
```

**B: create `hookdeploy-tray` then rename** (only if you want the redirect folklore)

1. Create `hookdeploy/hookdeploy-tray` empty, push `main`.
2. **Settings → General → Repository name** → type `hookdeploy-agent` → **Rename**.
3. GitHub keeps issues/stars (none yet) and 301s the old URL.
4. Then: `git remote set-url origin https://github.com/hookdeploy/hookdeploy-agent.git`

**Stopped before either.** Waiting on go-ahead before any GitHub create/rename/push.

### Files updated to the new package name (local only)

| File | Change |
| --- | --- |
| `package.json` / `package-lock.json` | `"name": "hookdeploy-agent"` |
| `src-tauri/Cargo.toml` | `name = "hookdeploy-agent"`, lib `hookdeploy_agent_lib` |
| `src-tauri/Cargo.lock` | regenerated for the rename + updater crates |
| `src-tauri/src/main.rs` | `hookdeploy_agent_lib::run()` |
| `scripts/free-dev.mjs` | looks for `hookdeploy-agent.exe` |
| `README.md` | product vs package names spelled out |
| `src-tauri/tauri.conf.json` | `productName` still `HookDeploy Agent`; identifier **unchanged** `com.hookdeploy.tray` |
| Frontend / docs URLs | no `hookdeploy-tray` GitHub URLs existed to rewrite. Updater endpoint uses `hookdeploy/hookdeploy-agent`. |

Local disk folder is still `hookdeploy-tray`. Renaming the directory is a separate human choice (breaks this Cursor workspace path).

---

## PART 1 — `certs_dir()` fix

Go source of truth (`hookdeployed/internal/store/store.go`):

```go
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

Go `os.UserConfigDir` on Darwin is `$HOME/Library/Application Support` ([pkg.go.dev/os?GOOS=darwin](https://pkg.go.dev/os?GOOS=darwin)).

**New tray logic** (same override-first, then platform `UserConfigDir`):

```141:197:src-tauri/src/supervisor.rs
/// Same store as `hookdeployed` `store.DefaultDir()`:
/// `{os.UserConfigDir()}/hookdeploy/certs`, then `"certs"` if that fails.
///
/// Matches Go `os.UserConfigDir` per platform (pkg.go.dev/os):
/// - Windows: `%AppData%`
/// - Darwin: `$HOME/Library/Application Support`
/// - other Unix: `$XDG_CONFIG_HOME` or `$HOME/.config`
pub fn certs_dir() -> PathBuf {
    if let Ok(env) = std::env::var("HOOKDEPLOY_CERT_DIR") {
        let trimmed = env.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    default_certs_dir()
}

fn platform_user_config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    { std::env::var_os("APPDATA").map(PathBuf::from) }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| {
            PathBuf::from(h).join("Library").join("Application Support")
        })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    }
    // ...
}
```

| Platform | Resolved default |
| --- | --- |
| Windows | `%AppData%\hookdeploy\certs` (unchanged) |
| macOS | `~/Library/Application Support/hookdeploy/certs` (**was** `~/.config/hookdeploy/certs`) |
| Linux | `$XDG_CONFIG_HOME/hookdeploy/certs` or `~/.config/hookdeploy/certs` |

`HOOKDEPLOY_CERT_DIR` still wins on every platform, first, non-empty trim — same as Go.

**Tests** cite that Go function, not a free-floating string:

- `default_certs_dir_matches_hookdeployed_user_config_dir_on_windows` — ran **ok** here.
- `default_certs_dir_matches_hookdeployed_user_config_dir_on_darwin` — `cfg(macos)`, not run on this machine.
- `default_certs_dir_matches_hookdeployed_user_config_dir_on_linux` — `cfg(unix, not macos)`.
- `connect_list_tap_enroll_rename_share_one_certs_path` — still one `-certs` path for every spawn — **ok**.

Did not mutate `HOOKDEPLOY_CERT_DIR` in tests (parallel tests would leak).

---

## PART 2 — macOS tray + known gaps

### Tray diff (exact)

`icon_as_template(true)` and `show_menu_on_left_click(true)` only under `#[cfg(target_os = "macos")]`. Windows keeps left-click-opens-window and `show_menu_on_left_click(false)`.

See `src-tauri/src/tray.rs`: macOS template PNG + those two builder calls; non-macOS click handler unchanged.

### Template icon — PLACEHOLDER

Needed: 22pt (and 44pt @2x) **alpha-mask** PNG, black ink, no color, no orange fill. macOS tints it for light/dark menu bar.

`src-tauri/icons/tray-template.png` is a conversion of `icon-source.png` (orange brand → transparent, dark hook → black). It is a **placeholder**. Swap before shipping. Windows still uses `icons/32x32.png`.

### `network.rs` — pre-existing gap, not touched

```10:21:src-tauri/src/network.rs
pub fn is_online() -> bool {
    #[cfg(windows)]
    { /* NLM then WinINet */ }
    #[cfg(not(windows))]
    { true }
}
```

Non-Windows always reports online. The offline gate never fires on a Mac. **Not fixed this pass.** Flagged in the macOS port audit; still deferred.

### `ports.rs` denylist — starting macOS set, needs a live Mac run

Added (lowercased, matching existing compare): `rapportd`, `controlcenter`, `sharingd`, `wifiagent`, `mdnsresponder`, `coreaudiod`, `identityservicesd`, `usernotificationcenter`.

**PLACEHOLDER:** same process as Windows — tune after `listeners::get_all()` on a real Mac. Do not treat this list as final.

---

## PART 3 — darwin sidecar wiring

`bundle.externalBin` is still `["binaries/hookdeployed"]`. Tauri’s suffix convention ([sidecar docs](https://v2.tauri.app/develop/sidecar/)):

| File | Target |
| --- | --- |
| `hookdeployed-x86_64-pc-windows-msvc.exe` | Windows (already) |
| `hookdeployed-aarch64-apple-darwin` | macOS Apple Silicon |
| `hookdeployed-x86_64-apple-darwin` | macOS Intel |

Do not pre-sign the darwin binaries.

### Local copy (human, on a Mac with the Go toolchain)

```bash
# Apple Silicon
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o hookdeployed ./cmd/agent
cp hookdeployed /path/to/hookdeploy-agent/src-tauri/binaries/hookdeployed-aarch64-apple-darwin
chmod +x /path/to/hookdeploy-agent/src-tauri/binaries/hookdeployed-aarch64-apple-darwin

# Intel (or cross from Apple Silicon)
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -o hookdeployed-amd64 ./cmd/agent
cp hookdeployed-amd64 /path/to/hookdeploy-agent/src-tauri/binaries/hookdeployed-x86_64-apple-darwin
chmod +x /path/to/hookdeploy-agent/src-tauri/binaries/hookdeployed-x86_64-apple-darwin
```

Windows local copy is unchanged (`Copy-Item` into the `-x86_64-pc-windows-msvc.exe` name). Release CI builds all three from `github.com/hookdeploy/hookdeployed`.

---

## PART 4 — `tauri-plugin-updater`

Added:

- Rust: `tauri-plugin-updater`, `tauri-plugin-process`
- JS: `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`
- `bundle.createUpdaterArtifacts: true`
- Capabilities: `updater:default`, `process:allow-restart`

**Endpoint** (static GitHub Release JSON):

```text
https://github.com/hookdeploy/hookdeploy-agent/releases/latest/download/latest.json
```

**Public key** (safe to commit; this is what is in `tauri.conf.json`):

```
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEVCOENFMEM4RTIxREZFMjgKUldRby9oM2l5T0NNNjlQQWZMakJ6dHdLK0FUbFRhUXdTZzRKdENGQkxOeEVBdEVYUHU3eTFxQmMK
```

**Private key was never written to any file in this repo.** Generated with `tauri signer generate --force -w` **outside** the tree:

```text
C:\Users\MichaelBernstein\.hookdeploy\tauri-updater.key
C:\Users\MichaelBernstein\.hookdeploy\tauri-updater.key.pub
```

No password on this key (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` can be empty). Put the **contents** of the `.key` file into GitHub secret `TAURI_SIGNING_PRIVATE_KEY`. Losing that file means installed apps can never be updated with this pubkey.

### UI

Settings → **Updates**: version label, **Check for updates**, and **Install and restart** when `check()` returns an update. Also a silent check on launch (failures stay in the hint, no modal). Small, same panel density as “This agent”.

---

## PART 5 — `bundle.macOS`

```json
"macOS": {
  "signingIdentity": "Developer ID Application: HookDeploy (TEAMID)",
  "hardenedRuntime": true,
  "entitlements": null
}
```

Placeholder identity until the real `Developer ID Application: … (TEAMID)` exists. CI overrides via `APPLE_SIGNING_IDENTITY` after keychain import. No entitlements file (Go sidecar, no JIT). Hardened runtime explicit (already Tauri’s default).

Windows `signCommand` is **not** in `tauri.conf.json` (would break local unsigned `tauri build`). CI writes `src-tauri/windows-sign.ci.json` and passes `--config`.

---

## PART 6 — combined release workflow

**No Windows-only draft existed.** New file: `.github/workflows/release.yml`.

Trigger: `push` tags `v*`, plus `workflow_dispatch`. **Not run.** No tag created.

Three-job matrix on `macos-latest` / `windows-latest`:

| Job | Runner | `tauri build` args | Sidecar |
| --- | --- | --- | --- |
| `windows` | `windows-latest` | `--config src-tauri/windows-sign.ci.json` | `GOOS=windows GOARCH=amd64` |
| `macos-arm64` | `macos-latest` | `--target aarch64-apple-darwin` | `GOOS=darwin GOARCH=arm64` |
| `macos-x64` | `macos-latest` | `--target x86_64-apple-darwin` | `GOOS=darwin GOARCH=amd64` |

Intel is **cross-compiled from the same Apple Silicon `macos-latest` runner**, matching [Tauri’s GitHub pipeline example](https://v2.tauri.app/distribute/pipelines/github/).

Each macOS job: `security create-keychain` / `import` / `set-key-partition-list` from the macOS audit, then `tauri-action` with `APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH` (Team API key `.p8`, not Apple ID). Identity grepped as **Developer ID Application**, not “Apple Development”.

Windows: `artifact-signing-cli` + Azure env ([Tauri Azure Artifact Signing](https://v2.tauri.app/distribute/sign/windows/)). **No Azure Trusted Signing account/profile is confirmed in this repo.** The step is wired and **untestable** until those secrets exist. It does not block the rest of this change set.

`latest-json` job runs after all three: `scripts/assemble-latest-json.mjs` writes one file with `windows-x86_64`, `darwin-aarch64`, `darwin-x86_64`, uploads to the same GitHub Release. `includeUpdaterJson: false` on the matrix so we do not race three partial manifests.

Draft release (`releaseDraft: true`). Cutting a real tag is a human action after secrets exist.

### Secrets to add in GitHub Settings (do not set from here)

**Apple (7)**

| Secret | What |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` export password |
| `KEYCHAIN_PASSWORD` | Random password for the CI ephemeral keychain |
| `APPLE_API_ISSUER` | App Store Connect Team key issuer UUID |
| `APPLE_API_KEY` | Team key ID (10-char). Individual keys cannot use `notaryTool` |
| `APPLE_API_KEY_P8` | Contents of `AuthKey_<id>.p8` (download once) |
| `APPLE_SIGNING_IDENTITY` | Optional; workflow greps the imported cert if unset |

**Updater (2, shared)**

| Secret | What |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~\.hookdeploy\tauri-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Empty for the key generated this pass |

**Azure Trusted Signing (6) — wired, profile not confirmed ready**

| Secret | What |
| --- | --- |
| `AZURE_CLIENT_ID` | App registration |
| `AZURE_CLIENT_SECRET` | App registration secret |
| `AZURE_TENANT_ID` | Directory ID |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | e.g. `https://wus2.codesigning.azure.net` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | Account name |
| `AZURE_TRUSTED_SIGNING_PROFILE` | Certificate profile name |

Plus automatic `GITHUB_TOKEN` (needs `contents: write`, already on the workflow).

**Nothing in that list was written to GitHub.**

---

## PART 7 — `/windows/latest` and `/mac/latest`

**Recommendation: follow-up pass, not this change.**

Live `apt-worker` (`platform-agents-pr/apt-worker`, `apt.hookdeploy.dev`) is an R2 **object server** for the Debian repo (`InRelease`, `Packages`, `.deb`). Pathname → R2 key. No redirects, no GitHub, no Windows/Mac installers. Putting GUI downloads on that worker mixes a package repo with a download CDN and the wrong bucket.

What the redirects need (thin, same *idea* as apt-worker — a tiny Worker — different job):

1. `GET https://<host>/windows/latest` → **302** to the current GitHub Release NSIS `-setup.exe`.
2. `GET https://<host>/mac/latest` → **302** to the current **`.dmg`** (not the updater `.app.tar.gz`).
3. Optional: `/mac/arm64/latest` vs `/mac/x64/latest`, or sniff `User-Agent`.
4. Implementation: GitHub Releases API (`/releases/latest`) + cache, or a KV/R2 pointer the release workflow updates.

That is a small Worker, but it is a new hostname (or new routes on something that is not `apt.hookdeploy.dev`), plus DNS, plus a decision about arm64 vs x64. Keep it out of this already-large agent change.

---

## What was not done (explicit)

- No `git commit`.
- No `git push`.
- No GitHub repo create/rename.
- No secrets created.
- No workflow run, no tag.
- No `CREATE_NO_WINDOW` / SIGTERM macOS branch (audit: not needed).
- `network.rs` stub left as-is.
- Azure Trusted Signing identity **not** confirmed ready.

Supervisor spawn, stdin-close tap-stop, parser, CSP, self-hosted fonts, no `shell:*` — reused, not rewritten.

Working tree also contains **pre-existing uncommitted** Windows work vs `98d99d1` (`network.rs`, fonts, CSP, large `main.ts`/`styles.css`/`parse.rs` deltas). This pass sits on top of that. Review the whole diff together before the first commit.
