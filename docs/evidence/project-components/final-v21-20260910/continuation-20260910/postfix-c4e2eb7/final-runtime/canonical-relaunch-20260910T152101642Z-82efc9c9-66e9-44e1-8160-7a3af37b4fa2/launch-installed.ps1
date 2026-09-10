param(
  [string]$Label = '16',
  [string]$EvidenceFile = 'launch-16.json'
)

$ErrorActionPreference = 'Stop'
$exe = 'C:\Users\lin0\AppData\Local\Programs\RelayQaHubPreview-v21-e2e-fresh-0910\RelayQaHubPreview-v21-e2e-fresh-0910.exe'
$profile = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-v21-e2e-fresh-0910\desktop\profile'
$evidenceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$existing = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe })
if ($existing.Count -ne 0) { throw 'EXACT_PREVIEW_PROCESS_ALREADY_RUNNING' }
$occupied = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(4642, 9433) })
if ($occupied.Count -ne 0) { throw 'PREVIEW_DESKTOP_PORT_OCCUPIED' }

$stdout = Join-Path $evidenceRoot ("desktop-$Label.stdout.log")
$stderr = Join-Path $evidenceRoot ("desktop-$Label.stderr.log")
$process = Start-Process -FilePath $exe `
  -ArgumentList @('--hidden', '--remote-debugging-port=9433', ("--user-data-dir=" + $profile)) `
  -WorkingDirectory (Split-Path $exe) `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru

$deadline = [DateTime]::UtcNow.AddSeconds(45)
$cdp = $null
$mcp = $null
do {
  Start-Sleep -Milliseconds 250
  try { $cdp = Invoke-RestMethod -Uri 'http://127.0.0.1:9433/json' -Method Get -TimeoutSec 2 } catch {}
  try { $mcp = Invoke-RestMethod -Uri 'http://127.0.0.1:4642/health' -Method Get -TimeoutSec 2 } catch {}
} while (([DateTime]::UtcNow -lt $deadline) -and (-not $cdp -or $mcp.status -ne 'ready'))

$main = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $process.Id) |
  Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine
$owners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @(4642, 9433) } |
  Sort-Object LocalPort |
  ForEach-Object { [ordered]@{ port = $_.LocalPort; pid = $_.OwningProcess; address = $_.LocalAddress } })
$pages = @($cdp | Where-Object { $_.type -eq 'page' -and $_.url -like 'qa-hub-preview-v21-e2e-fresh-0910://app/*' })
$cdpOwner = @($owners | Where-Object { $_.port -eq 9433 })
$mcpOwner = @($owners | Where-Object { $_.port -eq 4642 })
$result = [ordered]@{
  schemaVersion = 1
  capturedAt = [DateTime]::UtcNow.ToString('o')
  requestedPid = $process.Id
  process = $main
  listeners = $owners
  cdpPageCount = $pages.Count
  cdpPageUrls = @($pages.url)
  mcp = $mcp
  checks = [ordered]@{
    processExact = $main.ExecutablePath -eq $exe
    profileExact = $main.CommandLine -like ("*--user-data-dir=" + $profile + "*")
    cdpArgumentExact = $main.CommandLine -like '*--remote-debugging-port=9433*'
    cdpOwnedByMain = $cdpOwner.Count -eq 1 -and $cdpOwner[0].pid -eq $process.Id
    mcpOwnedByMain = $mcpOwner.Count -eq 1 -and $mcpOwner[0].pid -eq $process.Id
    exactPreviewPage = $pages.Count -eq 1
    mcpReady = $mcp.status -eq 'ready'
  }
  productionObservation = [ordered]@{ action = 'read_only'; touched = $false }
}
$result.passed = @($result.checks.Values) -notcontains $false
$json = $result | ConvertTo-Json -Depth 15
[System.IO.File]::WriteAllText((Join-Path $evidenceRoot $EvidenceFile), $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
$json
if (-not $result.passed) { exit 1 }
