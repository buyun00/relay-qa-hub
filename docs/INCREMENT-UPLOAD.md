# Legacy desktop incremental upload (through 3.1.4)

This document preserves the pre-migration integration contract. Since 3.2.0,
execution, accounts, queues and diagnostics belong to the server; the current
contract is [Server incremental upload](SERVER-INCREMENT-UPLOAD.md). The Windows
package no longer contains the uploader or starts local upload/build workers.

The Windows sidebar includes 上传增量 after 打包下载. The page configures the
platform account, reviews a new job, shows download/upload and processing stages,
and resumes local jobs with their original ZIP and target. New jobs have two endpoints:
完成发布 (`publish_workflow`) and 等待最终确认 (`prepare_publish`). Both finish
uploading, the recorded test-status workflow, release copy and release preparation.
The latter stops at remote status 60 with `AWAITING_PUBLISH_CONFIRMATION / WAITING`.
Only the explicit 确认发布 action launches `confirm-publish` to submit status 99 and
wait for verified publication at status 100. Normal resume and page reload never
grant this confirmation. Remote identity, status and release URL are checked again
before publication. The confirmation timestamp is saved before continuing.

The latest original recording supplies product **2002**, channel **1002**, tester
**11562**, and `[2002]Baloot Go|[1002]谷歌-国际正式`. Evidence: events 3708, 7609,
8537 and 8796 in `原始操作记录/ozdqp-upload-f76457e4-7c1b-4503-b5ed-8511330d3a78.json`
(SHA-256 `7db1b6bf0c7c44824d954f76b57c9a83361cef4633435a4a02b6a58e776af2d3`).
Historical version/record IDs are never reused. Both summary and description are
the resolved version number, including an automatically generated next version.
Existing custom drafts retain their target; empty fields receive recorded defaults.
Legacy drafts with the old default tester 1 migrate to 11562 once. Drafts are
then marked `defaultsVersion: 2`, so later deliberate manual choices are preserved.

New jobs use the user's requested recorded workflow without a manual test-report
field. The worker audits `testStatusSource=user_selected_recorded_workflow` and
`executesGameTests=false`; it does not invent a test report or execute game tests.
Existing jobs retain their original configuration, digest, mode and test-result
requirements, and remain recoverable with their original ZIP.

## Integration boundary

- `apps/desktop/vendor/ozdqp-uploader` contains the **0.3.2** executable built from
  `apps/desktop/uploader`, adapted from the original 0.2.0 handover source in
  `D:\OZDQP-自动上传完整交接包-20260908`. The original handover remains untouched.
  SHA-256: `43a3ba2d30f4b1792e0406aa92ead1a61624c7aa491bfa9ae7e5be2b559b7a3d`.
  Packaging and execution verify that hash. The binary is placed outside ASAR in
  `resources/uploader`; no .NET installation is required on client machines.
- The original executable does not implement `serve --stdio` or redirected
  password login. The Electron main process implements only the recorded login
  contract (email/subaccount, uppercase UTF-8 MD5, access check and compatible
  token cache). The worker owns token renewal and the entire upload/publication
  state machine. Credentials are sent only to the two fixed recorded HTTPS
  origins; redirects are not followed. Failed login does not replace saved access.
- Preload exposes bounded operations to the trusted main renderer. There is no
  arbitrary shell, executable path, API URL, job directory or historical version
  ID in the renderer contract. Target product/channel defaults come from the original
  recording, not the ZIP name, and remain editable. Version defaults to the next
  platform version. The fixed ZIP is downloaded by the worker without platform auth.
- Credentials use the tool's existing local JSON format in
  `%LOCALAPPDATA%\OZDQP-Uploader\auth\fq2ivi.ipwana.com-443.json` as required by the
  handover. Passwords are cleared from the form on submission and excluded from
  renderer snapshots, localStorage drafts, task configs, command lines and logs.

## Persistence and lifecycle

Jobs are under `%LOCALAPPDATA%\OZDQP-Uploader\qa-hub-jobs\<uuid>`. They are independent
of installation directories and QA Hub Bug lifecycle. Each contains immutable
target configuration in `job.json`, worker-owned `state.json`, `events.jsonl` and
`result.json`, plus desktop run metadata/receipts and per-run JSONL output. The page
opens only directories identified by a validated local job ID. Corrupt records
are retained and reported.

