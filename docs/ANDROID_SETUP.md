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

## Frozen Android baseline

- `minSdk = 35` (Android 15)
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
- Optional API 36 and API 35 system images for automated compatibility work; absence is not a blocker while MuMu supplies the API 35 emulator lane

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
7. `minSdk=35`, `compileSdk=37`, and `targetSdk=37` from the actual resolved
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

This is the supported minimum Android 15/API 35 emulator lane. Its permissive
SELinux and hosted environment make it unsuitable as proof of production
security boundaries.

Required release evidence starts at Android 15/API 35 (the current MuMu plus at
least one real device), then covers Android 16/API 36 and Android 17/API 37, and
at least one strongly managed OEM device. The current API 35 MuMu never replaces
real-device evidence for overlay, MediaProjection, system reclaim, SELinux, OEM
power behavior, or Poco `127.0.0.1` security.

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
`displayName`, `roles`, and `active`. `roles` accepts only `fixer` and
`verifier`:

```json
{
  "schemaVersion": 1,
  "projectKey": "LOCAL",
  "people": [
    {
      "id": "<QA Hub user UUID>",
      "displayName": "QA member",
      "roles": ["fixer", "verifier"],
      "active": true
    }
  ]
}
```

IDs must resolve to active users/memberships in the same QA Hub project. An
empty or invalid role list is shown as a configuration problem; the App never
falls back to embedded people.

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

- the App manifest does not declare `ACCESS_LOCAL_NETWORK` solely for Poco;
- same-profile Poco `127.0.0.1` works without that broad LAN permission, while
  Wi-Fi/LAN and work-profile/cross-profile loopback attempts are rejected;
- adaptive Compose layouts survive `sw600dp+`, multi-window, rotation, and
  ignored orientation/resizability/aspect-ratio restrictions without state loss;
- QA Hub HTTPS works with API 37 default Certificate Transparency and the
  selected network library's actual ECH negotiation/fallback behavior;
- notification custom-view limits and the user-visible MediaProjection
  foreground-service notification/lifecycle remain correct.

If a future product feature connects to a LAN device, it requires a separate
privacy decision and then an explicit declaration/runtime request for
`ACCESS_LOCAL_NETWORK`; it must not be predeclared for same-device Poco.
