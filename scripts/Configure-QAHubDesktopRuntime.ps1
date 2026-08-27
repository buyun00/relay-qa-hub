param(
  [string]$RuntimeStatePath = "D:\Relay-QA-Hub-Data\mvp-e2e-current.json",
  [string]$ApiBaseUrl = "http://127.0.0.1:4319",
  [string]$CsrfOrigin = "http://127.0.0.1:4174"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

if (-not (Test-Path -LiteralPath $RuntimeStatePath -PathType Leaf)) {
  throw "QA Hub runtime state is missing"
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw "LOCALAPPDATA is unavailable"
}

$apiUri = [Uri]$ApiBaseUrl
if (-not $apiUri.IsAbsoluteUri -or $apiUri.UserInfo -or $apiUri.Query -or $apiUri.Fragment) {
  throw "ApiBaseUrl must be an absolute URL without credentials, query, or fragment"
}
$loopbackHosts = @("127.0.0.1", "localhost", "::1")
if ($apiUri.Scheme -ne "https" -and
    -not ($apiUri.Scheme -eq "http" -and $loopbackHosts -contains $apiUri.Host)) {
  throw "ApiBaseUrl must use HTTPS or loopback HTTP"
}
$csrfUri = [Uri]$CsrfOrigin
if (-not $csrfUri.IsAbsoluteUri -or $csrfUri.AbsolutePath -ne "/" -or
    $csrfUri.UserInfo -or $csrfUri.Query -or $csrfUri.Fragment) {
  throw "CsrfOrigin must be an origin without credentials, path, query, or fragment"
}

$state = Get-Content -LiteralPath $RuntimeStatePath -Raw | ConvertFrom-Json
$token = [string]$state.accessToken
if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -gt 4096 -or $token -match '[\x00-\x20\x7f]') {
  throw "QA Hub runtime access token is invalid"
}

$runtimeDirectory = Join-Path $env:LOCALAPPDATA "Relay QA Hub"
$configFile = Join-Path $runtimeDirectory "desktop-runtime.json"
$tokenFile = Join-Path $runtimeDirectory "desktop-access.token"
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$administratorsSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")

function Set-PrivateDirectoryAcl {
  param([string]$LiteralPath)
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $LiteralPath -AclObject $acl
}

function Set-PrivateFileAcl {
  param([string]$LiteralPath)
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $LiteralPath -AclObject $acl
}

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
Set-PrivateDirectoryAcl -LiteralPath $runtimeDirectory

$wssScheme = if ($apiUri.Scheme -eq "https") { "wss" } else { "ws" }
$wssUrl = "${wssScheme}://$($apiUri.Authority)/api/v1/notifications/stream"
$config = [ordered]@{
  schemaVersion = 1
  apiBaseUrl = $apiUri.GetLeftPart([UriPartial]::Authority)
  wssUrl = $wssUrl
  csrfOrigin = $csrfUri.GetLeftPart([UriPartial]::Authority)
  accessTokenFile = $tokenFile
  allowLoopbackHttp = $apiUri.Scheme -eq "http"
  autoStartAtLogin = $false
  startupHidden = $false
}
$encoding = [Text.UTF8Encoding]::new($false)
$tokenTemp = "$tokenFile.tmp-$PID"
$configTemp = "$configFile.tmp-$PID"
try {
  [IO.File]::WriteAllText($tokenTemp, "$token`n", $encoding)
  Set-PrivateFileAcl -LiteralPath $tokenTemp
  Move-Item -LiteralPath $tokenTemp -Destination $tokenFile -Force
  [IO.File]::WriteAllText($configTemp, (($config | ConvertTo-Json -Depth 3) + "`n"), $encoding)
  Set-PrivateFileAcl -LiteralPath $configTemp
  Move-Item -LiteralPath $configTemp -Destination $configFile -Force
} finally {
  Remove-Item -LiteralPath $tokenTemp -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $configTemp -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
  configured = $true
  apiBaseUrl = $config.apiBaseUrl
  notificationStream = $config.wssUrl
  runtimeDirectory = $runtimeDirectory
  configFile = $configFile
  tokenFile = $tokenFile
  tokenStoredSeparately = $true
}
