# Android 0.1.12: delete an unsubmitted screenshot

Date: 2026-09-08

## Delivered behavior

- New Bug shows a red `删除图片` button above the screenshot, including for long images.
- Deletion removes the selected local screenshot, recovery marker and associated Poco files. The form's content and assignments remain in place; annotations reset with the removed capture.
- Delete and submit are disabled while either operation is staging. A capture already in the submission queue is protected.
- Capture lookup uses the displayed capture ID. A restore started before deletion cannot reload its stale result.

## Validation

- `:app:testDebugUnitTest`: 67 tests, zero failures/errors; includes four file-deletion regressions for selected-only removal, repeated deletion, cross-capture artifacts and paths outside the draft directory.
- `:app:lintDebug` and `:app:assembleDebug`: passed on the final source.
- `Build-QAHubAndroidDebug.ps1 -SkipUnitTests`: passed; final APK has no embedded access-token markers.
- MuMu `127.0.0.1:16384`: overlay-installed over versionCode 9, preserving the existing `AndroidV9RemoteTest` login and app data.
- Real MediaProjection screenshot `13f5be58-e016-4efa-a648-babed9a58eac`: entered `QA_DELETE_IMAGE_20260908`, clicked Delete, observed the screenshot and marker disappear from the app-private draft directory. The content, unassigned fixer and existing verifier remained unchanged.
- Returned through Bug List to New Bug: no old image restored. Captured again as `b264f75b-0d84-4f85-b1ad-f1fcdbd8ae1c`, deleted again, then stopped/relaunched the QA Hub test app: no image restored, capture directory empty, login retained.
- This device run exercised draft deletion without creating a production test Bug. Capture service ended with the app restart.

Screenshots: [delete above image](android-0.1.12-delete-image-before.png), [retained form](android-0.1.12-delete-image-after.png), [after restart](android-0.1.12-delete-image-reopened.png).

## Release and read-back

- Source commit: `a26c765f2db455a9e8812cfba5f3619bf42cb1a6` (clean main at publication).
- Package: `com.relayqahub.android.debug`; versionCode `13`; versionName `0.1.12-debug`.
- Size: `35,364,667` bytes.
- SHA-256: `5050e89a7059957826af09d22de388d103214bb4045cadc215927a7b7df14d3b`.
- APK v2 signature verified; certificate SHA-256 `9bbf6d2a68c27871c00abc3203fb319629aabacdcac03674483262bcf09e2a83`, matching the prior stable APK.
- Published with `Publish-QAHubAndroid.ps1 -SkipBuild`. LAN manifest/source/version and downloaded APK size/hash verified; the MuMu-installed APK has the identical hash.
- API readiness: `ready`, schema `12`, database/evidence/worker all `ok`.
- Prior versionCode 12 APK remains in the stable artifact directory.
- [Download APK](http://10.100.5.157:4319/api/v1/android-updates/stable/Relay-QA-Hub-Android-13-0.1.12-debug.apk).
