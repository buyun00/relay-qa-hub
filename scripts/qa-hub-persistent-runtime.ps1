$ErrorActionPreference = "Stop"

$script:QAHubPersistentDataRoot = "D:\Relay-QA-Hub-Data\production"
$script:QAHubLocalBackupRoot = "D:\Relay-QA-Hub-Backups\production"
$script:QAHubArchiveRoot = "E:\Relay-QA-Hub-Archives\production"
$script:QAHubPeopleConfigFile = "D:\Relay-QA-Hub-Config\qa-people.json"
$script:QAHubBackupIntervalMinutes = 15

function Test-QAHubOrdinaryDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $item = Get-Item -LiteralPath $LiteralPath -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$Label must be an ordinary directory: $LiteralPath"
  }
  return $item.FullName
}

function Initialize-QAHubPersistentRuntime {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string]$RepositoryRoot
  )

  $stateDataProperty = $State.PSObject.Properties["dataRoot"]
  if ($null -eq $stateDataProperty -or [string]::IsNullOrWhiteSpace([string]$stateDataProperty.Value)) {
    throw "Runtime state is missing dataRoot"
  }
  $dataRoot = [IO.Path]::GetFullPath([string]$stateDataProperty.Value)
  if (-not (Test-Path -LiteralPath $dataRoot -PathType Container)) {
    throw "Persistent data root is missing; restore a verified recovery point instead of creating an empty replacement: $dataRoot"
  }

  $backupRoot = $script:QAHubLocalBackupRoot
  $archiveRoot = $script:QAHubArchiveRoot
  $peopleConfigFile = $script:QAHubPeopleConfigFile
  foreach ($directory in @(
    $backupRoot,
    (Split-Path -Parent $peopleConfigFile),
    $archiveRoot
  )) {
    # Avoid the PowerShell FileSystem provider here. On this host its New-Item
    # call can stall against the ReFS developer volume even though the native
    # directory operation completes normally.
    [IO.Directory]::CreateDirectory($directory) | Out-Null
  }

  $canonicalDataRoot = (Resolve-Path -LiteralPath $dataRoot).Path
  $canonicalBackupRoot = Test-QAHubOrdinaryDirectory -LiteralPath $backupRoot -Label "Local backup root"
  $canonicalArchiveRoot = Test-QAHubOrdinaryDirectory -LiteralPath $archiveRoot -Label "Off-disk archive root"
  if ([IO.Path]::GetPathRoot($canonicalDataRoot) -eq [IO.Path]::GetPathRoot($canonicalArchiveRoot)) {
    throw "Off-disk archive root must be on a different drive from the persistent data root"
  }

  if (-not (Test-Path -LiteralPath $peopleConfigFile -PathType Leaf)) {
    $repositoryPeopleConfig = Join-Path $RepositoryRoot "apps\android\config\qa-people.json"
    Copy-Item -LiteralPath $repositoryPeopleConfig -Destination $peopleConfigFile
  }

  $peopleConfigItem = Get-Item -LiteralPath $peopleConfigFile -Force
  if (($peopleConfigItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $peopleConfigItem.PSIsContainer) {
    throw "People configuration must be an ordinary file: $peopleConfigFile"
  }
  # Windows PowerShell 5.1 defaults Get-Content to the active ANSI code page.
  # The production people file is UTF-8 without a BOM, so request UTF-8
  # explicitly before validating it.
  Get-Content -LiteralPath $peopleConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null

  $peopleConfigBytes = [IO.File]::ReadAllBytes($peopleConfigFile)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $peopleConfigSha256 = -join ($sha256.ComputeHash($peopleConfigBytes) | ForEach-Object {
      $_.ToString("x2")
    })
  } finally {
    $sha256.Dispose()
  }
  $peopleConfigArchiveRoot = Join-Path $canonicalArchiveRoot "configuration"
  [IO.Directory]::CreateDirectory($peopleConfigArchiveRoot) | Out-Null
  $peopleConfigArchiveFile = Join-Path $peopleConfigArchiveRoot "qa-people.$peopleConfigSha256.json"
  if (-not [IO.File]::Exists($peopleConfigArchiveFile)) {
    $stream = [IO.File]::Open(
      $peopleConfigArchiveFile,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    try {
      $stream.Write($peopleConfigBytes, 0, $peopleConfigBytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
  }

  $env:QA_HUB_PEOPLE_CONFIG_FILE = $peopleConfigFile
  $env:QA_HUB_BACKUP_ROOT = $canonicalBackupRoot
  $env:QA_HUB_BACKUP_ON_START = "true"
  $env:QA_HUB_BACKUP_INTERVAL_MINUTES = [string]$script:QAHubBackupIntervalMinutes
  $env:QA_HUB_BACKUP_ARCHIVE_ENABLED = "true"
  $env:QA_HUB_BACKUP_ARCHIVE_ROOT = $canonicalArchiveRoot
  $env:QA_HUB_BACKUP_RETENTION_ENABLED = "true"

  foreach ($entry in @{
    persistentDataRoot = $canonicalDataRoot
    backupRoot = $canonicalBackupRoot
    backupArchiveRoot = $canonicalArchiveRoot
    backupIntervalMinutes = $script:QAHubBackupIntervalMinutes
    backupRetentionPolicy = "latest-two-and-09-shanghai"
    peopleConfigFile = $peopleConfigFile
    peopleConfigSha256 = $peopleConfigSha256
    peopleConfigArchiveFile = $peopleConfigArchiveFile
  }.GetEnumerator()) {
    $State | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value -Force
  }

  return [pscustomobject][ordered]@{
    dataRoot = $canonicalDataRoot
    backupRoot = $canonicalBackupRoot
    archiveRoot = $canonicalArchiveRoot
    intervalMinutes = $script:QAHubBackupIntervalMinutes
    peopleConfigFile = $peopleConfigFile
    peopleConfigSha256 = $peopleConfigSha256
    peopleConfigArchiveFile = $peopleConfigArchiveFile
  }
}
