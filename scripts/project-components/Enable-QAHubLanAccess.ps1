[CmdletBinding()]
param(
  [string]$ConfigFile = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-lan-v22-0911\instance.json'
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'LAN_FIREWALL_ADMIN_REQUIRED: rerun from an elevated PowerShell'
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$configPath = (Resolve-Path -LiteralPath $ConfigFile).Path
$config = (& $nodePath (Join-Path $PSScriptRoot 'inspect-preview.mjs') $configPath) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $config.deploymentMode -ne 'lan') { throw 'LAN_CONFIGURATION_VALIDATION_FAILED' }
$hostAddress = ([Uri]$config.publicWebBaseUrl).Host
$ip = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $hostAddress -ErrorAction Stop
$profile = Get-NetConnectionProfile -InterfaceIndex $ip.InterfaceIndex -ErrorAction Stop
$ruleNames = @(
  "Relay QA Hub LAN Web - $($config.instanceId)",
  "Relay QA Hub LAN MCP - $($config.instanceId)"
)
for ($index = 0; $index -lt $ruleNames.Count; $index++) {
  $name = $ruleNames[$index]
  $port = if ($index -eq 0) { $config.webPort } else { $config.mcpPort }
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Enabled True -Profile $profile.NetworkCategory -Protocol TCP -LocalPort $port -RemoteAddress $config.lanCidr -Program $nodePath -Description "Scoped to $($config.instanceId), $($config.lanCidr), and $($profile.NetworkCategory) profile" | Out-Null
}
[pscustomobject]@{
  instanceId = $config.instanceId
  address = $hostAddress
  interfaceAlias = $ip.InterfaceAlias
  networkProfile = $profile.NetworkCategory
  remoteAddress = $config.lanCidr
  ports = @($config.webPort, $config.mcpPort)
  rules = $ruleNames
} | ConvertTo-Json -Depth 4 -Compress

