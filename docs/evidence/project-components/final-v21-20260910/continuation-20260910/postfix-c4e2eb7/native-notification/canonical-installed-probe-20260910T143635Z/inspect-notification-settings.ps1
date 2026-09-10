$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$beforeIds = @(Get-Process -Name SystemSettings -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
Start-Process -FilePath 'ms-settings:notifications'

$root = [System.Windows.Automation.AutomationElement]::RootElement
$window = $null
$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
  Start-Sleep -Milliseconds 200
  $windows = @($root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  ))
  $window = $windows | Where-Object {
    try {
      $_.Current.Name -like '*设置*' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window
    } catch { $false }
  } | Select-Object -First 1
} while ($null -eq $window -and [DateTime]::UtcNow -lt $deadline)

if ($null -eq $window) { throw 'SETTINGS_WINDOW_NOT_FOUND' }

$rows = @()
$condition = [System.Windows.Automation.Condition]::TrueCondition
$elements = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
foreach ($element in $elements) {
  try {
    $name = [string]$element.Current.Name
    $automationId = [string]$element.Current.AutomationId
    if (
      $name -notmatch '通知|勿扰|焦点|全屏|游戏|显示器|优先|横幅|声音|打开|关闭|开启|已关闭|已打开|QA Hub|v21|Relay' -and
      $automationId -notmatch 'QuietHours|Notifications'
    ) { continue }
    $togglePattern = $null
    $supportsToggle = $element.TryGetCurrentPattern(
      [System.Windows.Automation.TogglePattern]::Pattern,
      [ref]$togglePattern
    )
    $rows += [ordered]@{
      name = $name
      automationId = $automationId
      className = [string]$element.Current.ClassName
      controlType = [string]$element.Current.ControlType.ProgrammaticName
      offscreen = [bool]$element.Current.IsOffscreen
      enabled = [bool]$element.Current.IsEnabled
      supportsToggle = [bool]$supportsToggle
      toggleState = if ($supportsToggle) { [string]$togglePattern.Current.ToggleState } else { $null }
    }
  } catch {}
}

$afterIds = @(Get-Process -Name SystemSettings -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$result = [ordered]@{
  schemaVersion = 1
  capturedAt = [DateTime]::UtcNow.ToString('o')
  sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
  settingsWindow = [ordered]@{
    name = [string]$window.Current.Name
    processId = [int]$window.Current.ProcessId
    nativeWindowHandle = [int]$window.Current.NativeWindowHandle
  }
  beforeProcessIds = $beforeIds
  afterProcessIds = $afterIds
  matches = $rows
}
$json = $result | ConvertTo-Json -Depth 10
$outputPath = Join-Path $PSScriptRoot 'notification-settings-uia.json'
[System.IO.File]::WriteAllText($outputPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
$json
