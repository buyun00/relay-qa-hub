$ErrorActionPreference = "Stop"

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $desktopRoot "..\..")).Path
$electron = Join-Path $repoRoot "node_modules\.bin\electron.cmd"

if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
  throw "Electron is not installed; install the root workspace dependencies first."
}

$env:QA_HUB_DESKTOP_DEV_URL = "http://127.0.0.1:4174"
$env:QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP = "1"
$env:QA_HUB_DESKTOP_USE_DEV_URL = "1"

& $electron $desktopRoot
exit $LASTEXITCODE
