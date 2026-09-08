# Android 0.1.13: submit one final screenshot

Date: 2026-09-08

## Behavior

- A saved annotation replaces the unmarked screenshot in new submissions. An unmarked screenshot still submits as one image, and text-only Bugs remain supported.
- Both the durable queue and direct upload path send one final image.
- An annotated-only queue entry is valid and its attachment is used as the capture bundle's primary evidence. Existing queued entries containing both images retain their original parsing/binding behavior.

## Validation

- Android unit tests: 67 passed; lint: 0 errors; application and instrumentation APK builds passed.
- MuMu instrumentation: `OfflineAttachmentDraftContractTest`, 4 tests passed with `clearPackageData=false`. Covers annotated-only, original-only, text-only and existing two-image entries.
- Instrumentation method names use camelCase so the test APK supports the application's minimum SDK 29.
- Overlay-installed the final APK in MuMu `127.0.0.1:16384`, preserving the existing `AndroidV9RemoteTest` login.
- Real UI flow: MediaProjection capture → open editor → draw one red stroke → save → enter `QA_TEST_ANNOTATED_ONLY_20260908` → submit → open detail. Detail reports `图片 / 1 张`; its sole image retains the red stroke.
- Created exactly one named test Bug `LOCAL-385` (`c07dea56-6d5f-4eaf-8bb3-2eaeb6da3405`), retained as verification evidence.
- Read-only production verification: one finalized upload and one Bug attachment for submission `2897e757-a6f9-4345-a06c-a90ab3e28844`.
- Sole attachment `82b2a60b-c480-46a8-bbe7-e39fab5b7d25`: `capture-34cfde43-cea8-4fa9-8c37-8fa3efc4436d-annotated.png`, 212,129 bytes, SHA-256 `95cc8d790fb8f87a1d2575ff92673d78fac1ed8f7534b4368c113333e896f2be`.
- Original local screenshot SHA-256 was `c98d5440bc86d04487d2bb3e3025c38c808d3c8578dc21015c6d5e264031be7e`; it was not uploaded as an additional attachment.
- Capture bundle `34cfde43-cea8-4fa9-8c37-8fa3efc4436d` is `bound`, with the annotated attachment as `primary_attachment_id`. Poco is `unavailable` in this QA-app capture; game-side enrichment collection was outside this UI test.
- Local capture draft directory is empty after successful submission. Stopped the capture session through the app after testing.

Screenshots: [editor](android-0.1.13-annotated-only-editor.png), [one annotated image in detail](android-0.1.13-annotated-only-detail.png).

## Release

- Source commit: `5bbb46384f4b62318ca087eb7b58cfab74eab2b9`; clean main at publication.
- Package `com.relayqahub.android.debug`, versionCode `14`, versionName `0.1.13-debug`.
- APK: 34,357,125 bytes; SHA-256 `405e3909f65bea00583ddfb8332b5198c1ebeac6d7967d870d514a502e31db70`.
- V2 signature verified with the same certificate as versionCode 13. Standard build artifact checks found no embedded access-token markers.
- Published through `Publish-QAHubAndroid.ps1`; LAN manifest/source/version and downloaded size/hash verified. MuMu-installed APK has the identical hash.
- API readiness `ready`, schema `12`, database/evidence/worker all `ok`. Previous versionCode 13 artifact retained.
- [Download APK](http://10.100.5.157:4319/api/v1/android-updates/stable/Relay-QA-Hub-Android-14-0.1.13-debug.apk).
