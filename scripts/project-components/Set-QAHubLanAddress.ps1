[CmdletBinding()]
param(
  [string]$ConfigFile = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-lan-v22-0911\instance.json',
  [string]$Address,
  [string]$Cidr,
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$nodeCommand = if ($NodePath) { $null } else { Get-Command node -ErrorAction SilentlyContinue }
$nodePath = if ($NodePath) { [IO.Path]::GetFullPath($NodePath) } elseif ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'NODE_RUNTIME_NOT_FOUND' }
$configPath = (Resolve-Path -LiteralPath $ConfigFile).Path
if (-not $Address -or -not $Cidr) {
  $candidate = @(& (Join-Path $PSScriptRoot 'Get-QAHubLanAddress.ps1') -WebPort 4740) | Select-Object -First 1
  if (-not $candidate) { throw 'LAN_ADDRESS_NOT_FOUND' }
  if (-not $Address) { $Address = $candidate.address }
  if (-not $Cidr) { $Cidr = $candidate.cidr }
}
& (Join-Path $PSScriptRoot 'Manage-QAHubLan.ps1') -Action Stop -ConfigFile $configPath -NodePath $nodePath
& $nodePath (Join-Path $PSScriptRoot 'update-lan-address.mjs') $configPath $Address $Cidr
if ($LASTEXITCODE -ne 0) { throw 'LAN_ADDRESS_UPDATE_FAILED' }
$firewallScript = Join-Path $PSScriptRoot 'Enable-QAHubLanAccess.ps1'
$firewall = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',"`"$firewallScript`"",'-ConfigFile',"`"$configPath`"",'-NodePath',"`"$nodePath`"") -Verb RunAs -WindowStyle Hidden -Wait -PassThru
if ($firewall.ExitCode -ne 0) { throw "LAN_FIREWALL_UPDATE_FAILED: $($firewall.ExitCode)" }
& (Join-Path $PSScriptRoot 'Manage-QAHubLan.ps1') -Action Start -ConfigFile $configPath -NodePath $nodePath
