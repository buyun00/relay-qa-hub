param(
  [string]$LanAddress,
  [string]$ReleaseId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
)

$ErrorActionPreference = "Stop"
$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $desktopRoot "..\..")).Path
$assertReleaseSource = Join-Path $repoRoot "scripts\Assert-QAHubReleaseSource.ps1"
$packageScript = Join-Path $PSScriptRoot "package-windows.ps1"
$installerScript = Join-Path $PSScriptRoot "installer.nsi"
$outputRoot = Join-Path $desktopRoot "release\installer"
$desktopPackage = Get-Content -LiteralPath (Join-Path $desktopRoot "package.json") -Raw | ConvertFrom-Json

foreach ($required in @($assertReleaseSource, $packageScript, $installerScript)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required installer dependency is missing: $required"
  }
}
& $assertReleaseSource -RepoRoot $repoRoot | Out-Null

$portable = & $packageScript -LanAddress $LanAddress -ReleaseId $ReleaseId
$packageDirectory = [string]$portable.packageDirectory
if (-not (Test-Path -LiteralPath $packageDirectory -PathType Container)) {
  throw "The current portable package is missing: $packageDirectory"
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

$iconFile = Join-Path $desktopRoot "release\.generated\RelayQaHub.ico"
$installerFile = Join-Path $outputRoot "Relay-QA-Hub-Setup-$($desktopPackage.version)-x64.exe"
$stableAlias = Join-Path $outputRoot "Relay-QA-Hub-Setup-x64.exe"
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

& $makensis `
  "/DPRODUCT_VERSION=$($desktopPackage.version)" `
  "/DRELEASE_ID=$ReleaseId" `
  "/DSOURCE_DIR=$packageDirectory" `
  "/DICON_FILE=$iconFile" `
  "/DOUTPUT_FILE=$installerFile" `
  $installerScript | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "NSIS installer build failed with exit code $LASTEXITCODE."
}

$installer = Get-Item -LiteralPath $installerFile -ErrorAction Stop
Copy-Item -LiteralPath $installer.FullName -Destination $stableAlias -Force

[pscustomobject][ordered]@{
  installer = $installer.FullName
  installerBytes = $installer.Length
  stableAlias = $stableAlias
  version = [string]$desktopPackage.version
  releaseId = $ReleaseId
  sourceCommit = [string]$portable.sourceCommit
  defaultApiBaseUrl = [string]$portable.defaultApiBaseUrl
  portableZip = [string]$portable.zipFile
  updateManifest = [string]$portable.updateManifest
  containsAccessToken = $false
}
