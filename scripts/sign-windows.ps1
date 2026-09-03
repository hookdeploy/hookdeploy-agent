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

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $enc = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

function Ensure-ArtifactSigningDlib {
  if (Test-Path -LiteralPath $libPath) { return }

  Write-Host "sign-windows: downloading Microsoft.ArtifactSigning.Client nupkg"
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  $tmp = Join-Path $env:TEMP ("acs-client-" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $nupkg = Join-Path $tmp "Microsoft.ArtifactSigning.Client.nupkg"
  # nuget.org package download (latest stable redirects to nupkg)
  Invoke-WebRequest `
    -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/index.json" `
    -OutFile (Join-Path $tmp "index.json")
  $index = Get-Content -Raw (Join-Path $tmp "index.json") | ConvertFrom-Json
  $ver = $index.versions[-1]
  Write-Host "sign-windows: ArtifactSigning.Client $ver"
  Invoke-WebRequest `
    -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/$ver/microsoft.artifactsigning.client.$ver.nupkg" `
    -OutFile $nupkg
  # Expand-Archive requires a .zip extension on Windows PowerShell 5.1.
  $zip = Join-Path $tmp "client.zip"
  Copy-Item -LiteralPath $nupkg -Destination $zip -Force
  $extracted = Join-Path $tmp "extracted"
  Expand-Archive -LiteralPath $zip -DestinationPath $extracted -Force
  $found = Get-ChildItem -Path $extracted -Recurse -Filter "Azure.CodeSigning.Dlib.dll" |
    Where-Object { $_.FullName -match '\\x64\\' } |
    Select-Object -First 1
  if (-not $found) { throw "sign-windows: Azure.CodeSigning.Dlib.dll (x64) not found in nupkg $ver" }
  $libDir = Split-Path $libPath -Parent
  New-Item -ItemType Directory -Force -Path $libDir | Out-Null
  # Copy sibling deps next to the dlib (same folder as in the nupkg).
  Copy-Item -Force (Join-Path $found.DirectoryName "*") $libDir
}

Ensure-ArtifactSigningDlib

if (-not (Test-Path -LiteralPath $signtool)) {
  throw "sign-windows: signtool missing at $signtool"
}

# Prefer EnvironmentCredential (AZURE_CLIENT_ID / SECRET / TENANT_ID from the
# workflow). A 403 here means the SP authenticated but lacks Certificate Profile
# Signer on the Trusted Signing account/profile — not a Tauri/%1 bug.
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
Write-Utf8NoBom $metaPath (($meta | ConvertTo-Json -Depth 5) + "`n")
Write-Host "sign-windows: metadata:"
Get-Content $metaPath
Write-Host "sign-windows: AZURE_CLIENT_ID set=$([bool]$env:AZURE_CLIENT_ID) TENANT set=$([bool]$env:AZURE_TENANT_ID) SECRET set=$([bool]$env:AZURE_CLIENT_SECRET)"
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
