# QA Hub Windows guardian

Install from an elevated PowerShell:

```powershell
& D:\Relay-QA-Hub\scripts\Install-QAHubGuardian.ps1 -StartNow
```

Two SYSTEM tasks, `Relay QA Hub Guardian Primary` and `Relay QA Hub Guardian
Secondary`, run without an interactive login. Each restores its missing peer.
Primary probes API `4319` and Web/download `4174` every five seconds, requiring
three consecutive failures before invoking the existing production launcher.
API is recovered before Web when both are unavailable. Each service has a
60-second restart cooldown. API liveness is separate from dependency readiness:
disk space or persistent database errors must not cause a restart loop.

Both tasks start 15 seconds after boot and have an indefinite one-minute
repeating trigger as a fallback when both guardians stop. Running instances are
not duplicated. A peer with no heartbeat for 180 seconds is terminated only if
its PID, process creation time, script and role still match. The two launchers
share a global runtime mutex and atomically update the existing runtime pointer,
so manual restarts and guardian restarts cannot overwrite each other's state.
`-IfUnhealthy` rechecks health after obtaining the mutex and skips a recovered
service. Unexpected port owners are never terminated by the launchers.
Recovery launchers run in separate PowerShell processes so a guardian exit does
not interrupt a successful service start or its runtime-state write.

Status and events are under `D:\Relay-QA-Hub-Data\guardian`:

- `Primary.json` / `Secondary.json`: atomic heartbeats, PIDs and service status.
- `Primary.events.jsonl` / `Secondary.events.jsonl`: transitions and recovery
  results, rotated at 5 MiB with one previous file. No tokens or session data.
- `install-<timestamp>`: exported scheduled-task definitions for rollback.

Installation adopts healthy services without restarting them. The old `Relay QA
Hub Backend` task is exported and disabled, retained for rollback. Production
data, sessions, evidence, backups and launcher paths stay in their existing
locations. No client update is required.

For planned maintenance, pause recovery before stopping services:

```powershell
New-Item -ItemType File -Path D:\Relay-QA-Hub-Data\guardian\maintenance -Force
# Perform maintenance using the normal launchers, then resume:
Remove-Item -LiteralPath D:\Relay-QA-Hub-Data\guardian\maintenance
```

The marker pauses service recovery and peer recovery; the guardians still write
heartbeats. To disable permanently, leave the marker in place, disable both
guardian tasks and stop only their exact PIDs from the heartbeat files. Re-enable
the preserved `Relay QA Hub Backend` task if reverting to the old boot behavior.
That old task starts only the API and provides no ongoing recovery.

Validation must distinguish task configuration from an actual host reboot.
Check both heartbeats, LAN API readiness, authenticated client requests and the
Windows update manifest/installer. Process termination drills must target only
the verified QA Hub PIDs and confirm a new PID plus real HTTP recovery.

Policy and state-file tests (Pester 5):

```powershell
Import-Module Pester -MinimumVersion 5.7.1
Invoke-Pester D:\Relay-QA-Hub\tests\unit\qa-hub-guardian.Tests.ps1 -Output Detailed
```

## Validation on 2026-09-04

Installed both SYSTEM tasks and verified fresh heartbeats. Both have a 15-second
boot delay, an indefinite one-minute fallback, no execution time limit and
`IgnoreNew` concurrency. The legacy Backend task is disabled and exported.
Five policy/atomic-write/lock tests passed under Windows PowerShell 5.1.

Live process termination drills, without manual recovery:

| Scenario | Observed recovery |
| --- | --- |
| Web/download process stopped | 23.08 seconds on the final implementation |
| API process stopped | 24.08 seconds |
| Primary stopped, Secondary remains | 1.09 seconds |
| Secondary stopped, Primary remains | 5.61 seconds |
| Both guardians stopped | 23.45 seconds via the repeating task trigger |
| Primary stopped during independent API launch | 22.36 seconds including detection, with new API/guardian PIDs and matching persisted runtime state |

These are observed timings, not guaranteed deadlines. Raw results are in
`D:\Relay-QA-Hub-Data\guardian\validation-20260904.jsonl`,
`validation-launcher-20260904.json` and `validation-web-final-20260904.json`.
Before the drills, a fresh SQLite online backup passed `integrity_check`, and the
existing separate-disk recovery point passed its manifest/attachment validation.
Afterward, real LAN Bug-list requests returned HTTP 200. Boot configuration was
verified without rebooting the host.
