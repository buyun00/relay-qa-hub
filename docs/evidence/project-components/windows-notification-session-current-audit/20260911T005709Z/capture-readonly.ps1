param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $true)]
  [string]$ProofPath
)

$ErrorActionPreference = 'Stop'
$captureStartedAt = [datetime]::UtcNow
$proofFullPath = [IO.Path]::GetFullPath($ProofPath)
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class QaHubReadonlyWtsAudit {
  public sealed class SessionRow {
    public int SessionId { get; set; }
    public string StationName { get; set; }
    public int State { get; set; }
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct WTS_SESSION_INFO {
    public int SessionId;
    public IntPtr StationName;
    public int State;
  }

  [DllImport("wtsapi32.dll", EntryPoint="WTSEnumerateSessionsW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr sessions, out int count);

  [DllImport("wtsapi32.dll", EntryPoint="WTSQuerySessionInformationW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool WTSQuerySessionInformation(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytesReturned);

  [DllImport("wtsapi32.dll")]
  private static extern void WTSFreeMemory(IntPtr memory);

  [DllImport("kernel32.dll")]
  public static extern uint WTSGetActiveConsoleSessionId();

  public static SessionRow[] EnumerateSessions() {
    IntPtr buffer = IntPtr.Zero;
    int count = 0;
    if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out buffer, out count)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      var rows = new List<SessionRow>();
      int size = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
      for (int index = 0; index < count; index++) {
        var item = (WTS_SESSION_INFO)Marshal.PtrToStructure(
          IntPtr.Add(buffer, index * size),
          typeof(WTS_SESSION_INFO)
        );
        rows.Add(new SessionRow {
          SessionId = item.SessionId,
          StationName = item.StationName == IntPtr.Zero ? "" : Marshal.PtrToStringUni(item.StationName),
          State = item.State
        });
      }
      return rows.ToArray();
    } finally {
      if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
    }
  }

  public static string QueryString(int sessionId, int infoClass) {
    IntPtr buffer = IntPtr.Zero;
    int bytesReturned = 0;
    if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, infoClass, out buffer, out bytesReturned)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      return buffer == IntPtr.Zero ? "" : (Marshal.PtrToStringUni(buffer) ?? "");
    } finally {
      if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
    }
  }

  public static short QueryInt16(int sessionId, int infoClass) {
    IntPtr buffer = IntPtr.Zero;
    int bytesReturned = 0;
    if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, infoClass, out buffer, out bytesReturned)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      return buffer == IntPtr.Zero || bytesReturned < 2 ? (short)-1 : Marshal.ReadInt16(buffer);
    } finally {
      if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
    }
  }
}
"@

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-EventFields($Event) {
  $xml = [xml]$Event.ToXml()
  $fields = @{}
  foreach ($item in @($xml.Event.EventData.Data)) {
    $fields[[string]$item.Name] = [string]$item.'#text'
  }
  return [pscustomobject]@{
    recordId = [long]$Event.RecordId
    eventId = [int]$Event.Id
    timeCreated = $Event.TimeCreated.ToUniversalTime().ToString('o')
    providerProcessId = [int]$xml.Event.System.Execution.ProcessID
    appUserModelId = [string]$fields['AppUserModelId']
    notificationType = [string]$fields['NotificationType']
    trackingId = [string]$fields['TrackingId']
    sessionId = if ([string]::IsNullOrEmpty([string]$fields['SessionId'])) { $null } else { [int]$fields['SessionId'] }
    messageId = [string]$fields['MessageId']
  }
}

$proof = Get-Content -LiteralPath $proofFullPath -Raw -Encoding utf8 | ConvertFrom-Json
$proofFingerprint = [ordered]@{
  pathTail = "desktop-notification-project-route-live/$([string]$proof.runId)/proof.json"
  bytes = (Get-Item -LiteralPath $proofFullPath).Length
  sha256 = Get-Sha256 $proofFullPath
}
$targetAppUserModelId = [string](@($proof.wpn)[0].appUserModelId)
$targetExecutable = [string](@($proof.inputFingerprints | Where-Object {
  [IO.Path]::GetFileName([string]$_.path) -eq 'RelayQaHubPreview-v21-e2e-fresh-0910.exe'
})[0].path)
if ([string]::IsNullOrWhiteSpace($targetAppUserModelId)) { throw 'PROOF_WPN_AUMID_MISSING' }
if ([string]::IsNullOrWhiteSpace($targetExecutable)) { throw 'PROOF_TARGET_EXECUTABLE_MISSING' }

