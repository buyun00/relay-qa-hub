# Android MediaProjection revalidation

- Result: PASS
- Device: MuMu `127.0.0.1:16384`, Android fingerprint recorded in `02-device-fingerprint.txt`, display `2560x1440`.
- Package/build: `com.relayqahub.android.preview.debug`, `versionName=0.2.0-preview.13`, `versionCode=26` (see `28-preview-package-after.txt`).
- Activity: `com.relayqahub.android.MainActivity`, resumed in task 152 after the action (see `30-activity-full-after.txt`).
- Preview PID: `52177` before and after; daily debug PID: `5051` before and after (see `12`, `13`, `20`, `21`, `29`).
- MediaProjection: already authorized at baseline and remained active for the single capture (`16`, `24`, `32`). No second consent was requested.
- Action: one overlay single tap at `(2535,595)` at host `2026-09-10T13:59:59.5828844+08:00` (`17-action.txt`), followed by a screenshot after 3 seconds (`19-screen-after.png`).
- Visual result: post-action screenshot still shows the QA Hub “现场图片” draft preview; before/after PNG hashes are retained in `41-screen-hashes.txt`.
- Reverse: unchanged `host-12 tcp:4419 tcp:4419` and `host-12 tcp:4639 tcp:4639` (`08`, `25`, `33`).
- Crash boundary: no product `FATAL EXCEPTION` or native fatal signal for PID 52177 after the action (`34-logcat-product-pid-after.txt`). Existing SIGSEGV/SIGBUS markers are from `uiautomator` uid 2000 and are retained separately in `35-logcat-crash-markers-after.txt`; they are not classified as a QA Hub crash.
