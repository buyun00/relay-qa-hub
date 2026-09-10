$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSCommandPath
$expected = @(
    @{ Name = 'production-api'; Port = 4319; Uri = 'http://127.0.0.1:4319/api/v1/health/ready'; Kind = 'api' },
    @{ Name = 'production-web'; Port = 4174; Uri = 'http://127.0.0.1:4174/'; Kind = 'web' },
    @{ Name = 'production-local-mcp'; Port = 4320; Kind = 'mcp' },
    @{ Name = 'old-preview-api'; Port = 4419; Uri = 'http://127.0.0.1:4419/api/v1/health/ready'; Kind = 'api' },
    @{ Name = 'old-preview-web'; Port = 4274; Uri = 'http://127.0.0.1:4274/'; Kind = 'web' },
    @{ Name = 'old-preview-local-mcp'; Port = 4420; Kind = 'mcp' },
    @{ Name = 'preserved-failed-migration-api'; Port = 4539; Uri = 'http://127.0.0.1:4539/api/v1/health/ready'; Kind = 'api' },
    @{ Name = 'preserved-failed-migration-mcp'; Port = 4541; Kind = 'mcp' },
    @{ Name = 'v21-api'; Port = 4639; Uri = 'http://127.0.0.1:4639/api/v1/health/ready'; Kind = 'api' },
    @{ Name = 'v21-web'; Port = 4640; Uri = 'http://127.0.0.1:4640/'; Kind = 'web' },
    @{ Name = 'v21-server-mcp'; Port = 4641; Kind = 'mcp' },
    @{ Name = 'v21-local-mcp'; Port = 4642; Kind = 'mcp' }
)

$items = foreach ($target in $expected) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $target.Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -ne 1) {
        throw "Expected exactly one listener on port $($target.Port), found $($listeners.Count)"
    }
    $listener = $listeners[0]
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
    $http = $null
    if ($target.ContainsKey('Uri')) {
        $response = Invoke-WebRequest -Uri $target.Uri -Method Get -TimeoutSec 5 -UseBasicParsing
        if ($response.StatusCode -ne 200) {
            throw "HTTP check failed for $($target.Name): $($response.StatusCode)"
        }
        $readyStatus = $null
        $schemaVersion = $null
        if ($target.Kind -eq 'api') {
            $body = $response.Content | ConvertFrom-Json
            if ($body.status -ne 'ready') {
                throw "Readiness body failed for $($target.Name)"
            }
            $readyStatus = $body.status
            $schemaVersion = $body.schemaVersion
        }
        $http = [ordered]@{
            status = [int]$response.StatusCode
            readyStatus = $readyStatus
            schemaVersion = $schemaVersion
        }
    }
    [ordered]@{
        name = $target.Name
        kind = $target.Kind
        port = $target.Port
        localAddress = $listener.LocalAddress
        pid = [int]$listener.OwningProcess
        processName = $process.ProcessName
        http = $http
    }
}

$v21 = @($items | Where-Object { $_.name -like 'v21-*' })
if (($v21 | Where-Object { $_.localAddress -ne '127.0.0.1' }).Count -ne 0) {
    throw 'A v2.1 listener is not loopback-bound'
}
if (($items | Where-Object name -eq 'v21-api').pid -ne 26088) {
    throw 'The v2.1 API no longer matches the post-restart receipt PID'
}

$result = [ordered]@{
    schemaVersion = 1
    recordedAt = [DateTime]::UtcNow.ToString('o')
    sourceCommit = '88a6d0f9c31106f6cd3fc9edbadca0db6bf6397b'
    mode = 'read-only listener and anonymous HTTP observation'
    expectedListeners = $expected.Count
    observedListeners = $items.Count
    productionWrites = 0
    currentMcpBusinessProof = 'post-restart-mcp-check.json'
    items = $items
    passed = $true
}
$json = $result | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $root 'coexistence-post-restart.json'), $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$json
