param([string]$LanAddress)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$nodeExecutable = $env:QA_HUB_DESKTOP_NODE_EXE
if ([string]::IsNullOrWhiteSpace($nodeExecutable) -or
    -not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) {
    throw "Node is not on PATH; set QA_HUB_DESKTOP_NODE_EXE to node.exe."
  }
  $nodeExecutable = $nodeCommand.Source
}
$env:QA_HUB_DESKTOP_NODE_EXE = $nodeExecutable
$env:PATH = "$(Split-Path -Parent $nodeExecutable);$env:PATH"
$tsc = Join-Path $repoRoot "node_modules\.bin\tsc.cmd"
$vite = Join-Path $repoRoot "node_modules\.bin\vite.cmd"
$packageScript = Join-Path $repoRoot "apps\desktop\scripts\package-windows.ps1"
$installerScript = Join-Path $repoRoot "apps\desktop\scripts\build-installer.ps1"
$signUpdateScript = Join-Path $repoRoot "apps\desktop\scripts\sign-update.mjs"
$assertReleaseSource = Join-Path $repoRoot "scripts\Assert-QAHubReleaseSource.ps1"
foreach ($required in @($tsc, $vite, $packageScript, $installerScript, $signUpdateScript, $assertReleaseSource)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required Windows publish dependency is missing: $required"
  }
}

& $assertReleaseSource -RepoRoot $repoRoot | Out-Null
$releaseId = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")

Push-Location $repoRoot
try {
  & $tsc -p apps/web/tsconfig.app.json --noEmit
  if ($LASTEXITCODE -ne 0) { throw "Web typecheck failed." }
  Push-Location (Join-Path $repoRoot "apps\web")
  try {
    & $vite build
    if ($LASTEXITCODE -ne 0) { throw "Web build failed." }
  } finally {
    Pop-Location
  }
  & $tsc -p apps/desktop/tsconfig.json
  if ($LASTEXITCODE -ne 0) { throw "Desktop build failed." }
  $installer = & $installerScript -LanAddress $LanAddress -ReleaseId $releaseId
  if ($LASTEXITCODE -ne 0) { throw "Desktop installer build failed." }
  $updateManifest = Join-Path $repoRoot "apps\desktop\release\RelayQaHub-win32-x64-latest.json"
  & $nodeExecutable `
    $signUpdateScript `
    --archive ([string]$installer.stableAlias) `
    --manifest $updateManifest `
    --release-id $releaseId `
    --version ([string]$installer.version) `
    --url "/downloads/Relay-QA-Hub-Setup-x64.exe"
  if ($LASTEXITCODE -ne 0) { throw "Desktop installer update manifest signing failed." }
} finally {
  Pop-Location
}

[pscustomobject][ordered]@{
  releaseId = $releaseId
  installer = $installer
}
