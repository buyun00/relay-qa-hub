[CmdletBinding()]
param(
    [string]$AndroidStudioPath = 'C:\Program Files\Android\Android Studio',
    [string]$SdkRoot = (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
    [string]$DeviceSerial = $env:QA_HUB_ANDROID_ADB_SERIAL
)

$ErrorActionPreference = 'Stop'

$studioExecutable = Join-Path $AndroidStudioPath 'bin\studio64.exe'
$bundledJava = Join-Path $AndroidStudioPath 'jbr\bin\java.exe'
$adbExecutable = Join-Path $SdkRoot 'platform-tools\adb.exe'
$emulatorExecutable = Join-Path $SdkRoot 'emulator\emulator.exe'
$commandLineTools = Join-Path $SdkRoot 'cmdline-tools'
$buildTools = Join-Path $SdkRoot 'build-tools'
$licenses = Join-Path $SdkRoot 'licenses'

function Test-DirectoryHasChild {
    param([string]$LiteralPath)

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Container)) {
        return $false
    }

    return $null -ne (Get-ChildItem -LiteralPath $LiteralPath -Directory -ErrorAction Stop | Select-Object -First 1)
}

function Test-DirectoryHasEntry {
    param([string]$LiteralPath)

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Container)) {
        return $false
    }
    return $null -ne (Get-ChildItem -LiteralPath $LiteralPath -Force -ErrorAction Stop | Select-Object -First 1)
}

function Read-AndroidProperties {
    param([string]$LiteralPath)

    $properties = @{}
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        return $properties
    }

    foreach ($line in Get-Content -LiteralPath $LiteralPath -ErrorAction Stop) {
        if ($line -match '^\s*([^#!][^=]*)=(.*)$') {
            $properties[$matches[1].Trim()] = $matches[2].Trim()
        }
    }
    return $properties
}

function Find-StableAndroidPlatform37 {
    param([string]$AndroidSdkRoot)

    $platformsRoot = Join-Path $AndroidSdkRoot 'platforms'
    if (-not (Test-Path -LiteralPath $platformsRoot -PathType Container)) {
        return $null
    }

    foreach ($directory in Get-ChildItem -LiteralPath $platformsRoot -Directory -ErrorAction Stop) {
        $androidJar = Join-Path $directory.FullName 'android.jar'
        if (-not (Test-Path -LiteralPath $androidJar -PathType Leaf)) {
            continue
        }

        $sourcePropertiesPath = Join-Path $directory.FullName 'source.properties'
        $properties = Read-AndroidProperties -LiteralPath $sourcePropertiesPath
        $apiLevel = $properties['AndroidVersion.ApiLevel']
        $previewSdkInt = $properties['AndroidVersion.PreviewSdkInt']

        if (-not $apiLevel) {
            $packageXmlPath = Join-Path $directory.FullName 'package.xml'
            if (Test-Path -LiteralPath $packageXmlPath -PathType Leaf) {
                try {
                    [xml]$packageXml = Get-Content -LiteralPath $packageXmlPath -Raw -ErrorAction Stop
                    $apiNode = $packageXml.SelectSingleNode("//*[local-name()='api-level']")
                    $previewNode = $packageXml.SelectSingleNode("//*[local-name()='preview-level']")
                    if ($apiNode) { $apiLevel = $apiNode.InnerText }
                    if ($previewNode) { $previewSdkInt = $previewNode.InnerText }
                }
                catch {
                    continue
                }
            }
        }

        if (-not $previewSdkInt) { $previewSdkInt = '0' }
        try {
            $normalizedApiLevel = [decimal]::Parse(
                [string]$apiLevel,
                [Globalization.CultureInfo]::InvariantCulture
            )
            $normalizedPreview = [int]$previewSdkInt
        }
        catch {
            continue
        }

        if ($normalizedApiLevel -eq [decimal]37 -and $normalizedPreview -eq 0) {
            return [pscustomobject]@{
                path = $directory.FullName
                androidJar = $androidJar
                apiLevel = [string]$apiLevel
                previewSdkInt = $normalizedPreview
                extensionLevel = $properties['AndroidVersion.ExtensionLevel']
                revision = $properties['Pkg.Revision']
                description = $properties['Pkg.Desc']
            }
        }
    }

    return $null
}

