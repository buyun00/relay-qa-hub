param(
  [ValidateSet('measure', 'restore', 'resize')][string]$Action = 'measure',
  [int]$Width = 1440,
  [int]$Height = 960
)
$ErrorActionPreference = 'Stop'
# The CDP port identifies the isolated test instance. Never target a daily client by name.
$testPid = (Get-NetTCPConnection -State Listen -LocalPort 9333).OwningProcess | Select-Object -Unique
if (@($testPid).Count -ne 1) { throw 'Expected one isolated CDP process' }
$testProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$testPid"
if ($testProcess.CommandLine -notmatch '--remote-debugging-port=9333' -or $testProcess.CommandLine -notmatch '--user-data-dir=') { throw 'Process is not an isolated desktop smoke instance' }
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SmokeWindow {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int width, int height, bool repaint);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, param) => {
      uint owner; GetWindowThreadProcessId(hwnd, out owner);
      var title = new StringBuilder(256); GetWindowText(hwnd,title,title.Capacity);
      if(owner == pid && title.ToString() == "Relay QA Hub") {found=hwnd;return false;}
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$windowHandle = [SmokeWindow]::Find([uint32]$testPid)
if ($windowHandle -eq [IntPtr]::Zero) { throw 'Isolated test window not found' }
[SmokeWindow]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
if ($Action -eq 'restore') { [SmokeWindow]::ShowWindow($windowHandle, 9) | Out-Null }
if ($Action -eq 'resize') {
  $scale = [SmokeWindow]::GetDpiForWindow($windowHandle) / 96.0
  [SmokeWindow]::MoveWindow($windowHandle, 20, 20, [int]($Width*$scale), [int]($Height*$scale), $true) | Out-Null
}
@{pid=$testPid; minimized=[SmokeWindow]::IsIconic($windowHandle); visible=[SmokeWindow]::IsWindowVisible($windowHandle)} | ConvertTo-Json -Compress
