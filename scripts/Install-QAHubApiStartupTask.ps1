param(
  [string]$TaskName = "Relay QA Hub Backend",
  [int]$StartupDelaySeconds = 30,
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

if ($StartupDelaySeconds -lt 0 -or $StartupDelaySeconds -gt 3600) {
  throw "StartupDelaySeconds must be from 0 through 3600"
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Install-QAHubApiStartupTask.ps1 must run as administrator"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$startupScript = Join-Path $repoRoot "scripts\restart-mvp-api.ps1"
$powerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

foreach ($requiredFile in @($startupScript, $powerShellExe)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Required startup file is missing: $requiredFile"
  }
}

$actionArguments = @(
  "-NoProfile"
  "-NonInteractive"
  "-ExecutionPolicy Bypass"
  "-WindowStyle Hidden"
  "-File `"$startupScript`""
) -join " "
$action = New-ScheduledTaskAction `
  -Execute $powerShellExe `
  -Argument $actionArguments `
  -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT$($StartupDelaySeconds)S"
$taskPrincipal = New-ScheduledTaskPrincipal `
  -UserId "SYSTEM" `
  -LogonType ServiceAccount `
  -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$task = New-ScheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Principal $taskPrincipal `
  -Settings $settings `
  -Description "Starts the Relay QA Hub production API after Windows boots."

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
$registered = Get-ScheduledTask -TaskName $TaskName
if (
  $registered.Principal.UserId -ne "SYSTEM" -or
  [string]$registered.Principal.RunLevel -ne "Highest" -or
  $registered.Triggers[0].CimClass.CimClassName -ne "MSFT_TaskBootTrigger" -or
  [string]$registered.Triggers[0].Delay -ne "PT$($StartupDelaySeconds)S" -or
  [string]$registered.Actions[0].Execute -ne $powerShellExe -or
  [string]$registered.Actions[0].Arguments -notlike "*$startupScript*"
) {
  throw "The registered QA Hub startup task does not match the requested boot contract"
}

$lastTaskResult = $null
if ($StartNow) {
  $manualStartTime = Get-Date
  Start-ScheduledTask -TaskName $TaskName
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 500
    $registered = Get-ScheduledTask -TaskName $TaskName
    $taskInfo = $registered | Get-ScheduledTaskInfo
    $completedThisRun =
      $taskInfo.LastRunTime -ge $manualStartTime.AddSeconds(-2) -and
      [string]$registered.State -ne "Running"
  } while (-not $completedThisRun -and [DateTime]::UtcNow -lt $deadline)

  if (-not $completedThisRun) {
    throw "The QA Hub startup task did not finish its manual validation run within 60 seconds"
  }
  $lastTaskResult = [int64]$taskInfo.LastTaskResult
  if ($lastTaskResult -ne 0) {
    throw "The QA Hub startup task failed with result $lastTaskResult"
  }
}

[pscustomobject][ordered]@{
  taskName = $registered.TaskName
  state = [string]$registered.State
  userId = [string]$registered.Principal.UserId
  runLevel = [string]$registered.Principal.RunLevel
  execute = [string]$registered.Actions[0].Execute
  arguments = [string]$registered.Actions[0].Arguments
  startupDelay = [string]$registered.Triggers[0].Delay
  startedNow = [bool]$StartNow
  lastTaskResult = $lastTaskResult
}
