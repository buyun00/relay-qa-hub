param([string]$LanAddress, [switch]$IfUnhealthy)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2
. (Join-Path $PSScriptRoot 'qa-hub-guardian-common.ps1')

$runtimeLock = Enter-QAHubRuntimeLock
try {
if ($IfUnhealthy -and (Get-QAHubServiceProbe -Service web).healthy) {
  [pscustomobject]@{ ready = $true; skipped = $true }
  return
}
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$statePath = "D:\Relay-QA-Hub-Data\mvp-e2e-current.json"
$nodeExe = "C:\Users\lin0\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$viteEntry = Join-Path $repoRoot "node_modules\vite\bin\vite.js"
$webRoot = Join-Path $repoRoot "apps\web"
$apkPath = Join-Path $repoRoot "apps\android\app\build\outputs\apk\debug\app-debug.apk"
$apkDownloadName = "Relay-QA-Hub-Android12-debug.apk"
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
. (Join-Path $PSScriptRoot "qa-hub-lan.ps1")
$lan = Resolve-QAHubLanBinding -LanAddress $LanAddress

$apkSha256 = $null
$apkDownloadUrl = $null
if (Test-Path -LiteralPath $apkPath) {
  $apkSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $apkPath).Hash
  $apkDownloadUrl = "http://$($lan.Address):4174/downloads/$apkDownloadName"
}

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 4174 -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
  if (
    $null -eq $currentProcess -or
    $currentProcess.CommandLine -notlike "*$viteEntry*preview*"
  ) {
    throw "Port 4174 is owned by an unexpected process $($listener.OwningProcess)"
  }
  Stop-Process -Id $listener.OwningProcess -Force
}

$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (
  (Get-NetTCPConnection -State Listen -LocalPort 4174 -ErrorAction SilentlyContinue) -and
  [DateTime]::UtcNow -lt $deadline
) {
  Start-Sleep -Milliseconds 100
}
if (Get-NetTCPConnection -State Listen -LocalPort 4174 -ErrorAction SilentlyContinue) {
  throw "Port 4174 did not close"
}

$env:QA_HUB_WEB_AUTH_MODE = "session"
$env:QA_HUB_API_BASE_URL = "http://127.0.0.1:4319"
$env:QA_HUB_WEB_HOST = "0.0.0.0"
Remove-Item Env:QA_HUB_MVP_ACCESS_TOKEN -ErrorAction SilentlyContinue

$stamp = [DateTime]::UtcNow.ToString("yyyyMMddHHmmssfff")
$stdout = Join-Path ([string]$state.logsRoot) "$stamp-web.stdout.log"
$stderr = Join-Path ([string]$state.logsRoot) "$stamp-web.stderr.log"
$web = Start-Process `
  -FilePath $nodeExe `
  -ArgumentList @($viteEntry, "preview", "--host", "0.0.0.0", "--port", "4174", "--strictPort") `
  -WorkingDirectory $webRoot `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -WindowStyle Hidden `
  -PassThru

$ready = $false
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ([DateTime]::UtcNow -lt $deadline) {
  if ($web.HasExited) { break }
  try {
    $page = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "http://127.0.0.1:4174/" `
      -TimeoutSec 2
    if ($page.StatusCode -eq 200 -and $page.Content -like "*<div id=`"root`"></div>*") {
      $ready = $true
      break
    }
  } catch {
    Start-Sleep -Milliseconds 200
  }
}
if (-not $ready) {
  if (-not $web.HasExited) { Stop-Process -Id $web.Id -Force }
  $tail = Get-Content -LiteralPath $stderr -Tail 30 -ErrorAction SilentlyContinue
  throw "Web failed to become ready. $tail"
}

$proxyStatus = $null
try {
  $proxyResponse = Invoke-WebRequest `
    -UseBasicParsing `
    -Uri "http://127.0.0.1:4174/api/v1/auth/me" `
    -TimeoutSec 5
  $proxyStatus = $proxyResponse.StatusCode
} catch {
  if ($null -ne $_.Exception.Response) {
    $proxyStatus = [int]$_.Exception.Response.StatusCode
  }
}
if ($proxyStatus -ne 401) {
  Stop-Process -Id $web.Id -Force
  throw "Web API proxy failed its unauthenticated session probe"
}

$state.webPid = $web.Id
$state.webPort = 4174
$state | Add-Member -NotePropertyName apkPath -NotePropertyValue $apkPath -Force
$state | Add-Member -NotePropertyName apkSha256 -NotePropertyValue $apkSha256 -Force
$state | Add-Member -NotePropertyName lanAddress -NotePropertyValue $lan.Address -Force
$state | Add-Member -NotePropertyName lanSubnet -NotePropertyValue $lan.Cidr -Force
$state | Add-Member -NotePropertyName webUrl -NotePropertyValue "http://$($lan.Address):4174/" -Force
$state | Add-Member -NotePropertyName androidApkUrl -NotePropertyValue $apkDownloadUrl -Force
$state | Add-Member -NotePropertyName androidApkSha256 -NotePropertyValue $apkSha256 -Force
Write-QAHubJsonAtomic -Path $statePath -Value $state

[pscustomobject]@{
  webPid = $web.Id
  ready = $ready
  apiProxyStatus = $proxyStatus
  url = "http://$($lan.Address):4174/"
  loopbackUrl = "http://127.0.0.1:4174/"
  androidApkUrl = $apkDownloadUrl
  androidApkSha256 = $apkSha256
  lanSubnet = $lan.Cidr
  serving = "apps/web/dist"
}
} finally {
  $runtimeLock.ReleaseMutex()
  $runtimeLock.Dispose()
}
