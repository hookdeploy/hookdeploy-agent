Sidecar binaries for `bundle.externalBin`: `binaries/hookdeployed`.

Tauri looks up a **target-triple-suffixed** filename next to this README
([Embedding External Binaries](https://v2.tauri.app/develop/sidecar/)):

| Host | File |
| --- | --- |
| Windows MSVC | `hookdeployed-x86_64-pc-windows-msvc.exe` |
| macOS Apple Silicon | `hookdeployed-aarch64-apple-darwin` |
| macOS Intel | `hookdeployed-x86_64-apple-darwin` |
| Linux x64 (later) | `hookdeployed-x86_64-unknown-linux-gnu` |

Rust calls `app.shell().sidecar("hookdeployed")` — the filename only, not the `binaries/` prefix.
Do **not** pre-sign the darwin binaries; Tauri's bundler signs every Mach-O in `Contents/MacOS/` when the Apple signing env is set.

## Local `tauri dev` — copy a built CLI

Windows (this machine):

```powershell
Copy-Item C:\hookdeploy\hookdeployed\hookdeployed.exe `
  C:\hookdeploy\hookdeploy-tray\src-tauri\binaries\hookdeployed-x86_64-pc-windows-msvc.exe
```

macOS Apple Silicon (run on the Mac, after `go build` of `hookdeployed`):

```bash
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o hookdeployed ./cmd/agent
cp hookdeployed /path/to/hookdeploy-agent/src-tauri/binaries/hookdeployed-aarch64-apple-darwin
chmod +x /path/to/hookdeploy-agent/src-tauri/binaries/hookdeployed-aarch64-apple-darwin
```

macOS Intel (or cross-compile from Apple Silicon):

```bash
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -o hookdeployed-amd64 ./cmd/agent
cp hookdeployed-amd64 /path/to/hookdeploy-agent/src-tauri/binaries/hookdeployed-x86_64-apple-darwin
chmod +x /path/to/hookdeploy-agent/src-tauri/binaries/hookdeployed-x86_64-apple-darwin
```

Release CI builds these three from `github.com/hookdeploy/hookdeployed` rather than copying by hand.
