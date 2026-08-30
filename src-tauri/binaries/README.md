Sidecar binaries for `bundle.externalBin`: `binaries/hookdeployed`.

Tauri looks up a **target-triple-suffixed** filename next to this README:

| Host | File |
| --- | --- |
| Windows MSVC (this machine) | `hookdeployed-x86_64-pc-windows-msvc.exe` |
| macOS Apple Silicon (later) | `hookdeployed-aarch64-apple-darwin` |
| Linux x64 (later) | `hookdeployed-x86_64-unknown-linux-gnu` |

Rust calls `app.shell().sidecar("hookdeployed")` — the filename only, not the `binaries/` prefix.

Local Windows copy (from the already-built CLI):

```powershell
Copy-Item C:\hookdeploy\hookdeployed\hookdeployed.exe `
  C:\hookdeploy\hookdeploy-tray\src-tauri\binaries\hookdeployed-x86_64-pc-windows-msvc.exe
```
