# HookDeploy tray

Windows-first Tauri 2 tray app that supervises `hookdeployed` (`connect`, `tap`, enroll).

See `docs/scaffold-report.md` for the scaffold notes. Do not run `tauri dev` until that report has been reviewed.

## Local sidecar

Copy the already-built CLI to the triple-suffixed name (Windows MSVC):

```powershell
Copy-Item C:\hookdeploy\hookdeployed\hookdeployed.exe `
  .\src-tauri\binaries\hookdeployed-x86_64-pc-windows-msvc.exe
```
