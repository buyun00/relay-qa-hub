param(
  [ValidateSet("PrepareStart", "Restart", "Stop")]
  [string]$Action = "PrepareStart",
  [switch]$FreshData
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeParent = "D:\Relay-QA-Hub-Data"
$pointerPath = Join-Path $runtimeParent "mvp-e2e-current.json"
$nodeExe = "C:\Users\lin0\AppData\Local\OpenAI\Codex\runtimes\cua_node\1b25664590014d28\bin\node.exe"
$npmCmd = "C:\Users\lin0\AppData\Local\OpenAI\Codex\runtimes\cua_node\1b25664590014d28\bin\npm.cmd"
$adbExe = "C:\Users\lin0\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$androidSdk = "C:\Users\lin0\AppData\Local\Android\Sdk"
$javaHome = "C:\Program Files\Android\Android Studio\jbr"
$electronExe = Join-Path $repoRoot "node_modules\electron\dist\electron.exe"
$apiEntry = Join-Path $repoRoot "apps\api\dist\main.js"
$workerEntry = Join-Path $repoRoot "apps\worker\dist\main.js"
$viteEntry = Join-Path $repoRoot "node_modules\vite\bin\vite.js"
$apkPath = Join-Path $repoRoot "apps\android\app\build\outputs\apk\debug\app-debug.apk"
$deviceSerial = "127.0.0.1:16384"
. (Join-Path $PSScriptRoot "qa-hub-lan.ps1")
. (Join-Path $PSScriptRoot "qa-hub-persistent-runtime.ps1")
$lan = Resolve-QAHubLanBinding

function New-HexSecret {
  param([int]$Bytes = 32)
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  } finally {
    $rng.Dispose()
  }
  return -join ($buffer | ForEach-Object { $_.ToString("x2") })
}

function Read-State {
  if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) {
    throw "MVP E2E runtime pointer is missing"
  }
  return Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
}

function Write-State {
  param($State)
  $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $pointerPath -Encoding UTF8
}

function Stop-ExactPid {
  param([Nullable[int]]$PidValue)
  if ($null -eq $PidValue -or $PidValue -le 0) { return }
  $process = Get-Process -Id $PidValue -ErrorAction SilentlyContinue
  if ($null -eq $process) { return }
  Stop-Process -Id $PidValue -Force
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ((Get-Process -Id $PidValue -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  if (Get-Process -Id $PidValue -ErrorAction SilentlyContinue) {
    throw "Exact process $PidValue did not exit"
  }
}

function Stop-StateProcesses {
  param($State)
  Stop-ExactPid $State.electronPid
  Stop-ExactPid $State.webPid
  Stop-ExactPid $State.workerPid
  Stop-ExactPid $State.apiPid
}

function Start-LoggedProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$LogPrefix,
    [switch]$Visible
  )
  $stdout = "$LogPrefix.stdout.log"
  $stderr = "$LogPrefix.stderr.log"
  if ($Visible) {
    return Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  }
  return Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
}

function Wait-HttpOk {
  param([string]$Url, [int]$TimeoutSeconds = 20)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return }
    } catch {
      Start-Sleep -Milliseconds 200
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for $Url"
}