$stateNames = @('Active', 'Connected', 'ConnectQuery', 'Shadow', 'Disconnected', 'Idle', 'Listen', 'Reset', 'Down', 'Init')
$protocolNames = @{ 0 = 'Console'; 1 = 'Legacy'; 2 = 'RDP' }
$activeConsoleRaw = [QaHubReadonlyWtsAudit]::WTSGetActiveConsoleSessionId()
$activeConsoleSessionId = if ($activeConsoleRaw -eq [uint32]::MaxValue) { $null } else { [int]$activeConsoleRaw }
$sessions = @([QaHubReadonlyWtsAudit]::EnumerateSessions() | Sort-Object SessionId | ForEach-Object {
  $protocol = [int][QaHubReadonlyWtsAudit]::QueryInt16($_.SessionId, 16)
  [pscustomobject][ordered]@{
    sessionId = [int]$_.SessionId
    state = [int]$_.State
    stateName = if ($_.State -ge 0 -and $_.State -lt $stateNames.Count) { $stateNames[$_.State] } else { 'Unknown' }
    hasLoggedOnUser = -not [string]::IsNullOrWhiteSpace([QaHubReadonlyWtsAudit]::QueryString($_.SessionId, 5))
    protocolType = $protocol
    protocolName = if ($protocolNames.ContainsKey($protocol)) { $protocolNames[$protocol] } else { 'Unknown' }
  }
})

$processNames = @(
  'explorer.exe',
  'ShellExperienceHost.exe',
  'StartMenuExperienceHost.exe',
  'sihost.exe',
  'LogonUI.exe',
  'winlogon.exe',
  'dwm.exe',
  'RuntimeBroker.exe',
  'svchost.exe',
  [IO.Path]::GetFileName($targetExecutable)
)
$allProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in $processNames })
$wpnServices = @(Get-CimInstance Win32_Service | Where-Object { $_.Name -like 'WpnUserService_*' })
$wpnPids = @($wpnServices | ForEach-Object { [int]$_.ProcessId })
$selectedProcessesRaw = @($allProcesses | Where-Object {
  $_.Name -ne 'svchost.exe' -or $wpnPids -contains [int]$_.ProcessId
} | Sort-Object SessionId, Name, ProcessId)
$targetProcessesRaw = @($selectedProcessesRaw | Where-Object {
  [StringComparer]::OrdinalIgnoreCase.Equals([string]$_.ExecutablePath, $targetExecutable)
})
$selectedProcesses = @($selectedProcessesRaw | ForEach-Object {
  [pscustomobject][ordered]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    sessionId = [int]$_.SessionId
    name = [string]$_.Name
    startedAt = try { ([datetime]$_.CreationDate).ToUniversalTime().ToString('o') } catch { $null }
  }
})
$targetProcesses = @($targetProcessesRaw | ForEach-Object {
  [pscustomobject][ordered]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    sessionId = [int]$_.SessionId
    name = [string]$_.Name
    startedAt = try { ([datetime]$_.CreationDate).ToUniversalTime().ToString('o') } catch { $null }
  }
})
$wpnServiceAudit = @($wpnServices | Sort-Object Name | ForEach-Object {
  $servicePid = [int]$_.ProcessId
  $process = @($selectedProcesses | Where-Object pid -eq $servicePid)[0]
  [pscustomobject][ordered]@{
    serviceFamily = 'WpnUserService_*'
    state = [string]$_.State
    pid = $servicePid
    sessionId = if ($null -eq $process) { $null } else { [int]$process.sessionId }
  }
})

