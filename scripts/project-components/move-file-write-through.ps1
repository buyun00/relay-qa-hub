[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('CreateOnly')]
  [string] $Mode,

  [Parameter(Mandatory = $true)]
  [string] $Source,

  [Parameter(Mandatory = $true)]
  [string] $Destination,

  [Parameter(Mandatory = $true)]
  [string] $ExpectedSourceSha256,

  [ValidateRange(0, 5000)]
  [int] $RetryMilliseconds = 2000
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

# A test harness may preload this exact type in a fresh PowerShell process. Its
# Move method is then the native-call seam, after this script has completed the
# source hash precondition. Production -File invocations start with no such type
# and always compile the pinned kernel32 wrapper below.
if ($null -eq ('QaHubMoveFileWriteThroughNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class QaHubMoveFileWriteThroughNative
{
    public const uint MOVEFILE_WRITE_THROUGH = 0x8;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileExW(string existingName, string newName, uint flags);

    public static int Move(string source, string destination)
    {
        return MoveFileExW(source, destination, MOVEFILE_WRITE_THROUGH)
            ? 0
            : Marshal.GetLastWin32Error();
    }
}
'@
}

function Convert-ToExtendedPath([string] $Path) {
  if ($Path.StartsWith('\\?\', [StringComparison]::Ordinal)) { return $Path }
  if ($Path.StartsWith('\\', [StringComparison]::Ordinal)) {
    return '\\?\UNC\' + $Path.Substring(2)
  }
  return '\\?\' + $Path
}

function Write-Failure(
  [string] $Code,
  [Nullable[int]] $NativeError,
  [int] $Attempts,
  [long] $ElapsedMilliseconds
) {
  [Console]::Error.WriteLine(([ordered]@{
    succeeded = $false
    code = $Code
    nativeError = $NativeError
    mode = $Mode
    flags = 8
    attempts = $Attempts
    elapsedMilliseconds = $ElapsedMilliseconds
    source = $sourceFull
    destination = $destinationFull
    expectedSourceSha256 = $ExpectedSourceSha256
  } | ConvertTo-Json -Compress))
  exit 1
}

function Get-FileSha256([string] $Path) {
  $stream = [IO.File]::Open(
    $Path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $algorithm.ComputeHash($stream)
    return ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

$sourceFull = [IO.Path]::GetFullPath($Source)
$destinationFull = [IO.Path]::GetFullPath($Destination)
if (-not [IO.Path]::IsPathRooted($Source) -or -not [IO.Path]::IsPathRooted($Destination)) {
  Write-Failure 'PATH_NOT_FULLY_QUALIFIED' $null 0 0
}
if ([StringComparer]::OrdinalIgnoreCase.Equals($sourceFull, $destinationFull)) {
  Write-Failure 'PATH_COLLISION' $null 0 0
}
$sourceParent = [IO.Path]::GetDirectoryName($sourceFull)
$destinationParent = [IO.Path]::GetDirectoryName($destinationFull)
if (-not [IO.Directory]::Exists($sourceParent) -or -not [IO.Directory]::Exists($destinationParent)) {
  Write-Failure 'PARENT_DIRECTORY_MISSING' $null 0 0
}
if (-not [IO.File]::Exists($sourceFull)) {
  Write-Failure 'SOURCE_MISSING' $null 0 0
}
if ($ExpectedSourceSha256 -cnotmatch '^[0-9a-f]{64}$') {
  Write-Failure 'EXPECTED_SOURCE_SHA256_INVALID' $null 0 0
}

$sourceExtended = Convert-ToExtendedPath $sourceFull
$destinationExtended = Convert-ToExtendedPath $destinationFull
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
$attempts = 0
$nativeError = 0
do {
  if (-not [IO.File]::Exists($sourceFull)) {
    Write-Failure 'SOURCE_LOST_BEFORE_MOVE' $null $attempts $stopwatch.ElapsedMilliseconds
  }
  try {
    $actualSourceSha256 = Get-FileSha256 $sourceFull
  } catch {
    Write-Failure 'SOURCE_PRECONDITION_READ_FAILED' $null $attempts $stopwatch.ElapsedMilliseconds
  }
  if (-not [StringComparer]::Ordinal.Equals($actualSourceSha256, $ExpectedSourceSha256)) {
    Write-Failure 'SOURCE_PRECONDITION_CHANGED' $null $attempts $stopwatch.ElapsedMilliseconds
  }

  $attempts += 1
  $nativeError = [QaHubMoveFileWriteThroughNative]::Move($sourceExtended, $destinationExtended)
  if ($nativeError -eq 0) { break }
  $retryable = $nativeError -eq 5 -or $nativeError -eq 32 -or $nativeError -eq 33
  if (-not $retryable -or $stopwatch.ElapsedMilliseconds -ge $RetryMilliseconds) {
    Write-Failure 'MOVE_FILE_EX_FAILED' $nativeError $attempts $stopwatch.ElapsedMilliseconds
  }
  if (-not [IO.File]::Exists($sourceFull)) {
    Write-Failure 'SOURCE_LOST_DURING_RETRY' $nativeError $attempts $stopwatch.ElapsedMilliseconds
  }
  Start-Sleep -Milliseconds 25
} while ($true)
$stopwatch.Stop()

if ([IO.File]::Exists($sourceFull) -or -not [IO.File]::Exists($destinationFull)) {
  Write-Failure 'POSTCONDITION_FAILED' $null $attempts $stopwatch.ElapsedMilliseconds
}

[ordered]@{
  succeeded = $true
  mode = $Mode
  flags = 8
  attempts = $attempts
  elapsedMilliseconds = $stopwatch.ElapsedMilliseconds
  source = $sourceFull
  destination = $destinationFull
  expectedSourceSha256 = $ExpectedSourceSha256
  sourceExistsAfter = [IO.File]::Exists($sourceFull)
  destinationExistsAfter = [IO.File]::Exists($destinationFull)
} | ConvertTo-Json -Compress
