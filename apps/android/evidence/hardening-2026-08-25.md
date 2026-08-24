# P3.2 hardening verification — 2026-08-25

Verified at 2026-08-25 04:50:03 +08:00 from
`D:\Relay-QA-Hub\apps\android`.

## Final clean verification

The final command used Android Studio's bundled JBR, the installed Android SDK,
and the explicitly selected MuMu serial:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME='C:\Users\lin0\AppData\Local\Android\Sdk'
$env:ANDROID_SERIAL='127.0.0.1:16384'
.\gradlew.bat clean assembleDebug lint testDebugUnitTest connectedDebugAndroidTest
```

Result: `BUILD SUCCESSFUL in 49s`; 92 Gradle tasks, 46 executed, 45 from cache,
and 1 up to date. Lint completed with 0 errors and 13 warnings.

The generated JVM XML reports contain 38 tests, 0 failures, 0 errors, and 0
skips:

- `FoundationViewModelContractTest`: 9
- `QaHubApiClientTest`: 11
- `CredentialVaultTest`: 3
- `SessionLifecycleCoordinatorTest`: 2
- `DeviceSecurityResumeCoordinatorTest`: 1
- `OfflineSyncEngineTest`: 10
- `SyncSchedulerTest`: 2

The generated connected-test XML contains 10 tests, 0 failures, 0 errors, and 0
skips on serial `127.0.0.1:16384` (MuMu Android 15/API35):

- `RoomMigrationTest`: 2
- `RoomScopeIsolationTest`: 5
- `AndroidKeystoreCredentialVaultTest`: 1
- `MainActivityTest`: 1
- `PersistentOfflinePipelineTest`: 1

The ten device tests include v1→v3 schema validation with fail-closed legacy
queue rows, process-style queue reopen, same-project native-session isolation,
unknown 4→3 downgrade refusal, transactional createBug receipt persistence
before `SUCCEEDED`, wrong submission/idempotency transaction rollback,
encrypted session/account-wide credential deletion, native Compose activity
launch, and a production-wired persistent pipeline test.

## Response and reconciliation hardening

The real OkHttp createBug path now requires the frozen `201` status and vendor
media type, bounds the decoded response to 256 KiB, validates the complete
closed response shape, and binds `clientSubmissionId`, QA item, Bug project,
reporter actor, attachments, capture, and idempotency identity to the queued
operation. Unit negatives cover 204, empty body, empty JSON, HTML, generic JSON
media type, over-size body, wrong submission, wrong project, and mismatched QA
item. None can enter `SUCCEEDED`.

A stateful real-OkHttp JVM test commits one synthetic server effect, loses the
first response, then replays the exact payload/idempotency key. It proves
`effectCount=1` and exercises receipt-before-success ordering through the
engine's deterministic `FakeOperationDao`; it does not claim Room persistence.
Separate real SQLite device tests enforce receipt-before-`SUCCEEDED`, bind the
receipt `clientSubmissionId` to the exact
`submission:<clientSubmissionId>:commit` key inside the Room transaction, and
prove a mismatched key rolls back without inserting a receipt or changing the
running operation to successful.

`PersistentOfflinePipelineTest` uses the production `QaHubApplication`
container rather than fake DAOs: the real `OfflineSyncWorker` reads all five
account/project/actor/installation/session input fields, claims exactly the
20-row batch limit from the persistent Room database, and fail-closes the
expired Android-Keystore session as `BLOCKED_AUTH` while leaving row 21 pending.
It then schedules delayed primary and sibling-session WorkManager work and runs
the production sign-out coordinator, proving both work requests reach terminal
cancellation, account-scoped Room rows cascade away, and both encrypted native
session entries become missing. The expired credential deliberately prevents a
network call, so this test does not claim an end-to-end server receipt.
`BLOCKED_DEVICE` scopes are explicitly re-enqueued through the App
foreground/unlock path.

## Count correction

An earlier source inventory used `rg --files`, which honored the repository's
then-current bare `data/` ignore rule and omitted the two real files under
`app/src/androidTest/.../data`. A non-clean intermediate run therefore appeared
to contain stale Room bytecode. `Get-ChildItem` confirmed the source files on
disk, and a clean run proved those five Room tests were real. Temporary duplicate
tests added during the investigation produced an intermediate clean 12/12 run;
the duplicate files were then removed and the new assertions were merged into
the maintained connected suite. The final clean run above is the authoritative
10/10 result. The root ignore rule was subsequently narrowed to `/data/`; both
Android Room source directories are now visible to ordinary Git staging.

## Final APK and explicit install

- APK: `app\build\outputs\apk\debug\app-debug.apk`
- Bytes: `32,618,659`
- SHA-256: `2265B10159B4DC86A58721A3964C13E15B51E0B5CCF453AB5D3D8A9F67180A48`
- Package: `com.relayqahub.android.debug`

The exact final APK was installed with:

```powershell
adb -s 127.0.0.1:16384 install -r -t app-debug.apk
```

The streamed install succeeded. A forced cold launch of
`com.relayqahub.android.debug/com.relayqahub.android.MainActivity` succeeded in
576 ms; `pm path` returned the installed `base.apk`, and `pidof` returned PID
16093 at capture time. Running `sha256sum` against that installed `base.apk`
produced the exact same SHA-256 as the locally built APK.

This is QA Hub's own Gradle-built APK. No Unity Jenkins URL or Unity-hosted APK
source was used.

## Independent final review

At 2026-08-25 04:59:47 +08:00 a separate read-only reviewer reran the complete
gate with `--no-daemon --no-build-cache --rerun-tasks`. All 92 tasks executed
and the build completed successfully in 1 minute 8 seconds. The result remained
38/38 JVM tests, 10/10 MuMu API35 connected tests, and lint with 0 errors and 13
warnings. The rebuilt 32,618,659-byte APK, the explicitly reinstalled device
`base.apk`, and this evidence all retained SHA-256
`2265B10159B4DC86A58721A3964C13E15B51E0B5CCF453AB5D3D8A9F67180A48`; the
independent cold launch completed in 682 ms.

The reviewer found Blocker/High/Medium=`0/0/0`. This is P3.2 foundation
evidence only: the persistent worker test deliberately uses an expired
credential and `TestListenableWorkerBuilder`, while production WorkManager
enqueue/cancel is exercised separately. It does not claim server E2E, OS timed
scheduling E2E, physical-device, API37 runtime, Poco, overlay, MediaProjection,
or hardware-backed Keystore completion.