function Start-Runtime {
  param($State)
  $generation = [DateTime]::UtcNow.ToString("yyyyMMddHHmmssfff")
  $logsRoot = [string]$State.logsRoot
  New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null
  $backupPolicy = Initialize-QAHubPersistentRuntime -State $State -RepositoryRoot $repoRoot
  $started = @()
  try {
    $env:QA_HUB_API_HOST = "0.0.0.0"
    $env:QA_HUB_API_PORT = "4319"
    $env:QA_HUB_BUILD_SHA = [string]$State.buildSha
    $env:QA_HUB_DATA_ROOT = [string]$State.dataRoot
    $env:QA_HUB_MVP_ACCESS_TOKEN = [string]$State.accessToken
    $env:QA_HUB_WEB_AUTH_MODE = "session"
    $env:QA_HUB_WEB_SESSION_SECRET = [string]$State.webSessionSecret
    $env:QA_HUB_WEB_SECURE_COOKIE = "false"
    Remove-Item Env:QA_HUB_WEB_ORIGIN -ErrorAction SilentlyContinue
    $env:QA_HUB_WEB_ORIGINS = "http://127.0.0.1:4174,http://localhost:4174,http://$($lan.Address):4174"
    Remove-Item Env:QA_HUB_BOOTSTRAP_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    $env:QA_HUB_NOTIFICATION_HINT_CHANNEL_ENABLED = "true"
    $api = Start-LoggedProcess -FilePath $nodeExe -ArgumentList @($apiEntry) -WorkingDirectory $repoRoot -LogPrefix (Join-Path $logsRoot "$generation-api")
    $started += $api
    Wait-HttpOk -Url "http://127.0.0.1:4319/api/v1/health/ready" -TimeoutSeconds 30
    Remove-Item Env:QA_HUB_WEB_SESSION_SECRET -ErrorAction SilentlyContinue
    Remove-Item Env:QA_HUB_BOOTSTRAP_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:QA_HUB_MVP_ACCESS_TOKEN -ErrorAction SilentlyContinue

    $worker = Start-LoggedProcess -FilePath $nodeExe -ArgumentList @($workerEntry) -WorkingDirectory $repoRoot -LogPrefix (Join-Path $logsRoot "$generation-worker")
    $started += $worker

    $env:QA_HUB_API_BASE_URL = "http://127.0.0.1:4319"
    $env:QA_HUB_WEB_HOST = "0.0.0.0"
    $web = Start-LoggedProcess -FilePath $nodeExe -ArgumentList @($viteEntry, "--host", "0.0.0.0", "--port", "4174", "--strictPort") -WorkingDirectory (Join-Path $repoRoot "apps\web") -LogPrefix (Join-Path $logsRoot "$generation-web")
    $started += $web
    Wait-HttpOk -Url "http://127.0.0.1:4174" -TimeoutSeconds 30

    $env:QA_HUB_DESKTOP_API_BASE_URL = "http://127.0.0.1:4319"
    $env:QA_HUB_DESKTOP_ACCESS_TOKEN = [string]$State.accessToken
    $env:QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP = "1"
    $env:QA_HUB_DESKTOP_WEB_ASSETS_DIR = (Join-Path $repoRoot "apps\web\dist")
    $env:QA_HUB_DESKTOP_START_HIDDEN = "0"
    Remove-Item Env:QA_HUB_DESKTOP_USE_DEV_URL -ErrorAction SilentlyContinue
    Remove-Item Env:QA_HUB_DESKTOP_DEV_URL -ErrorAction SilentlyContinue
    $electron = Start-LoggedProcess -FilePath $electronExe -ArgumentList @((Join-Path $repoRoot "apps\desktop")) -WorkingDirectory $repoRoot -LogPrefix (Join-Path $logsRoot "$generation-electron") -Visible
    $started += $electron
    Start-Sleep -Seconds 3
    if ($electron.HasExited) { throw "Electron exited during startup" }

    $State.apiPid = $api.Id
    $State.workerPid = $worker.Id
    $State.webPid = $web.Id
    $State.electronPid = $electron.Id
    $State.generation = $generation
    $State.startedAt = [DateTime]::UtcNow.ToString("o")
    $State | Add-Member -NotePropertyName lanAddress -NotePropertyValue $lan.Address -Force
    $State | Add-Member -NotePropertyName lanSubnet -NotePropertyValue $lan.Cidr -Force
    $State | Add-Member -NotePropertyName apiUrl -NotePropertyValue "http://$($lan.Address):4319" -Force
    $State | Add-Member -NotePropertyName webUrl -NotePropertyValue "http://$($lan.Address):4174" -Force
    Write-State $State
  } catch {
    foreach ($process in $started) {
      Stop-ExactPid $process.Id
    }
    throw
  }
}

