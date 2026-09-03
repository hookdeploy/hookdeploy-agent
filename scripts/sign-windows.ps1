#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$File
)

$ErrorActionPreference = "Stop"

$cfgPath = Join-Path $PSScriptRoot "..\src-tauri\windows-sign-ci.json"
$cfg = Get-Content -Raw -Path $cfgPath | ConvertFrom-Json

# Tauri passes sidecars as repo-relative paths (binaries\…). SignTool + the
# Azure Artifact Signing dlib often fail with SignerSign()/0x80004005 on a
# relative path even when the same credentials signed an absolute main .exe.
$full = [System.IO.Path]::GetFullPath($File)
if (-not (Test-Path -LiteralPath $full)) {
  throw "sign-windows: file not found: $File (resolved: $full) cwd=$(Get-Location)"
}

attrib -R $full 2>$null | Out-Null
Write-Host "sign-windows: signing $full"

& artifact-signing-cli `
  -e $cfg.endpoint.TrimEnd("/") `
  -a $cfg.codeSigningAccountName `
  -c $cfg.certificateProfileName `
  -d "HookDeploy Agent" `
  $full

if ($LASTEXITCODE -ne 0) {
  throw "sign-windows: artifact-signing-cli exited $LASTEXITCODE for $full"
}
