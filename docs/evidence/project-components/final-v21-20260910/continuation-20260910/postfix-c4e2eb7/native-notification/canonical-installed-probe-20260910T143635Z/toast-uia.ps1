
param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$inputData = Get-Content -LiteralPath $InputPath -Raw -Encoding utf8 | ConvertFrom-Json
$root = [System.Windows.Automation.AutomationElement]::RootElement
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function Ancestors($element) {
  $items = New-Object System.Collections.ArrayList
  $cursor = $element
  for ($i=0; $i -lt 16 -and $null -ne $cursor; $i++) { [void]$items.Add($cursor); $cursor=$walker.GetParent($cursor) }
  return $items
}
function Same($a,$b) { return [System.Windows.Automation.Automation]::Compare($a,$b) }
$deadline = [datetime]::UtcNow.AddMilliseconds([int]$inputData.timeoutMs)
do {
  $titles = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$inputData.title))))
  $bodies = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$inputData.body))))
  $matches = @()
  foreach($title in $titles) { foreach($body in $bodies) {
    $ta = @(Ancestors $title); $ba = @(Ancestors $body); $common = $null
    foreach($left in $ta) { if (@($ba | Where-Object { Same $left $_ }).Count -gt 0) { $common=$left; break } }
    if ($null -eq $common) { continue }
    $invokeElement=$common; $pattern=$null
    for($i=0; $i -lt 10 -and $null -ne $invokeElement; $i++) {
      if($invokeElement.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){ break }
      $pattern=$null; $invokeElement=$walker.GetParent($invokeElement)
    }
    if($null -ne $pattern){ $matches += [pscustomobject]@{title=$title;body=$body;invoke=$invokeElement;pattern=$pattern} }
  }}
  if($matches.Count -eq 1){
    $match=$matches[0]
    $evidence=[ordered]@{ observedAt=[datetime]::UtcNow.ToString('o'); title=$match.title.Current.Name; body=$match.body.Current.Name; titleOffscreen=$match.title.Current.IsOffscreen; bodyOffscreen=$match.body.Current.IsOffscreen; invokeName=$match.invoke.Current.Name; invokeControlType=$match.invoke.Current.ControlType.ProgrammaticName; invoked=$false }
    if($inputData.mode -eq 'observe-wait-invoke'){
      $evidence | ConvertTo-Json -Compress | Set-Content -LiteralPath $inputData.observedPath -Encoding utf8 -NoNewline
      $signalDeadline=[datetime]::UtcNow.AddMilliseconds([int]$inputData.signalTimeoutMs)
      while(-not (Test-Path -LiteralPath $inputData.signalPath) -and [datetime]::UtcNow -lt $signalDeadline){ Start-Sleep -Milliseconds 50 }
      if(-not (Test-Path -LiteralPath $inputData.signalPath)){ throw 'TOAST_INVOKE_SIGNAL_TIMEOUT' }
      $match.pattern.Invoke(); $evidence.invoked=$true; $evidence.invokedAt=[datetime]::UtcNow.ToString('o')
    }
    $evidence | ConvertTo-Json -Compress
    exit 0
  }
  if($matches.Count -gt 1){ throw 'AMBIGUOUS_EXACT_TOAST' }
  Start-Sleep -Milliseconds 100
} while([datetime]::UtcNow -lt $deadline)
throw 'EXACT_TOAST_NOT_FOUND'
