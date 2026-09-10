# Server incremental upload (3.4.0)

The API server owns uploads and the external-build/upload workflow. Web and EXE
submit authenticated requests and display persistent server snapshots. Closing the
page, quitting the client or shutting down that client does not stop server work.
Windows contains no upload executable, supervisor or build monitor. Legacy desktop
upload IPC fails with `UPLOAD_MOVED_TO_SERVER`; there is no local execution fallback.

## Defaults and final confirmation

The Android handover recording supplies product **2002**, channel **1002**, tester
**11562**, and `[2002]Baloot Go|[1002]谷歌-国际正式`. Historical version and record IDs
are never reused. Summary and description contain only the resolved version number.
Legacy tester-1 drafts still migrate once, preserving later deliberate choices.

The page offers Android/iOS and Debug/Release. Debug maps to product 2001,
Release to 2002, Android to channel 1002 and iOS to 2004. Both platforms read ready
build-info.json receipts under http://10.100.5.129:8000/ozdqp/ with explicit platform,
configuration, version and artifact-build directories. A standalone request selects
its requested build version or the latest validated build for that target. The
RuiXue version and release notes equal the build version exactly.

The server persists the original ZIP URL, size, Last-Modified and SHA-256 before
launch. Conditional download and final HEAD reject changing artifacts; both newly
downloaded and cached files must match the recorded hash before any platform write.
Recovery retains that original selection. Old job config digests and completed ZIPs
remain compatible. Clients cannot provide arbitrary source URLs.

New server jobs explicitly use **8 concurrent COS parts**, each **5 MiB**. This
applies to both manual uploads and automatic build handoffs. Existing job configs
and checkpoints are retained; changing this default does not alter active jobs.

There are exactly two new-job modes: `publish_workflow` publishes and verifies
status 100; `prepare_publish` performs the same preceding upload/test-status/resource
steps and stops at status 60 for a separate **确认发布** action. Normal resume cannot
grant final confirmation. The recorded test-status workflow does not execute game
tests or invent a test report. Actor, account identity, parameters and build source
identity are frozen before dispatch.

## Persistence and conflicts

The server root is `<QA_HUB_DATA_ROOT>/integrations/increment-upload`:

- `queue.sqlite`: request and dispatch intents, actor audit and scheduler process
  lease. WAL mode and FULL synchronous writes are enabled. Preserve its WAL alongside
  the database, and use a consistent SQLite backup when backing up a live service.
- `owners/<userId>/auth.json`: per-user platform login cache, retaining the requested
  plaintext format. No credentials appear in the queue, API snapshots, diagnostics
  or command arguments. Configure once per QA Hub user; other devices share it.
- `owners/<userId>/jobs/<jobId>/`: config, original ZIP and hashes, worker state,
  events, result, per-run JSONL and supervisor receipts.
- `owners/<userId>/build-chains/`: exact Jenkins queue/build and ZIP handoff records.
- `bin/<sha256>/ozdqp-uploader.exe`: retained versioned server binary.
- `channel-locks/`: cross-account worker locks for product/channel targets.

Submissions are persisted before execution, without waiting for Jenkins. Repeated
request IDs return the same task; changed inputs or another actor are rejected.
Client retries preserve IDs after lost acknowledgements. A single API process owns
scheduling, with one upload worker at a time. Unfinished tasks, unresolved failures
and pending final confirmations retain their product/channel reservation. Queued
tasks may be cancelled; started work and evidence are never deleted by cancellation.

The server supervisor outlives the API process. Restart reconciles the recorded run
identity and reads the original worker result instead of repeating launches. A
machine restart leaves interrupted work recoverable with the original ZIP. Unknown
writes are reconciled only on explicit recovery, never blindly replayed.

