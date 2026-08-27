param(
  [string]$ServerAddress = "10.100.5.157",
  [ValidateRange(1, 65535)][int]$ApiPort = 4319,
  [ValidateRange(1, 65535)][int]$WebPort = 4174
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

$parsedAddress = $null
if (
  -not [Net.IPAddress]::TryParse($ServerAddress.Trim(), [ref]$parsedAddress) -or
  $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork
) {
  throw "ServerAddress must be a literal IPv4 address"
}
$octets = $parsedAddress.GetAddressBytes()
$isLoopback = $octets[0] -eq 127
$isPrivateLan =
  $octets[0] -eq 10 -or
  ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
  ($octets[0] -eq 192 -and $octets[1] -eq 168)
if (-not $isLoopback -and -not $isPrivateLan) {
  throw "ServerAddress must be loopback or RFC1918 private IPv4"
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw "LOCALAPPDATA is unavailable"
}

$normalizedAddress = $parsedAddress.ToString()
$runtimeDirectory = Join-Path $env:LOCALAPPDATA "Relay QA Hub"
$configFile = Join-Path $runtimeDirectory "desktop-runtime.json"
$config = [ordered]@{
  schemaVersion = 1
  apiBaseUrl = "http://${normalizedAddress}:$ApiPort"
  wssUrl = "ws://${normalizedAddress}:$ApiPort/api/v1/notifications/stream"
  csrfOrigin = "http://${normalizedAddress}:$WebPort"
  allowLoopbackHttp = $isLoopback
  allowPrivateLanHttp = $isPrivateLan
  autoStartAtLogin = $true
  startupHidden = $false
}

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$encoding = [Text.UTF8Encoding]::new($false)
$temporaryFile = "$configFile.tmp-$PID"
try {
  [IO.File]::WriteAllText(
    $temporaryFile,
    (($config | ConvertTo-Json -Depth 3) + "`n"),
    $encoding
  )
  Move-Item -LiteralPath $temporaryFile -Destination $configFile -Force
} finally {
  Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
}

[pscustomobject][ordered]@{
  configured = $true
  apiBaseUrl = $config.apiBaseUrl
  configFile = $configFile
  containsAccessToken = $false
  nextAction = "Exit and reopen RelayQaHub.exe"
}