$logName = 'Microsoft-Windows-PushNotification-Platform/Operational'
$queryStart = ([datetime]$proof.startedAt).ToUniversalTime()
$events = @(Get-WinEvent -FilterHashtable @{
  LogName = $logName
  StartTime = $queryStart
  Id = 2418, 3052, 3153
} -ErrorAction Stop | ForEach-Object { Get-EventFields $_ } | Where-Object {
  [StringComparer]::Ordinal.Equals($_.appUserModelId, $targetAppUserModelId)
} | Sort-Object recordId)
$chains = @($events | Group-Object trackingId | ForEach-Object {
  $accepted = @($_.Group | Where-Object { $_.eventId -eq 2418 -and $_.notificationType -eq 'toast' })
  $delivered = @($_.Group | Where-Object eventId -eq 3052)
  $presented = @($_.Group | Where-Object eventId -eq 3153)
  $valid = $accepted.Count -eq 1 -and $delivered.Count -eq 1 -and $presented.Count -eq 1
  if ($valid) {
    $valid = [long]$accepted[0].recordId -lt [long]$delivered[0].recordId -and
      [long]$delivered[0].recordId -lt [long]$presented[0].recordId -and
      [int]$delivered[0].sessionId -eq [int]$presented[0].sessionId -and
      [string]$delivered[0].messageId -eq [string]$presented[0].messageId
  }
  [pscustomobject][ordered]@{
    trackingId = [string]$_.Name
    valid = [bool]$valid
    destinationSessionId = if ($delivered.Count -eq 1) { [int]$delivered[0].sessionId } else { $null }
    messageId = if ($delivered.Count -eq 1) { [string]$delivered[0].messageId } else { $null }
    acceptedRecordId = if ($accepted.Count -eq 1) { [long]$accepted[0].recordId } else { $null }
    deliveredRecordId = if ($delivered.Count -eq 1) { [long]$delivered[0].recordId } else { $null }
    presentedRecordId = if ($presented.Count -eq 1) { [long]$presented[0].recordId } else { $null }
    acceptedAt = if ($accepted.Count -eq 1) { [string]$accepted[0].timeCreated } else { $null }
    deliveredAt = if ($delivered.Count -eq 1) { [string]$delivered[0].timeCreated } else { $null }
    presentedAt = if ($presented.Count -eq 1) { [string]$presented[0].timeCreated } else { $null }
  }
} | Sort-Object acceptedRecordId)
$destinationCounts = @($chains | Where-Object valid | Group-Object destinationSessionId | Sort-Object Name | ForEach-Object {
  [pscustomobject][ordered]@{ sessionId = [int]$_.Name; count = [int]$_.Count }
})

$runnerSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
$runnerSession = @($sessions | Where-Object sessionId -eq $runnerSessionId)[0]
$consoleSession = @($sessions | Where-Object sessionId -eq $activeConsoleSessionId)[0]
$runnerExplorer = @($selectedProcesses | Where-Object { $_.sessionId -eq $runnerSessionId -and $_.name -eq 'explorer.exe' })
$runnerShell = @($selectedProcesses | Where-Object { $_.sessionId -eq $runnerSessionId -and $_.name -eq 'ShellExperienceHost.exe' })
$consoleExplorer = @($selectedProcesses | Where-Object { $_.sessionId -eq $activeConsoleSessionId -and $_.name -eq 'explorer.exe' })
$consoleShell = @($selectedProcesses | Where-Object { $_.sessionId -eq $activeConsoleSessionId -and $_.name -eq 'ShellExperienceHost.exe' })
$consoleLogonUi = @($selectedProcesses | Where-Object { $_.sessionId -eq $activeConsoleSessionId -and $_.name -eq 'LogonUI.exe' })
$validChains = @($chains | Where-Object valid)
$invalidChains = @($chains | Where-Object { -not $_.valid })
$allWpnDestinationsEqualConsole = $validChains.Count -gt 0 -and @($validChains | Where-Object destinationSessionId -ne $activeConsoleSessionId).Count -eq 0
$allWpnDestinationsEqualRunner = $validChains.Count -gt 0 -and @($validChains | Where-Object destinationSessionId -ne $runnerSessionId).Count -eq 0
$targetAppOnlyInRunner = $targetProcesses.Count -gt 0 -and @($targetProcesses | Where-Object sessionId -ne $runnerSessionId).Count -eq 0
$runnerHasInteractiveShell = $runnerExplorer.Count -gt 0 -and $runnerShell.Count -gt 0
$consoleHasInteractiveUser = $null -ne $consoleSession -and [bool]$consoleSession.hasLoggedOnUser
$consoleHasInteractiveShell = $consoleExplorer.Count -gt 0 -and $consoleShell.Count -gt 0
$sameSessionGateReady = $targetAppOnlyInRunner -and $runnerHasInteractiveShell -and $allWpnDestinationsEqualRunner
$proofWatcher = @($proof.watchers)[0].ready
$sanitizedProofWatcher = [ordered]@{
  schemaVersion = $proofWatcher.schemaVersion
  ready = [bool]$proofWatcher.ready
  readyAt = [string]$proofWatcher.readyAt
  observerPid = [int]$proofWatcher.observerPid
  observerSessionId = [int]$proofWatcher.observerSessionId
  appPid = [int]$proofWatcher.appPid
  appSessionId = [int]$proofWatcher.appSessionId
  activeConsoleSessionId = [int]$proofWatcher.activeConsoleSessionId
  wtsSessions = @($proofWatcher.wtsSessions | ForEach-Object {
    [ordered]@{ sessionId = [int]$_.sessionId; state = [int]$_.state }
  })
  explorer = @($proofWatcher.explorer | ForEach-Object {
    [ordered]@{ pid = [int]$_.pid; sessionId = [int]$_.sessionId; name = [string]$_.name }
  })
  shellExperienceHost = @($proofWatcher.shellExperienceHost | ForEach-Object {
    [ordered]@{ pid = [int]$_.pid; sessionId = [int]$_.sessionId; name = [string]$_.name }
  })
}
$sanitizedWpnCorrelation = @($proof.wpn | ForEach-Object {
  [ordered]@{
    label = [string]$_.label
    appUserModelId = [string]$_.appUserModelId
    trackingId = [string]$_.trackingId
    messageId = [string]$_.messageId
    destinationSessionId = [int]$_.destinationSessionId
    boundary = [ordered]@{
      capturedAt = [string]$_.boundary.capturedAt
      newestRecordId = [long]$_.boundary.newestRecordId
    }
    queriedAt = [string]$_.queriedAt
    events = @($_.events | ForEach-Object {
      [ordered]@{
        eventId = [int]$_.eventId
        recordId = [long]$_.recordId
        timeCreated = [string]$_.timeCreated
        providerProcessId = [int]$_.providerProcessId
        appUserModelId = [string]$_.appUserModelId
        notificationType = [string]$_.notificationType
        trackingId = [string]$_.trackingId
        sessionId = if ($null -eq $_.sessionId) { $null } else { [int]$_.sessionId }
        messageId = if ($null -eq $_.messageId) { $null } else { [string]$_.messageId }
      }
    })
  }
})
$destinationSummary = if ($destinationCounts.Count -eq 0) {
  'none'
} else {
  (@($destinationCounts | ForEach-Object { [string]$_.sessionId }) -join ',')
}
$blockerText = if ($sameSessionGateReady) {
  $null
} else {
  "The installed app and audit observer are in runner session $runnerSessionId; WPN operational events report destination session(s) $destinationSummary; the active physical-console session is $activeConsoleSessionId and its logged-on-user/shell preflight is $consoleHasInteractiveUser/$consoleHasInteractiveShell."
}

