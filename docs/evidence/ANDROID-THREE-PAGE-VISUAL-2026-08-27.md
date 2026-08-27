# Android three-page visual and device verification (2026-08-27)

## Delivered interaction

- The Android field App now starts on `Bug 列表` and has exactly three bottom destinations: `悬浮球`, a raised center `+ 新建`, and `Bug 列表`.
- `悬浮球` owns start/stop/capture controls and the instructions for choosing `共享整个屏幕`; Poco remains optional enrichment and is not exposed as a management control.
- `Bug 列表` reads the shared QA Hub API, opens a large in-App detail, and combines reporter, owner and grouped-state filters with an explicit `全部显示` reset. Filtering applies to the currently loaded, bounded 100-item page.
- `新建 Bug` remains the same durable submission flow, but uses a single content field and grouped cards. The screenshot is passive while the form scrolls; drawing begins only after the image is tapped. Verifier defaults to the signed-in person and fixer reuses that identity's previous selection.
- The palette and hierarchy reuse the approved Web baseline: `#F3F6F2` canvas, `#172B21` forest, `#B9F34A` lime, white cards and soft borders.

## Build and automated checks

```text
:app:compileDebugKotlin                         PASS
:app:testDebugUnitTest                         PASS (52 tests, 0 failures/errors/skips)
:app:assembleDebug                             PASS
:app:assembleDebugAndroidTest                  PASS
MainActivityTest on 127.0.0.1:16384            PASS (1 test)
```

The unit coverage includes reporter, owner, unassigned-owner, grouped-state, reset/all and three-way AND filtering. The connected Compose smoke signs in with pinyin, verifies the default list, all three destinations, all filter controls, the capture page and the scroll-safe content field.

## Real MuMu evidence

Device: `127.0.0.1:16384`, model `22041211A`, Android 15 / API 35. The App used `http://10.100.5.157:4319/api/v1/` directly; no `adb reverse` was present.

1. The default list loaded 12 real Bugs from the shared backend. Choosing reporter `吴鹏生` produced `显示 0 条 · 当前已加载 12 条`; `全部显示` restored all 12.
2. The system notification prompt was accepted, MediaProjection was changed from `共享一个应用` to `共享整个屏幕`, and the App displayed `悬浮球已开启` with the overlay visible.
3. `立即截图` created a private draft and automatically opened `新建 Bug` with the captured image.
4. Vertical swipes on the form scrolled without drawing. Tapping the image opened the full-screen editor; two red strokes were drawn and saved, enabling undo and clear.
5. The assignment card showed both verifier and previous fixer as `罗东乐` for this identity, matching the requested defaults.
6. `LOCAL-11` opened in the large Android detail and decoded/displayed its real game screenshot in the same dialog. `LOCAL-12` also opened correctly with the explicit empty-image state.
7. `关闭悬浮球` returned the page to `悬浮球未开启`; `dumpsys activity services` no longer listed `QaOverlayService`.

Representative screenshots:

- [Default list](android-visual-current-2026-08-27.png)
- [Three filters and empty result](android-visual-filtered-2026-08-27.png)
- [Capture settings](android-visual-capture-settings-2026-08-27.png)
- [Active full-screen capture](android-visual-after-share-2026-08-27.png)
- [Captured draft](android-visual-captured-draft-2026-08-27.png)
- [Drawing enabled only in editor](android-visual-editor-drawn-2026-08-27.png)
- [Default fixer and verifier](android-visual-new-bug-fields-2026-08-27.png)
- [Real Bug image in detail](android-visual-bug-detail-image-2026-08-27.png)
- [Stopped capture service](android-visual-stopped-2026-08-27.png)

## Current artifact

```text
path     apps/android/app/build/outputs/apk/debug/app-debug.apk
bytes    34,706,930
sha256   5DFF218ACF2D8101130DB351856E295E450E2DA2EF558CD3CEE51E38E8C748F7
package  com.relayqahub.android.debug
version  0.1.0-debug
```

The installed MuMu `base.apk` produced the same SHA-256. This is an internal debug artifact with a controlled LAN credential; it must not be published externally. Android 15+ physical-device/OEM power behavior and API 37 permission behavior remain release-matrix work, not blockers for this controlled LAN lane. Unity and Jenkins were not invoked.
