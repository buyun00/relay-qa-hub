param([string]$LanAddress)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$statePath = "D:\Relay-QA-Hub-Data\mvp-e2e-current.json"
$nodeExe = "C:\Users\lin0\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$apiEntry = Join-Path $repoRoot "apps\api\dist\main.js"
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
. (Join-Path $PSScriptRoot "qa-hub-lan.ps1")
. (Join-Path $PSScriptRoot "qa-hub-persistent-runtime.ps1")
$lan = Resolve-QAHubLanBinding -LanAddress $LanAddress
$backupPolicy = Initialize-QAHubPersistentRuntime -State $state -RepositoryRoot $repoRoot

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

$env:QA_HUB_API_HOST = "0.0.0.0"
$env:QA_HUB_API_PORT = "4319"
$env:QA_HUB_BUILD_SHA = [string]$state.buildSha
$env:QA_HUB_DATA_ROOT = [string]$state.dataRoot
$env:QA_HUB_MVP_ACCESS_TOKEN = [string]$state.accessToken
$env:QA_HUB_WEB_AUTH_MODE = "session"
$env:QA_HUB_WEB_SESSION_SECRET = [string]$state.webSessionSecret
$env:QA_HUB_WEB_SECURE_COOKIE = "false"
Remove-Item Env:QA_HUB_WEB_ORIGIN -ErrorAction SilentlyContinue
$env:QA_HUB_WEB_ORIGINS = "http://127.0.0.1:4174,http://localhost:4174,http://$($lan.Address):4174"
$env:QA_HUB_BOOTSTRAP_ADMIN_PASSWORD = [string]$state.bootstrapPassword
$env:QA_HUB_NOTIFICATION_HINT_CHANNEL_ENABLED = "true"

$relayTokenFile = "C:\ProgramData\Relay\secrets\qa-hub-m2m.token"
$relayWebhookSecretFile = "C:\ProgramData\Relay\secrets\qa-hub-webhook.secret"
if (
  (Test-Path -LiteralPath $relayTokenFile -PathType Leaf) -and
  (Test-Path -LiteralPath $relayWebhookSecretFile -PathType Leaf)
) {
  $env:QA_HUB_RELAY_M2M_URL = "http://127.0.0.1:4317/api/integrations/qa/v1/handoffs"
  $env:QA_HUB_RELAY_M2M_TOKEN_FILE = $relayTokenFile
  $env:QA_HUB_RELAY_WEBHOOK_SECRET_FILE = $relayWebhookSecretFile
  $env:QA_HUB_RELAY_INSTANCE_ID = "relay-main"
  $env:QA_HUB_RELAY_QA_INSTANCE_ID = "qa-local"
  $env:QA_HUB_RELAY_PRINCIPAL_ID = "10000000-0000-4000-8000-000000000008"
} else {
  foreach ($name in @(
    "QA_HUB_RELAY_M2M_URL",
    "QA_HUB_RELAY_M2M_TOKEN_FILE",
    "QA_HUB_RELAY_WEBHOOK_SECRET_FILE",
    "QA_HUB_RELAY_INSTANCE_ID",
    "QA_HUB_RELAY_QA_INSTANCE_ID",
    "QA_HUB_RELAY_PRINCIPAL_ID"
  )) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
}

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
$state.generation = $stamp
$state.startedAt = [DateTime]::UtcNow.ToString("o")
$state | Add-Member -NotePropertyName lanAddress -NotePropertyValue $lan.Address -Force
$state | Add-Member -NotePropertyName lanSubnet -NotePropertyValue $lan.Cidr -Force
$state | Add-Member -NotePropertyName apiUrl -NotePropertyValue "http://$($lan.Address):4319" -Force
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8

[pscustomobject]@{
  apiPid = $api.Id
  ready = $ready
  dataRoot = $state.dataRoot
  backupRoot = $backupPolicy.backupRoot
  backupArchiveRoot = $backupPolicy.archiveRoot
  backupIntervalMinutes = $backupPolicy.intervalMinutes
  lanAddress = $lan.Address
  lanSubnet = $lan.Cidr
  url = "http://$($lan.Address):4319"
}
