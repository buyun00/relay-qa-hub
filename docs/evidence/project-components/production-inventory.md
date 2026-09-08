# Production inventory for project components v2.1

Captured 2026-09-09 00:09–00:16 Asia/Shanghai. Machine-readable, timestamped observations are in `production-inventory.json`. This is a read-only baseline, not end-to-end acceptance or permission to use production resources.

## Source and instructions

- Read the full copied design document, version 2.1, including sections 16 and 17. Its SHA-256 is recorded in JSON.
- Applicable local instruction file: `C:\Users\lin0\.codex\AGENTS.md`; the supplied UAC instruction also applies. Elevated inspection used a hidden PowerShell process only to read CIM, service/task metadata and VM status, and write this worktree's evidence JSON.
- Worktree: `C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub`; branch `codex/project-components-v2-1`; starting HEAD `62b4495c9b28dc3aea1d5633e870be4e1fdf841f`.
- Production: `D:\Relay-QA-Hub`, branch `main`, same HEAD at capture. Only `?? docs/design/` appeared in production Git status. No Git mutation was performed.
- The worktree `.git` points to `D:/Relay-QA-Hub/.git/worktrees/Relay-QA-Hub2`; Git objects/references are shared. This does not isolate runtime configuration or writable directories.

## Actual running processes and health

| Surface | Listener / PID | Observed executable or entry |
| --- | --- | --- |
| Production API | `0.0.0.0:4319`, PID 10844 | bundled Node, `D:\Relay-QA-Hub\apps\api\dist\main.js` |
| Production Web/download | `0.0.0.0:4174`, PID 7420 | bundled Node, `D:\Relay-QA-Hub\node_modules\vite\bin\vite.js preview --host 0.0.0.0 --port 4174 --strictPort` |
| Daily EXE / local MCP | `127.0.0.1:4320`, PID 17160 | `C:\Users\lin0\AppData\Local\Programs\RelayQaHub\RelayQaHub.exe` |
| Relay API | `0.0.0.0:4317`, PID 23984 | Node `server/index.mjs`, child of Relay Guardian |
| Relay Guardian | `0.0.0.0:4318`, PID 9220 | `D:\Relay-Unity-Orchestrator\server\guardian.mjs` |
| Relay Web | ports 3000 / 3001, PIDs 16300 / 14120 | existing Relay Web/vinext |

The API and Web process paths were confirmed through elevated CIM because non-elevated CIM returned null command lines. The process environment blocks were not extracted. Runtime state and startup source are corroborating evidence, not a claim to have directly read every effective environment variable.

At 00:16:14:

- `GET http://127.0.0.1:4319/api/v1/health/ready`: HTTP 200, `status=ready`, schema 12; database, evidence and worker all `ok`.
- `GET http://127.0.0.1:4174/`: HTTP 200 and application root element present.
- `GET http://127.0.0.1:4174/api/v1/auth/me` without a session: HTTP 401.
- Earlier probes during this pass returned the same results. No production login or business write was performed.

There are three different version observations: main/worktree HEAD is `62b4495…`; the running API's state file records build SHA `f0416eb4da824291fad3c47d0018688754393b18` and start time `2026-09-08T11:09:27.3380981Z`; the daily installed EXE is 3.3.4, while the production update manifest is 3.3.5. They must remain separate in later comparisons. This inventory did not restart or upgrade anything to reconcile them.

## Protected data, state, configuration and release boundaries

