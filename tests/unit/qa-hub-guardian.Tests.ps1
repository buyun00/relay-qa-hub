BeforeAll {
  . (Join-Path $PSScriptRoot '..\..\scripts\qa-hub-guardian-common.ps1')
}

Describe 'QA Hub recovery policy' {
  It 'ignores isolated failures and recovers on the third failure' {
    $now = [datetime]::UtcNow
    (Get-QAHubRecoveryDecision -Healthy $false -Failures 0 -LastAttempt ([datetime]::MinValue) -Now $now).restart | Should -BeFalse
    (Get-QAHubRecoveryDecision -Healthy $false -Failures 1 -LastAttempt ([datetime]::MinValue) -Now $now).restart | Should -BeFalse
    (Get-QAHubRecoveryDecision -Healthy $false -Failures 2 -LastAttempt ([datetime]::MinValue) -Now $now).restart | Should -BeTrue
  }
  It 'resets failure history after a successful probe' {
    $result = Get-QAHubRecoveryDecision -Healthy $true -Failures 10 -LastAttempt ([datetime]::MinValue)
    $result.failures | Should -Be 0
    $result.restart | Should -BeFalse
  }
  It 'bounds repeated restarts to once per minute' {
    $now = [datetime]::UtcNow
    (Get-QAHubRecoveryDecision -Healthy $false -Failures 9 -LastAttempt $now.AddSeconds(-59) -Now $now).restart | Should -BeFalse
    (Get-QAHubRecoveryDecision -Healthy $false -Failures 9 -LastAttempt $now.AddSeconds(-60) -Now $now).restart | Should -BeTrue
  }
}

Describe 'QA Hub atomic runtime state' {
  It 'replaces state while preserving unrelated values and leaves no temporary files' {
    $path = Join-Path $TestDrive 'state.json'
    Write-QAHubJsonAtomic -Path $path -Value @{ apiPid = 1; webPid = 2; retained = 'unchanged' }
    $state = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $state.webPid = 3
    Write-QAHubJsonAtomic -Path $path -Value $state
    $result = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $result.apiPid | Should -Be 1
    $result.webPid | Should -Be 3
    $result.retained | Should -Be 'unchanged'
    @(Get-ChildItem -LiteralPath $TestDrive -Filter '*.tmp').Count | Should -Be 0
  }
  It 'blocks concurrent runtime writers in different processes' {
    $name = 'Local\QAHubGuardianTest' + [guid]::NewGuid().ToString('N')
    $mutex = Enter-QAHubRuntimeLock -Name $name
    try {
      $helper = (Resolve-Path (Join-Path $PSScriptRoot '..\..\scripts\qa-hub-guardian-common.ps1')).Path
      $result = & powershell.exe -NoProfile -Command ". '$helper'; try { Enter-QAHubRuntimeLock -Name '$name' -TimeoutMilliseconds 100 | Out-Null; 'unexpected' } catch { 'blocked' }"
      $result | Should -Be 'blocked'
    } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
  }
}
