[CmdletBinding()]
param(
    [string]$RuntimeStatePath = 'D:\Relay-QA-Hub-Data\mvp-e2e-current.json',
    [string]$AndroidSdkRoot = (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
    [string]$JavaHome = 'C:\Program Files\Android\Android Studio\jbr',
    [switch]$SkipUnitTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$androidRoot = Join-Path $repoRoot 'apps\android'
$gradleWrapper = Join-Path $androidRoot 'gradlew.bat'
$apkPath = Join-Path $androidRoot 'app\build\outputs\apk\debug\app-debug.apk'
$metadataPath = Join-Path $androidRoot 'app\build\outputs\apk\debug\output-metadata.json'

if (-not (Test-Path -LiteralPath $RuntimeStatePath -PathType Leaf)) {
    throw "QA Hub runtime state is missing: $RuntimeStatePath"
}
if (-not (Test-Path -LiteralPath $gradleWrapper -PathType Leaf)) {
    throw "Android Gradle wrapper is missing: $gradleWrapper"
}
if (-not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin\java.exe') -PathType Leaf)) {
    throw "Android Studio JDK is missing: $JavaHome"
}

$state = Get-Content -LiteralPath $RuntimeStatePath -Raw | ConvertFrom-Json
$accessToken = [string]$state.accessToken
if ([string]::IsNullOrWhiteSpace($accessToken) -or $accessToken.Length -lt 32) {
    throw 'Runtime state does not contain a usable controlled-QA access token.'
}
$apiUrl = [string]$state.apiUrl
if ([string]::IsNullOrWhiteSpace($apiUrl)) {
    $lanAddress = [string]$state.lanAddress
    if ([string]::IsNullOrWhiteSpace($lanAddress)) {
        throw 'Runtime state does not contain apiUrl or lanAddress.'
    }
    $apiUrl = "http://$lanAddress`:4319"
}
$apiBaseUrl = $apiUrl.TrimEnd('/') + '/api/v1/'

$previousAndroidHome = $env:ANDROID_HOME
$previousAndroidSdkRoot = $env:ANDROID_SDK_ROOT
$previousJavaHome = $env:JAVA_HOME
$previousApiBaseUrl = $env:ORG_GRADLE_PROJECT_qaHubApiBaseUrl
$previousAccessToken = $env:ORG_GRADLE_PROJECT_qaHubDebugAccessToken

try {
    $env:ANDROID_HOME = $AndroidSdkRoot
    $env:ANDROID_SDK_ROOT = $AndroidSdkRoot
    $env:JAVA_HOME = $JavaHome
    $env:ORG_GRADLE_PROJECT_qaHubApiBaseUrl = $apiBaseUrl
    $env:ORG_GRADLE_PROJECT_qaHubDebugAccessToken = $accessToken

    $tasks = @()
    if (-not $SkipUnitTests) { $tasks += ':app:testDebugUnitTest' }
    $tasks += ':app:assembleDebug'
    Push-Location $androidRoot
    try {
        & $gradleWrapper --no-daemon @tasks
        if ($LASTEXITCODE -ne 0) { throw 'Android debug build failed.' }
    }
    finally {
        Pop-Location
    }
}
finally {
    $env:ANDROID_HOME = $previousAndroidHome
    $env:ANDROID_SDK_ROOT = $previousAndroidSdkRoot
    $env:JAVA_HOME = $previousJavaHome
    $env:ORG_GRADLE_PROJECT_qaHubApiBaseUrl = $previousApiBaseUrl
    $env:ORG_GRADLE_PROJECT_qaHubDebugAccessToken = $previousAccessToken
    $accessTokenForVerification = $accessToken
    $accessToken = $null
}

if (-not (Test-Path -LiteralPath $apkPath -PathType Leaf)) {
    throw "Gradle completed without producing $apkPath"
}
if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    throw "Gradle completed without producing $metadataPath"
}
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$element = @($metadata.elements)
if ($element.Count -ne 1 -or [string]$element[0].outputFile -ne 'app-debug.apk') {
    throw 'Android output metadata does not describe exactly one debug APK.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($apkPath)
try {
    $latin1 = [System.Text.Encoding]::GetEncoding(28591)
    $credentialEmbedded = $false
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName -notmatch '^classes\d*\.dex$') { continue }
        $stream = $entry.Open()
        try {
            $reader = [System.IO.StreamReader]::new($stream, $latin1, $false, 65536, $true)
            try {
                if ($reader.ReadToEnd().Contains($accessTokenForVerification)) {
                    $credentialEmbedded = $true
                    break
                }
            }
            finally {
                $reader.Dispose()
            }
        }
        finally {
            $stream.Dispose()
        }
    }
}
finally {
    $archive.Dispose()
    $accessTokenForVerification = $null
}

if (-not $credentialEmbedded) {
    throw 'Built APK verification failed: controlled-QA credential was not embedded.'
}

$artifact = Get-Item -LiteralPath $apkPath
[pscustomobject]@{
    path = $artifact.FullName
    bytes = $artifact.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $apkPath).Hash
    applicationId = [string]$metadata.applicationId
    version = [string]$element[0].versionName
    versionCode = [int]$element[0].versionCode
    minSdk = [int]$metadata.minSdkVersionForDexing
    apiBaseUrl = $apiBaseUrl
    credentialVerified = $credentialEmbedded
    controlledQaLanOnly = $true
} | ConvertTo-Json -Depth 3
