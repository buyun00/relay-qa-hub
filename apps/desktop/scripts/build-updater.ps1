param(
  [Parameter(Mandatory = $true)][string]$IconFile,
  [Parameter(Mandatory = $true)][string]$ProductVersion
)

$ErrorActionPreference = "Stop"
$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$updaterScript = Join-Path $PSScriptRoot "updater.nsi"
$outputRoot = Join-Path $desktopRoot "release\.generated"
$updaterFile = Join-Path $outputRoot "RelayQaHubUpdater.exe"

foreach ($required in @($updaterScript, $IconFile)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required native updater dependency is missing: $required"
  }
}

$makensis = $env:QA_HUB_NSIS_MAKENSIS
if ([string]::IsNullOrWhiteSpace($makensis) -or -not (Test-Path -LiteralPath $makensis -PathType Leaf)) {
  $makensisCommand = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($null -ne $makensisCommand) {
    $makensis = $makensisCommand.Source
  } else {
    $cacheRoot = Join-Path $env:LOCALAPPDATA "electron-builder\Cache"
    $makensis = @(
      Get-ChildItem -LiteralPath $cacheRoot -Recurse -File -Filter "makensis.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -ExpandProperty FullName
    ) | Select-Object -First 1
  }
}
if ([string]::IsNullOrWhiteSpace($makensis) -or -not (Test-Path -LiteralPath $makensis -PathType Leaf)) {
  throw "makensis.exe is missing; install NSIS or set QA_HUB_NSIS_MAKENSIS."
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
& $makensis `
  "/DPRODUCT_VERSION=$ProductVersion" `
  "/DICON_FILE=$IconFile" `
  "/DOUTPUT_FILE=$updaterFile" `
  $updaterScript | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "NSIS native updater build failed with exit code $LASTEXITCODE."
}

$updater = Get-Item -LiteralPath $updaterFile -ErrorAction Stop
[pscustomobject][ordered]@{
  updater = $updater.FullName
  updaterBytes = $updater.Length
  version = $ProductVersion
}
