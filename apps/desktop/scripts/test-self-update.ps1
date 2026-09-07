param(
  [string]$PackageDirectory,
  [string]$NodeExe = $env:QA_HUB_DESKTOP_NODE_EXE,
  [string]$UpdateManifestUrl = "http://127.0.0.1:4174/downloads/Relay-QA-Hub-Windows-x64-latest.json",
  [string]$SupersededManifestFile,
  [string]$SupersededInstallerFile,
  [int]$McpPort = 4321
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $desktopRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($PackageDirectory)) {
  $PackageDirectory = Join-Path $desktopRoot "release\RelayQaHub-win32-x64"
}
$targetPackage = (Resolve-Path -LiteralPath $PackageDirectory).Path
$targetRuntime = Join-Path $targetPackage "desktop-runtime.json"
$targetUpdater = Join-Path $targetPackage "RelayQaHubUpdater.exe"
$packager = Join-Path $repoRoot "node_modules\.bin\electron-packager.cmd"
$cdpScript = Join-Path $repoRoot "scripts\desktop-cdp-smoke.mjs"
foreach ($required in @($targetRuntime, $targetUpdater, $packager, $cdpScript)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Self-update test prerequisite is missing: $required"
  }
}
if ([string]::IsNullOrWhiteSpace($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
  throw "NodeExe is required for the packaged self-update test"
}
if (Get-NetTCPConnection -State Listen -LocalPort 9333 -ErrorAction SilentlyContinue) {
  throw "Self-update CDP port 9333 is already in use"
}
if (Get-NetTCPConnection -State Listen -LocalPort $McpPort -ErrorAction SilentlyContinue) {
  throw "Self-update MCP port $McpPort is already in use"
}
if ([string]::IsNullOrWhiteSpace($SupersededManifestFile) -ne [string]::IsNullOrWhiteSpace($SupersededInstallerFile)) {
  throw "Superseded manifest and installer must be supplied together"
}

$manifest = Invoke-RestMethod -Uri $UpdateManifestUrl -TimeoutSec 10
if ([string]$manifest.releaseId -notmatch '^\d{8}T\d{9}Z$') {
  throw "The live update manifest has an invalid release ID"
}

$temporaryLeaf = "relay-qa-hub-self-update-$([Guid]::NewGuid().ToString('N'))"
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) $temporaryLeaf
$stageLeaf = ".self-update-stage-$([Guid]::NewGuid().ToString('N'))"
$stageRoot = Join-Path $desktopRoot $stageLeaf
$oldOutput = Join-Path $temporaryRoot "old"
$renamedPackage = Join-Path $oldOutput "QA Hub Renamed By User"
$appDataRoot = Join-Path $temporaryRoot "roaming"
$localAppDataRoot = Join-Path $temporaryRoot "local"
$chromiumRoot = Join-Path $temporaryRoot "chromium"
$oldReleaseId = "20000101T000000000Z"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "com.relayqahub.desktop"
$previousRunValue = (Get-ItemProperty -LiteralPath $runKey -Name $runValueName -ErrorAction SilentlyContinue).$runValueName
$previousEnvironment = @{}
foreach ($name in @("APPDATA", "LOCALAPPDATA")) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
$testProcesses = @()
$result = $null
$succeeded = $false
$channelProcess = $null
$channelOrigin = $null
$channelRequests = @()
$initialManifest = $manifest

