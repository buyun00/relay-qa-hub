param(
  [string]$RuntimeStatePath = "D:\Relay-QA-Hub-Data\mvp-e2e-current.json",
  [int]$Port = 4322
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$nodeExe = "C:\Users\lin0\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$apiEntry = Join-Path $repoRoot "apps\api\dist\main.js"
$state = Get-Content -LiteralPath $RuntimeStatePath -Raw | ConvertFrom-Json
$sourceDatabase = Join-Path ([string]$state.dataRoot) "db\qa-hub.sqlite"

if (-not (Test-Path -LiteralPath $sourceDatabase -PathType Leaf)) {
  throw "The live SQLite database does not exist"
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw "Canary port $Port is already in use"
}

$canaryRoot = Join-Path $env:TEMP ("relay-qa-hub-migration-canary-" + [guid]::NewGuid().ToString("N"))
$dataRoot = Join-Path $canaryRoot "data"
$databaseRoot = Join-Path $dataRoot "db"
$evidenceRoot = Join-Path $dataRoot "evidence"
$quarantineRoot = Join-Path $dataRoot "quarantine"
$logsRoot = Join-Path $canaryRoot "logs"
New-Item `
  -ItemType Directory `
  -Path $databaseRoot, $evidenceRoot, $quarantineRoot, $logsRoot `
  -Force | Out-Null
$targetDatabase = Join-Path $databaseRoot "qa-hub.sqlite"

$onlineBackupCode = @'
const { DatabaseSync, backup } = require('node:sqlite');
const [source, target] = process.argv.slice(1);
const database = new DatabaseSync(source, { readOnly: true });
backup(database, target)
  .then(() => database.close())
  .catch((error) => {
    try { database.close(); } catch {}
    console.error(error.message);
    process.exitCode = 1;
  });
'@

& $nodeExe -e $onlineBackupCode $sourceDatabase $targetDatabase
if ($LASTEXITCODE -ne 0) {
  throw "The online SQLite backup failed"
}

$env:QA_HUB_API_HOST = "127.0.0.1"
$env:QA_HUB_API_PORT = [string]$Port
$env:QA_HUB_BUILD_SHA = "dev"
$env:QA_HUB_DATA_ROOT = $dataRoot
$env:QA_HUB_MVP_ACCESS_TOKEN = [string]$state.accessToken
$env:QA_HUB_WEB_AUTH_MODE = "debug"
Remove-Item Env:QA_HUB_WEB_SESSION_SECRET -ErrorAction SilentlyContinue
Remove-Item Env:QA_HUB_BOOTSTRAP_ADMIN_PASSWORD -ErrorAction SilentlyContinue

$stdout = Join-Path $logsRoot "api.stdout.log"
$stderr = Join-Path $logsRoot "api.stderr.log"
$api = Start-Process `
  -FilePath $nodeExe `
  -ArgumentList @($apiEntry) `
  -WorkingDirectory $repoRoot `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -WindowStyle Hidden `
  -PassThru

try {
  $ready = $null
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($api.HasExited) { break }
    try {
      $ready = Invoke-RestMethod `
        -Uri "http://127.0.0.1:$Port/api/v1/health/ready" `
        -TimeoutSec 2
      if ($ready.status -eq "ready") { break }
      $ready = $null
      Start-Sleep -Milliseconds 200
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }
  if ($null -eq $ready) {
    $tail = Get-Content -LiteralPath $stderr -Tail 30 -ErrorAction SilentlyContinue
    throw "The canary API failed to become ready. $tail"
  }

  $headers = @{ Authorization = "Bearer $([string]$state.accessToken)" }
  $bugs = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/api/v1/bugs?limit=100" `
    -Headers $headers `
    -TimeoutSec 5
  $migrationBackups = @(
    Get-ChildItem `
      -LiteralPath (Join-Path $databaseRoot "migration-backups") `
      -Filter "*.sqlite" `
      -ErrorAction SilentlyContinue
  )

  [pscustomobject]@{
    canaryReady = $ready.status
    schemaVersion = $ready.schemaVersion
    migrationBackupCreated = $migrationBackups.Count -gt 0
    bugCount = @($bugs.items).Count
    canaryRoot = $canaryRoot
  }
} finally {
  if (-not $api.HasExited) {
    Stop-Process -Id $api.Id -Force
  }
  Wait-Process -Id $api.Id -ErrorAction SilentlyContinue
}
