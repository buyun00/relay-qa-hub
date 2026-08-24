# P3.2 Android native foundation evidence

Latest independent verification completed at 2026-08-25 04:59:47 +08:00 from
`D:\Relay-QA-Hub\apps\android` using only this directory's Gradle wrapper.

## Toolchain

- Android Studio build: `AI-261.26222.65.2613.15948027`
- Android Studio bundled JBR: OpenJDK `25.0.2`
- Android Gradle Plugin: `9.1.1`
- Gradle wrapper: `9.3.1`
- SDK platform: `platforms;android-37.0` revision `2.0.0`
- SDK Build-Tools: `36.0.0`
- Platform-Tools: `37.0.1`
- App SDK range: min `35`, compile `37`, target `37`
- NDK/CMake: not configured or used

These pinned values are also encoded in the Gradle wrapper, version catalog,
module configuration, and Android setup document; ignored transient `.log`
files are not treated as repository evidence.

## Latest build and checks

- Final independent forced command (`--no-build-cache --rerun-tasks clean
  assembleDebug lint testDebugUnitTest connectedDebugAndroidTest`): PASS in 1
  minute 8 seconds with 92/92 tasks executed.
- JVM tests: 38/38, 0 failures/errors/skips.
- MuMu API35 connected tests: 10/10, 0 failures/errors/skips.
- Lint: PASS, 0 errors and 13 warnings.
- Source trailing-whitespace scan across Android Kotlin, Gradle, manifest,
  schema, and Markdown files: PASS.

This run includes strict real-OkHttp `createBug` success validation, bounded
response reads, wrong-status/media/body/submission/project/QA-item negative
cases, response-lost exact replay with one committed effect, Room v3 durable
receipts before `SUCCEEDED`, transactional rejection of a mismatched submission
key, a real persistent Room/worker/WorkManager/Keystore/logout instrumentation
path, and foreground/unlock resumption of `BLOCKED_DEVICE` work. The
response-loss network test uses a deterministic DAO test double; the separate
device tests are the persistence evidence.

The exact command, suite list, count-correction audit, final hash, and install
evidence are in
[`hardening-2026-08-25.md`](hardening-2026-08-25.md). The older `.log` files in
this local directory are ignored transient output and are superseded for test
counts and APK identity.

The build emits two non-failing tool diagnostics: the installed SDK metadata is
XML v4 while one SDK parser reports v3 awareness, and the packaged
`libandroidx.graphics.path.so` has no symbols the debug strip task can remove.
Neither changed the successful assemble, lint, unit, or device-test results.

## APK and installed package

- APK:
  `D:\Relay-QA-Hub\apps\android\app\build\outputs\apk\debug\app-debug.apk`
- Size: `32,618,659` bytes
- SHA-256: `2265B10159B4DC86A58721A3964C13E15B51E0B5CCF453AB5D3D8A9F67180A48`
- Package: `com.relayqahub.android.debug`
- Version: code `1`, name `0.1.0-debug`
- Manifest evidence: min `35`, target `37`, compile `37`
- Explicit streamed `adb install -r -t`: PASS
- Cold activity launch: PASS in `682 ms`
- Installed `pm path`: present under `/data/app/.../base.apk`
- Running process after launch: PASS at evidence capture time

The runtime screenshot
[`mumu-api35-native-foundation.png`](mumu-api35-native-foundation.png) is retained
as foundation history; the current install/hash/launch evidence is recorded in
[`hardening-2026-08-25.md`](hardening-2026-08-25.md).

## Device boundary

The injected serial `127.0.0.1:16384` reported API level `35` and the spoofed
product identity `Redmi 22041211A`. It is the designated MuMu emulator, not a
physical device. These results prove API35 install, launch, Room behavior,
Compose UI, and emulator Keystore availability only. They do not satisfy or
claim real-device hardware-backed Keystore, overlay, MediaProjection, or Poco
gates.

No Relay, Unity/Jenkins, or Unity-hosted APK path was called or used to produce
this QA Hub APK.