if ($Action -eq "PrepareStart") {
  $existing = $null
  if (Test-Path -LiteralPath $pointerPath -PathType Leaf) {
    $existing = Read-State
    foreach ($pidValue in @($existing.apiPid, $existing.workerPid, $existing.webPid, $existing.electronPid)) {
      if ($pidValue -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
        throw "An MVP E2E runtime is already active at $($existing.runtimeRoot)"
      }
    }
  }

  foreach ($required in @($nodeExe, $npmCmd, $adbExe, (Join-Path $javaHome "bin\java.exe"), $electronExe)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required tool is missing: $required" }
  }
  $env:PATH = "$(Split-Path -Parent $nodeExe);$env:PATH"
  $env:QA_HUB_WEB_AUTH_MODE = "session"
  & $npmCmd run build --workspace "@relay-qa-hub/storage"
  if ($LASTEXITCODE -ne 0) { throw "storage build failed" }
  & $npmCmd run build --workspace "@relay-qa-hub/api"
  if ($LASTEXITCODE -ne 0) { throw "api build failed" }
  & $npmCmd run build --workspace "@relay-qa-hub/worker"
  if ($LASTEXITCODE -ne 0) { throw "worker build failed" }
  & $npmCmd run build --workspace "@relay-qa-hub/web"
  if ($LASTEXITCODE -ne 0) { throw "web build failed" }
  & $npmCmd run build --workspace "@relay-qa-hub/desktop"
  if ($LASTEXITCODE -ne 0) { throw "desktop build failed" }

  if ($null -ne $existing -and -not $FreshData) {
    $state = $existing
    if (-not (Test-Path -LiteralPath ([string]$state.dataRoot) -PathType Container)) {
      throw "Existing persistent data root is missing; restore it from E: instead of silently creating a new empty database: $($state.dataRoot)"
    }
    $state.buildSha = (& git -C $repoRoot rev-parse HEAD).Trim()
    $state.apkPath = $apkPath
    $state.apkSha256 = $null
    $state.apiPid = $null
    $state.workerPid = $null
    $state.webPid = $null
    $state.electronPid = $null
    $state.generation = $null
    $state.startedAt = $null
  } else {
    $stamp = [DateTime]::UtcNow.ToString("yyyyMMddHHmmssfff")
    $runtimeRoot = Join-Path $runtimeParent "mvp-e2e-$stamp"
    $dataRoot = if ($FreshData) { Join-Path $runtimeRoot "data" } else { $script:QAHubPersistentDataRoot }
    $logsRoot = Join-Path $runtimeRoot "logs"
    New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
    New-Item -ItemType Directory -Path $dataRoot | Out-Null
    New-Item -ItemType Directory -Path $logsRoot | Out-Null
    $state = [pscustomobject][ordered]@{
      runtimeRoot = $runtimeRoot
      dataRoot = $dataRoot
      logsRoot = $logsRoot
      buildSha = (& git -C $repoRoot rev-parse HEAD).Trim()
      accessToken = New-HexSecret 32
      webSessionSecret = New-HexSecret 32
      bootstrapPassword = "Mvp-" + (New-HexSecret 16)
      androidSerial = $deviceSerial
      apiPort = 4319
      webPort = 4174
      apiPid = $null
      workerPid = $null
      webPid = $null
      electronPid = $null
      generation = $null
      startedAt = $null
      apkPath = $apkPath
      apkSha256 = $null
    }
  }
  Write-State $state

  $env:ANDROID_HOME = $androidSdk
  $env:ANDROID_SDK_ROOT = $androidSdk
  $env:JAVA_HOME = $javaHome
  $env:ORG_GRADLE_PROJECT_qaHubApiBaseUrl = "http://$($lan.Address):4319/api/v1/"
  Push-Location (Join-Path $repoRoot "apps\android")
  try {
    & ".\gradlew.bat" --no-daemon assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Android assembleDebug failed" }
  } finally {
    Pop-Location
  }
  $state.apkSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $apkPath).Hash
  Write-State $state

  & $adbExe -s $deviceSerial install -r $apkPath
  if ($LASTEXITCODE -ne 0) { throw "APK install failed" }
  & $adbExe -s $deviceSerial reverse --remove tcp:4319 2>$null | Out-Null
  Start-Runtime $state
} elseif ($Action -eq "Restart") {
  $state = Read-State
  Stop-StateProcesses $state
  & $adbExe -s $deviceSerial reverse --remove tcp:4319 2>$null | Out-Null
  Start-Runtime $state
} else {
  $state = Read-State
  Stop-StateProcesses $state
  & $adbExe -s $deviceSerial reverse --remove tcp:4319 | Out-Null
  $state.apiPid = $null
  $state.workerPid = $null
  $state.webPid = $null
  $state.electronPid = $null
  Write-State $state
}

$result = [ordered]@{
  action = $Action
  runtimeRoot = $state.runtimeRoot
  dataRoot = $state.dataRoot
  buildSha = $state.buildSha
  apkPath = $state.apkPath
  apkSha256 = $state.apkSha256
  androidSerial = $state.androidSerial
  apiUrl = "http://$($lan.Address):4319"
  webUrl = "http://$($lan.Address):4174"
  loopbackApiUrl = "http://127.0.0.1:4319"
  loopbackWebUrl = "http://127.0.0.1:4174"
  apiPid = $state.apiPid
  workerPid = $state.workerPid
  webPid = $state.webPid
  electronPid = $state.electronPid
  generation = $state.generation
  startedAt = $state.startedAt
  pointerPath = $pointerPath
}
$result | ConvertTo-Json -Compress
