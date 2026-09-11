[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Install','Start','Stop','Status','Uninstall')][string]$Action,
  [string]$ConfigFile = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-lan-v22-0911\instance.json',
  [string]$NodePath,
  [ValidateSet('api','web','mcp')][string[]]$Services = @('api','web','mcp')
)

$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path -LiteralPath $ConfigFile).Path
$nodeCommand = if ($NodePath) { $null } else { Get-Command node -ErrorAction SilentlyContinue }
$nodePath = if ($NodePath) { [IO.Path]::GetFullPath($NodePath) } elseif ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'NODE_RUNTIME_NOT_FOUND' }
$config = (& $nodePath (Join-Path $PSScriptRoot 'inspect-preview.mjs') $configPath) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $config.deploymentMode -ne 'lan') { throw 'LAN_CONFIGURATION_VALIDATION_FAILED' }
$taskName = "Relay QA Hub LAN - $($config.instanceId)"
$previewManager = Join-Path $PSScriptRoot 'Manage-QAHubPreview.ps1'

function Invoke-ServiceAction([string]$ServiceAction) {
  & $previewManager -Action $ServiceAction -ConfigFile $configPath -NodePath $nodePath -Services $Services
  if ($LASTEXITCODE -ne 0) { throw "LAN_SERVICE_ACTION_FAILED: $ServiceAction" }
}

function Rotate-Logs {
  $cutoff = [DateTime]::UtcNow.AddDays(-7)
  $archive = Join-Path $config.logsRoot 'archive'
  New-Item -ItemType Directory -Path $archive -Force | Out-Null
  Get-ChildItem -LiteralPath $config.logsRoot -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -lt $cutoff -and $_.Name -notlike '*-process.json' } |
    ForEach-Object {
      $target = Join-Path $archive $_.Name
      if (-not (Test-Path -LiteralPath $target)) { Move-Item -LiteralPath $_.FullName -Destination $target }
    }
}

if ($Action -eq 'Start') {
  Rotate-Logs
  Invoke-ServiceAction 'Start'
  exit 0
}
if ($Action -eq 'Stop') {
  Invoke-ServiceAction 'Stop'
  exit 0
}
if ($Action -eq 'Status') {
  Invoke-ServiceAction 'Status'
  $ready = $false
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($config.apiPort)/api/v1/health/ready" -TimeoutSec 2 -UseBasicParsing
    $ready = $response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).status -eq 'ready'
  } catch { $ready = $false }
  [pscustomobject]@{
    instanceId = $config.instanceId
    deploymentMode = $config.deploymentMode
    scheduledTask = [bool](Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
    apiReady = $ready
    publicWebBaseUrl = $config.publicWebBaseUrl
    lanCidr = $config.lanCidr
    runtimeRoot = $config.runtimeRoot
    backupArchiveRoot = $config.backupArchiveRoot
  } | ConvertTo-Json -Compress
  exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'LAN_TASK_ADMIN_REQUIRED: rerun from an elevated PowerShell'
}
if ($Action -eq 'Install') {
  $powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action Start -ConfigFile `"$configPath`" -NodePath `"$nodePath`""
  $taskAction = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $config.sourceRoot
  $startup = New-ScheduledTaskTrigger -AtStartup
  $watchdog = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Highest
  $task = New-ScheduledTask -Action $taskAction -Trigger @($startup,$watchdog) -Settings $settings -Principal $taskPrincipal
  Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Output "installed and started scheduled task: $taskName"
  exit 0
}
if ($Action -eq 'Uninstall') {
  Invoke-ServiceAction 'Stop'
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  Write-Output "scheduled task removed; runtime data, logs, downloads, and backups retained"
}
