[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Start','Stop','Status')][string]$Action,
  [Parameter(Mandatory=$true)][string]$ConfigFile,
  [ValidateSet('api','web','mcp')][string[]]$Services = @('api','web','mcp')
)
$ErrorActionPreference = 'Stop'
$sourcePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$nodePath = (Get-Command node -ErrorAction Stop).Source
$configPath = (Resolve-Path -LiteralPath $ConfigFile).Path
$configText = & $nodePath (Join-Path $PSScriptRoot 'inspect-preview.mjs') $configPath
if ($LASTEXITCODE -ne 0) { throw 'Preview configuration validation failed' }
$config = $configText | ConvertFrom-Json
if ($config.sourceRoot -ne $sourcePath) { throw 'INSTANCE_SOURCE_ROOT_MISMATCH' }
$runnerPath = Join-Path $PSScriptRoot 'run-preview-service.mjs'
function Read-OwnedProcess($Receipt) {
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($Receipt.pid)"
  if (-not $processInfo) { return $null }
  $created = $processInfo.CreationDate.ToUniversalTime().ToString('o')
  $storedCreated = ([DateTime]$Receipt.createdAt).ToUniversalTime().ToString('o')
  if ($created -ne $storedCreated -or $processInfo.ExecutablePath -ne $Receipt.executable -or $processInfo.CommandLine -ne $Receipt.commandLine) {
    throw 'PREVIEW_PID_IDENTITY_MISMATCH: will not control this process'
  }
  return $processInfo
}
foreach ($serviceName in $Services) {
  $receiptPath = Join-Path $config.logsRoot "$serviceName-process.json"
  $receipt = if (Test-Path -LiteralPath $receiptPath) { Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json } else { $null }
  $owned = if ($receipt) { Read-OwnedProcess $receipt } else { $null }
  if ($Action -eq 'Start') {
    if ($owned) { Write-Output "$serviceName already running PID $($owned.ProcessId)"; continue }
    $servicePort = if ($serviceName -eq 'api') { $config.apiPort } elseif ($serviceName -eq 'mcp') { $config.mcpPort } else { $config.webPort }
    if (Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue) { throw "PREVIEW_PORT_OCCUPIED: $servicePort" }
    $arguments = @('"' + $runnerPath + '"', '"' + $configPath + '"', $serviceName)
    $launchId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $stdoutPath = Join-Path $config.logsRoot "$serviceName-$launchId.stdout.log"
    $stderrPath = Join-Path $config.logsRoot "$serviceName-$launchId.stderr.log"
    $started = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $sourcePath -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$($started.Id)"
    if (-not $actual) { throw "PREVIEW_START_FAILED: inspect $serviceName logs" }
    $receiptText = @{ instanceId=$config.instanceId; service=$serviceName; pid=$actual.ProcessId; createdAt=$actual.CreationDate.ToUniversalTime().ToString('o'); executable=$actual.ExecutablePath; commandLine=$actual.CommandLine; stdout=$stdoutPath; stderr=$stderrPath } | ConvertTo-Json
    $receiptText | Set-Content -LiteralPath $receiptPath -Encoding utf8
    $receiptText | Set-Content -LiteralPath (Join-Path $config.logsRoot "$serviceName-$launchId-process.json") -Encoding utf8
    $ready = $false
    $probePath = if ($serviceName -eq 'api') { '/api/v1/health/ready' } elseif ($serviceName -eq 'mcp') { '/health' } else { '/' }
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      if (-not (Get-Process -Id $started.Id -ErrorAction SilentlyContinue)) { throw "PREVIEW_START_FAILED: inspect $stderrPath" }
      try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$servicePort$probePath" -TimeoutSec 1 -UseBasicParsing
        $ready = $response.StatusCode -eq 200
        if ($ready -and $serviceName -ne 'web') { $ready = ($response.Content | ConvertFrom-Json).status -eq 'ready' }
      } catch { $ready = $false }
      if ($ready) { break }
      Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw "PREVIEW_NOT_READY: service process retained for diagnosis; inspect $stderrPath" }
    Write-Output "$serviceName ready PID $($actual.ProcessId) port $servicePort"
  } elseif ($Action -eq 'Stop') {
    if ($owned) {
      # Recheck immediately; never use a process-name kill or a production service.
      $verified = Read-OwnedProcess $receipt
      if ($verified) { Stop-Process -Id $verified.ProcessId -ErrorAction Stop }
      Write-Output "$serviceName stopped; all preview data and logs retained"
    } else { Write-Output "$serviceName is stopped" }
  } else {
    @{ instanceId=$config.instanceId; service=$serviceName; running=[bool]$owned; pid=if($owned){$owned.ProcessId}else{$null}; sourceRoot=$sourcePath; dataRoot=$config.dataRoot } | ConvertTo-Json -Compress
  }
}
