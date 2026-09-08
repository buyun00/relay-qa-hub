# Server incremental upload (3.3.4)

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

The page offers **Android / iOS**. Selecting iOS changes the channel to **2004**;
product, tester, version and final-confirmation mode retain their current values.
The server reads `http://10.100.5.129:8000/pkg_zip/ozdqp/ios/?json=true` when a new
iOS task is dispatched, selects the ZIP with the newest file modification time,
and verifies its size and Last-Modified using HEAD. Directories, checksum files,
partial files and unsafe names are excluded. Android retains its original fixed ZIP.

The selected iOS URL, filename, size and modification time are persisted before
launch. Conditional download and a final HEAD reject a changing artifact; retry
before launch, lost acknowledgements and resume retain that same selection.
Completed local ZIPs and old Android configuration digests remain compatible.
The client cannot supply a download URL. Both platforms use the same eight-part
upload and recorded test/publication workflow.

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

Worker 0.4.3 reads explicit server-owned `OZDQP_AUTH_FILE` and `OZDQP_LOCK_ROOT`.
The API does not accept client-selected paths, executables, origins or historical
version IDs. Eight 5 MiB COS parts run concurrently, with serialized STS renewal and
checkpoint writes; recovery sends only missing verified parts. The SDK's synchronous
request deadline is 180 seconds (its `ConnectionTimeoutMs` also bounds transfer),
with a 90-second read/write timeout. COS error diagnostics retain status codes and
transport exception types, excluding messages, signed URLs and credentials.

Completion always serializes parts in numeric order. If a previous merge has an
uncertain result and the finished object cannot be inspected, recovery may continue
only when the original upload ID is still active and every expected remote part
matches the original local bytes by size and MD5. An unavailable upload, mismatched
object, missing part or mismatched digest stops recovery. It never creates a new
upload or replaces the original package to resolve an uncertain merge.

## Build and upload

The external build menu works in Web and Windows. The combined option queues a
server workflow, submits Jenkins once and tracks the exact queue/build. Successful
ZIP output must match the build's time window, size and Last-Modified, with no
observed competing writer. Its upload takes priority over another queued build.
The worker checks conditional-download metadata and HEAD again before accepting a
new ZIP. A changed or ambiguous shared artifact stops handoff. A finished local
download remains the original job snapshot on resume. Cancelling automatic handoff
preserves the Jenkins build; unknown submission results are not automatically resent.
This existing build button produces Android artifacts. An iOS draft disables its
combined upload option, and the API independently rejects that combination before
Jenkins submission. Existing iOS ZIPs are submitted from the incremental upload page.

## API and diagnostics

Prefix: `/api/v1/increment-upload`. All routes use existing QA Hub authentication,
browser CSRF and per-actor authorization, including reads and final confirmation.

| Method | Suffix | Behavior |
| --- | --- | --- |
| GET | prefix | Per-user account availability and task snapshots |
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

Tests cover persistence, actor isolation, concurrent requests, queue ownership,
restart, lost acknowledgements, account binding, cancellation and build handoff.
A real supervisor/worker test closes the API and verifies its result after restart
using a deliberately invalid local cache before any platform request. Worker self-test
includes server credential isolation. Browser verification uses the real API/queue
with fixture execution and no desktop bridge, and confirms a task from a new client.
These checks do not constitute a new COS upload or actual business publication.