| Resource | Actual path or identity |
| --- | --- |
| Shared production runtime state | `D:\Relay-QA-Hub-Data\mvp-e2e-current.json` |
| Business database | `D:\Relay-QA-Hub-Data\production\db\qa-hub.sqlite`, plus existing `-wal` and `-shm` |
| Attachments / quarantine | `D:\Relay-QA-Hub-Data\production\evidence` / `quarantine` |
| Upload queue / supervisors / owners / locks | `D:\Relay-QA-Hub-Data\production\integrations\increment-upload`, including `queue.sqlite`, `queue.sqlite-wal`, `queue.sqlite-shm`, `owners`, `channel-locks`, `bin` |
| Relay batch state / uploads | `D:\Relay-QA-Hub-Data\production\integrations\production\batches` / `uploads` |
| Business outbox | Existing `outbox` in the main business database, per storage code; no live SQL query performed |
| Qingyu encrypted state | `D:\Relay-QA-Hub-Data\production\integrations\qingyu-state.enc.json` |
| API/Web logs | `D:\Relay-QA-Hub-Data\mvp-e2e-20260826021925294\logs` (not beneath the current `production` data root) |
| Local backup / archive | `D:\Relay-QA-Hub-Backups\production` / `E:\Relay-QA-Hub-Archives\production` |
| People configuration | `D:\Relay-QA-Hub-Config\qa-people.json` |
| Android updates / older desktop update storage | `D:\Relay-QA-Hub-Data\production\android-updates` / `D:\Relay-QA-Hub-Data\desktop-updates` |
| Served Windows installer / manifest | `D:\Relay-QA-Hub\apps\desktop\release\installer` |
| Served Android APK | `D:\Relay-QA-Hub\apps\android\app\build\outputs\apk\debug\app-debug.apk` |
| EXE program / rollback area | `C:\Users\lin0\AppData\Local\Programs\RelayQaHub` |
| EXE runtime / token / history / remembered login | `C:\Users\lin0\AppData\Local\Relay QA Hub` |
| Daily Electron profile | `C:\Users\lin0\AppData\Roaming\@relay-qa-hub\desktop` |
| Production browser cookie | `qa_hub_browser_session` |
| Windows AppUserModelId / scheme | `com.relayqahub.desktop` / `qa-hub` |
| Android package | release `com.relayqahub.android`; debug suffix `.debug`; provider authorities derive from applicationId |

The inspected production paths and their ancestors had no reparse points. This is not an exhaustive scan of all descendants. The worktree's nine observed npm junctions all target this worktree's own `apps` or `packages`; none targets the main checkout. Repeat final-target validation for every proposed writable path when starting the new instance.

Production configuration and release SHA-256 values are recorded in JSON. Selected immutable comparison points:

- Runtime state: `dfbd1abbcfa2e81675ad98aea329a20fd6b1173b06d52688df91b5b2e4f2828e`.
- People configuration: `13588aa8d0bbcd74fa516b6668b8fe9767b6266a79330bacd12a81901d213374`.
- Served Windows manifest: `c2fa894e890d3c75ed24cd400dc8bf07d937683bfea7a3f46a8a965d553f626e`.
- Stable installer file: 150473551 bytes, `aea3b25ad16e45449c62d893ac5fc01ed1f50bea5185f6f97d7f68e7b822f4cf`, matching the HTTP manifest's archive fields. The installer was hashed locally; this pass did not download the remote installer or cryptographically reverify the manifest signature.

No active SQLite database hash is used to claim unchanged business data. Production activity legitimately changes its WAL and queue.

## Services, tasks and resource availability

No matching QA Hub/Relay Win32 service was found. Existing scheduled tasks include `Relay QA Hub Backend` (Disabled), `Relay QA Hub Guardian Primary` (Running), `Relay QA Hub Guardian Secondary` (Running), and `Relay Unity Guardian` (Running). Their scripts and working directories point to the existing production checkouts. Guardian Primary's read-only heartbeat reported both API and Web healthy. Task status codes and timestamps are retained as observed; a recurring task's last-result code is not independently interpreted as service failure.

At capture, ports 4419 (candidate API), 4274 (candidate Web), 4421 (candidate server MCP), and 4420 (candidate EXE MCP) were not listening. They were not bound or reserved. A startup must recheck them and refuse collisions, without stopping an existing owner. Distinct ports alone do not isolate cookies: use a distinct cookie name and preferably a distinct preview hostname, plus explicit WebSocket/CSRF/download origins.

Approximately 103.75 GiB on C:, 78.16 GiB on D:, and 276.19 GiB on E: were free; physical memory had about 25.31 GiB free. Four existing relevant VMs were observed (`lin-worker-01`, `lin-worker-02`, `lin-worker-03`, `ozdqp-build`), including allocated production memory. Raw VM status is in JSON. These measurements do not establish idle, licensed, authorized build-worker capacity; none was reserved, started, stopped or borrowed.

## Isolation hazards found in source

