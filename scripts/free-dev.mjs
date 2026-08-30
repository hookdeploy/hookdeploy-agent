import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const debugDir = join(root, "src-tauri", "target", "debug");
const dest = join(debugDir, "hookdeployed.exe");
const tray = join(debugDir, "hookdeploy-tray.exe");
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
Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
    if ($p.CommandLine -match 'hookdeploy-tray') {
      Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
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
