param(
  [string]$PackageDirectory,
  [string]$LoginName = "Windows安装包验收账号",
  [string]$NodeExe = $env:QA_HUB_DESKTOP_NODE_EXE
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $desktopRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($PackageDirectory)) {
  $PackageDirectory = Join-Path $desktopRoot "release\RelayQaHub-win32-x64"
}
$packageRoot = (Resolve-Path -LiteralPath $PackageDirectory).Path
$exe = Join-Path $packageRoot "RelayQaHub.exe"
$runtimeConfig = Join-Path $packageRoot "desktop-runtime.json"
$smokeScript = Join-Path $repoRoot "scripts\desktop-cdp-smoke.mjs"
foreach ($requiredFile in @($exe, $runtimeConfig, $smokeScript)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Portable smoke prerequisite is missing: $requiredFile"
  }
}
if ([string]::IsNullOrWhiteSpace($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) {
    throw "NodeExe is required for the packaged CDP smoke"
  }
  $NodeExe = $nodeCommand.Source
}
if ([string]::IsNullOrWhiteSpace($LoginName) -or $LoginName.Length -gt 100 -or $LoginName -match '[\x00-\x1f\x7f]') {
  throw "LoginName must contain 1 to 100 visible characters"
}
if (Get-NetTCPConnection -State Listen -LocalPort 9333 -ErrorAction SilentlyContinue) {
  throw "CDP smoke port 9333 is already in use"
}
$existingPackageProcesses = @(
  Get-CimInstance Win32_Process -Filter "Name='RelayQaHub.exe'" |
    Where-Object {
      -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
      $_.ExecutablePath.StartsWith($packageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    }
)
if ($existingPackageProcesses.Count -gt 0) {
  throw "The packaged RelayQaHub is already running"
}

$smokeLeaf = "relay-qa-hub-portable-smoke-$([Guid]::NewGuid().ToString('N'))"
$smokeRoot = Join-Path ([IO.Path]::GetTempPath()) $smokeLeaf
New-Item -ItemType Directory -Path (Join-Path $smokeRoot "local") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $smokeRoot "roaming") -Force | Out-Null
$environmentNames = @(
  "LOCALAPPDATA",
  "APPDATA",
  "QA_HUB_DESKTOP_CONFIG_FILE",
  "QA_HUB_DESKTOP_PORTABLE_CONFIG_FILE",
  "QA_HUB_DESKTOP_ACCESS_TOKEN",
  "QA_HUB_DESKTOP_ACCESS_TOKEN_FILE",
  "QA_HUB_DESKTOP_API_BASE_URL",
  "QA_HUB_DESKTOP_WSS_URL",
  "QA_HUB_DESKTOP_CSRF_ORIGIN",
  "QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP",
  "QA_HUB_DESKTOP_ALLOW_PRIVATE_LAN_HTTP",
  "QA_HUB_DESKTOP_LOGIN_NAME"
)
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

