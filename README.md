# HookDeploy Agent

Tauri 2 tray / menu-bar app that supervises `hookdeployed` (`connect`, `tap`, enroll).
Product name is **HookDeploy Agent**. Repo/package name is `hookdeploy-agent`.

See `docs/cross-platform-build.md` for the Windows + macOS unify pass.

Do not run `tauri dev` until that report has been reviewed. Do not cut a release tag until signing secrets exist on both platforms.

## Local sidecar

Copy the already-built CLI to the triple-suffixed name. See `src-tauri/binaries/README.md`.
