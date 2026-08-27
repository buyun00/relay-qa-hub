# Android App-first toolchain setup and preflight

This document defines prerequisites for `apps/android`. It is not evidence that
the Android toolchain, APK build, emulator, or device tests are currently
available.

## Current host audit

The initial read-only audit on 2026-08-24 found:

```text
C:\Program Files\Android\Android Studio        absent
%LOCALAPPDATA%\Android\Sdk                    absent
adb on PATH                                   absent
java on PATH                                  absent
HypervisorPlatform InstallState               1 (enabled)
```

Consequences:

- P3.0 contracts, P3.1 Poco source/protocol inspection, and server work may
  continue.
- P3.2 and later Android compile/test packages cannot be marked `DONE`, and no
  APK/build/test result may be claimed, until the preflight below passes.
- Do not install, remove, or reconfigure host virtualization as a workaround.

A corrected read-only preflight at `2026-08-24T19:27:07+08:00` discovered the
stable API 37 package at `platforms/android-37.0` by parsing package metadata,
not by assuming the directory name `android-37`. It passed with API `37.0`,
`PreviewSdkInt=0`, extension level 22, revision 2, and a real `android.jar`.
Android Studio 2026.1.3, bundled JBR 25.0.2, Platform-Tools 37.0.1,
Build-Tools 36.0.0, Command-line Tools, Emulator, licenses, and WHPX are also
available. The Android Gradle project has not yet been generated. At
`19:33+08:00`, a configurable adb serial selected the connected MuMu instance
`127.0.0.1:16384`; this is device discovery only, not APK test evidence.

## Current Android baseline

- `minSdk = 31` (Android 12; Android 12L is API 32)
- `compileSdk = 37`
- `targetSdk = 37`
- Android Gradle Plugin `9.1.1`
- Gradle Wrapper `9.3.1`
- Android SDK Build-Tools `36.0.0` (the supported AGP 9.1.1 default; not a blocker)
- Kotlin + Jetpack Compose
- Room for account/project-scoped cache, drafts, and durable local queues
- WorkManager for constrained upload/reconciliation retries
- A foreground service for user-approved MediaProjection and overlay lifetime
- Pure JVM/Android code: no NDK, CMake, JNI, or native C++ dependency
- Checked-in Gradle Wrapper; builds must not depend on a globally installed
  Gradle
- Android Studio bundled JDK; no separate system Java installation required

The version catalog and Android module must repeat these values explicitly and
tests must assert them. Any future NDK need requires a separate approved design
and an exact Gradle-pinned NDK version.

## Required installation components

Install Android Studio with its bundled JDK, then use SDK Manager to install:

- Android SDK Platform 37
- Android SDK Build-Tools 36.0.0, pinned with AGP 9.1.1
- Android SDK Platform-Tools (`adb`)
- Android SDK Command-line Tools
- Android Emulator
- Optional API 31/32, API 35, and API 36 system images for automated compatibility work; absence is not a blocker while MuMu supplies the API 35 regression lane

The project-local `local.properties` must point `sdk.dir` to the installed SDK;
it is ignored by Git and must not contain credentials. Do not commit signing
keys, keystore properties, tokens, device backups, or user-specific SDK paths.

## Virtualization safety

Windows Hypervisor Platform is already enabled. Android emulators must use
WHPX. Never disable Hyper-V, Virtual Machine Platform, Windows Hypervisor
Platform, or related boot settings to install AEHD/HAXM: Relay workers depend on
Hyper-V and are outside the Android toolchain change scope.

An emulator or MuMu can supplement deterministic tests but cannot satisfy the
real overlay, MediaProjection, system reclaim, OEM power management, or Poco
loopback Gate.

## Preflight acceptance

Before any APK claim, record exact output for:

1. Android Studio installation path and version.
2. Bundled JDK absolute path and `java -version`.
3. SDK root and stable Platform 37 metadata (`ApiLevel=37.0`,
   `PreviewSdkInt=0`, `android.jar`), Build-Tools 36.0.0, Platform-Tools,
   Command-line Tools, and Emulator package revisions.
