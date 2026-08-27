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
foreach ($required in @($tsc, $vite, $packageScript)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required Windows publish dependency is missing: $required"
  }
}

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
  & $packageScript -LanAddress $LanAddress
  if ($LASTEXITCODE -ne 0) { throw "Desktop packaging failed." }
} finally {
  Pop-Location
}
