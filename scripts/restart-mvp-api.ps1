param(
  [string]$ApiSourceRoot = "",
  [string]$BuildSha = "dev"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

$defaultRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = if ([string]::IsNullOrWhiteSpace($ApiSourceRoot)) {
  $defaultRepoRoot
} else {
  (Resolve-Path -LiteralPath $ApiSourceRoot -ErrorAction Stop).Path
}
$statePath = "D:\Relay-QA-Hub-Data\mvp-e2e-current.json"
$nodeExe = "C:\Users\lin0\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$apiEntry = Join-Path $repoRoot "apps\api\dist\main.js"
$desktopUpdateRoot = "D:\Relay-QA-Hub-Data\desktop-updates\stable"
$runtimeBuildSha = $BuildSha
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 4319 -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
  if ($null -eq $currentProcess -or $currentProcess.CommandLine -notlike "*apps\api\dist\main.js*") {
    throw "Port 4319 is owned by an unexpected process $($listener.OwningProcess)"
  }
  Stop-Process -Id $listener.OwningProcess -Force
}

$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ((Get-NetTCPConnection -State Listen -LocalPort 4319 -ErrorAction SilentlyContinue) -and
       [DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 100
}
if (Get-NetTCPConnection -State Listen -LocalPort 4319 -ErrorAction SilentlyContinue) {
  throw "Port 4319 did not close"
}

$env:QA_HUB_API_HOST = "127.0.0.1"
$env:QA_HUB_API_PORT = "4319"
$env:QA_HUB_BUILD_SHA = $runtimeBuildSha
$env:QA_HUB_DATA_ROOT = [string]$state.dataRoot
$env:QA_HUB_DESKTOP_UPDATE_ROOT = $desktopUpdateRoot
$env:QA_HUB_MVP_ACCESS_TOKEN = [string]$state.accessToken
$env:QA_HUB_WEB_AUTH_MODE = "session"
$env:QA_HUB_WEB_SESSION_SECRET = [string]$state.webSessionSecret
$env:QA_HUB_WEB_SECURE_COOKIE = "false"
$env:QA_HUB_WEB_ORIGIN = "http://127.0.0.1:4174"
$env:QA_HUB_BOOTSTRAP_ADMIN_PASSWORD = [string]$state.bootstrapPassword
$env:QA_HUB_NOTIFICATION_HINT_CHANNEL_ENABLED = "true"

$stamp = [DateTime]::UtcNow.ToString("yyyyMMddHHmmssfff")
$stdout = Join-Path ([string]$state.logsRoot) "$stamp-api.stdout.log"
$stderr = Join-Path ([string]$state.logsRoot) "$stamp-api.stderr.log"
$api = Start-Process `
  -FilePath $nodeExe `
  -ArgumentList @($apiEntry) `
  -WorkingDirectory $repoRoot `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -WindowStyle Hidden `
  -PassThru

$ready = $false
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ([DateTime]::UtcNow -lt $deadline) {
  if ($api.HasExited) { break }
  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "http://127.0.0.1:4319/api/v1/health/ready" `
      -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    Start-Sleep -Milliseconds 200
  }
}
if (-not $ready) {
  $tail = Get-Content -LiteralPath $stderr -Tail 30 -ErrorAction SilentlyContinue
  throw "API failed to become ready. $tail"
}

$state.apiPid = $api.Id
$state.buildSha = $runtimeBuildSha
$state.generation = $stamp
$state.startedAt = [DateTime]::UtcNow.ToString("o")
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8

[pscustomobject]@{
  apiPid = $api.Id
  ready = $ready
  dataRoot = $state.dataRoot
  desktopUpdateRoot = $desktopUpdateRoot
}
