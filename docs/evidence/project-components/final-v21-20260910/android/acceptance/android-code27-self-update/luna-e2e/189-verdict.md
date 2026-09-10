# Android code26 -> code27 in-app self-update E2E

- Result: PASS.
- Device: MuMu `127.0.0.1:16384`, display 2560x1440.
- Baseline: `com.relayqahub.android.preview.debug`, versionCode 26, versionName `0.2.0-preview.13`, PID 52177, APK SHA-256 `63fb67774b0fed95f923f975a1e20956a7821a629157be965950379191953acb`.
- Baseline retained state: project `OZDQP`, identity `LunaV21E2E_0910_1038`, existing `现场图片` unsubmitted screenshot draft. Bug list later confirmed `LOCAL-2` remains `关闭`.
- UI path: bottom `悬浮球` -> same page continuous upward swipes -> `QA Hub 更新` -> `重新检查`. The card reported `发现新版本 0.2.0-preview.14`; the app opened system unknown-source settings, which was enabled through the system UI only, then returned to the system installer.
- Installer path: system dialog `要更新此应用吗？` -> `更新` -> `已安装应用。` -> `打开`; no adb/pm install was used.
- Installed result: versionCode 27, versionName `0.2.0-preview.14`, PID 54653, APK SHA-256 `5977070bb3594e9a69fd770d082727446ece339f3a2b127353a64c5990eee11b`, matching the supplied target metadata.
- Post-upgrade UI: project/identity and screenshot draft remained visible; Bug list showed `LOCAL-2 / 关闭`. Project components -> `打包` -> `历史` entered component detail. Persistent top `检查更新` was visible there; clicking it exited detail and placed the `QA Hub 更新` card on the first screen, showing `当前版本 0.2.0-preview.14 / 已经是最新版`.
- Daily/reverse preservation: daily `com.relayqahub.android.debug` stayed PID 5051 and versionCode 14/versionName `0.1.13-debug`; reverse remained `host-12 tcp:4419 tcp:4419` and `host-12 tcp:4639 tcp:4639`.
- Stability: no product fatal markers for preview PID 54653 or daily PID 5051. Repeated `uiautomator` shutdown-thread SIGSEGV/SIGBUS records in raw logcat are the known UI-dump process and are not classified as product crashes.
- Evidence: this directory contains numbered raw screenshots, UI dumps, action records, package/PID/version/hash/reverse captures, and final logcat (`186-logcat-final.txt`).