4. Checked-in Gradle Wrapper 9.3.1, AGP 9.1.1 version-catalog pin, and
   `gradlew --version` using the Android Studio bundled JDK.
5. `adb version` and `adb devices -l`.
6. Clean Gradle configuration, compile, lint, unit tests, and the applicable
   connected/instrumented tests.
7. `minSdk=31`, `compileSdk=37`, and `targetSdk=37` from the actual resolved
   module model, not only documentation.

If any item is missing, report the exact missing command/path/package and keep
the affected work package `PLANNED`, `IN_PROGRESS`, `VERIFYING`, or `BLOCKED` as
appropriate; never substitute source completion for a built APK.

Run the checked-in read-only preflight with:

```text
npm run check:android-toolchain
```

It exits nonzero while required components are absent and prints JSON evidence;
it never installs packages or changes virtualization.

## MuMu and device evidence

Never trust a MuMu product label as an Android version. Configure a development
serial outside production App code, then save live values:

```text
adb -s <serial> shell getprop ro.build.version.sdk
adb -s <serial> shell getprop ro.build.version.release
adb -s <serial> shell getprop ro.build.fingerprint
```

For the checked-in preflight, an already connected serial can be selected with
`QA_HUB_ANDROID_ADB_SERIAL` or the script's `-DeviceSerial` argument. The script
does not run `adb connect` and no endpoint is hardcoded into the production App.

The currently connected instance was verified at `2026-08-24T19:33+08:00`:

```text
serial/security context  127.0.0.1:16384 / SELinux Permissive
product/model/device      rubens / 22041211A / rubens
release/API/codename      15 / 35 / REL
security patch            2025-05-05
ABI / uname               x86_64,arm64-v8a,x86 / aarch64
display                   1440x2560 @ density 360
```

This is the current Android 15/API 35 regression emulator lane. Its permissive
SELinux and hosted environment make it unsuitable as proof of Android 12
compatibility or production security boundaries.

Required release evidence now starts at Android 12/API 31 and Android 12L/API
32, includes the current Android 15/API 35 MuMu plus real-device coverage, then
covers Android 16/API 36 and Android 17/API 37 and at least one strongly managed
OEM device. The current API 35 MuMu never replaces real-device evidence for
installation, overlay, MediaProjection, system reclaim, SELinux, OEM power
behavior, or Poco `127.0.0.1` security.

## Field people configuration

The Android field client has no people-management screen and does not hardcode
assignees. Its checked-in seed is `apps/android/config/qa-people.json`. On first
launch the App copies that seed to the user-editable file below and prefers the
external file on subsequent process starts:

```text
/storage/emulated/0/Android/media/<applicationId>/qa-hub/config/qa-people.json
```

Use `com.relayqahub.android.debug` for a debug APK and
`com.relayqahub.android` for release. The JSON object has exactly
`schemaVersion`, `projectKey`, and `people`; each person has exactly `id`,
`pinyin`, `displayName`, `roles`, and `active`. `pinyin` is the unique lowercase
name spelling used by the passwordless Web and Android login. `roles` accepts only `fixer` and
`verifier`:

```json
{
  "schemaVersion": 2,
  "projectKey": "LOCAL",
  "people": [
    {
      "id": "<QA Hub user UUID>",
      "pinyin": "luodongle",
      "displayName": "QA member",
      "roles": ["fixer", "verifier"],
      "active": true
    }
  ]
}
```

At API startup the same file creates or updates the active project users and
memberships. The default API path is the checked-in seed; operators can override
it with `QA_HUB_PEOPLE_CONFIG_FILE`. An empty or invalid role list is shown as a
configuration problem; the App never falls back to embedded people.

On an existing debug installation, the App preserves a schema-v1 external file
as `qa-people.schema-v1.backup.json` and atomically seeds schema v2. An unknown
future schema is never overwritten automatically.

## Current Android interaction model

