# Android remote-phone access and landscape capture fix — 2026-08-27

## Scope

This slice fixes three user-visible failures in the controlled-QA Android APK:

1. a freshly downloaded APK reported `DEBUG_ACCESS_TOKEN_MISSING` and could not list or create Bugs;
2. authorizing capture while QA Hub was portrait left the later landscape game inside a portrait PNG;
3. enabling the floating ball immediately continued into whole-screen sharing instead of first asking for the Android overlay permission.

No Unity or Jenkins build was started. The tested game remained the already installed
`com.chuyao.baloots` package.

## Root causes and implementation

- The former website artifact, SHA-256 `00F65900825A442A88A0A86FF543A9EF1EDBED8C341B9D1B45BFF17CF67ECDEF`, had an empty debug credential even though an older APK on the original test device had one. `Build-QAHubAndroidDebug.ps1` now obtains the opaque value from the active QA runtime, scopes it to the Gradle process, clears the environment afterward, and fails the build if the final DEX does not contain a non-empty controlled-QA credential. The value is never printed or checked into source.
- `CaptureSessionService` no longer keeps the portrait `maximumWindowMetrics` captured during authorization. Before each capture it resolves the current real display metrics and resizes the `VirtualDisplay` onto a new matching `ImageReader` surface when width, height, or density changed. A queued frame from the retired reader is rejected unless its dimensions match the new surface.
- The floating-ball page now models overlay permission separately. The first action opens Android's `ACTION_MANAGE_OVERLAY_PERMISSION` page only. After returning, the explicit second action is labelled `授权整屏截图并开启`.
- A landscape screenshot keeps its native aspect ratio on the New Bug page. Opening the editor requests sensor landscape and uses a full-screen canvas; the Activity handles the orientation configuration change and restores the previous orientation on exit.

## Artifact proof

```text
path        apps/android/app/build/outputs/apk/debug/app-debug.apk
package     com.relayqahub.android.debug
version     0.1.2-debug (code 3)
minSdk      31
targetSdk   37
bytes       34,093,402
sha256      096098FCD5251269FF97969E80F2F3256E82CE0B49117A66A13536A86637760D
signature   APK Signature Scheme v2 = true; one Android Debug signer
download    http://10.100.5.157:4174/downloads/Relay-QA-Hub-Android12-debug.apk
```

The full LAN download was 34,093,402 bytes and had the same SHA-256 as the Gradle artifact. The route continued to return the Android APK MIME type with `no-store` and `nosniff`.

`Build-QAHubAndroidDebug.ps1`, `:app:testDebugUnitTest`, `:app:assembleDebug`, and `:app:lintDebug` all completed successfully. `aapt2` read back version code 3, version `0.1.2-debug`, `minSdk=31`, and `targetSdk=37`.

## Direct-LAN device proof

Device lane: MuMu `127.0.0.1:16384`, Android 15/API35. `adb reverse --list` was empty and `tcp:4319` was explicitly removed before the smoke.

- After installing the exact artifact with `adb install -r -t`, the package manager read back version code 3, version `0.1.2-debug`, minSdk 31, and targetSdk 37.
- The App read 13 existing project Bugs without `DEBUG_ACCESS_TOKEN_MISSING`, `UnknownHostException`, `ConnectException`, or `NATIVE_SESSION_INVALID`.
- The App created a real Bug over the PC LAN API: `LOCAL-14`, content `LAN-APK-0.1.2-device-create-20260827`, reporter 罗东乐, owner 林步云. The refreshed list changed from 13 to 14 and displayed the same content.

## Permission and rotation proof

With `SYSTEM_ALERT_WINDOW` denied, the first floating-ball action opened the Android Settings page titled `显示在其他应用的上层`, whose QA Hub row was `不允许`. After granting it and returning:

- QA Hub showed `上层显示已允许`;
- the next explicit action was `授权整屏截图并开启`;
- no MediaProjection dialog opened automatically.

The second action intentionally opened Android's whole-screen sharing dialog. The session was authorized while the display was portrait, then the existing game was opened in landscape and the QA ball was tapped.

The app-private evidence PNG was read back directly from the debuggable package:

```text
captureId   d35964a0-be1a-4302-a543-dbb48a967783
width       2560
height      1440
bytes       3,398,928
sha256      300A4F085A658A9486CDEB07C241D15D3F501B5F2B0F23BD1F83ED28AACF6855
```

Visual inspection confirmed that the game fills the landscape PNG, with no portrait canvas/letterbox and no QA floating ball in the evidence. The New Bug page displayed the image as a landscape card. Tapping the image opened a landscape full-screen annotation canvas with Cancel, Save, Undo, and Clear.

## Remaining boundary

The reported Android 12 physical phone was not present in `adb devices`, so its OEM install and permission behavior still needs a download/reinstall readback. MuMu/API35 proves the repaired package, direct-LAN API path, permission sequencing, and portrait-to-landscape capture implementation; it does not replace API31/32 OEM, SELinux Enforcing, API37, or release-signing gates. This APK embeds an internal debug credential and is limited to the controlled QA LAN.
