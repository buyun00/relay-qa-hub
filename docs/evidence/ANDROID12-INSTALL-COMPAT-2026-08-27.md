# Android 12 install compatibility — 2026-08-27

## Reported failure and root cause

An Android 12 device showed the OEM installer message `app-debug.apk 安装失败`
with generic error code `-2`. The authoritative module configuration still had
`minSdk = 35`, while Android 12 and Android 12L are API 31 and API 32. The APK
therefore could not be accepted by those systems; this was not a Poco, backend,
network, CPU ABI, or screenshot-permission failure.

## Compatibility repair

- Product minimum changed to `minSdk = 31`.
- Debug package advanced to `versionCode=2`, `versionName=0.1.1-debug` so phones
  can distinguish it from the rejected package.
- Both app-private dynamic broadcast bridges now register through
  `ContextCompat.registerReceiver(..., RECEIVER_NOT_EXPORTED)`.
- MediaProjection result transport now reads its parcelable through
  `IntentCompat.getParcelableExtra`, avoiding the API 33-only overload on
  Android 12.
- The LAN APK download has an explicit APK MIME type, attachment filename,
  `nosniff`, and `no-store`, so an OEM browser does not cache or misclassify the
  previous package.

## Build and package evidence

```text
Gradle :app:testDebugUnitTest     PASS
Gradle :app:lintDebug             PASS (0 errors)
Gradle :app:assembleDebug         PASS
API focused tests                 PASS (8/8, API31 accepted/API30 rejected)
App-first contract validation     PASS (51 payload scenarios)
Contract additive/strict checks   PASS
Plan/progress pointer check       PASS (56 ids)
aapt2 package                     com.relayqahub.android.debug
aapt2 version                     code 2 / 0.1.1-debug
aapt2 SDK                         min 31 / target 37 / compile 37
native ABIs                       arm64-v8a / armeabi-v7a / x86 / x86_64
APK signature                     v2 verified, one Android Debug signer
ZIP central directory             readable, 147 entries, 0 invalid entries
APK size                          34,071,174 bytes
APK SHA-256                       00F65900825A442A88A0A86FF543A9EF1EDBED8C341B9D1B45BFF17CF67ECDEF
```

The repaired package was installed with `adb install -r` on the existing
MuMu/API35 regression device and launched successfully. Android `dumpsys
package` independently returned:

```text
versionCode=2 minSdk=31 targetSdk=37
versionName=0.1.1-debug
primaryCpuAbi=x86_64
process running after launcher event
FATAL EXCEPTION / VerifyError      0 / 0
```

## LAN delivery evidence

The fixed artifact is available to the controlled QA subnet at:

```text
http://10.100.5.157:4174/downloads/Relay-QA-Hub-Android12-debug.apk
```

The live response returned `200`,
`application/vnd.android.package-archive`, the explicit attachment filename,
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and content length
`34,071,174`. A full download from that URL reproduced the build artifact's
SHA-256 exactly.

The production API was rebuilt and restarted on `10.100.5.157:4319`; readiness
returned true. Its runtime capture parser now accepts API31 through API100 and
the focused test proves API30 remains rejected, so the repaired phone is not
stopped at its first capture submission by the former API35 server floor.

## Remaining real-device evidence

No Android 12/API31 or Android 12L/API32 device is connected to this host, so
the user's next install is the first physical-device proof. Package parsing,
SDK/API compatibility lint, signing, all four common ABIs, LAN delivery, and the
existing API35 launch are proven; OEM overlay permission, MediaProjection, Poco
loopback, PC LAN API access, and power-management behavior still need a short
smoke on that actual phone. Ordinary screenshot submission remains independent
of Poco enrichment. Unity and Jenkins were not started or changed.
