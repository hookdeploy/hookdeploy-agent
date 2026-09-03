#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$File
)

$ErrorActionPreference = "Stop"

$cfgPath = Join-Path $PSScriptRoot "..\src-tauri\windows-sign-ci.json"
$cfg = Get-Content -Raw -Path $cfgPath | ConvertFrom-Json
$endpoint = $cfg.endpoint.TrimEnd("/")

$full = [System.IO.Path]::GetFullPath($File)
if (-not (Test-Path -LiteralPath $full)) {
  throw "sign-windows: file not found: $File (resolved: $full) cwd=$(Get-Location)"
}
attrib -R $full 2>$null | Out-Null

# Do not use $HOME — it is a read-only automatic variable in PowerShell.
$userHome = $env:USERPROFILE
$configDir = Join-Path $userHome ".artifact-signing-cli"
$libPath = Join-Path $configDir "lib\bin\x64\Azure.CodeSigning.Dlib.dll"
$metaPath = Join-Path $configDir "metadata.json"
$signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"

if (-not (Test-Path -LiteralPath $libPath)) {
  Write-Host "sign-windows: bootstrapping Artifact Signing dlib via artifact-signing-cli"
  # Triggers download+extract of Microsoft.ArtifactSigning.Client (then exits on our throwaway).
  # Use a tiny copy of ourselves as the file arg so the CLI gets past arg parse.
  $probe = Join-Path $env:TEMP "hd-sign-probe.exe"
  Copy-Item -LiteralPath $full -Destination $probe -Force
  try {
    & artifact-signing-cli -e $endpoint -a $cfg.codeSigningAccountName -c $cfg.certificateProfileName $probe 2>&1 | Out-Host
  } catch {
    # First run may fail login/sign; we only need the dlib on disk.
  }
  if (-not (Test-Path -LiteralPath $libPath)) {
    throw "sign-windows: dlib missing at $libPath after bootstrap"
  }
}

if (-not (Test-Path -LiteralPath $signtool)) {
  throw "sign-windows: signtool missing at $signtool"
}

# Force DefaultAzureCredential onto EnvironmentCredential (AZURE_CLIENT_ID /
# SECRET / TENANT_ID already set by the workflow). Avoids interactive and
# stale VS/CLI credential chains that surface as SignerSign/0x80004005.
$meta = [ordered]@{
  Endpoint                 = $endpoint
  CodeSigningAccountName   = $cfg.codeSigningAccountName
  CertificateProfileName   = $cfg.certificateProfileName
  ExcludeCredentials       = @(
    "ManagedIdentityCredential"
    "WorkloadIdentityCredential"
    "SharedTokenCacheCredential"
    "VisualStudioCredential"
    "VisualStudioCodeCredential"
    "AzureCliCredential"
    "AzurePowerShellCredential"
    "AzureDeveloperCliCredential"
    "InteractiveBrowserCredential"
  )
}
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
($meta | ConvertTo-Json -Depth 5) | Set-Content -Path $metaPath -Encoding utf8
Write-Host "sign-windows: metadata:"
Get-Content $metaPath
Write-Host "sign-windows: signing $full"

& $signtool sign `
  /v /debug `
  /fd SHA256 `
  /tr "http://timestamp.acs.microsoft.com" `
  /td SHA256 `
  /dlib $libPath `
  /dmdf $metaPath `
  /d "HookDeploy Agent" `
  $full

if ($LASTEXITCODE -ne 0) {
  throw "sign-windows: signtool exited $LASTEXITCODE for $full"
}

& $signtool verify /pa /v $full
if ($LASTEXITCODE -ne 0) {
  throw "sign-windows: verify failed for $full"
}

Write-Host "sign-windows: ok $full"
