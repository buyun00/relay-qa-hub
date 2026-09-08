param(
  [string]$LanAddress,
  [string]$ReleaseId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
)

$ErrorActionPreference = "Stop"

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$repoRoot = (Resolve-Path (Join-Path $desktopRoot "..\.." )).Path
$webDist = Join-Path $repoRoot "apps\web\dist"
$desktopDist = Join-Path $desktopRoot "dist"
$packager = Join-Path $repoRoot "node_modules\.bin\electron-packager.cmd"
$outputRoot = Join-Path $desktopRoot "release"
$portableClientScript = Join-Path $PSScriptRoot "Configure-QAHubPortableClient.ps1"
$signUpdateScript = Join-Path $PSScriptRoot "sign-update.mjs"
$generateIconScript = Join-Path $PSScriptRoot "generate-windows-icon.mjs"
$buildUpdaterScript = Join-Path $PSScriptRoot "build-updater.ps1"
$uploaderDirectory = Join-Path $desktopRoot "vendor\ozdqp-uploader"
$uploaderExecutable = Join-Path $uploaderDirectory "ozdqp-uploader.exe"
if (-not (Test-Path -LiteralPath $uploaderExecutable -PathType Leaf) -or
    (Get-FileHash -LiteralPath $uploaderExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne "9ffa226d0c6dc6e971963e7d1fc838dd2e1110f3120c716e548d33e80934dc23") {
  throw "Pinned OZDQP uploader 0.2.0 is missing or has changed."
}
$assertReleaseSource = Join-Path $repoRoot "scripts\Assert-QAHubReleaseSource.ps1"
$desktopPackage = Get-Content -LiteralPath (Join-Path $desktopRoot "package.json") -Raw | ConvertFrom-Json
$manifestFile = Join-Path $outputRoot "RelayQaHub-win32-x64-portable-latest.json"
$stageRoot = Join-Path $desktopRoot (".packaging-stage-" + [Guid]::NewGuid().ToString("N"))
$expectedStagePrefix = $desktopRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $stageRoot.StartsWith($expectedStagePrefix, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($stageRoot) -notmatch '^\.packaging-stage-[0-9a-f]{32}$') {
  throw "Unsafe packaging stage path: $stageRoot"
}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  $configuredNode = $env:QA_HUB_DESKTOP_NODE_EXE
  if ($null -ne $configuredNode -and (Test-Path -LiteralPath $configuredNode -PathType Leaf)) {
    $nodeCommand = Get-Command $configuredNode
  }
}

if (-not (Test-Path -LiteralPath $desktopDist -PathType Container)) {
  throw "apps/desktop/dist is missing; run the desktop build first."
}
if (-not (Test-Path -LiteralPath $webDist -PathType Container)) {
  throw "apps/web/dist is missing; run the web production build first."
}
if (-not (Test-Path -LiteralPath $packager -PathType Leaf)) {
  throw "@electron/packager is not installed; install workspace dependencies before packaging."
}
if ($null -eq $nodeCommand) {
  throw "Node is not on PATH; set QA_HUB_DESKTOP_NODE_EXE to the workspace Node executable."
}
$lanScript = Join-Path $repoRoot "scripts\qa-hub-lan.ps1"
if (-not (Test-Path -LiteralPath $lanScript -PathType Leaf)) {
  throw "QA Hub LAN resolver is missing."
}
if (-not (Test-Path -LiteralPath $portableClientScript -PathType Leaf)) {
  throw "Portable client configuration script is missing."
}
if (-not (Test-Path -LiteralPath $signUpdateScript -PathType Leaf)) {
  throw "Desktop update signing script is missing."
}
if (-not (Test-Path -LiteralPath $generateIconScript -PathType Leaf)) {
  throw "Windows icon generator is missing."
}
if (-not (Test-Path -LiteralPath $buildUpdaterScript -PathType Leaf)) {
  throw "Native updater builder is missing."
}
if (-not (Test-Path -LiteralPath $assertReleaseSource -PathType Leaf)) {
  throw "Release source guard is missing."
}
if ($ReleaseId -notmatch '^\d{8}T\d{9}Z$') {
  throw "ReleaseId must use yyyyMMddTHHmmssfffZ."
}
. $lanScript
$lan = Resolve-QAHubLanBinding -LanAddress $LanAddress
& $assertReleaseSource -RepoRoot $repoRoot | Out-Null
$sourceCommit = (git -C $repoRoot rev-parse HEAD).Trim()
$env:PATH = "$(Split-Path -Parent $nodeCommand.Source);$env:PATH"
$iconFile = Join-Path $outputRoot ".generated\RelayQaHub.ico"
& $nodeCommand.Source $generateIconScript $iconFile
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $iconFile -PathType Leaf)) {
  throw "Windows icon generation failed."
}
$nativeUpdater = & $buildUpdaterScript `
  -IconFile $iconFile `
  -ProductVersion ([string]$desktopPackage.version)
