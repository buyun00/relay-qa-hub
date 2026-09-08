# Android code23 / 0.2.0-preview.9 — build and acceptance plan

This is a read-only preparation record. No assemble, install, device command, service mutation or business request was executed to prepare it. The [bounded source proof](android-offline-create-recovery.md) is frozen at 115 passing JVM tests and lint 0 errors / 33 warnings. This plan does not mark client baseline14 passed.

## Pinned inputs and tools

- Worktree: `C:/Users/lin0/.codex/worktrees/7c86/Relay-QA-Hub`. Recheck the ten source/test hashes in [source evidence](android-offline-create-recovery.json) and record the eventual reviewed commit before packaging.
- Java: `C:/Program Files/Android/Android Studio/jbr`; SDK: `C:/Users/lin0/AppData/Local/Android/Sdk`; wrapper: `apps/android/gradlew.bat`; `adb.exe`: SDK `platform-tools`; `aapt.exe` and `apksigner.bat`: SDK `build-tools/36.0.0`. The source uses compileSdk37 and buildTools36.0.0.
- Retained code22: `C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/android-code22-acceptance/qa-hub-preview-code22.apk`; SHA256 `733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777`. This file hash was checked read-only during preparation.
- The [code22 evidence](android-code22-no-code.md) records package `com.relayqahub.android.preview.debug`, version22 / `0.2.0-preview.8`, and certificate SHA256 `9bbf6d2a68c27871c00abc3203fb319629aabacdcac03674483262bcf09e2a83`. It also retains code21 and a private data archive. These are historical installation facts, not a fresh device inventory.
- The same historical evidence names MuMu serial `127.0.0.1:16384`, and daily package `com.relayqahub.android.debug`, code14 / PID5051. Re-read all of them at execution time; do not assume a process ID or installed version remains current.

`scripts/Build-QAHubAndroidDebug.ps1` reads the production runtime-state path by default and can derive port4319. Do not use it for this preview. Direct, explicitly scoped Gradle invocation is required. Do not run connected instrumentation on the preserved preview installation: the current Gradle runner arguments include `clearPackageData=true`.

## Explicit build invocation — not executed

Run only from this worktree's `apps/android`. `$previewProjectId` must be a newly created dedicated test project, with all five components confirmed disabled. Keep the existing normalized API origin so retained scopes and the origin-namespaced Room database remain visible. The runtime file at `/Android/media/com.relayqahub.android.preview.debug/qa-hub/config/qa-runtime.json` takes precedence over the build default; read its schema/origin and retain its hash before proceeding.

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = 'C:\Users\lin0\AppData\Local\Android\Sdk'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
# Set from the newly created isolated test project and a checked, unused device-local fixture port.
if ($previewProjectId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'Explicit fresh project required' }
if ($fixturePocoPort -lt 1 -or $fixturePocoPort -gt 65535) { throw 'Explicit isolated Poco fixture port required' }
.\gradlew.bat :app:assembleDebug --offline --no-daemon --max-workers=2 `
  '-Dorg.gradle.parallel=false' '-Dorg.gradle.jvmargs=-Xmx2g' `
  '-PqaHubApiBaseUrl=http://127.0.0.1:4419/api/v1/' `
  "-PqaHubProjectId=$previewProjectId" `
  '-PqaHubVersionCode=23' '-PqaHubVersionName=0.2.0-preview.9' `
  '-PqaHubGameApkDirectoryUrl=https://qa-hub.invalid/disabled/' `
  "-PqaHubPocoPort=$fixturePocoPort"