function Get-InstalledPackageVersions {
    param([string]$Root)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return @()
    }
    return @(
        Get-ChildItem -LiteralPath $Root -Directory -ErrorAction Stop |
            ForEach-Object {
                $properties = Read-AndroidProperties -LiteralPath (Join-Path $_.FullName 'source.properties')
                if ($properties['Pkg.Revision']) { $properties['Pkg.Revision'] } else { $_.Name }
            }
    )
}

$hypervisorFeature = Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='HypervisorPlatform'" -ErrorAction SilentlyContinue
$platform37 = Find-StableAndroidPlatform37 -AndroidSdkRoot $SdkRoot
$buildToolsVersions = Get-InstalledPackageVersions -Root $buildTools
$platformToolsProperties = Read-AndroidProperties -LiteralPath (Join-Path $SdkRoot 'platform-tools\source.properties')
$connectedDevices = @()
if (Test-Path -LiteralPath $adbExecutable -PathType Leaf) {
    try {
        $connectedDevices = @(
            & $adbExecutable devices -l 2>$null |
                Select-Object -Skip 1 |
                Where-Object { $_ -match '^\S+\s+device(?:\s|$)' } |
                ForEach-Object { ($_ -split '\s+')[0] }
        )
    }
    catch {
        $connectedDevices = @()
    }
}
$studioProductInfoPath = Join-Path $AndroidStudioPath 'product-info.json'
$studioVersion = $null
if (Test-Path -LiteralPath $studioProductInfoPath -PathType Leaf) {
    try { $studioVersion = (Get-Content -LiteralPath $studioProductInfoPath -Raw | ConvertFrom-Json).version }
    catch { $studioVersion = $null }
}
$result = [ordered]@{
    checkedAt = (Get-Date).ToString('o')
    androidStudioPath = $AndroidStudioPath
    sdkRoot = $SdkRoot
    androidStudio = Test-Path -LiteralPath $studioExecutable -PathType Leaf
    androidStudioVersion = $studioVersion
    bundledJdk = Test-Path -LiteralPath $bundledJava -PathType Leaf
    platform37 = $null -ne $platform37
    platform37Details = $platform37
    buildTools = Test-DirectoryHasChild -LiteralPath $buildTools
    buildToolsVersions = $buildToolsVersions
    buildTools3600 = $buildToolsVersions -contains '36.0.0'
    platformTools = Test-Path -LiteralPath $adbExecutable -PathType Leaf
    platformToolsVersion = $platformToolsProperties['Pkg.Revision']
    connectedDevices = $connectedDevices
    requestedDeviceSerial = if ($DeviceSerial) { $DeviceSerial } else { $null }
    requestedDeviceConnected = if ($DeviceSerial) { $connectedDevices -contains $DeviceSerial } else { $null }
    commandLineTools = Test-DirectoryHasChild -LiteralPath $commandLineTools
    emulator = Test-Path -LiteralPath $emulatorExecutable -PathType Leaf
    licenses = Test-DirectoryHasEntry -LiteralPath $licenses
    hypervisorPlatformInstallState = $hypervisorFeature.InstallState
    minSdk = 31
    compileSdk = 37
    targetSdk = 37
    pinnedAgp = '9.1.1'
    pinnedGradle = '9.3.1'
    pinnedBuildTools = '36.0.0'
    ndkRequired = $false
}

$result | ConvertTo-Json -Depth 4

$requiredKeys = @(
    'androidStudio',
    'bundledJdk',
    'platform37',
    'buildTools',
    'buildTools3600',
    'platformTools',
    'commandLineTools',
    'emulator',
    'licenses'
)
$missing = @($requiredKeys | Where-Object { -not $result[$_] })

if ($missing.Count -gt 0 -or $result.hypervisorPlatformInstallState -ne 1) {
    Write-Error "Android toolchain preflight failed. Missing/disabled: $($missing -join ', '); HypervisorPlatform=$($result.hypervisorPlatformInstallState)"
    exit 1
}

exit 0
