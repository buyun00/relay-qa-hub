[CmdletBinding()]
param(
    [string]$AndroidStudioPath = 'C:\Program Files\Android\Android Studio',
    [string]$SdkRoot = (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
)

$ErrorActionPreference = 'Stop'

$studioExecutable = Join-Path $AndroidStudioPath 'bin\studio64.exe'
$bundledJava = Join-Path $AndroidStudioPath 'jbr\bin\java.exe'
$adbExecutable = Join-Path $SdkRoot 'platform-tools\adb.exe'
$platformJar = Join-Path $SdkRoot 'platforms\android-36\android.jar'
$emulatorExecutable = Join-Path $SdkRoot 'emulator\emulator.exe'
$commandLineTools = Join-Path $SdkRoot 'cmdline-tools'
$buildTools = Join-Path $SdkRoot 'build-tools'

function Test-DirectoryHasChild {
    param([string]$LiteralPath)

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Container)) {
        return $false
    }

    return $null -ne (Get-ChildItem -LiteralPath $LiteralPath -Directory -ErrorAction Stop | Select-Object -First 1)
}

$hypervisorFeature = Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='HypervisorPlatform'" -ErrorAction SilentlyContinue
$result = [ordered]@{
    checkedAt = (Get-Date).ToString('o')
    androidStudioPath = $AndroidStudioPath
    sdkRoot = $SdkRoot
    androidStudio = Test-Path -LiteralPath $studioExecutable -PathType Leaf
    bundledJdk = Test-Path -LiteralPath $bundledJava -PathType Leaf
    platform36 = Test-Path -LiteralPath $platformJar -PathType Leaf
    buildTools = Test-DirectoryHasChild -LiteralPath $buildTools
    platformTools = Test-Path -LiteralPath $adbExecutable -PathType Leaf
    commandLineTools = Test-DirectoryHasChild -LiteralPath $commandLineTools
    emulator = Test-Path -LiteralPath $emulatorExecutable -PathType Leaf
    hypervisorPlatformInstallState = $hypervisorFeature.InstallState
    minSdk = 31
    compileSdk = 36
    targetSdk = 36
    ndkRequired = $false
}

$result | ConvertTo-Json -Depth 4

$requiredKeys = @(
    'androidStudio',
    'bundledJdk',
    'platform36',
    'buildTools',
    'platformTools',
    'commandLineTools',
    'emulator'
)
$missing = @($requiredKeys | Where-Object { -not $result[$_] })

if ($missing.Count -gt 0 -or $result.hypervisorPlatformInstallState -ne 1) {
    Write-Error "Android toolchain preflight failed. Missing/disabled: $($missing -join ', '); HypervisorPlatform=$($result.hypervisorPlatformInstallState)"
    exit 1
}

exit 0
