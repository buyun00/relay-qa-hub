$ErrorActionPreference = "Stop"

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$repoRoot = (Resolve-Path (Join-Path $desktopRoot "..\.." )).Path
$webDist = Join-Path $repoRoot "apps\web\dist"
$desktopDist = Join-Path $desktopRoot "dist"
$packager = Join-Path $repoRoot "node_modules\.bin\electron-packager.cmd"
$outputRoot = Join-Path $desktopRoot "release"
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
$env:PATH = "$(Split-Path -Parent $nodeCommand.Source);$env:PATH"

try {
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $desktopRoot "package.json") -Destination $stageRoot
  Copy-Item -LiteralPath $desktopDist -Destination (Join-Path $stageRoot "dist") -Recurse
  Copy-Item -LiteralPath $webDist -Destination (Join-Path $stageRoot "web") -Recurse
  & $packager $stageRoot "RelayQaHub" --platform=win32 --arch=x64 --out=$outputRoot --overwrite --prune=true --asar
  if ($LASTEXITCODE -ne 0) { throw "electron-packager failed with exit code $LASTEXITCODE." }
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
