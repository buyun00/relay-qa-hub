[CmdletBinding()]
param(
  [string]$RuntimeRoot = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-lan-v22-0911',
  [string]$ArchiveRoot = 'C:\Users\lin0\.codex\parallel-archives\qa-hub-lan-v22-0911',
  [string]$Address,
  [string]$Cidr
)

$ErrorActionPreference = 'Stop'
$sourcePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$nodePath = (Get-Command node -ErrorAction Stop).Source
if (-not $Address -or -not $Cidr) {
  $candidate = @(& (Join-Path $PSScriptRoot 'Get-QAHubLanAddress.ps1') -WebPort 4740) | Select-Object -First 1
  if (-not $candidate) { throw 'LAN_ADDRESS_NOT_FOUND' }
  if (-not $Address) { $Address = $candidate.address }
  if (-not $Cidr) { $Cidr = $candidate.cidr }
}
foreach ($port in 4739,4740,4741,4742) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "LAN_PORT_OCCUPIED: $port"
  }
}
$result = & $nodePath (Join-Path $PSScriptRoot 'initialize-lan.mjs') $RuntimeRoot $Address $Cidr $ArchiveRoot
if ($LASTEXITCODE -ne 0) { throw 'LAN_INITIALIZATION_FAILED' }

# Limit runtime secrets/configuration to this user, SYSTEM and local administrators.
$principal = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $RuntimeRoot '/inheritance:r' '/grant:r' "${principal}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'LAN_RUNTIME_ACL_FAILED' }
& icacls.exe $ArchiveRoot '/inheritance:r' '/grant:r' "${principal}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'LAN_ARCHIVE_ACL_FAILED' }
$result
