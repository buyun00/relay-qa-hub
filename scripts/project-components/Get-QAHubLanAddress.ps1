[CmdletBinding()]
param(
  [int]$WebPort = 4740,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

function Get-NetworkCidr([string]$Address, [int]$PrefixLength) {
  $bytes = [Net.IPAddress]::Parse($Address).GetAddressBytes()
  $bits = $PrefixLength
  for ($index = 0; $index -lt $bytes.Length; $index++) {
    $mask = if ($bits -ge 8) { 255 } elseif ($bits -le 0) { 0 } else { 256 - [Math]::Pow(2, 8 - $bits) }
    $bytes[$index] = $bytes[$index] -band [int]$mask
    $bits -= 8
  }
  return "$([Net.IPAddress]::new($bytes).ToString())/$PrefixLength"
}

$profiles = @{}
Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object {
  $profiles[[int]$_.InterfaceIndex] = [string]$_.NetworkCategory
}

$candidates = foreach ($route in Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop) {
  if ($route.State -ne 'Alive') { continue }
  $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue
  if (-not $adapter -or $adapter.Status -ne 'Up') { continue }
  $ipInterface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue
  foreach ($address in Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue) {
    if ($address.AddressState -ne 'Preferred') { continue }
    if ($address.IPAddress -eq '0.0.0.0' -or $address.IPAddress.StartsWith('127.') -or $address.IPAddress.StartsWith('169.254.')) { continue }
    $metric = [int]$route.RouteMetric + [int]($ipInterface.InterfaceMetric | Select-Object -First 1)
    [pscustomobject]@{
      interfaceAlias = [string]$adapter.Name
      interfaceDescription = [string]$adapter.InterfaceDescription
      interfaceIndex = [int]$route.InterfaceIndex
      address = [string]$address.IPAddress
      prefixLength = [int]$address.PrefixLength
      cidr = Get-NetworkCidr $address.IPAddress $address.PrefixLength
      gateway = [string]$route.NextHop
      dhcpEnabled = [string]($ipInterface.Dhcp | Select-Object -First 1) -eq 'Enabled'
      networkProfile = if ($profiles.ContainsKey([int]$route.InterfaceIndex)) { $profiles[[int]$route.InterfaceIndex] } else { 'Unknown' }
      routeMetric = $metric
      publicWebBaseUrl = "http://$($address.IPAddress):$WebPort"
    }
  }
}

$ranked = @($candidates | Sort-Object routeMetric, interfaceIndex, address)
for ($index = 0; $index -lt $ranked.Count; $index++) {
  $ranked[$index] | Add-Member -NotePropertyName recommended -NotePropertyValue ($index -eq 0)
}
if ($ranked.Count -eq 0) { throw 'LAN_ADDRESS_NOT_FOUND: no preferred IPv4 address with an alive default route' }
if ($Json) { $ranked | ConvertTo-Json -Depth 4 } else { $ranked }

