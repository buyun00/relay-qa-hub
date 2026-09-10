# Final code26 targeted upgrade

- Baseline recorded: preview code25, daily code14, reverse 4419+4639, daily PID 5051.
- App-native update UI was not exposed in the current preview detail surface; no self-update action could be reached without leaving the acceptance surface. Result: UNRUN.
- Fallback adb install -r of Relay-QA-Hub-Android-26-0.2.0-preview.13.apk succeeded. APK SHA is in apk-sha256.txt; expected SHA 63fb67774b0fed95f923f975a1e20956a7821a629157be965950379191953acb.
- Installed package is code26/version 0.2.0-preview.13. UI retained OZDQP, LunaV21E2E_0910_1038, and LOCAL-2. API readback confirms LOCAL-2 remains closed.
- daily PID remained 5051, daily version unchanged, reverse 4419 and 4639 preserved. No uninstall/clear/force-stop daily.
- Final code26 MediaProjection was not retried after prior MuMu native crash evidence; classify UNRUN/blocked to avoid crash loop.

## Single final code26 MediaProjection attempt (2026-09-10)

- Exactly one final attempt was made on installed `com.relayqahub.android.preview.debug`, versionCode 26/versionName `0.2.0-preview.13`; pre-action record: `capture-before-version.txt`.
- Native UI path: floating-ball menu `现场截图` -> `授权整屏截图并开启` -> Android MediaProjection dialog -> dropdown `共享整个屏幕` -> `下一步`; records: `capture-menu.xml`, `capture-permission.xml`, `c26-dropdown.xml`, `capture-afterauth.xml`.
- The single `立即截图` action was then tapped once. The returned native UI changed to `快速提单/新建 Bug` and exposed `现场图片` plus content-desc `待提交的截图预览`, proving an in-app capture draft was created and visible. Post-action UI/screenshot: `capture-after-click.xml`, `capture-after-click.png`.
- System evidence shows MediaProjection permission activity closed, token started, virtual display `Relay QA Hub evidence session` created successfully, and preview returned to `MainActivity`: `capture-final-logcat.txt`, `capture-final-activities.txt`.
- MuMu emitted a native `Fatal signal 7 (SIGBUS)` on a `Shutdown thread` after the capture, alongside prior SIGSEGV shutdown-thread records in the same captured log. Per acceptance rule, stopped immediately and did not retry. Classify capture UI/draft: PASS; MuMu native stability: FAIL/blocker. No server submission was made.
- Read-only final checks: installed package `capture-final-package.txt`; preview PID `capture-final-preview-pid.txt`; daily PID `capture-final-daily-pid.txt` remained 5051; reverse remained exactly 4419 and 4639 in `capture-final-reverse.txt`; no daily action/data mutation.
- Read-only media inventory is in `capture-files-readonly.txt` (`/sdcard/Download/qa-v21-acceptance.png` and thumbnails); no DB or app data was modified.
