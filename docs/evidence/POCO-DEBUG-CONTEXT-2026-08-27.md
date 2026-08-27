# Poco debug context evidence — 2026-08-27

## Outcome

The QA Hub Web detail now reads both `poco_snapshot` and the already stored
`poco_hierarchy` artifact. It presents the active UI form candidates and their
bounded child hierarchy, and it separately presents bounded recent Unity errors
when the game provider supplies them. Missing error fields and an explicitly
empty error window are not treated as the same state.

Ordinary Android MediaProjection screenshots remain the primary evidence and
are not blocked by Poco, hierarchy, provider, or log failures.

## Real MuMu probe

- Device: `127.0.0.1:16384`
- Game: `com.chuyao.baloots`
- Host forward: `tcp:15001 -> device tcp:5001`
- Standard RPC: `Dump(true)`
- Response frame: `131850` bytes
- Result JSON payload: `131783` characters

The real visible dump contained this page root:

```text
GameFramework / UI / CameraLayer / MenuLayer / Hall-3_optimized(Clone)
```

Its components included:

```text
RectTransform
HallLobbyMainView
HallView
UIForm
```

The same node had Poco instance id `-4452`. This proves that the standard Dump
already has useful current UI hierarchy and that the previous Web detail was
discarding useful stored data by downloading only `poco_snapshot`.

The user-provided snapshot capture id
`1c6222ea-2375-493d-8d86-0843e68d6194` returned `404` from the current capture
bundle endpoint at audit time. It was a direct game-side snapshot response and
had not yet been submitted/bound as a backend capture bundle, so it could not be
used as backend artifact evidence.

## Unity provider gap

The installed game response still contains only generic runtime facts and the
warnings `business_provider_unavailable` / `business_fields_unavailable`.
Standard Dump does not know the prefab asset key or the framework's logical page
stack. A normal separately installed Android APK also cannot read another app's
logcat.

The additive `schemaVersion=1` provider contract is now documented in
`docs/UNITY_POCO_SNAPSHOT_IMPLEMENTATION_GUIDE.md`:

- `data.ui.groups[].forms[]` supplies UI group, prefab asset key, logical
  visibility, sibling order/current form and `rootInstanceId`.
- `rootInstanceId` joins the business form to Poco Dump `_instanceId`.
- `data.recentErrors[]` supplies a 120-second, bounded, deduplicated and redacted
  Error/Exception/Assert window.
- Full UI trees remain in `Dump(true)`; they are not duplicated in snapshot.

Ready worker Unity sources were audited read-only. No Unity/Jenkins build was
started and no worker workspace was changed.

## QA Hub verification

```text
Web TypeScript                 PASS
Web ESLint                     PASS
Web Vitest                     PASS (2 files, 6 tests)
Web production build           PASS
Plan/progress pointer check    PASS (55 ids)
```

The focused tests cover UIForm detection, visible child filtering, business
prefab/page parsing, Dump instance-id linkage, recent-error parsing, provider
missing versus empty error window, and readable server-rendered output.

## Deployed browser readback

The production Web bundle was reloaded at `http://10.100.5.157:4174/` and
verified through a real pinyin browser session. Opening existing Bug `LOCAL-4`
showed:

```text
截图时游戏上下文: 1 组
scene: BootScene
game: 2.1.65
Unity: 2022.3.62f3
SDK/port: 6 / 5001
active page: UpgradeUI(Clone)
path: GameFramework / UI / CameraLayer / PopLayer / UpgradeUI(Clone)
visible nodes: 107
page marker: UIForm
runtime text: %0 / Loading, please wait... / App 2.1.65 + Hot 2.1.65.10076
image/texture: bg_login / img_denglu_jindu* / btn_common_hd / icon_commom_*
```

The same deployed detail explicitly showed that recent errors were not supplied
by the current game build. Per the product requirement, bounded runtime
`payload.text` values and image/texture identifiers are rendered with each node;
the complete original Dump attachment remains stored server-side when the web
render limit is reached.