$result = [ordered]@{
  schemaVersion = 2
  kind = 'windows-notification-session-routing-readonly-sanitized-audit'
  capturedAt = [datetime]::UtcNow.ToString('o')
  redaction = [ordered]@{
    profile = 'local-identity-and-paths-v1'
    rawUserNameDomainAndClientNameOmitted = $true
    absolutePathsOmitted = $true
    processCommandLinesOmitted = $true
    proofErrorMessageAndDetailsOmitted = $true
  }
  capture = [ordered]@{
    startedAt = $captureStartedAt.ToString('o')
    processId = [Diagnostics.Process]::GetCurrentProcess().Id
    sessionId = $runnerSessionId
    script = [ordered]@{
      fileName = [IO.Path]::GetFileName($PSCommandPath)
      bytes = (Get-Item -LiteralPath $PSCommandPath).Length
      sha256 = Get-Sha256 $PSCommandPath
    }
    readOnlyQueries = @(
      'WTSEnumerateSessionsW',
      'WTSQuerySessionInformationW',
      'WTSGetActiveConsoleSessionId',
      'Win32_Process',
      'Win32_Service',
      'Get-WinEvent'
    )
    productActionsPerformed = @()
    sessionActionsPerformed = @()
    serviceActionsPerformed = @()
    productProcessesStartedOrStopped = @()
    notificationsSubmitted = 0
    artifactWrites = @([ordered]@{ kind = 'audit-json'; pathOmitted = $true })
  }
  proofAnchor = [ordered]@{
    fingerprint = $proofFingerprint
    runId = [string]$proof.runId
    version = [string]$proof.releaseProvenance.version
    sourceCommit = [string]$proof.releaseProvenance.sourceCommit
    passed = [bool]$proof.passed
    error = [ordered]@{
      name = [string]$proof.error.name
      code = [string]$proof.error.code
      classification = [string]$proof.error.classification
    }
    sessionPreflight = [ordered]@{
      environmentOnly = [bool]$proof.sessionPreflight.environmentOnly
      productPass = [bool]$proof.sessionPreflight.productPass
      status = [string]$proof.sessionPreflight.status
      notificationId = [string]$proof.sessionPreflight.notificationId
      completedAt = [string]$proof.sessionPreflight.completedAt
      error = [string]$proof.sessionPreflight.error
    }
    watcherReady = $sanitizedProofWatcher
    wpnCorrelation = $sanitizedWpnCorrelation
  }
  target = [ordered]@{
    appUserModelId = $targetAppUserModelId
    executableFileName = [IO.Path]::GetFileName($targetExecutable)
    executablePathSource = 'proof.inputFingerprints exact path comparison; raw path omitted'
    observedProcesses = $targetProcesses
    preExistingAtCapture = $targetProcesses.Count -gt 0
  }
  currentSessionTopology = [ordered]@{
    runnerSessionId = $runnerSessionId
    activeConsoleSessionId = $activeConsoleSessionId
    sessions = $sessions
    selectedProcesses = $selectedProcesses
    wpnUserServices = $wpnServiceAudit
  }
  currentWpnAudit = [ordered]@{
    logName = $logName
    queryStartedAt = $queryStart.ToString('o')
    queryFinishedAt = [datetime]::UtcNow.ToString('o')
    retainedEventCount = $events.Count
    eventCounts = [ordered]@{
      accepted2418 = @($events | Where-Object eventId -eq 2418).Count
      delivered3052 = @($events | Where-Object eventId -eq 3052).Count
      presented3153 = @($events | Where-Object eventId -eq 3153).Count
    }
    completeChainCount = $validChains.Count
    invalidChainCount = $invalidChains.Count
    destinationSessionCounts = $destinationCounts
    firstRetainedChain = @($chains | Select-Object -First 1)[0]
    lastRetainedChain = @($chains | Select-Object -Last 1)[0]
    lastFiveCompleteChains = @($validChains | Select-Object -Last 5)
    note = 'The operational log is bounded and older records may already have rolled over; proofAnchor preserves the earlier exact 81c44 chain.'
  }
  assertions = [ordered]@{
    runnerSessionHasLoggedOnUser = [bool]$runnerSession.hasLoggedOnUser
    runnerSessionHasExplorerAndShellExperienceHost = $runnerHasInteractiveShell
    activeConsoleSessionHasLoggedOnUser = $consoleHasInteractiveUser
    activeConsoleSessionHasExplorerAndShellExperienceHost = $consoleHasInteractiveShell
    activeConsoleSessionHasLogonUi = $consoleLogonUi.Count -gt 0
    targetExecutableProcessesOnlyInRunnerSession = $targetAppOnlyInRunner
    wpnCompleteChainsPresent = $validChains.Count -gt 0
    allWpnDestinationsEqualActiveConsoleSession = $allWpnDestinationsEqualConsole
    allWpnDestinationsEqualRunnerSession = $allWpnDestinationsEqualRunner
    appObserverWpnSameSessionGateReady = $sameSessionGateReady
  }
  conclusion = [ordered]@{
    status = if ($sameSessionGateReady) { 'session_preflight_ready' } else { 'environment_blocker' }
    productPass = $false
    code = if ($sameSessionGateReady) { $null } else { 'WINDOWS_TOAST_SESSION_MISMATCH' }
    exactBlocker = $blockerText
    supportedPerToastTerminalSessionOverrideFound = $false
    supportedPerToastTerminalSessionOverrideFindingIsInference = $true
    safeAutomaticRemediationUnderCurrentConstraints = $false
  }
  safeRetestPrerequisites = @(
    'Run the installed EXE, native submit, and UIAutomation observer in one unlocked interactive user session that has Explorer and ShellExperienceHost.',
    'Require the correlated WPN 3052 and 3153 SessionId to equal both the app and observer session before any business fixture is created.',
    'Use a test host already in the required topology, or arrange an operator-controlled console login outside this audit; do not switch, disconnect, log off, or restart the current host as part of this run.',
    'The owner of the pre-existing isolated installed instance must close it gracefully before a new runner-owned attempt; leave production and daily EXEs untouched.'
  )
  references = @(
    [ordered]@{ url = 'https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-wtsgetactiveconsolesessionid'; finding = 'Returns the session attached to the physical console.' },
    [ordered]@{ url = 'https://learn.microsoft.com/en-us/windows/win32/termserv/terminal-services-sessions'; finding = 'Each RDP session has its own WinSta0 and desktops.' },
    [ordered]@{ url = 'https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken'; finding = 'Cross-session logged-on user token lookup requires LocalSystem and SE_TCB_NAME.' },
    [ordered]@{ url = 'https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw'; finding = 'Interactive launch requires winsta0\\default, access, profile, and environment handling.' },
    [ordered]@{ url = 'https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.rootelement?view=windowsdesktop-9.0'; finding = 'UIAutomation RootElement is rooted at the current desktop.' },
    [ordered]@{ url = 'https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationmanager.createtoastnotifier'; finding = 'The desktop overload accepts an AppUserModelID, not a terminal-session ID.' },
    [ordered]@{ url = 'https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.windows.appnotifications.appnotificationmanager.show?view=windows-app-sdk-1.8'; finding = 'Show accepts an AppNotification, not a terminal-session target.' },
    [ordered]@{ url = 'https://github.com/electron/electron/blob/v43.4.1/shell/browser/notifications/win/windows_toast_notification.cc'; finding = 'Electron 43.4.1 uses CreateToastNotifierWithId(AppUserModelID) for unpackaged Windows notifications.' }
  )
}

$outputDirectory = [IO.Path]::GetDirectoryName($outputFullPath)
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$json = $result | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText($outputFullPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$roundTrip = Get-Content -LiteralPath $outputFullPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($roundTrip.schemaVersion -ne 2 -or $roundTrip.capture.notificationsSubmitted -ne 0 -or $roundTrip.conclusion.productPass -ne $false) {
  throw 'AUDIT_ROUND_TRIP_INVARIANT_FAILED'
}
[pscustomobject]@{
  path = $outputFullPath
  bytes = (Get-Item -LiteralPath $outputFullPath).Length
  sha256 = Get-Sha256 $outputFullPath
  runnerSessionId = $roundTrip.currentSessionTopology.runnerSessionId
  activeConsoleSessionId = $roundTrip.currentSessionTopology.activeConsoleSessionId
  completeChainCount = $roundTrip.currentWpnAudit.completeChainCount
  destinationSessionCounts = $roundTrip.currentWpnAudit.destinationSessionCounts
  productPass = $roundTrip.conclusion.productPass
  status = $roundTrip.conclusion.status
} | ConvertTo-Json -Depth 8