if (-not (Test-Path -LiteralPath ([string]$nativeUpdater.updater) -PathType Leaf)) {
  throw "Native updater build did not produce RelayQaHubUpdater.exe."
}

try {
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $desktopRoot "package.json") -Destination $stageRoot
  Copy-Item -LiteralPath $desktopDist -Destination (Join-Path $stageRoot "dist") -Recurse
  Copy-Item -LiteralPath $webDist -Destination (Join-Path $stageRoot "web") -Recurse
  $encoding = [Text.UTF8Encoding]::new($false)
  $releaseDescriptor = [ordered]@{
    schemaVersion = 1
    releaseId = $ReleaseId
    version = [string]$desktopPackage.version
    sourceCommit = $sourceCommit
  }
  [IO.File]::WriteAllText(
    (Join-Path $stageRoot "release.json"),
    (($releaseDescriptor | ConvertTo-Json -Depth 3) + "`n"),
    $encoding
  )
  $stageAssets = Join-Path $stageRoot "assets"
  New-Item -ItemType Directory -Path $stageAssets -Force | Out-Null
  Copy-Item `
    -LiteralPath $iconFile `
    -Destination (Join-Path $stageAssets "RelayQaHub.ico") `
    -Force
  & $packager $stageRoot "RelayQaHub" --platform=win32 --arch=x64 --out=$outputRoot --overwrite --prune=true --asar --icon=$iconFile
  if ($LASTEXITCODE -ne 0) { throw "electron-packager failed with exit code $LASTEXITCODE." }

  $packageDirectory = Join-Path $outputRoot "RelayQaHub-win32-x64"
  if (-not (Test-Path -LiteralPath $packageDirectory -PathType Container)) {
    throw "Packaged desktop directory is missing."
  }
  Copy-Item -LiteralPath $uploaderDirectory -Destination (Join-Path $packageDirectory "resources\uploader") -Recurse
  Copy-Item `
    -LiteralPath ([string]$nativeUpdater.updater) `
    -Destination (Join-Path $packageDirectory "RelayQaHubUpdater.exe") `
    -Force
  $runtimeConfig = [ordered]@{
    schemaVersion = 1
    apiBaseUrl = "http://$($lan.Address):4319"
    wssUrl = "ws://$($lan.Address):4319/api/v1/notifications/stream"
    csrfOrigin = "http://$($lan.Address):4174"
    allowPrivateLanHttp = $true
    autoStartAtLogin = $true
    startupHidden = $false
    mcpEnabled = $true
    mcpPort = 4320
  }
  [IO.File]::WriteAllText(
    (Join-Path $packageDirectory "desktop-runtime.json"),
    (($runtimeConfig | ConvertTo-Json -Depth 3) + "`n"),
    $encoding
  )
  Copy-Item `
    -LiteralPath $portableClientScript `
    -Destination (Join-Path $packageDirectory "Configure-QAHubPortableClient.ps1") `
    -Force
  # Keep this packaging script ASCII so Windows PowerShell 5.1 can parse it
  # without relying on a UTF-8 BOM. The decoded file remains UTF-8 Chinese.
  $instructionsTemplate = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String(
      "UmVsYXkgUUEgSHViIFdpbmRvd3Mg5YaF572R5L6/5pC65YyFCgoxLiDlv4Xpobvkv53nlZnlubbop6PljovmlbTkuKrnm67lvZXvvIzkuI3og73lj6rlpI3liLYgUmVsYXlRYUh1Yi5leGXjgIIKMi4g6buY6K6k5pyN5Yqh5Zyw5Z2A77yaaHR0cDovL3swfTo0MzE5CjMuIOebtOaOpei/kOihjCBSZWxheVFhSHViLmV4Ze+8jOeEtuWQjuS9v+eUqOWnk+WQjeWFqOaLvOeZu+W9leOAggo0LiDoi6UgUUEgSHViIOS4u+acuiBJUCDlj5jljJbvvIzlnKjmnKznm67lvZXov5DooYzvvJoKICAgcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1GaWxlIC5cQ29uZmlndXJlLVFBSHViUG9ydGFibGVDbGllbnQucHMxIC1TZXJ2ZXJBZGRyZXNzIOaWsElQCjUuIGRlc2t0b3AtcnVudGltZS5qc29uIOWSjOmFjee9ruiEmuacrOmDveS4jeWMheWQq+iuv+mXruS7pOeJjOOAguayoeacieWPpuihjOmFjee9ruS7pOeJjOaXtu+8jAogICDmi7zpn7PnmbvlvZXjgIFCdWcg5YiX6KGo5ZKM566h55CG5Yqf6IO95Y+v55So77ybV2luZG93cyDlkI7lj7DmjqjpgIHkvJrmmL7npLrkuLrmnKrlkK/nlKjjgII="
    )
  )
  $instructions = [string]::Format($instructionsTemplate, $lan.Address)
  $instructionsFileName = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("UUEtSHViLeWGhee9keS9v+eUqOivtOaYji50eHQ=")
  )
  [IO.File]::WriteAllText(
    (Join-Path $packageDirectory $instructionsFileName),
    $instructions,
    $encoding
  )
  $zipFile = Join-Path $outputRoot "RelayQaHub-win32-x64.zip"
  Compress-Archive `
    -LiteralPath $packageDirectory `
    -DestinationPath $zipFile `
    -CompressionLevel Optimal `
    -Force
  & $nodeCommand.Source `
    $signUpdateScript `
    --archive $zipFile `
    --manifest $manifestFile `
    --release-id $ReleaseId `
    --version ([string]$desktopPackage.version) `
    --url "/downloads/Relay-QA-Hub-Windows-x64.zip"
  if ($LASTEXITCODE -ne 0) { throw "Update manifest signing failed with exit code $LASTEXITCODE." }
} finally {
  if (Test-Path -LiteralPath $stageRoot) {
    $resolvedStageRoot = (Resolve-Path -LiteralPath $stageRoot).Path
    if (-not $resolvedStageRoot.StartsWith($expectedStagePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedStageRoot) -notmatch '^\.packaging-stage-[0-9a-f]{32}$') {
      throw "Refusing to remove unsafe packaging stage path: $resolvedStageRoot"
    }
    Remove-Item -LiteralPath $resolvedStageRoot -Recurse -Force
  }
}

[pscustomobject][ordered]@{
  packageDirectory = $packageDirectory
  zipFile = $zipFile
  updateManifest = $manifestFile
  releaseId = $ReleaseId
  defaultApiBaseUrl = $runtimeConfig.apiBaseUrl
  containsAccessToken = $false
  sourceCommit = $sourceCommit
  nativeUpdater = [string]$nativeUpdater.updater
}
