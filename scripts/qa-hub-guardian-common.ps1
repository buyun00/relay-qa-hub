Set-StrictMode -Version 2

function Enter-QAHubRuntimeLock {
  param([string]$Name = 'Global\RelayQAHubRuntime', [int]$TimeoutMilliseconds = 60000)
  $mutex = New-Object Threading.Mutex($false, $Name)
  try {
    try { $acquired = $mutex.WaitOne($TimeoutMilliseconds) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'Another QA Hub runtime operation is still running' }
    return $mutex
  } catch { $mutex.Dispose(); throw }
}

function Write-QAHubJsonAtomic {
  param([string]$Path, $Value)
  $temporaryPath = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = $Value | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($temporaryPath, $json, (New-Object Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporaryPath, $Path, [NullString]::Value) }
    else { [IO.File]::Move($temporaryPath, $Path) }
  } finally {
    if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
  }
}

function Get-QAHubServiceProbe {
  param([ValidateSet('api', 'web')][string]$Service)
  $url = if ($Service -eq 'api') { 'http://127.0.0.1:4319/api/v1/health/live' }
    else { 'http://127.0.0.1:4174/' }
  $response = $null
  try {
    $request = [Net.HttpWebRequest]::Create($url)
    $request.Proxy = $null
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $response = $request.GetResponse()
    $reader = New-Object IO.StreamReader($response.GetResponseStream())
    try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $valid = [int]$response.StatusCode -eq 200
    if ($Service -eq 'api') {
      $payload = $body | ConvertFrom-Json
      $valid = $valid -and $payload.status -eq 'ok' -and $payload.service -eq 'relay-qa-hub-api'
    } else { $valid = $valid -and $body.Contains('<div id="root"></div>') }
    return [pscustomobject]@{ healthy = [bool]$valid; reason = if ($valid) { 'ok' } else { 'unexpected-response' } }
  } catch {
    # Do not put response bodies, request headers or runtime credentials into guard logs.
    return [pscustomobject]@{ healthy = $false; reason = 'unreachable-or-invalid-response' }
  } finally { if ($null -ne $response) { $response.Close() } }
}

function Get-QAHubRecoveryDecision {
  param([bool]$Healthy, [int]$Failures, [datetime]$LastAttempt, [datetime]$Now = [datetime]::UtcNow)
  $nextFailures = if ($Healthy) { 0 } else { $Failures + 1 }
  return [pscustomobject]@{
    failures = $nextFailures
    restart = (-not $Healthy -and $nextFailures -ge 3 -and ($Now - $LastAttempt).TotalSeconds -ge 60)
  }
}
