[CmdletBinding()]
param(
    [string]$RuntimeStatePath = 'D:\Relay-QA-Hub-Data\mvp-e2e-current.json',
    [string]$ApkPath = '',
    [string]$UpdateRoot = '',
    [switch]$SkipBuild,
    [switch]$SkipUnitTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$defaultApkPath = Join-Path $repoRoot 'apps\android\app\build\outputs\apk\debug\app-debug.apk'
$metadataPath = Join-Path $repoRoot 'apps\android\app\build\outputs\apk\debug\output-metadata.json'

if (-not $SkipBuild) {
    $buildArguments = @{
        RuntimeStatePath = $RuntimeStatePath
    }
    if ($SkipUnitTests) { $buildArguments.SkipUnitTests = $true }
    & (Join-Path $PSScriptRoot 'Build-QAHubAndroidDebug.ps1') @buildArguments | Out-Host
}

$resolvedApkPath = if ([string]::IsNullOrWhiteSpace($ApkPath)) {
    $defaultApkPath
} else {
    (Resolve-Path -LiteralPath $ApkPath -ErrorAction Stop).Path
}
if (-not (Test-Path -LiteralPath $resolvedApkPath -PathType Leaf)) {
    throw "Android APK is missing: $resolvedApkPath"
}
if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    throw "Android output metadata is missing: $metadataPath"
}

$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$elements = @($metadata.elements)
if ($elements.Count -ne 1 -or [string]$elements[0].outputFile -ne 'app-debug.apk') {
    throw 'Android output metadata does not describe exactly one debug APK.'
}
$versionCode = [int]$elements[0].versionCode
$versionName = [string]$elements[0].versionName
$packageName = [string]$metadata.applicationId
if ($versionCode -le 0 -or $versionName -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') {
    throw 'Android output metadata contains an invalid version.'
}
if ($packageName -notmatch '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$') {
    throw 'Android output metadata contains an invalid application ID.'
}

$state = Get-Content -LiteralPath $RuntimeStatePath -Raw | ConvertFrom-Json
$dataRoot = [IO.Path]::GetFullPath([string]$state.dataRoot)
$resolvedUpdateRoot = if ([string]::IsNullOrWhiteSpace($UpdateRoot)) {
    Join-Path $dataRoot 'android-updates\stable'
} else {
    [IO.Path]::GetFullPath($UpdateRoot)
}
[IO.Directory]::CreateDirectory($resolvedUpdateRoot) | Out-Null
$updateDirectory = (Resolve-Path -LiteralPath $resolvedUpdateRoot).Path

$fileName = "Relay-QA-Hub-Android-$versionCode-$versionName.apk"
$destination = Join-Path $updateDirectory $fileName
$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedApkPath).Hash.ToLowerInvariant()
$sourceItem = Get-Item -LiteralPath $resolvedApkPath
if (Test-Path -LiteralPath $destination -PathType Leaf) {
    $existingHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
    if ($existingHash -ne $sourceHash) {
        throw "Published Android version already exists with different bytes: $destination"
    }
} else {
    $temporaryApk = Join-Path $updateDirectory ".$fileName.$([Guid]::NewGuid().ToString('N')).partial"
    [IO.File]::Copy($resolvedApkPath, $temporaryApk, $false)
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryApk).Hash.ToLowerInvariant() -ne $sourceHash) {
        [IO.File]::Delete($temporaryApk)
        throw 'Copied Android APK failed SHA-256 verification.'
    }
    [IO.File]::Move($temporaryApk, $destination)
}

$manifest = [ordered]@{
    schemaVersion = 1
    versionCode = $versionCode
    versionName = $versionName
    packageName = $packageName
    fileName = $fileName
    size = [long]$sourceItem.Length
    sha256 = $sourceHash
}
$latestPath = Join-Path $updateDirectory 'latest.json'
$temporaryLatest = Join-Path $updateDirectory ".latest.$([Guid]::NewGuid().ToString('N')).json"
$json = $manifest | ConvertTo-Json -Depth 3
[IO.File]::WriteAllText($temporaryLatest, $json, [Text.UTF8Encoding]::new($false))
if ([IO.File]::Exists($latestPath)) {
    [IO.File]::Replace($temporaryLatest, $latestPath, $null)
} else {
    [IO.File]::Move($temporaryLatest, $latestPath)
}

[pscustomobject]@{
    updateRoot = $updateDirectory
    latest = $latestPath
    apk = $destination
    packageName = $packageName
    versionName = $versionName
    versionCode = $versionCode
    bytes = [long]$sourceItem.Length
    sha256 = $sourceHash
} | ConvertTo-Json -Depth 3
