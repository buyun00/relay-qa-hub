param([string]$LanAddress)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"' + $PSCommandPath + '"')
  )
  if (-not [string]::IsNullOrWhiteSpace($LanAddress)) {
    $arguments += @("-LanAddress", $LanAddress)
  }
  $elevated = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $arguments `
    -Verb RunAs `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  if ($elevated.ExitCode -ne 0) {
    throw "Elevated QA Hub firewall configuration failed with exit code $($elevated.ExitCode)"
  }
  return
}

. (Join-Path $PSScriptRoot "qa-hub-lan.ps1")
$binding = Resolve-QAHubLanBinding -LanAddress $LanAddress

function Set-QAHubFirewallRule {
  param(
    [string]$Name,
    [string]$DisplayName,
    [int]$Port
  )

  $rule = Get-NetFirewallRule -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $rule) {
    $rule = New-NetFirewallRule `
      -Name $Name `
      -DisplayName $DisplayName `
      -Description "Relay QA Hub LAN access restricted to $($binding.Cidr) on $($binding.Address)." `
      -Enabled True `
      -Direction Inbound `
      -Action Allow `
      -Profile Any `
      -Protocol TCP `
      -LocalAddress $binding.Address `
      -LocalPort $Port `
      -RemoteAddress $binding.Cidr `
      -EdgeTraversalPolicy Block
  } else {
    Set-NetFirewallRule `
      -Name $Name `
      -NewDisplayName $DisplayName `
      -Description "Relay QA Hub LAN access restricted to $($binding.Cidr) on $($binding.Address)." `
      -Enabled True `
      -Direction Inbound `
      -Action Allow `
      -Profile Any `
      -EdgeTraversalPolicy Block `
      -ErrorAction Stop | Out-Null
    $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter `
      -Protocol TCP `
      -LocalPort $Port `
      -RemotePort Any `
      -ErrorAction Stop | Out-Null
    $rule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter `
      -LocalAddress $binding.Address `
      -RemoteAddress $binding.Cidr `
      -ErrorAction Stop | Out-Null
  }
}

Set-QAHubFirewallRule `
  -Name "RelayQAHubApiLan4319" `
  -DisplayName "Relay QA Hub API LAN (4319)" `
  -Port 4319
Set-QAHubFirewallRule `
  -Name "RelayQAHubWebLan4174" `
  -DisplayName "Relay QA Hub Web LAN (4174)" `
  -Port 4174

[pscustomobject][ordered]@{
  lanAddress = $binding.Address
  allowedRemoteSubnet = $binding.Cidr
  networkCategory = $binding.NetworkCategory
  apiPort = 4319
  webPort = 4174
  relayPortExposed = $false
}