$mainProcess = $null
try {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
  }
  $env:LOCALAPPDATA = Join-Path $smokeRoot "local"
  $env:APPDATA = Join-Path $smokeRoot "roaming"
  $mainProcess = Start-Process `
    -FilePath $exe `
    -ArgumentList @(
      "--hidden",
      "--remote-debugging-port=9333",
      "--user-data-dir=$(Join-Path $smokeRoot 'chromium')"
    ) `
    -WindowStyle Hidden `
    -PassThru

  $ready = $false
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($mainProcess.HasExited) { break }
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
  if (-not $ready) {
    throw "Packaged fresh-profile renderer did not become ready"
  }

  $snapshotOutput = & $NodeExe $smokeScript snapshot
  if ($LASTEXITCODE -ne 0) { throw "Packaged signed-out snapshot failed" }
  $snapshot = ($snapshotOutput | Select-Object -Last 1 | ConvertFrom-Json).snapshot
  if (-not $snapshot.loginVisible -or $snapshot.authUnavailable) {
    throw "Portable package did not reach the name login page"
  }
  if ($snapshot.desktopConnection.state -ne "disabled") {
    throw "Fresh portable package unexpectedly loaded a background notification credential"
  }

  $env:QA_HUB_DESKTOP_LOGIN_NAME = $LoginName
  $loginOutput = & $NodeExe $smokeScript login
  if ($LASTEXITCODE -ne 0) { throw "Packaged name login failed" }
  $login = ($loginOutput | Select-Object -Last 1 | ConvertFrom-Json).snapshot
  if (-not $login.appReady) {
    throw "Portable package login did not load the QA Hub workbench"
  }
  if ($login.workbenchLoading -or -not [string]::IsNullOrWhiteSpace([string]$login.workbenchErrorText)) {
    throw "Portable package login reached the shell but the real workbench API did not load"
  }
  $expectedSummaryLabels = @("待处理", "处理中", "待验收", "已完成")
  if ((@($login.summaryLabels) -join "|") -ne ($expectedSummaryLabels -join "|")) {
    throw "Packaged workbench shortcuts do not match the four lifecycle categories"
  }
  $notificationState = [string]$login.desktopConnection.state
  $notificationDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while ($notificationState -ne "connected" -and [DateTime]::UtcNow -lt $notificationDeadline) {
    Start-Sleep -Milliseconds 200
    $notificationOutput = & $NodeExe $smokeScript snapshot
    if ($LASTEXITCODE -ne 0) { throw "Packaged notification status snapshot failed" }
    $notificationSnapshot = ($notificationOutput | Select-Object -Last 1 | ConvertFrom-Json).snapshot
    $notificationState = [string]$notificationSnapshot.desktopConnection.state
  }
  if ($notificationState -ne "connected") {
    throw "Name login did not establish the browser-session notification stream: $notificationState"
  }

  $detailOutput = & $NodeExe $smokeScript open-first-bug
  if ($LASTEXITCODE -ne 0) { throw "Packaged Bug detail smoke failed" }
  $detail = ($detailOutput | Select-Object -Last 1 | ConvertFrom-Json).snapshot
  if (-not $detail.detailOpen -or $detail.detailLoadingVisible -or
      -not [string]::IsNullOrWhiteSpace([string]$detail.detailErrorText)) {
    throw "Portable package did not load the selected Bug detail"
  }
  if (-not $detail.pocoRegionVisible -or [string]::IsNullOrWhiteSpace([string]$detail.pocoRegionText)) {
    throw "Packaged Bug detail did not keep a visible Poco context region"
  }

  $overviewOutput = & $NodeExe $smokeScript open-overview
  if ($LASTEXITCODE -ne 0) { throw "Packaged Bug overview smoke failed" }
  $overview = ($overviewOutput | Select-Object -Last 1 | ConvertFrom-Json).snapshot
  if (-not $overview.overviewVisible -or $overview.overviewLoading -or
      -not [string]::IsNullOrWhiteSpace([string]$overview.overviewErrorText)) {
    throw "Portable package did not load the shared Bug overview"
  }
  $expectedOverviewHeaders = @("编号", "反馈问题", "优先级", "提报人", "负责人", "处理状态", "提出时间", "最后更新")
  if ((@($overview.overviewHeaders) -join "|") -ne ($expectedOverviewHeaders -join "|")) {
    throw "Packaged overview does not expose the dense shared-table columns"
  }
  if (-not $overview.overviewUnassignedFilterAvailable) {
    throw "Packaged overview does not expose the unassigned-owner filter"
  }
  if ([int]$overview.overviewRowCount -ne [int]$overview.overviewOwnerSelectCount) {
    throw "Packaged overview rows do not all expose direct owner assignment"
  }

  [pscustomobject][ordered]@{
    freshProfile = $true
    portableSidecarAutoLoaded = $true
    loginVisibleBeforeLogin = [bool]$snapshot.loginVisible
    apiUnavailableBeforeLogin = [bool]$snapshot.authUnavailable
    notificationsCredentialState = [string]$snapshot.desktopConnection.state
    notificationsAfterLogin = $notificationState
    nameLoginSucceeded = [bool]$login.appReady
    summaryLabels = @($login.summaryLabels) -join ", "
    bugRowCount = [int]$login.bugRowCount
    workbenchEmpty = [bool]$login.workbenchEmpty
    workbenchErrorText = [string]$login.workbenchErrorText
    bugDetailLoaded = [bool]($detail.detailOpen -and -not $detail.detailLoadingVisible)
    pocoRegionVisible = [bool]$detail.pocoRegionVisible
    bugDetailErrorText = [string]$detail.detailErrorText
    evidenceImageCount = [int]$detail.evidenceImageCount
    evidenceLoadedCount = [int]$detail.evidenceLoadedCount
    overviewLoaded = [bool]$overview.overviewVisible
    overviewRowCount = [int]$overview.overviewRowCount
    overviewOwnerSelectCount = [int]$overview.overviewOwnerSelectCount
    overviewUnassignedFilter = [bool]$overview.overviewUnassignedFilterAvailable
    overviewHeaders = @($overview.overviewHeaders) -join ", "
    rendererUrl = [string]$login.url
  }
} finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
  }
  $packageProcesses = @(
    Get-CimInstance Win32_Process -Filter "Name='RelayQaHub.exe'" |
      Where-Object {
        -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
        $_.ExecutablePath.StartsWith($packageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
      }
  )
  foreach ($process in $packageProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (
    (Get-CimInstance Win32_Process -Filter "Name='RelayQaHub.exe'" | Where-Object {
      -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
      $_.ExecutablePath.StartsWith($packageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    }) -and
    [DateTime]::UtcNow -lt $deadline
  ) {
    Start-Sleep -Milliseconds 100
  }
  if (Test-Path -LiteralPath $smokeRoot) {
    $resolvedSmokeRoot = (Resolve-Path -LiteralPath $smokeRoot).Path
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (
      -not $resolvedSmokeRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolvedSmokeRoot) -notmatch '^relay-qa-hub-portable-smoke-[0-9a-f]{32}$'
    ) {
      throw "Refusing to remove unsafe portable smoke directory"
    }
    Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
  }
}
