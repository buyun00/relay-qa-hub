$ErrorActionPreference = 'Stop'
$aumid = 'com.relayqahub.desktop.preview.v21.e2e.fresh.0910'
$exe = 'C:\Users\lin0\AppData\Local\Programs\RelayQaHubPreview-v21-e2e-fresh-0910\RelayQaHubPreview-v21-e2e-fresh-0910.exe'
$shortcutPaths = @(
  'C:\Users\lin0\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\QA Hub Project Preview (v21-e2e-fresh-0910).lnk',
  'C:\Users\lin0\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\QA Hub Project Preview - v21-e2e-fresh-0910\QA Hub Project Preview - v21-e2e-fresh-0910.lnk'
)

function Write-Utf8Json([string]$Name, $Value) {
  $path = Join-Path $PSScriptRoot $Name
  $json = $Value | ConvertTo-Json -Depth 15
  [System.IO.File]::WriteAllText($path, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

$shell = New-Object -ComObject Shell.Application
$wsh = New-Object -ComObject WScript.Shell
$shortcuts = @()
foreach ($path in $shortcutPaths) {
  $folder = $shell.Namespace((Split-Path -Parent $path))
  $item = $folder.ParseName((Split-Path -Leaf $path))
  $shortcut = $wsh.CreateShortcut($path)
  $shortcuts += [ordered]@{
    path = $path
    targetPath = $shortcut.TargetPath
    modifiedAt = (Get-Item -LiteralPath $path).LastWriteTimeUtc.ToString('o')
    appUserModelId = $item.ExtendedProperty('System.AppUserModel.ID')
    toastActivatorClsid = $item.ExtendedProperty('System.AppUserModel.ToastActivatorCLSID')
  }
}
Write-Utf8Json 'shortcut-properties.json' $shortcuts

$settingsRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings'
$appSettings = Join-Path $settingsRoot $aumid
$quietHours = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\QuietHours'
$registry = [ordered]@{
  capturedAt = [DateTime]::UtcNow.ToString('o')
  appUserModelId = $aumid
  global = Get-ItemProperty -LiteralPath $settingsRoot | Select-Object * -ExcludeProperty PSPath,PSParentPath,PSChildName,PSDrive,PSProvider
  app = Get-ItemProperty -LiteralPath $appSettings | Select-Object * -ExcludeProperty PSPath,PSParentPath,PSChildName,PSDrive,PSProvider
  quietHours = Get-ItemProperty -LiteralPath $quietHours | Select-Object * -ExcludeProperty PSPath,PSParentPath,PSChildName,PSDrive,PSProvider
}
Write-Utf8Json 'notification-registry.json' $registry

$current = [Diagnostics.Process]::GetCurrentProcess()
$session = [ordered]@{
  capturedAt = [DateTime]::UtcNow.ToString('o')
  currentSessionId = $current.SessionId
  userInteractive = [Environment]::UserInteractive
  queryUser = ((quser 2>&1) | Out-String).TrimEnd()
  querySession = ((query session 2>&1) | Out-String).TrimEnd()
  canonicalProcess = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine
}
Write-Utf8Json 'windows-session.json' $session

$events = @(Get-WinEvent -FilterHashtable @{
  LogName = 'Microsoft-Windows-PushNotification-Platform/Operational'
  StartTime = (Get-Date).AddMinutes(-30)
} -ErrorAction Stop | Where-Object { $_.Message -like "*$aumid*" } | Sort-Object TimeCreated | Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,Message)
Write-Utf8Json 'push-notification-events.json' $events

$settingsEvidence = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'notification-settings-uia.json') -Raw | ConvertFrom-Json
$previewToggle = @($settingsEvidence.matches | Where-Object { $_.automationId -eq 'com.relayqahub.desktop.preview.v21.e2e.fresh.09102_ToggleSwitch' })
$globalToggle = @($settingsEvidence.matches | Where-Object { $_.automationId -eq 'SystemSettings_Notifications_ShowAppNotifications_ToggleSwitch' })
$dndToggle = @($settingsEvidence.matches | Where-Object { $_.automationId -eq 'SystemSettings_Notifications_QuietHours_MuteNotification_Enabled_ToggleSwitch' })
$summary = [ordered]@{
  schemaVersion = 1
  capturedAt = [DateTime]::UtcNow.ToString('o')
  gate = 'desktop-native-notification-visible-and-invokable'
  passed = $false
  status = 'failed'
  installedVersion = '0.2.0-preview.17'
  canonicalExe = $exe
  appUserModelId = $aumid
  probes = @(
    [ordered]@{kind='exact-uia';triggerId='build-1789051046-finished';result='EXACT_TOAST_NOT_FOUND'},
    [ordered]@{kind='fuzzy-uia';triggerId='build-1789051379-finished';sampleCount=0;result='NO_NOTIFICATION_TEXT_ELEMENT'},
    [ordered]@{kind='exact-uia';triggerId='build-1789051762-finished';result='EXACT_TOAST_NOT_FOUND'}
  )
  windowsSettings = [ordered]@{
    globalNotifications = if ($globalToggle.Count -eq 1) { $globalToggle[0].toggleState } else { 'unknown' }
    doNotDisturb = if ($dndToggle.Count -eq 1) { $dndToggle[0].toggleState } else { 'unknown' }
    previewApplication = if ($previewToggle.Count -eq 1) { $previewToggle[0].toggleState } else { 'unknown' }
    previewApplicationSummary = '横幅、声音'
  }
  platformEvidence = [ordered]@{
    electronShownEventsPresent = $true
    windowsPushEventsPresent = $events.Count -gt 0
    lastNotificationAddedTimePresent = $null -ne $registry.app.LastNotificationAddedTime
    correctShortcutAumidAndActivatorPresent = @($shortcuts | Where-Object { $_.appUserModelId -eq $aumid -and $_.toastActivatorClsid }).Count -gt 0
  }
  conclusion = 'Windows accepted the native notifications, but no exact or fuzzy visible UI Automation notification element appeared in the active interactive session. The mandatory visible and InvokePattern gate remains failed.'
  delegatedUserGatesAffected = $false
  sourceReferences = @(
    'https://learn.microsoft.com/en-us/windows/win32/shell/enable-desktop-toast-with-appusermodelid',
    'https://www.electronjs.org/docs/latest/tutorial/notifications'
  )
}
Write-Utf8Json 'diagnostic-summary.json' $summary
$summary | ConvertTo-Json -Depth 15
