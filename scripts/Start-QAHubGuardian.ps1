param([Parameter(Mandatory = $true)][ValidateSet('Primary', 'Secondary')][string]$Role)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
. (Join-Path $PSScriptRoot 'qa-hub-guardian-common.ps1')
$guardRoot = 'D:\Relay-QA-Hub-Data\guardian'
[IO.Directory]::CreateDirectory($guardRoot) | Out-Null
$peerRole = if ($Role -eq 'Primary') { 'Secondary' } else { 'Primary' }
$heartbeatPath = Join-Path $guardRoot "$Role.json"
$peerHeartbeatPath = Join-Path $guardRoot "$peerRole.json"
$maintenancePath = Join-Path $guardRoot 'maintenance'
$guardianScript = $PSCommandPath
$instanceLock = $null
$selfStart = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
$serviceStates = @{ api = @{ failures = 0; lastAttempt = [datetime]::MinValue }; web = @{ failures = 0; lastAttempt = [datetime]::MinValue } }
$peerLastAttempt = [datetime]::MinValue
$lastObservations = @{}

function Write-GuardEvent {
  param([string]$Event, $Detail)
  $logPath = Join-Path $guardRoot "$Role.events.jsonl"
  if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 5MB) {
    Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
  }
  [pscustomobject]@{ at = [datetime]::UtcNow.ToString('o'); role = $Role; event = $Event; detail = $Detail } |
    ConvertTo-Json -Depth 5 -Compress | Add-Content -LiteralPath $logPath -Encoding UTF8
}

function Write-GuardHeartbeat {
  param([string]$Phase)
  Write-QAHubJsonAtomic -Path $heartbeatPath -Value ([ordered]@{
    role = $Role; processId = $PID; processStartedAt = $selfStart
    heartbeatAt = [datetime]::UtcNow.ToString('o'); phase = $Phase
    services = $lastObservations
  })
}

function Repair-GuardPeer {
  $now = [datetime]::UtcNow
  if (($now - $script:peerLastAttempt).TotalSeconds -lt 30) { return }
  $peer = $null
  try {
    $peer = Get-Content -LiteralPath $peerHeartbeatPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$peer.processId -le 0 -or -not $peer.processStartedAt -or -not $peer.heartbeatAt) { $peer = $null }
    else { [datetime]$peer.heartbeatAt | Out-Null }
  } catch { $peer = $null }
  if ($null -ne $peer -and ($now - [datetime]$peer.heartbeatAt).TotalSeconds -lt 180) {
    $process = Get-Process -Id $peer.processId -ErrorAction SilentlyContinue
    if ($null -ne $process -and $process.StartTime.ToUniversalTime().ToString('o') -eq $peer.processStartedAt) { return }
  }

  # Only terminate a stalled peer with matching PID, creation time AND exact script/role.
  if ($null -ne $peer) {
    $process = Get-Process -Id $peer.processId -ErrorAction SilentlyContinue
    if ($null -ne $process -and $process.StartTime.ToUniversalTime().ToString('o') -eq $peer.processStartedAt) {
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($peer.processId)"
      if ($cim.Name -eq 'powershell.exe' -and
          $cim.CommandLine -match [regex]::Escape($guardianScript) -and
          $cim.CommandLine -match "-Role\s+$peerRole(?:\s|$)") {
        Stop-Process -Id $peer.processId -Force
        Write-GuardEvent 'peer-stalled' @{ role = $peerRole; processId = $peer.processId }
      }
    }
  }
  $script:peerLastAttempt = $now
  Start-ScheduledTask -TaskName "Relay QA Hub Guardian $peerRole"
  Write-GuardEvent 'peer-start-requested' @{ role = $peerRole }
}

try {
  try { $instanceLock = Enter-QAHubRuntimeLock -Name "Global\RelayQAHubGuardian$Role" -TimeoutMilliseconds 0 }
  catch { exit 0 }
  Write-GuardEvent 'started' @{ processId = $PID }
  while ($true) {
    if (Test-Path -LiteralPath $maintenancePath) {
      Write-GuardHeartbeat 'maintenance'
      Start-Sleep -Seconds 5
      continue
    }
    Write-GuardHeartbeat 'checking'
    try { Repair-GuardPeer } catch { Write-GuardEvent 'peer-check-failed' @{ error = $_.Exception.GetType().Name } }
    if ($Role -eq 'Primary') {
      foreach ($service in @('api', 'web')) {
        $probe = Get-QAHubServiceProbe -Service $service
        $state = $serviceStates[$service]
        $decision = Get-QAHubRecoveryDecision -Healthy $probe.healthy -Failures $state.failures -LastAttempt $state.lastAttempt
        $state.failures = $decision.failures
        if (-not $lastObservations.ContainsKey($service) -or $lastObservations[$service].healthy -ne $probe.healthy) {
          Write-GuardEvent 'service-state' @{ service = $service; healthy = $probe.healthy; reason = $probe.reason }
        }
        $lastObservations[$service] = @{ healthy = $probe.healthy; consecutiveFailures = $state.failures; checkedAt = [datetime]::UtcNow.ToString('o') }
        if ($decision.restart -and -not (Test-Path -LiteralPath $maintenancePath)) {
          # The Web launcher checks its API proxy, so recover API first and defer Web if API is still down.
          if ($service -eq 'web' -and -not (Get-QAHubServiceProbe -Service api).healthy) { continue }
          $state.lastAttempt = [datetime]::UtcNow
          Write-GuardHeartbeat "recovering-$service"
          Write-GuardEvent 'service-restart-requested' @{ service = $service; consecutiveFailures = $state.failures }
          try {
            # Let the launcher finish writing runtime state even if this guardian is killed.
            # Do not redirect its output through the guardian's lifetime-bound pipes.
            $launcherPath = Join-Path $PSScriptRoot "restart-mvp-$service.ps1"
            $launcher = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
              -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $launcherPath + '"'), '-IfUnhealthy') `
              -WorkingDirectory (Split-Path -Parent $PSScriptRoot) -WindowStyle Hidden -PassThru
            $deadline = [datetime]::UtcNow.AddSeconds(120)
            while (-not $launcher.WaitForExit(1000) -and [datetime]::UtcNow -lt $deadline) {
              Write-GuardHeartbeat "recovering-$service"
            }
            if (-not $launcher.HasExited) {
              # Stop only our own stuck launcher. The shared mutex is then released by Windows.
              Stop-Process -InputObject $launcher -Force
              throw 'Service launcher timed out'
            }
            if ($launcher.ExitCode -ne 0) { throw 'Service launcher failed; inspect the service logs' }
            $healthy = (Get-QAHubServiceProbe -Service $service).healthy
            Write-GuardEvent 'service-restart-result' @{ service = $service; healthy = $healthy }
          } catch {
            Write-GuardEvent 'service-restart-failed' @{ service = $service; error = $_.Exception.GetType().Name }
          }
        }
      }
    }
    Write-GuardHeartbeat 'watching'
    Start-Sleep -Seconds 5
  }
} catch {
  try { Write-GuardEvent 'fatal' @{ error = $_.Exception.GetType().Name } } catch {}
  exit 1
} finally {
  if ($null -ne $instanceLock) { $instanceLock.ReleaseMutex(); $instanceLock.Dispose() }
}
