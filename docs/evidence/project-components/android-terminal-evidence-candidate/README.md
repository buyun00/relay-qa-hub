# Android workflow and retry hardening evidence candidate

> **Superseded source snapshot.** A later audit found that only 1 of the 12 recorded Android source hashes still matched and that the referenced APK size and SHA-256 had changed. This directory is retained as historical failure/development evidence only. It must not be cited as current Android acceptance; a post-commit APK and source binding are required.

Recorded 2026-09-09 17:21 +08:00 from branch `codex/project-components-v2-1`. The source checkpoint was HEAD `029188ba25df1c3e940437f1e78fa05ba011aed8`; the complete Android working-tree binding is in `source-binding.json`.

This candidate changes Android sources/tests plus this evidence directory. It was not committed, installed, or exercised against a device. Gradle compilation and interceptor-backed JVM tests did not mutate the configured API.

## Implemented behavior

- Workflow pagination requires every page to contain `nextCursor` as an exact JSON string or `null`. It rejects blank, oversized, or repeated cursors and rejects conflicting attempt IDs at the same sequence before choosing the newest attempt.
- Verification remains readable for all permitted viewers, while evidence selection, removal, and result actions require the canonical assigned verifier. An active workflow Verification's `verifierId` takes precedence over the Bug fallback `verificationOwnerId`. Creating a Verification is limited to `ready_for_verification`; `awaiting_build` has no create/result action. The submission callback repeats this authorization check after fetching fresh workflow state, and the client enforces it independently.
- Account people and action eligibility use parsed server roles. Developer-only users are fixers, verifier-only users are verifiers, mixed roles appear in both sets, and unknown roles grant neither capability.
- Selected verification images are removed from transient UI state immediately after their bytes and pending attachment record have been durably committed, preventing a later in-process upload failure from displaying or counting them twice.
- Attachment upload accepts files through the 20 MiB boundary, follows the server's `chunkSize` and `expectedChunkCount`, sends each exact byte range, and checks every evolving upload version and ETag.
- Pending verification attachments persist upload session, chunk confirmations, finalized attachment state, and binding receipt generation/version/expiry. A checkpoint is saved after init and every accepted chunk, finalize, bind, or renewal response. The same frozen result identity resumes after response loss or process recreation. An expired result binding renews the same binding through the server generation contract; protocol mismatches fail closed.

## Contract coverage

- `BugLifecycleClientTest` covers missing/non-string/repeated cursors, encoded multi-page cursors, conflicting sequences, newest-attempt projection, `awaiting_build` creation rejection, wrong-verifier rejection, and terminal workflow contracts.
- `AccountSessionClientTest` covers developer-only, verifier-only, mixed, and unknown roles and the resulting active fixer/verifier sets.
- `BugLifecyclePanelTest` covers workflow-verifier precedence, Bug-owner fallback, read-only `awaiting_build`, and existing-pending authorization.
- `AttachmentUploadClientTest` covers the exact 20 MiB boundary with 8 MiB/8 MiB/4 MiB chunks, pre-network rejection above the limit, lost init/chunk/finalize/bind responses across new client instances, and expired binding renewal with generation/version checks.
- `BugDraftPreferencesTest` covers checkpoint serialization across preference instances and monotonic pending-result identity protection.

## Validation

The checks ran from `apps/android` with:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME='C:\Users\lin0\AppData\Local\Android\Sdk'
```

The source-default candidate was validated first:

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug --no-daemon --max-workers=2 '-Dorg.gradle.parallel=false' '-Dorg.gradle.jvmargs=-Xmx2g' '-PqaHubApiBaseUrl=http://127.0.0.1:4419/api/v1/' '-PqaHubProjectId=10000000-0000-4000-8000-000000000099'
```

Result at the preceding source checkpoint: `BUILD SUCCESSFUL` in 2m 43s. It produced version code `15`, version name `0.1.14-debug`, size `35,782,697` bytes, SHA-256 `8b0ae3bf9f581604c1d36528da5c39cb48ad6650037aae83ffbdbf0109ffa2ce`. This artifact was overwritten and preceded the final frozen-result retry fix. Code 15 records the incremented source default only; it is not the retained candidate and cannot upgrade the already-installed preview at code 23.

The retained, noninstalled upgrade candidate was rebuilt with explicit preview identity and the final isolated schema-19 API/project:

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug --no-daemon --max-workers=2 '-Dorg.gradle.parallel=false' '-Dorg.gradle.jvmargs=-Xmx2g' '-PqaHubApiBaseUrl=http://127.0.0.1:4519/api/v1/' '-PqaHubProjectId=0c62c78c-5732-43c4-82c2-26c5c2eb91a4' '-PqaHubVersionCode=24' '-PqaHubVersionName=0.2.0-preview.10'
```

Final source-bound result: `BUILD SUCCESSFUL` in 1m 20s; 58 actionable tasks, 11 executed and 47 up-to-date. The final reports contain 23 test suites and 133 tests with 0 failures, 0 errors, and 0 skipped. `lintDebug` reports 35 warnings and 0 errors. The captured Gradle log has SHA-256 `70347dc8379a65a0e582d460c4232bd00dadfd1a324c7b872336c375a5c945cf`.

Retained APK:

- Path: `apps/android/app/build/outputs/apk/debug/app-debug.apk`
- Application ID: `com.relayqahub.android.preview.debug`
- Version code: `24`
- Version name: `0.2.0-preview.10`
- Min/target SDK: `29` / `37`
- Size: `37,026,695` bytes
- SHA-256: `28e5248848e65d767ec2bf71b627d55f274e5e3a0c95c4cf68756b58dffa0e19`

The first two setup invocations ended before tests because one omitted the required preview properties and one lacked `ANDROID_HOME`. Both harness inputs were corrected. A later metadata inspection used repo-root-relative paths from `apps/android` and was rerun from the repository root. No test failure was suppressed; the complete final-source run above passed.

Source binding for the retained APK:

- HEAD: `029188ba25df1c3e940437f1e78fa05ba011aed8`
- `source-binding.json`: SHA-256 `f378b0dcba69184b9f0ebc891e8bc7f4148c21730c6d306a285446841d0a18a7`
- `git diff --binary -- apps/android`: 174,516 bytes, SHA-256 `f282f8805d1c9ef389a753b45d9b8e4bfdfe5ca08670286cff82ca6a80ab328e`
- Sorted 12-file Android change aggregate: SHA-256 `02a4053b7ea86e076d1976561ddda436b4c78ea1bab418bbb9784956fc47e51d`
- Output metadata SHA-256: `4f093509ec1b1f8aa8be44a121ab16398c0c47d460988e014bc5865284918828`

## Acceptance limits

- No APK was installed, upgraded, opened, or tested on a device. Touch behavior, image picking, Android process death, and real network interruption still require device E2E.
- Network tests use deterministic OkHttp interceptors. The final APK embeds the isolated API/project values above, but no live verification upload/result or binding-renewal E2E was run.
- The panel can submit a pre-existing `captureBundleId` but does not create a capture bundle under the pending verification submission. That integration still needs implementation and server/device E2E.
- Relay and external successor modes are represented but their downstream execution/delivery was outside this Android-only candidate.
