# Relay QA Hub native Android foundation

This is the standalone Kotlin/Jetpack Compose application for QA Hub. It is a
native application and contains no WebView, PWA, or service-worker path. Its
Gradle build is self-contained under this directory and does not call Relay,
Unity Jenkins, or any APK/CDN endpoint.

## Pinned toolchain

- Android Gradle Plugin: `9.1.1`
- Gradle wrapper: `9.3.1`
- Built-in Kotlin / Compose compiler plugin: `2.2.10`
- `minSdk`: `29` (Android 10)
- `compileSdk`: `37`
- `targetSdk`: `37`
- SDK Build-Tools: `36.0.0`
- NDK/CMake: not used

AGP 9.1.1 supplies built-in Kotlin, so the project deliberately does not apply
`org.jetbrains.kotlin.android`. KSP2 `2.3.9` is pinned for AGP 9 built-in Kotlin
compatibility and Room schema output is kept at `app/schemas`.

## Setup on this Windows host

Use Android Studio's bundled JBR; no system Java installation is required.
From this directory in PowerShell:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = 'C:\Users\lin0\AppData\Local\Android\Sdk'
./gradlew.bat --version
./gradlew.bat clean assembleDebug lint testDebugUnitTest
```

The default API URL is the non-routable
`https://qa-hub.invalid/api/v1/`. Inject an HTTPS development endpoint without
editing source:

```powershell
./gradlew.bat assembleDebug -PqaHubApiBaseUrl='https://qa-hub.example/api/v1/'
```

## Device test injection

The development serial is never stored in app or Gradle production config.
Inject it for one shell when the intended emulator is already connected:

```powershell
$env:ANDROID_SERIAL = '127.0.0.1:16384'
./gradlew.bat connectedDebugAndroidTest
```

Always verify the selected device with `adb -s <serial> shell getprop
ro.build.version.sdk`. The current `127.0.0.1:16384` target is a MuMu emulator;
its API/Keystore results are emulator evidence only and do not satisfy real
device, hardware-backed key, overlay, MediaProjection, or Poco gates.

## Foundation boundaries

- Room tables and every cache/queue query are scoped by both account and
  project. Deleting an account cascades only that account namespace.
- Opaque access/refresh tokens are stored outside Room using a versioned
  AES-GCM key in `AndroidKeyStore`. The API reports availability without making
  a hardware-backed claim.
- WorkManager schedules one unique queue worker per scope with connected
  network, battery-not-low, exponential backoff, stale-running recovery, and a
  four-run retry ceiling. Returning to the foreground after device unlock
  explicitly re-enqueues fail-closed `BLOCKED_DEVICE` scopes.
- The real OkHttp `createBug` path accepts only the frozen `201` response with
  `application/vnd.relay-qa-hub.v1.1+json`, reads at most 256 KiB, and strictly
  binds the response to the queued submission, project, actor, QA item,
  attachment/capture set, and idempotency key. HTML, empty, over-size,
  wrong-media, or wrong-scope responses cannot mark work successful.
- A validated create response is transactionally inserted into Room's
  `offline_operation_receipts` table before the operation can enter
  `SUCCEEDED`. That transaction independently requires the operation key to be
  `submission:<receipt.clientSubmissionId>:commit`; a mismatch rolls back both
  receipt insertion and success. Response-lost replay therefore retains the
  same QA item without applying a second server effect. Upload-chunk paths
  remain excluded from the JSON transport.
- `FakeQaHubApiClient` and `FakeCredentialVault` exercise the same boundaries in
  deterministic unit tests.
- Device instrumentation separately uses the production Application container,
  persistent Room, `OfflineSyncWorker`, WorkManager cancellation, and Android
  Keystore to cover the 20-row batch boundary and account-wide logout cleanup.
  Its expired credential deliberately prevents network I/O; it is not server
  end-to-end evidence.

The debug APK is produced only at
`app/build/outputs/apk/debug/app-debug.apk` by this Gradle project.