Worker 0.5.0 reads explicit server-owned `OZDQP_AUTH_FILE` and `OZDQP_LOCK_ROOT`.
The API does not accept client-selected paths, executables, origins or historical
version IDs. Eight 5 MiB COS parts run concurrently, with serialized STS renewal and
checkpoint writes; recovery sends only missing verified parts. The SDK's synchronous
request deadline is 180 seconds (its `ConnectionTimeoutMs` also bounds transfer),
with a 90-second read/write timeout. COS error diagnostics retain status codes and
transport exception types, excluding messages, signed URLs and credentials.

Atomic checkpoint writes tolerate temporary Windows access/sharing/lock violations
with at most ten local retries over approximately 1.8 seconds. The last durable
state remains intact until the replacement succeeds. This retry never repeats a
COS request. Persistent or non-transient storage failures report
`CHECKPOINT_WRITE_FAILED`; the prior state and pending temporary file are retained.
Failure events still reach the supervisor's stdout receipt when the journal itself
cannot be written. Readers opened by the worker allow atomic file replacement.

Completion always serializes parts in numeric order. If a previous merge has an
uncertain result and the finished object cannot be inspected, recovery may continue
only when the original upload ID is still active and every expected remote part
matches the original local bytes by size and MD5. An unavailable upload, mismatched
object, missing part or mismatched digest stops recovery. It never creates a new
upload or replaces the original package to resolve an uncertain merge.

## Build and upload

All eight presets in JENKINS-PACKAGING.md support build-only and build/upload.
The server submits the unified quick-build job, tracks its exact queue/build, reads
that successful build's archived build-result.json and verifies the child job's
requestId and upstream cause. Artifact buildNumber may differ from the child Jenkins
number; the former determines the download path and the latter verifies provenance.
Platform, configuration, product/channel, version, package types and ZIP SHA-256 must
match. A mismatched or missing receipt never falls back to another build's latest ZIP.
Old chains without a preset retain their legacy Android progress/source rules.
Cancelling handoff preserves Jenkins work; unknown submissions are not blindly retried.

## API and diagnostics

Prefix: `/api/v1/increment-upload`. All routes require existing QA Hub authentication
and browser CSRF for writes. Upload history, progress, sanitized diagnostics and
build/upload handoffs are shared with every signed-in user, including records
created before this change. Account configuration remains the current user's;
shared responses do not contain another user's platform account binding. Task
mutations retain creator authorization, exposed through `canManage` for the UI.

| Method | Suffix | Behavior |
| --- | --- | --- |
| GET | prefix | Current-user account availability and shared task snapshots |
| POST | `/login`, `/logout`, `/check-auth` | Per-user server platform account |
| POST | `/jobs` | Enqueue; `Idempotency-Key` required |
| POST | `/jobs/:id/resume` | Original-job recovery; idempotency key required |
| POST | `/jobs/:id/confirm-publish` | Explicit final confirmation; idempotency key required |
| POST | `/jobs/:id/cancel` | Cancel queued work |
| GET | `/jobs/:id/logs` | Sanitized progress and actor audit |
| GET / POST | `/build-chains` | List / enqueue combined workflows |
| POST | `/build-chains/:id/cancel` | Cancel handoff, retain build |

## Existing records and verification limits

Upgrade preserves `%LOCALAPPDATA%/OZDQP-Uploader` accounts, ZIPs, checkpoints and
build-chain files. Old jobs are not imported as new server tasks or automatically
resumed/re-uploaded. Old clients do not participate in the server lock: update
submitting clients and reconcile unfinished old jobs before starting another release
for that target. Deployment never forcibly closes an active daily client.

Tests cover persistence, shared records, account and write isolation, concurrent requests, queue ownership,
restart, lost acknowledgements, account binding, cancellation and build handoff.
A real supervisor/worker test closes the API and verifies its result after restart
using a deliberately invalid local cache before any platform request. Worker self-test
includes server credential isolation. Browser verification uses the real API/queue
with fixture execution and no desktop bridge, and confirms a task from a new client.
These checks do not constitute a new COS upload or actual business publication.
