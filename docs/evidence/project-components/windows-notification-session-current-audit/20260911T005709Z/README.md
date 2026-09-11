# Windows notification current-session/WPN routing audit

This evidence freezes a read-only observation captured at `2026-09-11T00:57:11.1173588Z`. It does not claim a Windows toast product pass. No notification was submitted, no product action was called, and no process, service, or Windows session was started, stopped, switched, disconnected, logged off, or restarted by the capture.

## Observed blocker

The runner and the pre-existing isolated installed preview were in Session 2. Session 2 was the active RDP session with Explorer and ShellExperienceHost. The physical-console Session 1 was connected but had no logged-on user, Explorer, or ShellExperienceHost; it had LogonUI instead.

For the exact preview AUMID, the retained WPN Operational data contained 275 complete `2418 -> 3052 -> 3153` chains and zero invalid chains. Every retained `3052`/`3153` pair reported `SessionId=1`. The earlier immutable `81c44b26-5c6f-47c6-a56a-d4eb27f19d7a` proof independently anchors one exact chain and records the app and UIAutomation observer in Session 2 with the physical console in Session 1.

The equality gate therefore remains closed with `WINDOWS_TOAST_SESSION_MISMATCH` and `productPass=false`. `SessionId` here is the provider's EventData field used by the gate. Public provider documentation defining deeper semantics for that field was not found. The finding that the documented Electron/WinRT notification APIs expose no per-toast terminal-session selector is explicitly recorded as an inference.

## Sanitization and provenance

The original local audit was transformed by an allowlist. Raw WTS username, domain, and client-name values; absolute paths; service/process command lines; executable paths; and proof error message/details were omitted. Process IDs, session IDs, image names, event RecordIds, tracking/message IDs, timestamps, counts, the AUMID, and cryptographic hashes remain because they establish the routing mismatch.

The unpublished raw inputs are pinned without publishing their sensitive fields:

- raw audit: 20,399 bytes, SHA-256 `7247e02728ca6cbe9eaf7153809b2535bf8ba265b5788fac494c73bdedf96a16`
- raw capture script: 19,443 bytes, SHA-256 `ef66e79b1561781499afd6a89724a47520b83d78a20f9c5b61d846d442d9f70c`

Before publication, an in-memory exact-value scan compared all five tracked files with three raw local-identity values, 11 raw absolute-path values, and the three canonical isolated secret values. It found zero exact hits. No compared value was written to the evidence.

The tracked reproducer emits the sanitized schema directly, so a future capture does not first write local identity or absolute-path values. It performs only WTS reads, `Win32_Process`/`Win32_Service` reads, and `Get-WinEvent`. Its only write is the requested output JSON.

## Files and verification

- `current-session-wpn-routing.json` is the sanitized, machine-readable observation.
- `capture-readonly.ps1` is the directly sanitized read-only reproducer. It was preserved for a later operator-approved topology check and was not executed while publishing this evidence.
- `validation.json` pins all tracked artifact hashes and the fail-closed verdict.
- `validate-evidence.mjs` checks directory completeness, artifact hashes, the external `81c44` proof hash, event-chain arithmetic and ordering, session/process facts, empty action lists, the blocker verdict, safe retry prerequisites, forbidden JSON value slots, credential shapes, absolute paths, and the recorded private exact-scan result.

Run the offline validator from the repository root:

```powershell
node .\docs\evidence\project-components\windows-notification-session-current-audit\20260911T005709Z\validate-evidence.mjs
```

A future read-only recapture can use this shape after the operator has chosen the host/session topology:

```powershell
powershell.exe -NoProfile -File .\docs\evidence\project-components\windows-notification-session-current-audit\20260911T005709Z\capture-readonly.ps1 `
  -ProofPath .\docs\evidence\project-components\desktop-notification-project-route-live\81c44b26-5c6f-47c6-a56a-d4eb27f19d7a\proof.json `
  -OutputPath "$env:TEMP\windows-notification-session-audit.json"
```

That command is an observation only; it does not submit or validate a visible toast.

## Safe retry prerequisites

1. Run the installed EXE, native submit, and UIAutomation observer in one unlocked interactive user session with Explorer and ShellExperienceHost.
2. Before creating business fixtures, require the correlated WPN `3052` and `3153` `SessionId` to equal both the app and observer session.
3. Use a test host already in the required topology, or arrange an operator-controlled console login outside the audit. Do not switch, disconnect, log off, or restart the current host as part of this run.
4. The owner must gracefully close the pre-existing isolated installed instance before a new runner-owned attempt. Production and daily EXEs remain untouched.
