$ErrorActionPreference = 'Stop'
$evidenceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeRoot = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-v21-e2e-fresh-0910'
$profile = Join-Path $runtimeRoot 'desktop\profile'
$updates = Join-Path $profile 'updates'
$releaseId = '20260910T135324626Z'
$version = '0.2.0-preview.17'
$oldMainPid = 26836
$installedRoot = 'C:\Users\lin0\AppData\Local\Programs\RelayQaHubPreview-v21-e2e-fresh-0910'
$exe = Join-Path $installedRoot 'RelayQaHubPreview-v21-e2e-fresh-0910.exe'
$asar = Join-Path $installedRoot 'resources\app.asar'
$updaterDirectories = @(Get-ChildItem -LiteralPath $updates -Directory -Filter ("updater-$releaseId-$oldMainPid-*") | Sort-Object Name)
if ($updaterDirectories.Count -ne 1) { throw "EXACT_UPDATER_DIRECTORY_REQUIRED:$($updaterDirectories.Count)" }
$updaterDirectory = $updaterDirectories[0].FullName

function Read-UnicodeText([string]$Path) {
  return (Get-Content -LiteralPath $Path -Raw -Encoding Unicode).TrimStart([char]0xfeff).Trim()
}
function Hash([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$iniText = Read-UnicodeText (Join-Path $updaterDirectory 'update.ini')
$ini = [ordered]@{}
foreach ($line in ($iniText -split "`r?`n")) {
  if ($line -match '^([^=]+)=(.*)$') { $ini[$Matches[1]] = $Matches[2] }
}
$logLines = @((Read-UnicodeText (Join-Path $updaterDirectory 'update.log')) -split "`r?`n")
$readyFlag = Read-UnicodeText (Join-Path $updaterDirectory 'ready.flag')
$relaunchMarker = Get-Content -LiteralPath (Join-Path $updaterDirectory 'relaunched.flag') -Raw -Encoding utf8 | ConvertFrom-Json
$installResult = Read-UnicodeText (Join-Path $updates 'last-update-result.json') | ConvertFrom-Json
$packagePath = Join-Path $updates "$releaseId.exe"
$updaterPath = Join-Path $updaterDirectory 'RelayQaHubUpdater.exe'
$portableUpdaterPath = Join-Path $runtimeRoot 'packages\20260910T135324626Z\portable\RelayQaHubPreview-v21-e2e-fresh-0910-win32-x64\RelayQaHubUpdater.exe'
$backupRoot = "$installedRoot.backup-$releaseId"
$backupExe = Join-Path $backupRoot 'RelayQaHubPreview-v21-e2e-fresh-0910.exe'
$backupAsar = Join-Path $backupRoot 'resources\app.asar'
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe })
$mainProcesses = @($processes | Where-Object { $_.CommandLine -notmatch ' --type=' })
$main = if ($mainProcesses.Count -eq 1) { $mainProcesses[0] } else { $null }
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(4174, 4319, 4320, 4639, 4640, 4641, 4642, 9333, 9433) } | Sort-Object LocalPort | ForEach-Object {
  [ordered]@{ address = $_.LocalAddress; port = $_.LocalPort; pid = $_.OwningProcess }
})
$initializeBody = @{
  jsonrpc = '2.0'
  id = 1
  method = 'initialize'
  params = @{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'build17-upgrade-verifier'; version = '1.0.0' } }
} | ConvertTo-Json -Depth 10
$mcpInitialize = Invoke-RestMethod -Uri 'http://127.0.0.1:4642/mcp' -Method Post -Headers @{ Accept = 'application/json, text/event-stream' } -ContentType 'application/json' -Body $initializeBody
$before = Get-Content -LiteralPath (Join-Path $evidenceRoot 'before-launch.json') -Raw | ConvertFrom-Json
$after = Get-Content -LiteralPath (Join-Path $evidenceRoot 'after-auto-relaunch.json') -Raw | ConvertFrom-Json
$preservedPorts = @(4174, 4319, 4320, 4639, 4640, 4641, 9333)
$preservedOwners = $true
foreach ($port in $preservedPorts) {
  $beforeOwner = @($before.listeners | Where-Object { $_.port -eq $port })
  $afterOwner = @($after.listeners | Where-Object { $_.port -eq $port })
  if ($beforeOwner.Count -ne 1 -or $afterOwner.Count -ne 1 -or $beforeOwner[0].pid -ne $afterOwner[0].pid) { $preservedOwners = $false }
}
$expectedLogLines = @(
  'native updater started',
  'handoff validated',
  'main process exited; starting installer',
  'update installed; relaunching application',
  'application relaunch acknowledged'
)
$expectedCommand = "`"$exe`" --updated --user-data-dir=`"$profile`" --update-relaunch-marker=`"$(Join-Path $updaterDirectory 'relaunched.flag')`""
$checks = [ordered]@{
  exactUpdaterDirectory = $updaterDirectories.Count -eq 1
  iniPackageExact = $ini.PackagePath -eq $packagePath
  iniAppExact = $ini.AppPath -eq $exe
  iniProfileExact = $ini.UserDataPath -eq $profile
  iniParentExact = $ini.ParentPid -eq [string]$oldMainPid
  iniResultExact = $ini.ResultPath -eq (Join-Path $updates 'last-update-result.json')
  iniReleaseExact = $ini.ReleaseId -eq $releaseId
  iniVersionExact = $ini.Version -eq $version
  updatePackageBytesExact = (Get-Item -LiteralPath $packagePath).Length -eq 108488136
  updatePackageHashExact = (Hash $packagePath) -eq '1c67b6555ffeeefff3ce885acfd09735dc6bc650570e3b53d109c8ad617d11d4'
  updaterBinaryExact = (Hash $updaterPath) -eq (Hash $portableUpdaterPath)
  readyFlagExact = $readyFlag -eq "ready:$releaseId"
  logSequenceExact = ($logLines.Count -eq $expectedLogLines.Count) -and -not (Compare-Object -ReferenceObject $expectedLogLines -DifferenceObject $logLines -SyncWindow 0)
  installResultExact = $installResult.status -eq 'installed' -and $installResult.releaseId -eq $releaseId -and $installResult.version -eq $version
  oneAutoRelaunchMain = $mainProcesses.Count -eq 1
  autoRelaunchCommandExact = $main.CommandLine -eq $expectedCommand
  relaunchMarkerExact = $relaunchMarker.status -eq 'ready' -and $relaunchMarker.version -eq $version -and [int]$relaunchMarker.pid -eq [int]$main.ProcessId
  installedVersionExact = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion -eq $version
  installedExeHashExact = (Hash $exe) -eq '58c21fdc87e3b5007df9d30e59a27df67e24516f7c74c61d7fb545d8c54d4f0f'
  installedAsarHashExact = (Hash $asar) -eq 'ff3b49304c7f98ec754bd42ef9732cd6b58718002b3f4be8ae0ae506e69b7474'
  rollbackBackupVersion16 = (Get-Item -LiteralPath $backupExe).VersionInfo.ProductVersion -eq '0.2.0-preview.16'
  rollbackBackupExeHashExact = (Hash $backupExe) -eq '15974f3d818980bc0b1a341ecbe2636b9018c3ad4958a60ba2367648a64511c5'
  rollbackBackupAsarHashExact = (Hash $backupAsar) -eq '4d47c054aa4aa62fb23c99a5c437213663228003277ea0a58276252df0c75203'
  desktopMcpOwnedByRelaunch = @($listeners | Where-Object { $_.port -eq 4642 -and $_.pid -eq $main.ProcessId }).Count -eq 1
  cdpAbsentOnAutoRelaunch = @($listeners | Where-Object { $_.port -eq 9433 }).Count -eq 0
  desktopMcpVersion17 = $mcpInitialize.result.serverInfo.version -eq $version
  productionAndPreviewServiceOwnersPreserved = $preservedOwners
  productionObservationReadOnly = $true
}
$result = [ordered]@{
  schemaVersion = 1
  capturedAt = [DateTime]::UtcNow.ToString('o')
  transition = [ordered]@{ fromVersion = '0.2.0-preview.16'; toVersion = $version; releaseId = $releaseId; sourceCommit = 'c4e2eb7d9341a16d2430df9073a93f44f381dd2b' }
  updaterDirectory = $updaterDirectory
  ini = $ini
  updateLogLines = $logLines
  readyFlag = $readyFlag
  installResult = $installResult
  relaunchMarker = $relaunchMarker
  mainProcess = $main | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine
  installed = [ordered]@{ exeSha256 = Hash $exe; asarSha256 = Hash $asar; version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion }
  rollbackBackup = [ordered]@{ path = $backupRoot; version = (Get-Item -LiteralPath $backupExe).VersionInfo.ProductVersion; exeSha256 = Hash $backupExe; asarSha256 = Hash $backupAsar }
  mcpInitialize = $mcpInitialize
  listeners = $listeners
  checks = $checks
  productionObservation = [ordered]@{ action = 'read_only'; touched = $false }
}
$result.passed = @($checks.Values) -notcontains $false
$json = $result | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText((Join-Path $evidenceRoot 'auto-relaunch-verification.json'), $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
$json
if (-not $result.passed) { exit 1 }