if ($LASTEXITCODE -ne 0) { throw 'Preview build failed' }
```

The reserved Poco endpoint must not connect to an existing game. Pure-text recovery needs no Poco response. A screenshot fixture can leave this endpoint unavailable and record absent Poco capture; that must not be reported as verified game metadata integration.

Copy the resulting APK only to a new exclusive private runtime directory, such as `parallel-runtimes/qa-hub-preview-7c86/android-code23-acceptance-<unique-id>`, and hash both copies. Inspect the artifact with `aapt` and `apksigner`: exact preview applicationId, code23/name, unchanged signing certificate, provider authorities derived from preview applicationId, `qahub-preview` deep link, preview update channel and explicit4419 API. There must be no production updater fallback. Preserve the old APK and build log; generated `.kotlin`, `.gradle`, `app/build` and APK bytes do not enter Git.

## Preserve the actual installation before upgrading

1. Read the selected device identity, Android version, package/version/signature/base-APK paths, preview and daily process IDs, foreground activity, installation times and data roots. Record `adb reverse --list`. Reject an unexpected package or device rather than operating on a guessed target. Pull the installed preview APK into an exclusive private file and compare it with retained code22 before changing anything.
2. Inventory every preview draft, pending intent, capture PNG/sidecar, attachment file, runtime config and scoped queue. Read private metadata only inside the runtime evidence process; publish paths/counts/hashes and synthetic identifiers, not credentials or the user's draft text. Do not limit preservation to the three historically checked files.
3. Explicitly preserve any open form first. Current text callbacks persist synchronously; annotation-editor strokes are not promised durable across navigation/process death. Do not force-close an unsaved annotation editor and call a file backup sufficient. If such an editor is active, retain it until its state can be safely preserved through the existing UI.
4. After preview writes are quiescent, stop only the preview app for a coherent private archive. Preserve its complete `shared_prefs`, `files`, `databases` and `no_backup` directories when present, plus the external runtime config. Include SQLite WAL/SHM alongside databases; do not copy only a live main file. Use a binary-safe `spawnSync` Buffer to create an exclusive host tar file, not PowerShell text redirection. Record hashes and tar members without displaying credential bodies. Android Keystore keys are not exported by this archive; in-place same-signature update preserves them, uninstall/reset does not.
5. Retain daily package version, process and read-only configuration hashes before and after. Do not stop, uninstall, clear, downgrade, reconfigure or install into the daily package. Never use `pm clear`, uninstall, `adb install -d`, a broad `force-stop`, or `adb reverse --remove-all`.
6. Install only the verified code23 artifact with `adb -s <verified-serial> install -r <exact-private-apk>`. Start only the preview activity. Before logging into a new test identity, compare the preserved old draft/config/media hashes and show the old unsent draft remains. Later test identities legitimately add preference keys; compare the original entries and media individually instead of requiring the entire shared XML to remain identical after those new writes.

Historical retention anchors are the preview drafts XML and `files/capture-drafts/10135789-72bc-41c1-8756-9dba13ae3a96.{pending.json,png}`. Their code22 hashes are in its JSON. They must remain unsubmitted during the new test. Existing private code22 scripts contain fixed code21 archive names; read them as references, do not rerun them against their existing outputs.

## Real native loss-of-receipt experiment

Prepare a new loopback proxy fixture in the private runtime directory. No product source hook is needed. Keep APK origin4419 unchanged: temporarily map **the device's preview tcp4419** to a separately checked host proxy port, whose upstream remains the real preview API on host4419. Record and later restore that one reverse mapping exactly; leave daily4319 and all unrelated mappings intact. Do not rebind/restart the API. If4419 has unexpected shared consumers, stop this experiment at that boundary instead of redirecting them.

The proxy must be fail-closed and reviewed before use. Permit only the fresh test project and required native authentication/read/create/attachment routes. Refuse component execution routes and other projects. Hold credentials only in memory, do not follow redirects, and log only method/path, synthetic IDs, status, idempotency-key digest and raw-body SHA256. Persist the original real success receipt privately for later reconciliation without token/header output.

For a single fresh native Bug submission:

1. Let the native form create its own submission/operation identity and POST body. Forward the exact request unchanged. Only after the actual server returns a valid201 with matching project/submission/Bug identity, suppress the client response by closing its socket before headers. Do this for the first four attempts of that exact key/body. Reject a changed body or unexpected identity at the proxy; never manufacture server success.
2. Observe the actual WorkManager retry schedule. The engine uses30s exponential delays; after the first three failures nominal waits are30/60/120s, with connected-network/battery constraints and scheduling latency. Do not edit Room attempts, timestamps or WorkManager records, inject credentials into the DB, or count a scheduled attempt as a request. Keep progress visible during the wait.
3. After four actual committed-but-hidden responses, verify the same durable row is `FAILED_PERMANENT / RETRY_EXHAUSTED_*`; no fifth automatic create is sent. Use the UI plus proxy log, and, if DB detail is required, a quiesced preview-only private snapshot read through read-only SQLite. Keep the original ID, payload/hash, pending preferences and attachments. Reopen/relogin to the same scoped test identity using the normal app path; do not clear data.
4. Change the current form text while the original request remains pending. Click native submit to confirm the original request. The fifth request must carry the exact original idempotency identity/body, not the edited form. This time forward the actual valid201 response. Official API reads must show exactly one Bug effect/occurrence, unchanged original content, one scoped receipt and no duplicate creation. Row/receipt IDs and hashes must agree across native state, proxy transcript and API readback.
5. Confirm the pending original is resolved and current edits remain. Do not click submit again accidentally: after confirmation, that separate explicit action intentionally creates a new Bug from retained edits. Run a second distinct case for text that stayed unchanged and whose form was closed, where confirmed success may clear the draft normally.
6. Repeat the bounded case with one newly captured synthetic image. Compare original attachment IDs, immutable uploaded bytes/hash and binding count through the retries. For later annotation preservation, keep the new-Bug editor open while the receipt arrives and verify its text/capture/strokes are not reset; do not insert a process restart into this in-memory annotation case.

The native path, not a script-generated Bug POST, must supply each business request being claimed as APK acceptance. Backend behavior previously proven by standalone HTTP does not substitute for this run.

## Additional narrow recovery cases

- **Code22 legacy capture:** create a new synthetic uncertain capture using code22 before upgrading, record its sidecar identity and full-scope row without new pending prefs, then show code23 discovers and confirms that original request. The old retained user drafts are not test submissions. Do not claim a legacy upgrade test if the row is manually synthesized or only unit-tested.
- **Code22 legacy text:** create a separate synthetic uncertain pure-text request before upgrade; first code23 submit must display/adopt the old row without silently sending current edited text. Confirm one original record at a time, retaining any additional unresolved rows.
- **Wrong scope:** another fresh actor/project must not dispatch or consume the first scope's operation/receipt. Return to the original scope to finish. A missing known row remains blocked; never delete a real row to manufacture this case on the retained installation.
- **Protocol recovery:** in a separate fresh case, the proxy records a real committed201 and deliberately forwards an invalid success status or wrong-project receipt as a labeled response-corruption fixture. Normal submit/automatic work must not replay it. Click **“使用原请求重新确认”** while corruption remains to verify it stays unconfirmed, then restore unmodified responses and click again. The same key/body must eventually receive a valid201, with one actual server effect. Bad receipt acceptance is always failure.
- **Definitive attachment rejection:** use a fresh synthetic malformed media fixture that the real upload API rejects at the still-STAGE boundary, without a Bug POST. Verify the explicit **“保留附件失败记录，允许修改后新建”** action commits the original full failure/fingerprint before allowing a modified new intent, while old files and Room row remain. Do not mutate a previously uploaded file in place or treat arbitrary4xx as proof. If an ordinary native input cannot produce this stage safely, leave the real-UI case unexecuted and retain the existing JVM result.

## Evidence and teardown

Every native step gets a unique XML/screenshot path, exit status and relevant synthetic IDs. MuMu previously returned139 after writing a dump; preserve that status, validate the unique XML independently, and correlate screenshots with real requests. A stale dump or tool exit is never proof of successful submission.

Use official scoped API reads to reconcile the fresh project, Bug count, content, occurrence/event increments and attachment bindings. Read archive copies only for local queue/receipt details. Redact recursively while preserving primitive strings; hash raw private and derived public artifacts. Keep tokens, private app archives, APKs and raw user draft/media bytes outside Git.

In a `finally` path, stop only the new proxy, restore the original preview reverse mapping, and recheck preview readiness, daily process/version/config hashes, retained original drafts and capture bytes. Do not auto-delete queues or the private failure/rollback evidence. Physical-device behavior, screenshots with a real game/Poco source, edit/comment/component/lifecycle retry semantics, and any case not actually executed remain unverified. A successful emulator run is recorded as emulator evidence only.
