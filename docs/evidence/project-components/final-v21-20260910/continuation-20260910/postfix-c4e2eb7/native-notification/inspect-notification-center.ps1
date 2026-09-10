param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$clock = @($all | Where-Object {
  $_.Current.ClassName -eq 'SystemTray.OmniButton'
})
if ($clock.Count -ne 1) { throw "EXACT_CLOCK_BUTTON_REQUIRED:$($clock.Count)" }
$invoke = $null
if (-not $clock[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
  throw 'CLOCK_INVOKE_PATTERN_REQUIRED'
}
$invoke.Invoke()
Start-Sleep -Milliseconds 1200
$titles = @($root.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Title))
))
$bodies = @($root.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Body))
))
$result = [ordered]@{
  schemaVersion = 1
  capturedAt = [DateTime]::UtcNow.ToString('o')
  action = 'open_notification_center_and_read_exact_text'
  title = $Title
  body = $Body
  titleCount = $titles.Count
  bodyCount = $bodies.Count
  titles = @($titles | ForEach-Object { [ordered]@{ name = $_.Current.Name; class = $_.Current.ClassName; controlType = $_.Current.ControlType.ProgrammaticName; offscreen = $_.Current.IsOffscreen } })
  bodies = @($bodies | ForEach-Object { [ordered]@{ name = $_.Current.Name; class = $_.Current.ClassName; controlType = $_.Current.ControlType.ProgrammaticName; offscreen = $_.Current.IsOffscreen } })
  exactTextVisible = $titles.Count -eq 1 -and $bodies.Count -eq 1 -and -not $titles[0].Current.IsOffscreen -and -not $bodies[0].Current.IsOffscreen
}
$invoke.Invoke()
$json = $result | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($OutputPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
$json