The detached supervisor runs using Electron's Node runtime, continues when the
window/application exits, and records process completion and a heartbeat. Page
polling reads durable files. If the machine or supervisor stops, the page reports
an interrupted job, never a successful one. Resume calls the original worker's
`resume`; a child that failed before creating state can retry `run` in the same
directory. The worker retains exclusive job/channel locks, ZIP hash checks and
pending-action reconciliation. The host coalesces concurrent mutations and does
not replace test identity after testing has begun. There is no force-stop button:
the supplied worker has no cooperative desktop cancellation protocol.

Only worker `SUCCEEDED / PUBLISHED`, remote status 100 and a publication time are
shown as published. Upload progress at 100% is still uploading/processing. Other
workflow endpoints have separate completion labels. A remote-result-unknown
error remains visible and the worker decides whether reconciliation permits
continuing; the host does not clear pending writes or resend them itself.

## Verification and remaining platform acceptance

Host tests use disposable directories and mocked authentication. Browser fixtures
cover account submission, navigation/draft retention, review before start,
duplicate clicks, transfer progress, explicit final confirmation, reload and final-state
labels. The built executable's local self-test is run separately. Production
platform credentials and historical version IDs are not test fixtures.

Real account login, cross-origin token permissions/expiry, COS multipart recovery,
server unzip/copy terminal conditions and final publication on a designated **new**
version still require business acceptance. The handover explicitly marks these
as unverified. Integration/package checks do not claim that acceptance.

## Parallel multipart transfer

Worker 0.3.2 sends four 5 MB parts concurrently by default (bounded to 1–8 for CLI
configuration). HTTP connection capacity is at least eight. STS renewal and journal
writes are serialized; completed parts are checkpointed as their acknowledgments
arrive. On error/cancellation, in-flight calls finish before the journal closes.
Multipart completion only runs after all parts succeed. Resume retains the original
upload ID, validates remote parts/MD5 and sends only missing parts. Concurrency is
not part of task identity because it does not alter bytes or multipart layout.
The page's parallel count comes from the actual worker event, not an assumed setting.

## External build and automatic upload

The existing 打外网包 button opens two choices: 仅打外网包 and 打包并上传增量.
The latter reviews the saved product/channel/tester/version and selected endpoint
inline, checks the real upload account before submitting Jenkins, and freezes those
settings for that build. The ordinary choice uses the original packaging API.

Electron main stores chains under `%LOCALAPPDATA%\OZDQP-Uploader\qa-hub-build-chains`.
It follows the exact queue/build every five seconds, including when the window is
hidden. Complete application exit pauses build monitoring; next startup resumes it.
The QA Hub owner and a hash of the platform account identity bind the chain.
Switching either account cannot cause an automatic upload under another identity.
Cancelling automatic upload retains the Jenkins build and all local records.

Automatic handoff requires SUCCESS, a completed ZIP stage, fresh size/Last-Modified
within that build's time window, and no other observed overlapping or later ZIP
writer. The worker sends If-Unmodified-Since, verifies response size/time, and
rechecks HEAD after download before accepting the file. Completed local ZIPs remain
immutable task snapshots on resume. The shared download server supplies no ETag;
these guards use its size and modification time, followed by local ZIP/SHA checks.
An artifact replaced by another build is rejected, never silently adopted.

Build submission intent is saved before POST. Lost acknowledgements stay unknown
and are never automatically resubmitted. Handoff uses the chain UUID as the upload
job UUID, with a launch intent before spawning the supervisor; restart cannot create
a second upload job. The upload page shows that exact task, with the same two
endpoints and explicit final confirmation boundary as direct uploads.

## Build the standalone worker

Use .NET 10 SDK, then update the vendor EXE and both hash pins if the binary changes:

```powershell
dotnet publish apps/desktop/uploader/Ozdqp.Uploader.csproj -c Release -r win-x64 --self-contained true -o work/uploader-0.3.2
& work/uploader-0.3.2/ozdqp-uploader.exe self-test
```

The 0.3.2 worker passes 33 tests: the original 23, four confirmation/version tests,
three multipart tests and three pinned-download tests. The latter exercise the real Tencent SDK against a
loopback fixture, verify four concurrent requests and exact part bytes, and check
checkpoint recovery and cancellation. Loopback timing is not a real COS benchmark.
