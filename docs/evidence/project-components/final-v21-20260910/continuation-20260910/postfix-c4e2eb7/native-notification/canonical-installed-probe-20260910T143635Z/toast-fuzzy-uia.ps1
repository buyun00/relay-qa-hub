param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [int]$TimeoutMs = 20000
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$keywords = @('打包系统通知验证', '系统通知验证消息', '未触发真实构建')
$samples = New-Object System.Collections.ArrayList
$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)

do {
  $elements = @($root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  ))
  foreach ($element in $elements) {
    try {
      $name = [string]$element.Current.Name
      if ([string]::IsNullOrWhiteSpace($name)) { continue }
      if (@($keywords | Where-Object { $name.Contains($_) }).Count -eq 0) { continue }

      $ancestors = @()
      $cursor = $element
      for ($index = 0; $index -lt 10 -and $null -ne $cursor; $index += 1) {
        try {
          $ancestors += [ordered]@{
            name = [string]$cursor.Current.Name
            automationId = [string]$cursor.Current.AutomationId
            className = [string]$cursor.Current.ClassName
            controlType = [string]$cursor.Current.ControlType.ProgrammaticName
            offscreen = [bool]$cursor.Current.IsOffscreen
            enabled = [bool]$cursor.Current.IsEnabled
            nativeWindowHandle = [int]$cursor.Current.NativeWindowHandle
          }
        } catch {}
        $cursor = $walker.GetParent($cursor)
      }

      [void]$samples.Add([ordered]@{
        observedAt = [DateTime]::UtcNow.ToString('o')
        name = $name
        ancestors = $ancestors
      })
    } catch {}
  }
  if ($samples.Count -gt 0) { break }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)

$result = [ordered]@{
  schemaVersion = 1
  capturedAt = [DateTime]::UtcNow.ToString('o')
  sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
  sampleCount = $samples.Count
  samples = @($samples)
  exactTitleSeen = @($samples | Where-Object { $_.name -eq 'OZDQP · 打包系统通知验证' }).Count -gt 0
  exactBodySeen = @($samples | Where-Object { $_.name -eq '这是一条系统通知验证消息，未触发真实构建。' }).Count -gt 0
}
$json = $result | ConvertTo-Json -Depth 15
[System.IO.File]::WriteAllText((Resolve-Path (Split-Path -Parent $OutputPath)).Path + '\\' + (Split-Path -Leaf $OutputPath), $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
$json
