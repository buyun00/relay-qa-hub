param([switch]$StartNow)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run Install-QAHubGuardian.ps1 as administrator'
}
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$guardRoot = 'D:\Relay-QA-Hub-Data\guardian'
$startupScript = Join-Path $PSScriptRoot 'Start-QAHubGuardian.ps1'
$powerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
foreach ($file in @($startupScript, (Join-Path $PSScriptRoot 'qa-hub-guardian-common.ps1'),
  (Join-Path $PSScriptRoot 'restart-mvp-api.ps1'), (Join-Path $PSScriptRoot 'restart-mvp-web.ps1'),
  'D:\Relay-QA-Hub-Data\mvp-e2e-current.json')) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required file is missing: $file" }
}
[IO.Directory]::CreateDirectory($guardRoot) | Out-Null
$backupRoot = Join-Path $guardRoot ('install-' + [datetime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
[IO.Directory]::CreateDirectory($backupRoot) | Out-Null
$taskPrincipal = New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([timespan]::Zero)

foreach ($role in @('Primary', 'Secondary')) {
  $taskName = "Relay QA Hub Guardian $role"
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    if ($existing.Actions[0].Arguments -notlike "*$startupScript*") { throw "Unexpected owner of task $taskName" }
    Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $backupRoot "$role.xml") -Encoding Unicode
  }
  $action = New-ScheduledTaskAction -Execute $powerShellExe -WorkingDirectory $repoRoot `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startupScript`" -Role $role"
  $boot = New-ScheduledTaskTrigger -AtStartup
  $boot.Delay = 'PT15S'
  # An indefinite minute trigger also recovers both guardians if they disappear together.
  $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($boot, $repeat) `
    -Principal $taskPrincipal -Settings $settings -Description 'QA Hub mutual guardian and service recovery.' -Force | Out-Null
}

if ($StartNow) {
  foreach ($role in @('Primary', 'Secondary')) { Start-ScheduledTask -TaskName "Relay QA Hub Guardian $role" }
  $deadline = [datetime]::UtcNow.AddSeconds(45)
  do {
    Start-Sleep -Milliseconds 500
    $running = @('Primary', 'Secondary') | Where-Object {
      $heartbeat = $null
      try { $heartbeat = Get-Content -LiteralPath (Join-Path $guardRoot "$_.json") -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
      $null -ne $heartbeat -and ([datetime]::UtcNow - [datetime]$heartbeat.heartbeatAt).TotalSeconds -lt 15 -and
        (Get-ScheduledTask -TaskName "Relay QA Hub Guardian $_").State -eq 'Running'
    }
  } while (@($running).Count -ne 2 -and [datetime]::UtcNow -lt $deadline)
  if (@($running).Count -ne 2) { throw 'Both guardian tasks must produce fresh heartbeats before replacing legacy startup' }
}

$legacy = Get-ScheduledTask -TaskName 'Relay QA Hub Backend' -ErrorAction SilentlyContinue
if ($null -ne $legacy) {
  Export-ScheduledTask -TaskName $legacy.TaskName | Set-Content -LiteralPath (Join-Path $backupRoot 'Backend.xml') -Encoding Unicode
  # Preserve the old task for rollback; avoid its unconditional restart racing the guardians at boot.
  Disable-ScheduledTask -TaskName $legacy.TaskName | Out-Null
}
Get-ScheduledTask -TaskName 'Relay QA Hub Guardian *' | Select-Object TaskName,
  @{ Name = 'State'; Expression = { [string]$_.State } },
  @{ Name = 'User'; Expression = { $_.Principal.UserId } }, @{ Name = 'BackupRoot'; Expression = { $backupRoot } }
