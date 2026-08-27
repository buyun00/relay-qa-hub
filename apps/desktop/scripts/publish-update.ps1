param(
  [string]$SourceDirectory = "",
  [string]$UpdateRoot = "D:\Relay-QA-Hub-Data\desktop-updates\stable"
)

$ErrorActionPreference = "Stop"

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
  $SourceDirectory = Join-Path $desktopRoot "release\installer"
}
$source = (Resolve-Path -LiteralPath $SourceDirectory -ErrorAction Stop).Path
if (-not [IO.Path]::IsPathFullyQualified($UpdateRoot)) {
  throw "UpdateRoot must be an absolute path."
}
$destination = [IO.Path]::GetFullPath($UpdateRoot)
$latestSource = Join-Path $source "latest.yml"
if (-not (Test-Path -LiteralPath $latestSource -PathType Leaf)) {
  throw "latest.yml is missing from the installer output."
}
$metadata = Get-Content -LiteralPath $latestSource -Raw
if ($metadata.Length -gt 1MB) {
  throw "latest.yml exceeds the metadata size limit."
}
$versionMatch = [regex]::Match($metadata, '(?m)^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$')
if (-not $versionMatch.Success) {
  throw "latest.yml does not contain a stable semantic version."
}
$version = $versionMatch.Groups[1].Value
$installerName = "Relay-QA-Hub-Setup-$version-x64.exe"
$installerSource = Join-Path $source $installerName
$blockmapSource = "$installerSource.blockmap"
foreach ($requiredFile in @($installerSource, $blockmapSource)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Required update artifact is missing: $requiredFile"
  }
}
if ($metadata -notmatch [regex]::Escape("url: $installerName")) {
  throw "latest.yml does not reference the expected versioned installer."
}
$sizeMatch = [regex]::Match($metadata, '(?m)^\s*size:\s*([0-9]+)\s*$')
if (-not $sizeMatch.Success -or [int64]$sizeMatch.Groups[1].Value -ne (Get-Item -LiteralPath $installerSource).Length) {
  throw "latest.yml installer size does not match the update artifact."
}
$sha512Match = [regex]::Match($metadata, '(?m)^\s*sha512:\s*([^\s]+)\s*$')
if (-not $sha512Match.Success) {
  throw "latest.yml does not contain an installer SHA-512 digest."
}
$sha512 = [Security.Cryptography.SHA512]::Create()
$installerStream = [IO.File]::OpenRead($installerSource)
try {
  $actualSha512 = [Convert]::ToBase64String($sha512.ComputeHash($installerStream))
} finally {
  $installerStream.Dispose()
  $sha512.Dispose()
}
if ($actualSha512 -cne $sha512Match.Groups[1].Value) {
  throw "latest.yml installer SHA-512 digest does not match the update artifact."
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
$resolvedDestination = (Resolve-Path -LiteralPath $destination).Path
if ($resolvedDestination -eq [IO.Path]::GetPathRoot($resolvedDestination)) {
  throw "Refusing to publish updates to a filesystem root."
}
$latestDestination = Join-Path $resolvedDestination "latest.yml"
if (Test-Path -LiteralPath $latestDestination -PathType Leaf) {
  $existingMetadata = Get-Content -LiteralPath $latestDestination -Raw
  $existingVersionMatch = [regex]::Match($existingMetadata, '(?m)^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$')
  if (-not $existingVersionMatch.Success) {
    throw "Existing latest.yml does not contain a stable semantic version."
  }
  $newParts = @($version.Split('.') | ForEach-Object { [int64]::Parse($_) })
  $existingParts = @($existingVersionMatch.Groups[1].Value.Split('.') | ForEach-Object { [int64]::Parse($_) })
  for ($index = 0; $index -lt 3; $index++) {
    if ($newParts[$index] -gt $existingParts[$index]) { break }
    if ($newParts[$index] -lt $existingParts[$index]) {
      throw "Refusing to publish version $version below existing version $($existingVersionMatch.Groups[1].Value)."
    }
  }
}
$stage = Join-Path $resolvedDestination (".publishing-" + [Guid]::NewGuid().ToString("N"))
$expectedStagePrefix = $resolvedDestination.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $stage.StartsWith($expectedStagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe update staging path."
}

try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  foreach ($artifact in @($installerSource, $blockmapSource)) {
    $name = [IO.Path]::GetFileName($artifact)
    $existing = Join-Path $resolvedDestination $name
    if (Test-Path -LiteralPath $existing -PathType Leaf) {
      $sourceHash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
      $existingHash = (Get-FileHash -LiteralPath $existing -Algorithm SHA256).Hash
      if ($sourceHash -ne $existingHash) {
        throw "Immutable update artifact already exists with different bytes: $name"
      }
      continue
    }
    $staged = Join-Path $stage $name
    Copy-Item -LiteralPath $artifact -Destination $staged
    if ((Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash) {
      throw "Staged update artifact hash mismatch: $name"
    }
    Move-Item -LiteralPath $staged -Destination $existing
  }

  $stagedLatest = Join-Path $stage "latest.yml"
  Copy-Item -LiteralPath $latestSource -Destination $stagedLatest
  Move-Item -LiteralPath $stagedLatest -Destination $latestDestination -Force

  [pscustomobject]@{
    version = $version
    updateRoot = $resolvedDestination
    metadata = $latestDestination
    installer = Join-Path $resolvedDestination $installerName
    blockmap = Join-Path $resolvedDestination "$installerName.blockmap"
  } | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $stage) {
    $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
    if (-not $resolvedStage.StartsWith($expectedStagePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedStage) -notmatch '^\.publishing-[0-9a-f]{32}$') {
      throw "Refusing to remove an unsafe update staging path."
    }
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}
