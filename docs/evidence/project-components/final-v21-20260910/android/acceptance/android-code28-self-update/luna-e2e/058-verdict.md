# Android code27 -> code28 in-app self-update E2E

- Result: PASS for the isolated MuMu preview acceptance.
- Device: MuMu `127.0.0.1:16384`, Android 15/API 35, `Redmi/rubens/rubens`, display `1440x2560` (app UI bounds `2560x1440`).
- Scope: preview package `com.relayqahub.android.preview.debug`; no physical Android device was touched and no `adb install`/`pm install` was used.
- Source/publication target: commit `88a6d0f9c31106f6cd3fc9edbadca0db6bf6397b`, versionCode `28`, versionName `0.2.0-preview.15`, APK SHA-256 `61a885f22b9a62383d923bf36ca0f9ade9f987c22bb30c7323bd8acbd7536e7a`. Publication and isolated-feed verification are in the sibling `publication.json`, `artifact-verification.json`, and `feed-http-verification.json` files.

## Observed path

1. Baseline package inspection found preview code 27 (`0.2.0-preview.14`, PID `54653`) and daily package code 14 (`0.1.13-debug`, PID `5051`) installed. Reverse mappings were `host-12 tcp:4419 tcp:4419` and `host-12 tcp:4639 tcp:4639`. The preview UI showed project `OZDQP`, identity `LunaV21E2E_0910_1038`, and Bug list entry `LOCAL-2` in `关闭`; baseline draft UI is retained in the prior code27 evidence `android-code27-self-update/luna-e2e/137-ui-code27-open.xml` and `135-screen-code27-open.png`.
2. In the preview UI, `检查更新` -> `重新检查` opened the Android system installer with `QA Hub 项目预览` and `要更新此应用吗？`; the action is recorded in `012`–`019`.
3. The system installer `更新` action completed with `已安装应用。`, then `打开` launched the preview app. The post-install package was code 28 / `0.2.0-preview.15`, PID `56183`; the success dialog and app launch are in `021`–`027`.
4. Immediately after launch, the app restored project `OZDQP`, identity `LunaV21E2E_0910_1038`, and the pending screenshot draft (`现场图片`, `删除图片`, content description `待提交的截图预览`) without submitting or editing it. See `024-screen-code28-open.png` and `025-ui-code28-open.xml`.
5. Opening Bug list showed the existing `LOCAL-2` with status `关闭` in `029`–`030`. Opening its detail showed the existing text and one image (`040`–`041`). Entering `编辑` only to inspect the lifecycle form showed `Bug 内容`, `标题`, `问题内容`, and `预期结果`; no advanced capture-bundle UUID field, `UUID`, or `bundle` text was exposed. See `043-screen-bug-lifecycle-code28.png` and `044-ui-bug-lifecycle-code28.xml`. No save/submit control was used.
6. Returning to the home/update card showed `当前版本 0.2.0-preview.15` and `已经是最新版`; an explicit `重新检查` kept that state (`050`–`054`).

## Verification

- Pulled installed package from the device's resolved `pm path` and computed SHA-256 `61A885F22B9A62383D923BF36CA0F9ADE9F987C22BB30C7323BD8ACBD7536E7A`, matching the publication target. See `031`–`033`.
- Preview remained running as PID `56183`; daily package remained running as PID `5051`; both were present in `055-processes-after.txt`. Daily version remained code 14 / `0.1.13-debug` (`037-daily-version-after.txt`).
- Reverse mappings remained unchanged in `034-reverse-after.txt` and `057-reverse-final.txt`.
- Foreground activity was `com.relayqahub.android.preview.debug/com.relayqahub.android.MainActivity` (`046-window-focus-after.txt`). The captured fatal-marker check contains no product `FATAL EXCEPTION` or `Process:` markers (`047-logcat-fatal-markers-after.txt`).

## Verdict and limits

PASS: the isolated MuMu preview client updated through its own persistent update UI and the Android system installer, launched code 28, matched the expected installed hash, retained project/identity/Bug/draft state, removed the advanced UUID field from the reachable lifecycle form, preserved reverse mappings, and coexisted with the daily package.

This is emulator acceptance only. It does not prove a physical Android device, a different Android version, or production package/feed behavior.
