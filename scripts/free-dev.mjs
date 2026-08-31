import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const debugDir = join(root, "src-tauri", "target", "debug");
const dest = join(debugDir, "hookdeployed.exe");
const tray = join(debugDir, "hookdeploy-agent.exe");
const binaries = join(root, "src-tauri", "binaries");
const q = (p) => p.replace(/'/g, "''");

const srcName = existsSync(binaries)
  ? readdirSync(binaries).find(
      (name) => name.startsWith("hookdeployed-") && name.endsWith(".exe"),
    )
  : undefined;
const src = srcName ? join(binaries, srcName) : "";

const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$paths = @('${q(dest)}', '${q(tray)}')
Get-Process | Where-Object { $_.Path -and ($paths -contains $_.Path) } | Stop-Process -Force
# Tauri treats an already-open :1420 as "frontend ready" and starts the tray
# while this script is still running — then the kill above races the new exe
# (exit 0xffffffff). Free the port from leftover vite/node first.
Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Milliseconds 400
exit 0
`;

spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], {
  stdio: "inherit",
  windowsHide: true,
});

mkdirSync(debugDir, { recursive: true });
if (src && existsSync(src)) {
  try {
    copyFileSync(src, dest);
  } catch {
    // dest may still be locked; tauri-build will retry the copy
  }
}

process.exit(0);
