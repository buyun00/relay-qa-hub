param(
  [string]$UpdateUrl = "http://127.0.0.1:4319/api/v1/desktop-updates/stable"
)

$ErrorActionPreference = "Stop"

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $desktopRoot "..\..")).Path
$webDist = Join-Path $repoRoot "apps\web\dist"
$desktopDist = Join-Path $desktopRoot "dist"
$builder = Join-Path $desktopRoot "node_modules\.bin\electron-builder.cmd"
$outputRoot = Join-Path $desktopRoot "release\installer"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue

if ($null -eq $nodeCommand) {
  $configuredNode = $env:QA_HUB_DESKTOP_NODE_EXE
  if ($null -ne $configuredNode -and (Test-Path -LiteralPath $configuredNode -PathType Leaf)) {
    $nodeCommand = Get-Command $configuredNode
  }
}
if ($null -eq $nodeCommand) {
  throw "Node is not on PATH; set QA_HUB_DESKTOP_NODE_EXE to the workspace Node executable."
}
if ($null -eq $pnpmCommand) {
  throw "pnpm is not on PATH; install or expose the workspace pnpm executable first."
}
if (-not (Test-Path -LiteralPath $desktopDist -PathType Container)) {
  throw "apps/desktop/dist is missing; run the desktop build first."
}
if (-not (Test-Path -LiteralPath $webDist -PathType Container)) {
  throw "apps/web/dist is missing; run the Web production build first."
}
if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) {
  throw "electron-builder is not installed; install workspace dependencies first."
}

try {
  $uri = [Uri]$UpdateUrl
} catch {
  throw "UpdateUrl must be an absolute URL."
}
$loopbackHttp = $uri.Scheme -eq "http" -and $uri.IsLoopback
if ($uri.Scheme -ne "https" -and -not $loopbackHttp) {
  throw "UpdateUrl must use HTTPS, except for a loopback-only development deployment."
}
if (-not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
  throw "UpdateUrl must not contain credentials, a query, or a fragment."
}

$env:PATH = "$(Split-Path -Parent $nodeCommand.Source);$env:PATH"
$env:QA_HUB_DESKTOP_UPDATE_URL = $uri.AbsoluteUri.TrimEnd('/')

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$stageRoot = Join-Path $tempRoot ("relay-qa-hub-desktop-" + [Guid]::NewGuid().ToString("N"))
$expectedStagePrefix = $tempRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $stageRoot.StartsWith($expectedStagePrefix, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($stageRoot) -notmatch '^relay-qa-hub-desktop-[0-9a-f]{32}$') {
  throw "Unsafe desktop build staging path."
}

$buildFailure = $null
try {
  New-Item -ItemType Directory -Path $stageRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $desktopRoot "package.json") -Destination $stageRoot
  Copy-Item -LiteralPath $desktopDist -Destination $stageRoot -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $desktopRoot "assets") -Destination $stageRoot -Recurse -Force
  Copy-Item -LiteralPath $webDist -Destination (Join-Path $stageRoot "web-dist") -Recurse -Force

  $stagePackagePath = Join-Path $stageRoot "package.json"
  $stagePackage = Get-Content -LiteralPath $stagePackagePath -Raw | ConvertFrom-Json
  $stagePackage.build.directories.output = $outputRoot
  $stagePackage.build.extraResources[0].from = "web-dist"
  $stagePackage | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $stagePackagePath -Encoding utf8NoBOM

  Push-Location $stageRoot
  try {
    & $pnpmCommand.Source install --prod --ignore-workspace --ignore-scripts
    if ($LASTEXITCODE -ne 0) {
      throw "Isolated production dependency install failed with exit code $LASTEXITCODE."
    }
    & $builder --win nsis --x64 --publish never
    if ($LASTEXITCODE -ne 0) {
      throw "electron-builder failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
} catch {
  $buildFailure = $_
  throw
} finally {
  if (Test-Path -LiteralPath $stageRoot) {
    $resolvedStage = (Resolve-Path -LiteralPath $stageRoot).Path
    if (-not $resolvedStage.StartsWith($expectedStagePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedStage) -notmatch '^relay-qa-hub-desktop-[0-9a-f]{32}$') {
      throw "Refusing to remove an unsafe desktop build staging path."
    }
    for ($attempt = 1; $attempt -le 3 -and (Test-Path -LiteralPath $resolvedStage); $attempt++) {
      Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $resolvedStage) {
        Start-Sleep -Milliseconds 200
      }
    }
    if (Test-Path -LiteralPath $resolvedStage) {
      $cleanupMessage = "Could not completely remove desktop build staging path: $resolvedStage"
      if ($null -eq $buildFailure) {
        throw $cleanupMessage
      }
      Write-Warning $cleanupMessage
    }
  }
}

$latest = Get-Item -LiteralPath (Join-Path $outputRoot "latest.yml") -ErrorAction Stop
$latestMetadata = Get-Content -LiteralPath $latest.FullName -Raw
$versionMatch = [regex]::Match($latestMetadata, '(?m)^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$')
if (-not $versionMatch.Success) {
  throw "latest.yml does not contain a stable semantic version."
}
$installer = Get-Item -LiteralPath (Join-Path $outputRoot "Relay-QA-Hub-Setup-$($versionMatch.Groups[1].Value)-x64.exe") -ErrorAction Stop
$blockmap = Get-Item -LiteralPath ($installer.FullName + ".blockmap") -ErrorAction Stop

[pscustomobject]@{
  installer = $installer.FullName
  installerBytes = $installer.Length
  blockmap = $blockmap.FullName
  metadata = $latest.FullName
  updateUrl = $env:QA_HUB_DESKTOP_UPDATE_URL
} | ConvertTo-Json -Compress