The field App intentionally has exactly three bottom destinations and opens on
`Bug 列表`:

- `悬浮球` owns the start/stop switch, immediate capture and the instruction to
  choose `共享整个屏幕` in the system capture dialog. It also documents single
  tap, double tap, drag and end-of-test behavior.
- The raised center `+ 新建` opens the single-content create flow. A screenshot
  remains a passive preview while the form scrolls; tapping it opens the
  full-screen drawing editor with undo, clear, save and cancel.
- `Bug 列表` opens a read-only Bug detail and combines reporter, owner and
  grouped-state filters with `全部显示`. The client currently filters the
  bounded 100-item page already loaded from the shared backend.

The verifier defaults to the current identity. The fixer defaults to
`暂不指定` for every new Bug form and can be assigned later from the shared Web/
EXE overview. No previous fixer preference is applied.
The API's legacy required title remains an internal summary derived from the
content and is not shown as a second input.

## APK self-update and game downloads

The Android client checks `/api/v1/android-updates/stable/latest.json` on
startup and again at most every four hours unless the user taps `重新检查`.
`latest.json` identifies the exact package name, version code, byte length and
SHA-256. The client downloads into its private `apk-downloads` directory,
validates those fields, validates the parsed APK package/version, and then opens
Android's system package installer. Android still requires the user to allow
`安装未知应用` for QA Hub and to confirm installation; signature compatibility
is enforced by the system installer.

Build and atomically publish the current debug APK with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Publish-QAHubAndroid.ps1
```

The script publishes the immutable APK first and replaces `latest.json` last
under `<QA_HUB_DATA_ROOT>\android-updates\stable`. Future versions must increase
`versionCode`; `qaHubVersionCode` and `qaHubVersionName` are Gradle properties.

At the bottom of `悬浮球设置`, the App also reads
`http://10.100.5.129:8000/apk/?json=true`, filters ordinary game `.apk` files,
sorts by `mtime`, and displays the latest five. These downloads use the same
private-file and system-installer path, but are intentionally separate from the
QA Hub self-update feed.

## Phone-local game and PC LAN API

The two Android network endpoints are deliberately independent:

- Unity/Poco is always on the same phone and remains loopback-only at
  `127.0.0.1:5001` (with the existing bounded `5001..5005` fallback probes).
- QA Hub API is on the Windows host and defaults to
  `http://10.100.5.157:4319/api/v1/` for the current LAN.

The repository seed is `apps/android/config/qa-runtime.json`. On first launch,
the App copies it to the path below and then prefers that external file on every
process start:

```text
/storage/emulated/0/Android/media/<applicationId>/qa-hub/config/qa-runtime.json
```

The fixed JSON structure is:

```json
{
  "schemaVersion": 1,
  "apiBaseUrl": "http://10.100.5.157:4319/api/v1/"
}
```

HTTPS accepts a valid DNS name or IP address. Plain HTTP is accepted only for a
literal loopback, RFC1918, IPv4/IPv6 link-local, or IPv6 ULA address; public
cleartext addresses, DNS names, credentials, redirects, query strings,
fragments, and any path other than `/api/v1/` fail closed. To change a PC whose
address moved, edit the seed before a new install, use Gradle property
`qaHubApiBaseUrl`, or replace the external file on an existing installation and
restart the App. This does not alter the Poco endpoint.

Before phone testing, expose the QA Hub ports and restart the LAN runtime:

```powershell
.\scripts\Enable-QAHubLanAccess.ps1
.\scripts\restart-mvp-api.ps1
.\scripts\restart-mvp-web.ps1
```

The current host auto-detects `10.100.5.157/21`; an explicit address can be
passed with `-LanAddress`. The Web/API processes bind `0.0.0.0`, keep loopback
access, and advertise `http://10.100.5.157:4174/` as the management URL. Relay
4317 is not added to the QA Hub LAN firewall rules.

## Current internal build and install

