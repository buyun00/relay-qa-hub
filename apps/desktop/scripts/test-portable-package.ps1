param(
  [string]$PackageDirectory,
  [string]$LoginName = "Windows安装包验收账号",
  [string]$NodeExe = $env:QA_HUB_DESKTOP_NODE_EXE,
  [ValidateRange(1, 65535)][int]$McpPort = 4320,
  [switch]$VerifyPackagingNotification
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
$asarArchive = Join-Path $packageRoot "resources\app.asar"
$asarCli = Join-Path $repoRoot "node_modules\@electron\asar\bin\asar.js"
$smokeScript = Join-Path $repoRoot "scripts\desktop-cdp-smoke.mjs"
foreach ($requiredFile in @($exe, $runtimeConfig, $asarArchive, $asarCli, $smokeScript)) {
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

function Invoke-QAHubMcpRequest {
  param(
    [Parameter(Mandatory = $true)][int]$Id,
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)]$Params
  )
  $body = [ordered]@{
    jsonrpc = "2.0"
    id = $Id
    method = $Method
    params = $Params
  } | ConvertTo-Json -Depth 20 -Compress
  Invoke-RestMethod `
    -Uri "http://127.0.0.1:$McpPort/mcp" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body `
    -TimeoutSec 10
}

$archiveEntries = @(& $NodeExe $asarCli list $asarArchive)
if ($LASTEXITCODE -ne 0 -or $archiveEntries -notcontains "\assets\RelayQaHub.ico") {
  throw "Portable package does not contain the branded Windows tray icon"
}
if (Get-NetTCPConnection -State Listen -LocalPort 9333 -ErrorAction SilentlyContinue) {
  throw "CDP smoke port 9333 is already in use"
}
if (Get-NetTCPConnection -State Listen -LocalPort $McpPort -ErrorAction SilentlyContinue) {
  throw "MCP smoke port $McpPort is already in use"
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

$startupRunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$startupSnapshot = @{}
foreach ($startupName in @("com.relayqahub.desktop", "Relay QA Hub")) {
  try {
    $startupSnapshot[$startupName] = [pscustomobject]@{
      present = $true
      value = Get-ItemPropertyValue -LiteralPath $startupRunKey -Name $startupName -ErrorAction Stop
    }
  } catch {
    $startupSnapshot[$startupName] = [pscustomobject]@{ present = $false; value = $null }
  }
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
$packagingNotificationProof = $null
$nativeOutput = Join-Path $smokeRoot 'native.stdout.log'
$nativeError = Join-Path $smokeRoot 'native.stderr.log'
try {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
  }
  $env:QA_HUB_DESKTOP_MCP_PORT = [string]$McpPort
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
    -RedirectStandardOutput $nativeOutput `
    -RedirectStandardError $nativeError `
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

  $mcpReady = $false
  $mcpDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $mcpDeadline) {
    try {
      $mcpHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$McpPort/health" -TimeoutSec 2
      if ($mcpHealth.status -eq "ready") {
        $mcpReady = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }
  if (-not $mcpReady) {
    throw "Packaged EXE MCP endpoint did not become ready"
  }
  $mcpInitialize = Invoke-QAHubMcpRequest `
    -Id 1 `
    -Method "initialize" `
    -Params ([ordered]@{
      protocolVersion = "2025-06-18"
      capabilities = [ordered]@{}
      clientInfo = [ordered]@{ name = "qa-hub-package-smoke"; version = "1" }
    })
  if ($mcpInitialize.result.serverInfo.name -ne "relay-qa-hub-desktop") {
    throw "Packaged EXE MCP initialization returned the wrong server identity"
  }
  $mcpTools = Invoke-QAHubMcpRequest -Id 2 -Method "tools/list" -Params ([ordered]@{})
  $expectedMcpTools = @(
    "qa_list_projects",
    "qa_list_bugs",
    "qa_get_bug_context",
    "qa_materialize_attachment",
    "qa_begin_fix",
    "qa_add_comment",
    "qa_submit_fix",
    "qa_resolve_qingyu_bug"
  )
  if ((@($mcpTools.result.tools.name) -join "|") -ne ($expectedMcpTools -join "|")) {
    throw "Packaged EXE MCP tool list is incomplete"
  }
  $mcpSignedOut = Invoke-QAHubMcpRequest `
    -Id 3 `
    -Method "tools/call" `
    -Params ([ordered]@{ name = "qa_list_projects"; arguments = [ordered]@{} })
  if (-not $mcpSignedOut.result.isError -or
      [string]$mcpSignedOut.result.content[0].text -notmatch 'QA_HUB_LOGIN_REQUIRED') {
    throw "Packaged EXE MCP did not fail closed before browser login"
  }

  $snapshotOutput = & $NodeExe $smokeScript snapshot
  if ($LASTEXITCODE -ne 0) { throw "Packaged signed-out snapshot failed" }
  $snapshot = ($snapshotOutput | Select-Object -Last 1 | ConvertFrom-Json).snapshot
  if (-not $snapshot.desktopPackagingBridgeAvailable) {
    throw "Packaged build progress notification bridge is unavailable"
  }
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
  if ($VerifyPackagingNotification) {
    $packagingOutput = & $NodeExe $smokeScript notify-packaging
    if ($LASTEXITCODE -ne 0) { throw "Packaged system notification request failed" }
    $delivery = ($packagingOutput | Select-Object -Last 1 | ConvertFrom-Json).delivery
    $notificationShown = $false
    $packagingDeadline = [DateTime]::UtcNow.AddSeconds(12)
    while ([DateTime]::UtcNow -lt $packagingDeadline) {
      $nativeLines = @(Get-Content -LiteralPath $nativeOutput -ErrorAction SilentlyContinue)
      foreach ($nativeLine in $nativeLines) {
        if ($nativeLine -notmatch 'desktop.packaging.notification.shown') { continue }
        try {
          $nativeEvent = $nativeLine | ConvertFrom-Json
          if ($nativeEvent.id -eq $delivery.id) { $notificationShown = $true }
        } catch { }
      }
      if ($notificationShown) { break }
      Start-Sleep -Milliseconds 200
    }
    if (-not $notificationShown) { throw "Windows did not acknowledge the packaging system notification" }
    $packagingNotificationProof = [ordered]@{
      id = $delivery.id
      nativeShown = $notificationShown
      duplicateSuppressed = -not [bool]$delivery.duplicate
      inAppNotificationCount = [int]$delivery.inAppNotificationCount
    }
  }
  $mcpSignedIn = Invoke-QAHubMcpRequest `
    -Id 4 `
    -Method "tools/call" `
    -Params ([ordered]@{ name = "qa_list_projects"; arguments = [ordered]@{} })
  if ($mcpSignedIn.result.isError -or
      [string]$mcpSignedIn.result.content[0].text -notmatch 'projects') {
    throw "Packaged EXE MCP did not reuse the browser login session"
  }
  $mcpBugList = Invoke-QAHubMcpRequest `
    -Id 5 `
    -Method "tools/call" `
    -Params ([ordered]@{
      name = "qa_list_bugs"
      arguments = [ordered]@{ limit = 5 }
    })
  if ($mcpBugList.result.isError -or $null -eq $mcpBugList.result.structuredContent.items) {
    throw "Packaged EXE MCP could not read the current Bug list"
  }
  $mcpBugReadCount = @($mcpBugList.result.structuredContent.items).Count
  $mcpContextReadSucceeded = $false
  if ($mcpBugReadCount -gt 0) {
    $mcpBugId = [string]$mcpBugList.result.structuredContent.items[0].id
    $mcpBugContext = Invoke-QAHubMcpRequest `
      -Id 6 `
      -Method "tools/call" `
      -Params ([ordered]@{
        name = "qa_get_bug_context"
        arguments = [ordered]@{ bugId = $mcpBugId }
      })
    if ($mcpBugContext.result.isError -or
        [string]$mcpBugContext.result.structuredContent.bug.id -ne $mcpBugId) {
      throw "Packaged EXE MCP could not read complete context for a current Bug"
    }
    $mcpContextReadSucceeded = $true
  }
  if ($login.workbenchLoading -or -not [string]::IsNullOrWhiteSpace([string]$login.workbenchErrorText)) {
    throw "Portable package login reached the shell but the real workbench API did not load"
  }
  $expectedSummaryLabels = @("待处理", "处理中", "已完成待验收", "关闭")
  if ((@($login.summaryLabels) -join "|") -ne ($expectedSummaryLabels -join "|")) {
    throw "Packaged workbench shortcuts do not match the four task statuses"
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

  $qingyuOutput = & $NodeExe $smokeScript open-qingyu
  $qingyuExitCode = $LASTEXITCODE
  $qingyu = ($qingyuOutput | Select-Object -Last 1 | ConvertFrom-Json)
  if ($qingyuExitCode -ne 0) {
    throw "Packaged Qingyu import smoke failed: $($qingyu | ConvertTo-Json -Depth 20 -Compress)"
  }
  if (-not $qingyu.snapshot.qingyuModalVisible -or
      (-not $qingyu.snapshot.qingyuQrVisible -and -not $qingyu.snapshot.qingyuWorkspaceVisible) -or
      -not [string]::IsNullOrWhiteSpace([string]$qingyu.snapshot.qingyuErrorText)) {
    throw "Packaged Qingyu import did not render its login or connected workspace without an error"
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
  if (-not $detail.detailEditTriggerVisible) {
    throw "Packaged Bug detail does not expose manual editing"
  }
  if (-not $detail.detailDeleteTriggerVisible) {
    throw "Packaged Bug detail does not expose deletion"
  }
  $detailEditorOutput = & $NodeExe $smokeScript open-bug-editor
  if ($LASTEXITCODE -ne 0) { throw "Packaged Bug detail editor smoke failed" }
  $detailEditor = ($detailEditorOutput | Select-Object -Last 1 | ConvertFrom-Json).snapshot
  if (-not $detailEditor.detailEditorVisible -or
      [int]$detailEditor.detailEditorFieldCount -ne 6 -or
      -not $detailEditor.detailEditorImageInputVisible) {
    throw "Packaged Bug detail editor does not expose all editable fields and image input"
  }

  $overviewOutput = & $NodeExe $smokeScript open-overview
  if ($LASTEXITCODE -ne 0) { throw "Packaged Bug overview smoke failed" }
  $overview = ($overviewOutput | Select-Object -Last 1 | ConvertFrom-Json).snapshot
  if (-not $overview.overviewVisible -or $overview.overviewLoading -or
      -not [string]::IsNullOrWhiteSpace([string]$overview.overviewErrorText)) {
    throw "Portable package did not load the shared Bug overview"
  }
  $expectedOverviewHeaders = @("编号", "反馈问题", "负责人", "关闭人", "处理状态", "提出时间", "最后更新")
  if ((@($overview.overviewHeaders) -join "|") -ne ($expectedOverviewHeaders -join "|")) {
    throw "Packaged overview does not expose the dense shared-table columns"
  }
  if (-not $overview.overviewUnassignedFilterAvailable) {
    throw "Packaged overview does not expose the unassigned-owner filter"
  }
  if (-not $overview.overviewDateNavVisible -or
      -not $overview.overviewDatePickerVisible) {
    throw "Packaged overview does not expose creation-date subpages"
  }
  if ([int]$overview.overviewRowCount -gt 0 -and [int]$overview.overviewDatePageCount -lt 1) {
    throw "Packaged overview did not classify its Bugs into creation-date subpages"
  }
  if ([int]$overview.overviewRowCount -ne [int]$overview.overviewOwnerSelectCount) {
    throw "Packaged overview rows do not all expose direct owner assignment"
  }
  if ([int]$overview.overviewRowCount -ne [int]$overview.overviewVerifierSelectCount) {
    throw "Packaged overview rows do not all expose direct verifier assignment"
  }
  if ([int]$overview.overviewRowCount -ne [int]$overview.overviewPrioritySelectCount) {
    throw "Packaged overview numbers do not all expose direct priority assignment"
  }
  if ([int]$overview.overviewRowCount -ne [int]$overview.overviewPriorityLabelCount) {
    throw "Packaged overview numbers do not all display their compact priority label"
  }
  if (@($overview.overviewDisplayedKeys | Where-Object { $_ -match '^LOCAL-' }).Count -ne 0) {
    throw "Packaged overview still displays the LOCAL- task-number prefix"
  }
  if ([int]$overview.overviewTitleSupplementCount -ne 0) {
    throw "Packaged overview still displays expected-behavior supplement text under the issue"
  }
  if ([int]$overview.overviewRowCount -ne [int]$overview.overviewWrappedTitleCount) {
    throw "Packaged overview issue text does not wrap in every row"
  }
  if ([int]$overview.overviewRowCount -ne [int]$overview.overviewLargeTitleCount) {
    throw "Packaged overview issue text is not enlarged in every row"
  }
  if ([int]$overview.overviewColumnResizerCount -ne $expectedOverviewHeaders.Count) {
    throw "Packaged overview columns do not all expose drag resize handles"
  }

  $overviewSelectedDate = ""
  $overviewSelectedDateRowCount = 0
  if ([int]$overview.overviewRowCount -gt 0) {
    $datePageOutput = & $NodeExe $smokeScript select-overview-date
    if ($LASTEXITCODE -ne 0) { throw "Packaged overview creation-date filter smoke failed" }
    $datePage = ($datePageOutput | Select-Object -Last 1 | ConvertFrom-Json)
    if ([string]::IsNullOrWhiteSpace([string]$datePage.snapshot.overviewSelectedDate) -or
        [string]$datePage.snapshot.overviewSelectedDate -ne [string]$datePage.selection.date -or
        [int]$datePage.snapshot.overviewRowCount -ne [int]$datePage.selection.expectedCount -or
        @($datePage.snapshot.overviewRowDateKeys | Where-Object {
          $_ -ne [string]$datePage.snapshot.overviewSelectedDate
        }).Count -ne 0) {
      throw "Packaged overview date page did not restrict the right-hand list to the selected day"
    }
    $overviewSelectedDate = [string]$datePage.snapshot.overviewSelectedDate
    $overviewSelectedDateRowCount = [int]$datePage.snapshot.overviewRowCount
  }

  [pscustomobject][ordered]@{
    freshProfile = $true
    portableSidecarAutoLoaded = $true
    loginVisibleBeforeLogin = [bool]$snapshot.loginVisible
    apiUnavailableBeforeLogin = [bool]$snapshot.authUnavailable
    notificationsCredentialState = [string]$snapshot.desktopConnection.state
    notificationsAfterLogin = $notificationState
    packagingSystemNotification = $packagingNotificationProof
    mcpReady = $mcpReady
    mcpToolCount = @($mcpTools.result.tools).Count
    mcpSignedOutFailedClosed = [bool]$mcpSignedOut.result.isError
    mcpSignedInReadSucceeded = -not [bool]$mcpSignedIn.result.isError
    mcpBugReadCount = $mcpBugReadCount
    mcpContextReadSucceeded = $mcpContextReadSucceeded
    nameLoginSucceeded = [bool]$login.appReady
    summaryLabels = @($login.summaryLabels) -join ", "
    bugRowCount = [int]$login.bugRowCount
    workbenchEmpty = [bool]$login.workbenchEmpty
    workbenchErrorText = [string]$login.workbenchErrorText
    bugDetailLoaded = [bool]($detail.detailOpen -and -not $detail.detailLoadingVisible)
    bugDetailEditAvailable = [bool]$detail.detailEditTriggerVisible
    bugDetailDeleteAvailable = [bool]$detail.detailDeleteTriggerVisible
    bugDetailEditorFieldCount = [int]$detailEditor.detailEditorFieldCount
    bugDetailEditorImageInput = [bool]$detailEditor.detailEditorImageInputVisible
    qingyuImportDialogLoaded = [bool]$qingyu.snapshot.qingyuModalVisible
    qingyuQrLoaded = [bool]$qingyu.snapshot.qingyuQrVisible
    qingyuWorkspaceLoaded = [bool]$qingyu.snapshot.qingyuWorkspaceVisible
    pocoRegionVisible = [bool]$detail.pocoRegionVisible
    bugDetailErrorText = [string]$detail.detailErrorText
    evidenceImageCount = [int]$detail.evidenceImageCount
    evidenceLoadedCount = [int]$detail.evidenceLoadedCount
    overviewLoaded = [bool]$overview.overviewVisible
    overviewDatePageCount = [int]$overview.overviewDatePageCount
    overviewSelectedDate = $overviewSelectedDate
    overviewSelectedDateRowCount = $overviewSelectedDateRowCount
    overviewRowCount = [int]$overview.overviewRowCount
    overviewOwnerSelectCount = [int]$overview.overviewOwnerSelectCount
    overviewVerifierSelectCount = [int]$overview.overviewVerifierSelectCount
    overviewPrioritySelectCount = [int]$overview.overviewPrioritySelectCount
    overviewPriorityLabelCount = [int]$overview.overviewPriorityLabelCount
    overviewTitleSupplementCount = [int]$overview.overviewTitleSupplementCount
    overviewWrappedTitleCount = [int]$overview.overviewWrappedTitleCount
    overviewLargeTitleCount = [int]$overview.overviewLargeTitleCount
    overviewColumnResizerCount = [int]$overview.overviewColumnResizerCount
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
  foreach ($startupName in $startupSnapshot.Keys) {
    $startupEntry = $startupSnapshot[$startupName]
    if ($startupEntry.present) {
      Set-ItemProperty `
        -LiteralPath $startupRunKey `
        -Name $startupName `
        -Value ([string]$startupEntry.value)
    } else {
      Remove-ItemProperty `
        -LiteralPath $startupRunKey `
        -Name $startupName `
        -Force `
        -ErrorAction SilentlyContinue
    }
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
