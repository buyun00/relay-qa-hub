Set-StrictMode -Version 2

function Resolve-QAHubLanBinding {
  param([string]$LanAddress)

  $configured = $LanAddress
  if ([string]::IsNullOrWhiteSpace($configured)) {
    $configured = [string]$env:QA_HUB_LAN_ADDRESS
  }

  $addressEntry = $null
  if (-not [string]::IsNullOrWhiteSpace($configured)) {
    $parsedAddress = $null
    if (
      -not [System.Net.IPAddress]::TryParse($configured.Trim(), [ref]$parsedAddress) -or
      $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
      [System.Net.IPAddress]::IsLoopback($parsedAddress) -or
      $parsedAddress.Equals([System.Net.IPAddress]::Any)
    ) {
      throw "QA Hub LAN address must be an assigned non-loopback IPv4 address"
    }
    $addressEntry = @(
      Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -eq $parsedAddress.ToString() -and $_.AddressState -eq "Preferred" }
    ) | Select-Object -First 1
    if ($null -eq $addressEntry) {
      throw "QA Hub LAN address $configured is not assigned to this computer"
    }
  } else {
    $defaultRoutes = @(
      Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop |
        Sort-Object @{ Expression = { $_.RouteMetric + $_.InterfaceMetric } }, RouteMetric
    )
    foreach ($route in $defaultRoutes) {
      $addressEntry = @(
        Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue |
          Where-Object {
            $_.AddressState -eq "Preferred" -and
            -not $_.SkipAsSource -and
            $_.IPAddress -notlike "127.*" -and
            $_.IPAddress -notlike "169.254.*"
          }
      ) | Select-Object -First 1
      if ($null -ne $addressEntry) { break }
    }
    if ($null -eq $addressEntry) {
      throw "No preferred IPv4 address was found on an interface with a default route"
    }
    $parsedAddress = [System.Net.IPAddress]::Parse([string]$addressEntry.IPAddress)
  }

  $bytes = $parsedAddress.GetAddressBytes()
  $networkBytes = New-Object byte[] 4
  $remainingBits = [int]$addressEntry.PrefixLength
  for ($index = 0; $index -lt 4; $index += 1) {
    $bits = [Math]::Min(8, [Math]::Max(0, $remainingBits))
    $mask = if ($bits -eq 0) { 0 } else { 256 - [Math]::Pow(2, 8 - $bits) }
    $networkBytes[$index] = [byte]($bytes[$index] -band [int]$mask)
    $remainingBits -= $bits
  }
  $networkAddress = (New-Object System.Net.IPAddress -ArgumentList @(,$networkBytes)).ToString()
  $profile = Get-NetConnectionProfile -InterfaceIndex $addressEntry.InterfaceIndex -ErrorAction SilentlyContinue

  [pscustomobject][ordered]@{
    Address = $parsedAddress.ToString()
    PrefixLength = [int]$addressEntry.PrefixLength
    Cidr = "$networkAddress/$($addressEntry.PrefixLength)"
    InterfaceAlias = [string]$addressEntry.InterfaceAlias
    InterfaceIndex = [int]$addressEntry.InterfaceIndex
    NetworkCategory = if ($null -eq $profile) { "Unknown" } else { [string]$profile.NetworkCategory }
  }
}
