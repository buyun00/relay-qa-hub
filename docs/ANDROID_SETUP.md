# Android App-first toolchain setup and preflight

This document defines prerequisites for `apps/android`. It is not evidence that
the Android toolchain, APK build, emulator, or device tests are currently
available.

## Current host audit

Read-only audit on 2026-08-24 found:

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

## Frozen Android baseline

- `minSdk = 31` (Android 12; Android 12L/API 32 is included by compatibility)
- `compileSdk = 36`
- `targetSdk = 36`
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

- Android SDK Platform 36
- Android SDK Build-Tools compatible with compileSdk 36
- Android SDK Platform-Tools (`adb`)
- Android SDK Command-line Tools
- Android Emulator
- Optional API 35 and API 31 system images for automated compatibility work

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
3. SDK root and installed Platform 36, Build-Tools, Platform-Tools,
   Command-line Tools, and Emulator package revisions.
4. Checked-in Gradle Wrapper version and `gradlew --version`.
5. `adb version` and `adb devices -l`.
6. Clean Gradle configuration, compile, lint, unit tests, and the applicable
   connected/instrumented tests.
7. `minSdk=31`, `compileSdk=36`, and `targetSdk=36` from the actual resolved
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

The known MuMu environment is labeled Android 12. Once adb is available, save
the device serial plus live values rather than trusting that label:

```text
adb -s <serial> shell getprop ro.build.version.sdk
adb -s <serial> shell getprop ro.build.version.release
adb -s <serial> shell getprop ro.build.fingerprint
```

Expected API for the Android 12 slot is 31. A mismatched value is recorded as
the actual environment and routed to the matching matrix slot.

Required release evidence covers Android 12/API 31 (MuMu plus at least one real
device), Android 13/14/15/16 real devices, and at least one strongly managed OEM
device. Android 12L/API 32 is a non-blocking compatibility probe if no dedicated
device is available. MuMu never replaces the Android 12 real-device evidence
for overlay, MediaProjection, system reclaim, or Poco `127.0.0.1` connectivity.