Build the controlled-LAN debug APK only through the checked build wrapper. It
loads the active API URL and internal backend connection configuration, scopes
both to the Gradle process, clears them afterward, and verifies that the
finished DEX did not silently fall back to an unusable configuration:

```powershell
.\scripts\Build-QAHubAndroidDebug.ps1
```

Install it without clearing existing App data. Do not create an ADB reverse
mapping; the phone must reach the Windows LAN address directly:

```powershell
$adb = 'C:\Users\lin0\AppData\Local\Android\Sdk\platform-tools\adb.exe'
& $adb -s 127.0.0.1:16384 install -r -t `
  .\apps\android\app\build\outputs\apk\debug\app-debug.apk
& $adb -s 127.0.0.1:16384 reverse --remove tcp:4319
```

Current artifact:

```text
path     apps/android/app/build/outputs/apk/debug/app-debug.apk
bytes    33,931,144
sha256   81C5EB63CE9D8798C695757FA8634966590E35F8500D88668A500D97E4C55647
package  com.relayqahub.android.debug
version  0.1.4-debug (code 5)
```

The installed MuMu `base.apk` produced the same hash. The App no longer uses
Android Keystore, encrypted credential preferences, device PIN/biometrics, or a
per-submit credential write. Foreground submission and WorkManager retry read
the same bundled controlled-LAN backend configuration, so the artifact remains
internal-only and must not be published or sent externally.

The three pages, full-screen MediaProjection selection, start/capture/stop,
scroll-safe annotation, assignment defaults, list filters and real attachment
detail were rechecked on `127.0.0.1:16384`. Commands, results and screenshots
are recorded in
[`evidence/ANDROID-THREE-PAGE-VISUAL-2026-08-27.md`](evidence/ANDROID-THREE-PAGE-VISUAL-2026-08-27.md).
The direct-LAN credential, overlay sequencing, portrait-to-landscape capture,
and `LOCAL-14` proof are recorded in
[`evidence/ANDROID-REMOTE-PHONE-CAPTURE-FIX-2026-08-27.md`](evidence/ANDROID-REMOTE-PHONE-CAPTURE-FIX-2026-08-27.md).
The no-Keystore Android 12 submission repair and direct-LAN `LOCAL-17` evidence
are recorded in
[`evidence/ANDROID-LAN-NO-KEYSTORE-2026-08-27.md`](evidence/ANDROID-LAN-NO-KEYSTORE-2026-08-27.md).

## APK provenance boundary

The QA Hub App is built only from this repository's own `apps/android` Gradle
project and installed with the Android SDK `adb`. A Jenkins URL or
`http://10.100.5.129:8000/apk` supplied for the tested Unity game is not a QA
Hub App build or download source and must never be used as one. That Unity build
chain is used only after an actual QA Hub/Poco bridge change has been committed
to the Unity project's `main`, and only to obtain the matching Unity game APK
for integration testing.

Android 16/API 36 is a runtime compatibility layer, not the compile/target
default. The Android 17/API 37 slot must additionally verify:

- the App declares and requests `ACCESS_LOCAL_NETWORK` because direct access to
  the PC LAN API is now a product feature; denial must explain that the QA Hub
  backend is unavailable without blocking phone-local capture/Poco fallback;
- same-profile Poco `127.0.0.1` remains separate from that permission and the PC
  endpoint still uses the configured LAN address rather than loopback;
- adaptive Compose layouts survive `sw600dp+`, multi-window, rotation, and
  ignored orientation/resizability/aspect-ratio restrictions without state loss;
- QA Hub HTTPS works with API 37 default Certificate Transparency and the
  selected network library's actual ECH negotiation/fallback behavior;
- notification custom-view limits and the user-visible MediaProjection
  foreground-service notification/lifecycle remain correct.

Android 12/API31 through Android 16/API36 use the normal `INTERNET` permission
and do not request the API37-only local-network runtime permission. Android 17/API37
must grant it before direct LAN access. The current source follows the Android
platform requirement, but an API37 runtime is still needed for release-gate
evidence.
