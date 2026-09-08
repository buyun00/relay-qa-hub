# Desktop incremental upload

The Windows sidebar includes 上传增量 after 打包下载. The page configures the
platform account, reviews a new job, shows download/upload and processing stages,
and resumes local jobs with their original ZIP and target. Three endpoints are
available: upload only, upload and request testing, and the complete publication
workflow. Complete publication without a tester ID and actual test-result reference
stops after requesting testing; these fields can be supplied when resuming.
Recording the platform's test status does not execute a game test.

## Integration boundary

- `apps/desktop/vendor/ozdqp-uploader` contains the **unchanged** 0.2.0 executable
  supplied in `D:\OZDQP-自动上传完整交接包-20260908`, its original README and licenses.
  SHA-256: `9ffa226d0c6dc6e971963e7d1fc838dd2e1110f3120c716e548d33e80934dc23`.
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
  ID in the renderer contract. Unknown target product/channel IDs are not inferred
  from the ZIP name; the user enters them explicitly. Version defaults to the next
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
duplicate clicks, transfer progress, test-result recovery, reload and final-state
labels. The supplied executable's local self-test is run separately. Production
platform credentials and historical version IDs are not test fixtures.

Real account login, cross-origin token permissions/expiry, COS multipart recovery,
server unzip/copy terminal conditions and final publication on a designated **new**
version still require business acceptance. The handover explicitly marks these
as unverified. Integration/package checks do not claim that acceptance.
