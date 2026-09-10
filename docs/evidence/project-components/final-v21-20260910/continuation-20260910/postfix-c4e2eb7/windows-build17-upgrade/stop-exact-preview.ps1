param(
  [Parameter(Mandatory = $true)][int]$ExpectedPid,
  [Parameter(Mandatory = $true)][string]$RequiredCommandFragment,
  [Parameter(Mandatory = $true)][string]$EvidenceFile
)

$ErrorActionPreference = 'Stop'
$evidenceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = 'C:\Users\lin0\AppData\Local\Programs\RelayQaHubPreview-v21-e2e-fresh-0910\RelayQaHubPreview-v21-e2e-fresh-0910.exe'
$profile = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-v21-e2e-fresh-0910\desktop\profile'
$selectedPorts = @(4174, 4319, 4320, 4639, 4640, 4641, 4642, 9333, 9433)
$target = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ExpectedPid)
$exactProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe })
$mains = @($exactProcesses | Where-Object { $_.CommandLine -notmatch ' --type=' })
$before = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $selectedPorts -contains $_.LocalPort } | Sort-Object LocalPort | ForEach-Object {
  [ordered]@{ address = $_.LocalAddress; port = $_.LocalPort; pid = $_.OwningProcess }
})
$preChecks = [ordered]@{
  oneExactMain = $mains.Count -eq 1
  expectedPidIsMain = $mains.Count -eq 1 -and [int]$mains[0].ProcessId -eq $ExpectedPid
  exactPath = $target.ExecutablePath -eq $exe
  exactProfile = $target.CommandLine -like ("*" + $profile + "*")
  requiredCommandFragment = $target.CommandLine.Contains($RequiredCommandFragment)
  mcpOwnedByTarget = @($before | Where-Object { $_.port -eq 4642 -and $_.pid -eq $ExpectedPid }).Count -eq 1
  foreignPortsNotOwnedByTarget = @($before | Where-Object { $_.port -in @(4174, 4319, 4320, 9333) -and $_.pid -eq $ExpectedPid }).Count -eq 0
}
if (@($preChecks.Values) -contains $false) { throw ('STOP_PRECONDITION_FAILED:' + ($preChecks | ConvertTo-Json -Compress)) }

Stop-Process -Id $ExpectedPid
$deadline = [DateTime]::UtcNow.AddSeconds(20)
do {
  Start-Sleep -Milliseconds 250
  $remaining = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe })
} while ([DateTime]::UtcNow -lt $deadline -and $remaining.Count -gt 0)
$after = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $selectedPorts -contains $_.LocalPort } | Sort-Object LocalPort | ForEach-Object {
  [ordered]@{ address = $_.LocalAddress; port = $_.LocalPort; pid = $_.OwningProcess }
})
$preservedPorts = @(4174, 4319, 4320, 4639, 4640, 4641, 9333)
$preservedOwners = $true
foreach ($port in $preservedPorts) {
  $beforeOwner = @($before | Where-Object { $_.port -eq $port })
  $afterOwner = @($after | Where-Object { $_.port -eq $port })
  if ($beforeOwner.Count -ne 1 -or $afterOwner.Count -ne 1 -or $beforeOwner[0].pid -ne $afterOwner[0].pid) { $preservedOwners = $false }
}
$checks = [ordered]@{}
foreach ($item in $preChecks.GetEnumerator()) { $checks[$item.Key] = $item.Value }
$checks['allSelectedInstanceProcessesExited'] = $remaining.Count -eq 0
$checks['mcpReleased'] = @($after | Where-Object { $_.port -eq 4642 }).Count -eq 0
$checks['cdpReleased'] = @($after | Where-Object { $_.port -eq 9433 }).Count -eq 0
$checks['productionAndPreviewServiceOwnersPreserved'] = $preservedOwners
$result = [ordered]@{
  schemaVersion = 1
  capturedAt = [DateTime]::UtcNow.ToString('o')
  target = $target | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine
  processesBefore = $exactProcesses | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine
  listenersBefore = $before
  remainingProcesses = $remaining | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine
  listenersAfter = $after
  checks = $checks
  productionObservation = [ordered]@{ action = 'read_only_except_exact_preview_stop'; productionTouched = $false }
}
$result.passed = @($checks.Values) -notcontains $false
$json = $result | ConvertTo-Json -Depth 15
[System.IO.File]::WriteAllText((Join-Path $evidenceRoot $EvidenceFile), $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
$json
if (-not $result.passed) { exit 1 }
