param(
  [Parameter(Mandatory = $true)][string]$Phase,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][string]$ExpectedFileVersion,
  [Parameter(Mandatory = $true)][string]$ExpectedExeSha256,
  [Parameter(Mandatory = $true)][string]$ExpectedAsarSha256,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$installedRoot = 'C:\Users\lin0\AppData\Local\Programs\RelayQaHubPreview-v21-e2e-fresh-0910'
$exePath = Join-Path $installedRoot 'RelayQaHubPreview-v21-e2e-fresh-0910.exe'
$asarPath = Join-Path $installedRoot 'resources\app.asar'
$configPath = Join-Path $installedRoot 'preview-instance.json'
$profilePath = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-v21-e2e-fresh-0910\desktop\profile'
$identityPath = Join-Path $profilePath 'remembered-login-name.json'
$updateRoot = Join-Path $profilePath 'updates'
$downloadsRoot = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-v21-e2e-fresh-0910\downloads'
$latestManifestPath = Join-Path $downloadsRoot 'qa-hub-preview-v21-e2e-fresh-0910-windows-latest.json'
$selectedPorts = @(4174, 4319, 4320, 4639, 4640, 4641, 4642, 9333, 9433)

$exeItem = Get-Item -LiteralPath $exePath
$asarItem = Get-Item -LiteralPath $asarPath
$identityBytes = [System.IO.File]::ReadAllBytes($identityPath)
$identity = [System.Text.Encoding]::UTF8.GetString($identityBytes) | ConvertFrom-Json
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -eq $exePath
} | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine)
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
  $selectedPorts -contains $_.LocalPort
} | Sort-Object LocalPort | ForEach-Object {
  [ordered]@{ address = $_.LocalAddress; port = $_.LocalPort; pid = $_.OwningProcess }
})
$backupDirectories = @(Get-ChildItem -LiteralPath (Split-Path $installedRoot) -Directory -Filter 'RelayQaHubPreview-v21-e2e-fresh-0910.backup-*' | Sort-Object Name | ForEach-Object {
  [ordered]@{ name = $_.Name; fullName = $_.FullName; lastWriteTimeUtc = $_.LastWriteTimeUtc.ToString('o') }
})
$updateEntries = @(Get-ChildItem -LiteralPath $updateRoot -Force | Sort-Object Name | ForEach-Object {
  [ordered]@{ name = $_.Name; fullName = $_.FullName; isDirectory = $_.PSIsContainer; length = if ($_.PSIsContainer) { $null } else { $_.Length }; lastWriteTimeUtc = $_.LastWriteTimeUtc.ToString('o') }
})
$productionReady = Invoke-RestMethod -Uri 'http://127.0.0.1:4319/api/v1/health/ready' -Method Get -TimeoutSec 10
$previewReady = Invoke-RestMethod -Uri 'http://127.0.0.1:4639/api/v1/health/ready' -Method Get -TimeoutSec 10
$desktopMcp = $null
if (($listeners | Where-Object { $_.port -eq 4642 }).Count -eq 1) {
  $desktopMcp = Invoke-RestMethod -Uri 'http://127.0.0.1:4642/health' -Method Get -TimeoutSec 10
}
$versionInfo = $exeItem.VersionInfo
$exeSha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
$asarSha256 = (Get-FileHash -LiteralPath $asarPath -Algorithm SHA256).Hash.ToLowerInvariant()
$identitySha256 = ([System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($identityBytes))).Replace('-', '').ToLowerInvariant()
$latestManifest = Get-Content -LiteralPath $latestManifestPath -Raw | ConvertFrom-Json
$mainProcesses = @($processes | Where-Object { $_.CommandLine -notmatch ' --type=' })
$main = if ($mainProcesses.Count -eq 1) { $mainProcesses[0] } else { $null }

$result = [ordered]@{
  schemaVersion = 1
  capturedAt = [DateTime]::UtcNow.ToString('o')
  phase = $Phase
  sourceCommit = (git rev-parse HEAD).Trim()
  installed = [ordered]@{
    root = $installedRoot
    exePath = $exePath
    version = $versionInfo.ProductVersion
    fileVersion = $versionInfo.FileVersion
    exeBytes = $exeItem.Length
    exeSha256 = $exeSha256
    asarBytes = $asarItem.Length
    asarSha256 = $asarSha256
    previewConfigSha256 = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  rememberedIdentity = [ordered]@{
    value = $identity
    bytes = $identityBytes.Length
    sha256 = $identitySha256
  }
  latestManifest = $latestManifest
  processes = $processes
  mainProcess = $main
  listeners = $listeners
  backups = $backupDirectories
  updateEntries = $updateEntries
  previewReady = $previewReady
  desktopMcp = $desktopMcp
  productionReady = $productionReady
  productionObservation = [ordered]@{ action = 'read_only'; touched = $false }
  checks = [ordered]@{
    installedVersionExact = $versionInfo.ProductVersion -eq $ExpectedVersion
    installedFileVersionExact = $versionInfo.FileVersion -eq $ExpectedFileVersion
    installedExeHashExact = $exeSha256 -eq $ExpectedExeSha256.ToLowerInvariant()
    installedAsarHashExact = $asarSha256 -eq $ExpectedAsarSha256.ToLowerInvariant()
    rememberedIdentityHashExact = $identitySha256 -eq 'e004fe7fb4a8f9da43546be1cd53cc2894549eaacda5f578a00c304af20d98ff'
    previewReady = $previewReady.status -eq 'ready' -and [int]$previewReady.schemaVersion -eq 20
    productionReadyObserved = $productionReady.status -eq 'ready'
    productionObservationReadOnly = $true
  }
}
$result.passed = @($result.checks.Values) -notcontains $false
$json = $result | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $OutputPath), $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
$json
if (-not $result.passed) { exit 1 }