| Finding | Source | Required new-instance behavior |
| --- | --- | --- |
| Production runtime state, port and backup paths are hardcoded | `scripts/restart-mvp-api.ps1`, `restart-mvp-web.ps1`, `qa-hub-persistent-runtime.ps1`, `mvp-e2e-runtime.ps1` | Do not run these unchanged. Use a dedicated config and validated preview paths. |
| Guardian task/state/lock names are global | `Install-QAHubGuardian.ps1`, `Start-QAHubGuardian.ps1`, `qa-hub-guardian-common.ps1` | Separate task names, lock, logs and PID records; stop only verified new-instance PIDs. |
| Android build/publish and desktop runtime configuration default to the production state file | `Build-QAHubAndroidDebug.ps1:3`, `Publish-QAHubAndroid.ps1:3`, `Configure-QAHubDesktopRuntime.ps1:2` | Explicit preview config; do not read/copy production credentials or publish production update files. |
| Vite defaults its API proxy to production port 4319 and binds port 4174 | `apps/web/vite.config.ts:40` and server/preview configuration | Require explicit preview API/Web addresses; refuse missing preview config. |
| Desktop config defaults API to 4319, CSRF to 4174 and MCP to 4320 | `apps/desktop/src/config.ts:160,197,219` | Preview package must fail closed and have separate API, CSRF and MCP endpoints. |
| EXE identity, runtime directory, scheme and packaging names are production identities | `apps/desktop/src/main.ts:777`, `runtime-config.ts:155-170`, `config.ts:6`, `apps/desktop/scripts/package-windows.ps1` | Separate app identity, program/profile/runtime paths, lock, protocol, notification identity, shortcuts, update and rollback channel. |
| Windows signing script has a shared default key location | `apps/desktop/scripts/sign-update.mjs:41-46` | Preview signing configuration must be explicit; do not overwrite or implicitly reuse a production secret store. |
| Cookie name is fixed | `apps/api/src/browser-auth.ts:10` | Independent cookie name/host for preview. |
| Jenkins Job, download ZIP and authentication are embedded production defaults | `apps/api/src/jenkins-builds.ts:12-17` | Per-project explicit connection and dedicated Job; no fallback. Authentication values intentionally omitted. |
| Upload API/login/source are fixed external targets | `apps/api/src/uploader-host.ts:17-20` | Explicit test target/account/prefix and project-specific queue/credentials; do not copy production owners/auth state. |
| Qingyu and Relay have existing production endpoints and stored state | `qingyu-client.ts:3`, `main.ts:222-230`, `restart-mvp-api.ps1:151-166` | Components disabled until independent test connections are configured; copied tasks/outbox remain paused. |
| Queue is opened WAL-writable by constructor and schema lacks project in `upload_commands` | `apps/api/src/increment-upload.ts:86-108` | Validate isolated root before construction, migrate only the test copy, explicitly scope every task. |
| Base storage already requires `QA_HUB_DATA_ROOT`, but accepts any absolute root and optional source overlap check | `packages/storage/src/index.ts:189-238` | Retain fail-closed missing-root behavior and add production-root / link rejection; a worktree alone is insufficient. |

## Backup candidate and remaining gaps

An existing recovery candidate was found at `E:\Relay-QA-Hub-Archives\production\rpo\2026-09-08T16-01-26.301Z.2267bc98-a0b9-45dc-b951-f3f7da669d99.sqlite` with a schema-12 manifest, recorded integrity `ok`, recorded SHA-256 `4f4023a122fbcd37bd8225909d540d778fa9d6024ab75846893e1326a6c58a65`, and an attachment directory containing inventory, completion and binding markers. This inventory did not copy it or validate every hash/attachment. Pin and fully validate a chosen completed recovery set before test-only restore; never copy the active main SQLite file alone, never migrate production, and disable imported schedules, outbox, upload and Relay work before starting restored services.

Unverified dependencies: independent Jenkins Job/workspace and outputs; upload account/target/publish prefix; Relay test project/workspace and available Worker; third-party test account/order; physical Android device and dedicated coexistence/upgrade target. Existing production resources are not substitutes. Pure Bug implementation, HTTP/MCP, isolated clients and local migration work can proceed while these remain pending.

No production source/config/data/release file was modified, no dependency was installed by this inventory agent, no existing operation script was executed, no business SQL was opened, and no service/client/VM was stopped or restarted. Production health must be read again before/after later new-instance operations; this baseline is only evidence for its capture time.