try {
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $oldOutput -Force | Out-Null
  New-Item -ItemType Directory -Path $appDataRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $localAppDataRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $chromiumRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $desktopRoot "package.json") -Destination $stageRoot
  Copy-Item -LiteralPath (Join-Path $desktopRoot "dist") -Destination (Join-Path $stageRoot "dist") -Recurse
  Copy-Item -LiteralPath (Join-Path $repoRoot "apps\web\dist") -Destination (Join-Path $stageRoot "web") -Recurse
  $encoding = [Text.UTF8Encoding]::new($false)
  if (-not [string]::IsNullOrWhiteSpace($SupersededManifestFile)) {
    $initialManifest = Get-Content -LiteralPath $SupersededManifestFile -Raw | ConvertFrom-Json
    $channelReadyFile = Join-Path $temporaryRoot "channel-ready.json"
    $channelAdvanceFile = Join-Path $temporaryRoot "channel-advance"
    $channelReceiptFile = Join-Path $temporaryRoot "channel-requests.json"
    $channelConfigFile = Join-Path $temporaryRoot "channel-config.json"
    $channelConfig = @{
      readyFile = $channelReadyFile
      advanceFile = $channelAdvanceFile
      receiptFile = $channelReceiptFile
      releases = @(
        @{ manifestFile = (Resolve-Path -LiteralPath $SupersededManifestFile).Path; installerFile = (Resolve-Path -LiteralPath $SupersededInstallerFile).Path },
        @{ manifestFile = (Join-Path $desktopRoot "release\installer\Relay-QA-Hub-Windows-x64-latest.json"); installerFile = (Join-Path $desktopRoot "release\installer\Relay-QA-Hub-Setup-x64.exe") }
      )
    }
    [IO.File]::WriteAllText($channelConfigFile, ($channelConfig | ConvertTo-Json -Depth 5), $encoding)
    $channelScript = Join-Path $PSScriptRoot "self-update-test-channel.mjs"
    $channelProcess = Start-Process -FilePath $NodeExe `
      -ArgumentList @("`"$channelScript`"", "`"$channelConfigFile`"") `
      -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $temporaryRoot "channel.stdout.log") `
      -RedirectStandardError (Join-Path $temporaryRoot "channel.stderr.log")
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath $channelReadyFile)) {
      if ($channelProcess.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw "Isolated update channel did not start" }
      Start-Sleep -Milliseconds 100
    }
    $channelOrigin = [string](Get-Content -LiteralPath $channelReadyFile -Raw | ConvertFrom-Json).origin
  }
  $oldRelease = [ordered]@{
    schemaVersion = 1
    releaseId = $oldReleaseId
    version = "0.1.0-debug"
  }
  [IO.File]::WriteAllText(
    (Join-Path $stageRoot "release.json"),
    (($oldRelease | ConvertTo-Json -Depth 3) + [Environment]::NewLine),
    $encoding
  )
  $env:PATH = "$(Split-Path -Parent $NodeExe);$env:PATH"
  & $packager $stageRoot "RelayQaHub" --platform=win32 --arch=x64 --out=$oldOutput --overwrite --prune=true --asar
  if ($LASTEXITCODE -ne 0) { throw "Old-client packaging failed with exit code $LASTEXITCODE" }
  $packagedSource = (Resolve-Path -LiteralPath (Join-Path $oldOutput "RelayQaHub-win32-x64")).Path
  $outputPrefix = [IO.Path]::GetFullPath($oldOutput).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $packagedSource.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not [IO.Path]::GetFullPath($renamedPackage).StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe self-update package move"
  }
  Move-Item -LiteralPath $packagedSource -Destination $renamedPackage
  Copy-Item -LiteralPath $targetUpdater -Destination (Join-Path $renamedPackage "RelayQaHubUpdater.exe") -Force

  $runtime = Get-Content -LiteralPath $targetRuntime -Raw | ConvertFrom-Json
  $runtime.startupHidden = $true
  $runtime.mcpPort = $McpPort
  if ($null -ne $channelOrigin) {
    $runtime.csrfOrigin = $channelOrigin
    $runtime | Add-Member -NotePropertyName allowLoopbackHttp -NotePropertyValue $true -Force
  }
  [IO.File]::WriteAllText(
    (Join-Path $renamedPackage "desktop-runtime.json"),
    (($runtime | ConvertTo-Json -Depth 5) + [Environment]::NewLine),
    $encoding
  )
  $runtimeHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $renamedPackage "desktop-runtime.json")).Hash
  [IO.File]::WriteAllText(
    (Join-Path $chromiumRoot "auto-start-default-v1"),
    "already-configured" + [Environment]::NewLine,
    $encoding
  )
  $env:APPDATA = $appDataRoot
  $env:LOCALAPPDATA = $localAppDataRoot
  $oldExe = Join-Path $renamedPackage "RelayQaHub.exe"
  $oldProcess = Start-Process `
    -FilePath $oldExe `
    -ArgumentList @("--hidden", "--remote-debugging-port=9333", "--user-data-dir=$chromiumRoot") `
    -WindowStyle Hidden `
    -PassThru
  $testProcesses += $oldProcess.Id

  $ready = $false
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($oldProcess.HasExited) { break }
    try {
      $targets = Invoke-RestMethod -Uri "http://127.0.0.1:9333/json" -TimeoutSec 2
      if (@($targets | Where-Object { $_.type -eq "page" -and $_.url -like "qa-hub://app/*" }).Count -gt 0) {
        $ready = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }
  if (-not $ready) { throw "Old packaged client did not expose its renderer" }

  $readyOutput = & $NodeExe $cdpScript wait-update-ready
  if ($LASTEXITCODE -ne 0) { throw "Old packaged client did not download the signed update" }
  $readyState = ($readyOutput | Select-Object -Last 1 | ConvertFrom-Json).snapshot.desktopUpdate
  if ([string]$readyState.releaseId -ne [string]$initialManifest.releaseId) {
    throw "Old packaged client downloaded an unexpected release"
  }
  if ($null -ne $channelOrigin) {
    [IO.File]::WriteAllText($channelAdvanceFile, "latest", $encoding)
  }
  $installOutput = & $NodeExe $cdpScript install-update
  if ($LASTEXITCODE -ne 0) { throw "Old packaged client did not accept install-update" }

  $resultFile = $null
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while ([DateTime]::UtcNow -lt $deadline) {
    $matches = @(Get-ChildItem -LiteralPath $temporaryRoot -Filter "last-update-result.json" -Recurse -File -ErrorAction SilentlyContinue)
    if ($matches.Count -eq 1) {
      $candidate = [IO.File]::ReadAllText($matches[0].FullName, [Text.Encoding]::Unicode) | ConvertFrom-Json
      if ([string]$candidate.status -eq "installed") {
        $resultFile = $matches[0].FullName
        break
      }
      if ([string]$candidate.status -eq "failed") {
        throw "Update helper reported failure: $($candidate.message)"
      }
    }
    Start-Sleep -Milliseconds 250
  }
  if ($null -eq $resultFile) { throw "Update helper did not report installation success" }

  $updatedProcesses = @()
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $updatedProcesses = @(
      Get-CimInstance Win32_Process -Filter "Name='RelayQaHub.exe'" |
        Where-Object {
          -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
          $_.ExecutablePath.StartsWith($renamedPackage + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
        }
    )
    if ($updatedProcesses.Count -gt 0) { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($updatedProcesses.Count -lt 1) { throw "Updated client was not relaunched" }
  $sameProfileProcesses = @($updatedProcesses | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and $_.CommandLine.Contains($chromiumRoot)
  })
  if ($sameProfileProcesses.Count -lt 1) { throw "Updated client did not retain its user profile directory" }
  $testProcesses += @($updatedProcesses.ProcessId)

  $asarFile = Join-Path $renamedPackage "resources\app.asar"
  $releaseText = & $NodeExe -e "const asar=require('@electron/asar');process.stdout.write(asar.extractFile(process.argv[1],'release.json').toString())" $asarFile
  if ($LASTEXITCODE -ne 0) { throw "Installed release descriptor extraction failed" }
  $installedRelease = ($releaseText -join [Environment]::NewLine) | ConvertFrom-Json
  if ([string]$installedRelease.releaseId -ne [string]$manifest.releaseId) {
    throw "Installed release ID does not match the live signed manifest"
  }
  $runtimeHashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $renamedPackage "desktop-runtime.json")).Hash
  if ($runtimeHashAfter -ne $runtimeHashBefore) { throw "Portable runtime config was not preserved" }
  $backupDirectories = @(Get-ChildItem -LiteralPath $oldOutput -Directory -Filter "QA Hub Renamed By User.backup-*")
  if ($backupDirectories.Count -ne 1) { throw "Updater did not retain exactly one rollback directory" }
  $logFile = @(Get-ChildItem -LiteralPath $temporaryRoot -Filter "update.log" -Recurse -File)[0]
  $logText = [IO.File]::ReadAllText($logFile.FullName, [Text.Encoding]::Unicode)
  if ($logText -notlike "*update installed*") { throw "Update helper success was not logged" }
  if ($null -ne $channelOrigin) {
    $channelRequests = @(Get-Content -LiteralPath $channelReceiptFile -Raw | ConvertFrom-Json)
    $installerRequests = @($channelRequests | Where-Object { $_.kind -eq "installer" })
    if ($installerRequests.Count -ne 2 -or
        $installerRequests[0].releaseId -ne $initialManifest.releaseId -or
        $installerRequests[1].releaseId -ne $manifest.releaseId) {
      throw "Expected exactly one cached old download and one latest download"
    }
    $handoffs = @(Get-ChildItem -LiteralPath $chromiumRoot -Filter "update.ini" -Recurse -File)
    if ($handoffs.Count -ne 1 -or
        [IO.File]::ReadAllText($handoffs[0].FullName, [Text.Encoding]::Unicode) -notlike "*ReleaseId=$($manifest.releaseId)*") {
      throw "Expected one native handoff directly to the latest release"
    }
  }

  $result = [pscustomobject][ordered]@{
    renamedPortableDirectory = $true
    oldReleaseId = $oldReleaseId
    initiallyDownloadedReleaseId = [string]$initialManifest.releaseId
    installedReleaseId = [string]$installedRelease.releaseId
    signedManifestReleaseId = [string]$manifest.releaseId
    installResult = "installed"
    relaunched = $true
    userProfilePreserved = $true
    runtimeConfigPreserved = $true
    rollbackDirectoryRetained = $true
    channelRequests = $channelRequests
    supersededDownloadSkipped = $null -ne $channelOrigin
  }
  $succeeded = $true
} finally {
  if ($null -ne $channelProcess -and -not $channelProcess.HasExited) { $channelProcess.Kill() }
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='RelayQaHub.exe'" -ErrorAction SilentlyContinue)) {
    if (-not [string]::IsNullOrWhiteSpace($process.ExecutablePath) -and
        $process.ExecutablePath.StartsWith($temporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  if ($null -eq $previousRunValue) {
    Remove-ItemProperty -LiteralPath $runKey -Name $runValueName -ErrorAction SilentlyContinue
  } else {
    Set-ItemProperty -LiteralPath $runKey -Name $runValueName -Value $previousRunValue
  }
  foreach ($name in @("APPDATA", "LOCALAPPDATA")) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
  }
  if (Test-Path -LiteralPath $stageRoot) {
    $resolvedStageRoot = (Resolve-Path -LiteralPath $stageRoot).Path
    $desktopPrefix = $desktopRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedStageRoot.StartsWith($desktopPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedStageRoot) -notmatch '^\.self-update-stage-[0-9a-f]{32}$') {
      throw "Refusing to remove unsafe self-update stage directory"
    }
    Remove-Item -LiteralPath $resolvedStageRoot -Recurse -Force
  }
  if ($succeeded -and (Test-Path -LiteralPath $temporaryRoot)) {
    $resolvedTemporaryRoot = (Resolve-Path -LiteralPath $temporaryRoot).Path
    $temporaryPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedTemporaryRoot.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedTemporaryRoot) -notmatch '^relay-qa-hub-self-update-[0-9a-f]{32}$') {
      throw "Refusing to remove unsafe self-update test directory"
    }
    Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
  }
}

$result
