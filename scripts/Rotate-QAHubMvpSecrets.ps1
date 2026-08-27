param(
  [string]$StatePath = "D:\Relay-QA-Hub-Data\mvp-e2e-current.json"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

function New-HexSecret {
  param([int]$Bytes = 32)

  $buffer = New-Object byte[] $Bytes
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $random.GetBytes($buffer)
  } finally {
    $random.Dispose()
  }
  return -join ($buffer | ForEach-Object { $_.ToString("x2") })
}

if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
  throw "QA Hub MVP runtime state is missing: $StatePath"
}

$resolvedStatePath = (Resolve-Path -LiteralPath $StatePath).Path
$state = Get-Content -LiteralPath $resolvedStatePath -Raw | ConvertFrom-Json
foreach ($requiredProperty in @("accessToken", "webSessionSecret", "bootstrapPassword")) {
  if ($null -eq $state.PSObject.Properties[$requiredProperty]) {
    throw "QA Hub MVP runtime state is missing $requiredProperty"
  }
}

$state.accessToken = New-HexSecret 32
$state.webSessionSecret = New-HexSecret 32
$state.bootstrapPassword = "Mvp-" + (New-HexSecret 16)
$state | Add-Member -NotePropertyName secretsRotatedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedStatePath -Encoding UTF8

[pscustomobject]@{
  rotated = $true
  statePath = $resolvedStatePath
  rotatedAt = $state.secretsRotatedAt
}
