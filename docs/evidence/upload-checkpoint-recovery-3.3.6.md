# Upload checkpoint recovery — 3.3.6 / worker 0.4.4

Android task `5ce95bbe-0ff5-4da2-badc-8e61c56d0016`, version 2.4.35 (platform
version ID 840), stopped at 138/144 parts at 2026-09-09 16:21:37 Shanghai time.
The worker recorded `UnauthorizedAccessException`, with no COS request-failure
diagnostic. A progress event was missing for checkpoint 131 while later in-flight
acknowledgments were drained and retained. Original logs contain no stack trace,
so they cannot identify the particular external process that held the file.

An isolated Windows reproduction opened `state.json` for reading without delete
sharing. The unmodified writer threw the same exception (HRESULT 0x80070005) at
`File.Move` in `Journal.Save`; writing succeeded after closing that reader.
This demonstrates a checkpoint-replacement failure matching the incident evidence.

Recovery used the formal server resume API and the original task identity after
backing up metadata/events and verifying the ZIP SHA-256. The worker verified
138 existing remote parts, sent only the remaining six, and completed publication
with remote status 100. Version ID, config digest, upload ID, object key and ZIP
SHA-256 remained unchanged. Receipts are retained in `work/upload-2.4.35`.

Worker 0.4.4 retries only local atomic checkpoint writes for bounded transient
Windows file-access failures. Persistent failures preserve the durable checkpoint
and temporary file and produce a specific error, including an independent stdout
failure receipt if the journal cannot be updated. No platform write is retried by
this storage policy. Forty worker tests passed, including transient and persistent
Windows locks and preservation of confirmed parts.

Recovery finished at 16:27:04 Shanghai time using the existing worker 0.4.3.
The permanent fix was subsequently deployed as worker 0.4.4 and Windows/Web
3.3.6, release `20260909T083154895Z`, from source
`0edb65942528d5c863d0d32221c17ef7681ae4ce`. The running API reports that exact
source commit; its installed worker binary matches the pinned SHA-256
`b6808e44cb3f35dbb7817db7631f1f4d68bdf0061b12b8873870330a1e11b715`.

Release validation passed:

- Worker 40/40, API 51/51, Web 54/54; API/Web compilation and changed-file lint.
- Signed online installer and portable manifests, downloaded lengths and hashes;
  installer SHA-256 `a5f034fbedd4a10f2bcf48238ee89d0032d2fcd24f61ab53d18bcb5847042815`,
  portable SHA-256 `ce0f53142a30ef2d975a89941afaf7397cf3d1e415e0d8758f0f2fdf8d104e6a`.
- Packaged source identity and all nine packaged Web resources; live Web JS/CSS
  byte equality; API readiness.
- Real EXE login, navigation and MCP reads; live task 2.4.35 is published with
  remote status 100. A renderer-only failure fixture verified the new checkpoint
  message and resume button without submitting any additional upload actions.
- Isolated actual 3.3.5 to 3.3.6 download/install/relaunch; user profile, runtime
  settings, upload checkpoint/account/build-chain fixtures and rollback retained.
- Daily EXE processes and startup entries preserved; isolated test ports released.

Receipts and screenshots are in `work/windows-3.3.6-release`; original incident
metadata, request receipt and recovery verification remain in `work/upload-2.4.35`.
The complete previous release is retained under
`apps/desktop/release/builds/prepublish-20260908T110747982Z-20260909T082928602Z`.
No second production upload was created merely to exercise the new worker.
