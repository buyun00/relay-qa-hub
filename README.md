# Relay QA Hub

Relay QA Hub is an independent, mobile-first defect closed-loop product. QA Hub is the business source of truth; Relay is an optional repair executor and can never accept or close a QA bug automatically.

The authoritative implementation plan is [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md). Execution status and verification evidence live only in [`PROGRESS.md`](PROGRESS.md).

## Isolation boundary

- Source: `D:\Relay-QA-Hub`
- Persistent runtime data: `D:\Relay-QA-Hub-Data` (configurable and outside the repository)
- Relay source/runtime/data: separate and never imported, shared, or used as the QA Hub database or attachment store
- Qingyu: no runtime, data, authentication, state, or synchronization dependency

Runtime binaries and reproducible local commands are recorded in [`docs/RUNTIME_PATHS.md`](docs/RUNTIME_PATHS.md).

## Persistent team data and backups

The team Bug list is not stored in the Web bundle, EXE, APK, or source tree. The
production facts live in `D:\Relay-QA-Hub-Data\production\db\qa-hub.sqlite`,
with content-addressed screenshots and other evidence under
`D:\Relay-QA-Hub-Data\production\evidence\sha256`. The API is the only writer.
The team identity configuration is fixed separately at
`D:\Relay-QA-Hub-Config\qa-people.json`.

Every API start and every 15 minutes, the API's existing SQLite worker creates a
WAL-safe online recovery point under `D:\Relay-QA-Hub-Backups\production`. It
then publishes the exact manifest-bound database and all referenced ready/clean
attachments to `E:\Relay-QA-Hub-Archives\production`. D: and E: are separate
physical disks on the current server. Do not copy a live `qa-hub.sqlite` by
itself: the production database uses WAL, so a filesystem copy can omit newer
transactions or produce a mismatched database/WAL set.

Validate the newest E: recovery point without changing it:

```powershell
$qaHubNode = 'C:\Users\lin0\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $qaHubNode .\scripts\Verify-QAHubRecoveryPoint.mjs `
  --archive-root 'E:\Relay-QA-Hub-Archives\production'
```

For a restore drill, always choose a brand-new destination and verify it before
changing `QA_HUB_DATA_ROOT`:

```powershell
& $qaHubNode .\scripts\Verify-QAHubRecoveryPoint.mjs `
  --archive-root 'E:\Relay-QA-Hub-Archives\production' `
  --restore-root 'D:\Relay-QA-Hub-Data\restore-drill-YYYYMMDD-HHMMSS'
```

The runtime scripts now reuse the current persistent data root by default. Only
an explicit `mvp-e2e-runtime.ps1 -Action PrepareStart -FreshData` may create an
empty test data root. Backup and cutover evidence is recorded in
[`docs/evidence/PERSISTENT-BACKUP-2026-08-27.md`](docs/evidence/PERSISTENT-BACKUP-2026-08-27.md).

## Current browser mainline

The signed LAN product mainline is running at:

- Web: `http://10.100.5.157:4174/`
- API readiness: `http://10.100.5.157:4319/api/v1/health/ready`
- Same-PC fallback: `http://127.0.0.1:4174/`

The browser login accepts only a team member's lowercase pinyin, for example
`luodongle`; there is no password form. The sole people source is
[`apps/android/config/qa-people.json`](apps/android/config/qa-people.json), or
the server-side `QA_HUB_PEOPLE_CONFIG_FILE` override with the same schema.

After building `packages/storage`, `apps/api`, and `apps/web`, the current local
runtime can be safely restarted from an ordinary PowerShell prompt with:

```powershell
.\scripts\Enable-QAHubLanAccess.ps1
.\scripts\restart-mvp-api.ps1
.\scripts\restart-mvp-web.ps1
```

The Web restart serves the production `apps/web/dist` bundle and verifies its
same-origin API proxy. Both processes listen on all local interfaces, while the
QA-specific firewall rules allow the detected local subnet to reach only TCP
4174 and 4319. The API restart reuses the runtime pointer under
`D:\Relay-QA-Hub-Data`, and enables the optional Relay M2M adapter only when both
configured secret files exist. It never makes Relay the Bug source of truth.

The current Web uses one Bug content field, a large centered management dialog,
and an in-page evidence viewer. The task list intentionally uses larger type;
images no longer navigate away from the workbench. Visible browser pages sync
the list every five seconds and immediately after regaining focus; the Electron
shell refreshes immediately from its authenticated notification channel.

`总览` is a separate shared-table view beside `工作台`. It reads up to 500 Bugs
for the current project and supports text, lifecycle, severity and owner
filters, including a one-click `未分配` view. Every row can be claimed by the
current fixer or assigned/unassigned directly. New Bugs start with no fixer in
both Web/EXE and Android; the verifier still defaults to the signed-in person.

For captures carrying Poco enrichment, the detail downloads both
`poco_snapshot` and `poco_hierarchy`. It identifies visible `UIForm`/page
instances, shows a bounded child hierarchy with runtime text, image/texture
identifiers, component and instance-id facts, and renders the game's optional
bounded recent Error/Exception/Assert
window separately. Missing game-side log fields are shown as not integrated,
not as an empty error window. Current evidence and the additive Unity provider
contract are in
[`docs/evidence/POCO-DEBUG-CONTEXT-2026-08-27.md`](docs/evidence/POCO-DEBUG-CONTEXT-2026-08-27.md).

## Windows desktop App

The current management Web is also packaged as a close-to-tray Windows App:

```text
apps/desktop/release/RelayQaHub-win32-x64/RelayQaHub.exe
apps/desktop/release/RelayQaHub-win32-x64.zip
```

The EXE is a portable Electron application, so keep the complete extracted
`RelayQaHub-win32-x64` directory together; the EXE is not a standalone file.
The current ZIP carries a token-free portable profile for
`http://10.100.5.157:4319`, so another computer on the allowed LAN can extract
the directory and log in directly with pinyin. Download it from:

```text
http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64.zip
```

Current verified ZIP: `155,044,980` bytes, release
`20260827T062551963Z`, SHA-256
`3746D0872B94091885DC5B3B851FDB6043D4204524FDD1712D0F609BC48BB0CE`.
It includes the cross-Windows browser-session continuity fix and signed
self-update. Existing clients check the same 4174 endpoint automatically,
download a newer release in the background, verify its Ed25519 manifest and
ZIP SHA-256, then show `安装并重启` in the page and tray.

If the server address changes or an older per-user config overrides the
portable default, run the script shipped beside the EXE:

```powershell
.\Configure-QAHubPortableClient.ps1 -ServerAddress 10.100.5.157
```

On the QA Hub server computer only, the following optional command provisions
the separate local notification credential:

```powershell
.\scripts\Configure-QAHubDesktopRuntime.ps1
```

This writes `%LOCALAPPDATA%\Relay QA Hub\desktop-runtime.json` and a separate,
ACL-protected `desktop-access.token`. The Web login still only asks for pinyin.
Fresh remote clients do not receive this bearer. Management and native
background toast now use the remembered browser session, so a successful
pinyin login enables both list refresh and the Windows notification stream.
The successful pinyin is remembered locally and restored on later launches.
Closing the window hides it to the tray and keeps the authenticated WSS/Inbox
notification transport running. Use the tray's `退出 QA Hub` command to stop it.
The first normal launch enables `登录时启动`; users can turn it off again from
the tray and later releases do not overwrite that explicit choice.

To publish a new signed Windows release on the QA Hub server computer:

```powershell
$env:QA_HUB_DESKTOP_NODE_EXE = "C:\path\to\node.exe"
.\scripts\Publish-QAHubWindows.ps1 -LanAddress 10.100.5.157
```

The publisher uses the non-repository Ed25519 private key at
`%LOCALAPPDATA%\Relay QA Hub Publisher\update-signing-private.pem`. Back up that
file securely and never ship it with the EXE. The public key is embedded in the
client. This protects update provenance and bytes; it is not a substitute for
an Authenticode certificate.
The real `LOCAL-11` detail/image readback is in
[`docs/evidence/EXE-DETAIL-FIX-2026-08-27.md`](docs/evidence/EXE-DETAIL-FIX-2026-08-27.md).
The current artifact hashes, cross-PC endpoint fix, and fresh-profile smoke are in
[`docs/evidence/EXE-LAN-PORTABLE-FIX-2026-08-27.md`](docs/evidence/EXE-LAN-PORTABLE-FIX-2026-08-27.md).
The earlier background/toast/automatic-refresh smoke remains recorded in
[`docs/evidence/EXE-PUSH-AUTOREFRESH-2026-08-26.md`](docs/evidence/EXE-PUSH-AUTOREFRESH-2026-08-26.md).
The current four-category, Poco, session-toast, startup/login-memory and signed
self-update evidence is in
[`docs/evidence/EXE-SELF-UPDATE-2026-08-27.md`](docs/evidence/EXE-SELF-UPDATE-2026-08-27.md).

## Android field App

The Android App now opens on a Web-styled `Bug 列表` and has exactly three bottom
destinations: a dedicated `悬浮球` settings/usage page, a raised center `+ 新建`,
and `Bug 列表`. The list opens read-only details and filters the loaded page by
reporter, owner and grouped state. The create flow has one content field,
defaults the verifier to the signed-in person and leaves the fixer unassigned,
and opens drawing only after the screenshot is tapped. The
current controlled-device artifact is:

```text
apps/android/app/build/outputs/apk/debug/app-debug.apk
version 0.1.4-debug (code 5), Android 12/API31+
SHA-256 81C5EB63CE9D8798C695757FA8634966590E35F8500D88668A500D97E4C55647
```

Phones on the controlled QA LAN can download the same verified bytes from
`http://10.100.5.157:4174/downloads/Relay-QA-Hub-Android12-debug.apk`. The route
uses the Android APK MIME type and disables caching so an OEM downloader does
not reuse the previous Android-15-only package. Android 12 compatibility
evidence is recorded in
[`docs/evidence/ANDROID12-INSTALL-COMPAT-2026-08-27.md`](docs/evidence/ANDROID12-INSTALL-COMPAT-2026-08-27.md).
The fixed credential packaging, split overlay/screen-capture permission flow,
direct-LAN `LOCAL-14` creation, and 2560x1440 landscape capture evidence are in
[`docs/evidence/ANDROID-REMOTE-PHONE-CAPTURE-FIX-2026-08-27.md`](docs/evidence/ANDROID-REMOTE-PHONE-CAPTURE-FIX-2026-08-27.md).
The Android 12 `credential vault unavailable` repair removes Android Keystore and
all per-submit credential writes; `LOCAL-17` and the final download hash are in
[`docs/evidence/ANDROID-LAN-NO-KEYSTORE-2026-08-27.md`](docs/evidence/ANDROID-LAN-NO-KEYSTORE-2026-08-27.md).
The shared overview, unassigned-owner API and default-empty Android/Web create
flow are recorded in
[`docs/evidence/BUG-OVERVIEW-UNASSIGNED-2026-08-27.md`](docs/evidence/BUG-OVERVIEW-UNASSIGNED-2026-08-27.md).

It connects directly to the PC's configurable LAN API address. No `adb reverse`
is required. Poco remains a separate phone-local connection to
`127.0.0.1:5001`, so a physical phone talks to the game on that phone and to QA
Hub on the PC at the same time. The checked-in API seed is
[`apps/android/config/qa-runtime.json`](apps/android/config/qa-runtime.json);
the installed App prefers `Android/media/<applicationId>/qa-hub/config/qa-runtime.json`.
This debug APK contains the controlled-LAN backend connection configuration and
does not use a device key vault, PIN/biometric gate, password, or per-user token
setup. It must not be distributed outside the controlled QA environment. Build, configuration, and
install details are in [`docs/ANDROID_SETUP.md`](docs/ANDROID_SETUP.md).

The real Web + Android + API + Relay-boundary sign-off, including `LOCAL-6` and
`LOCAL-7`, is recorded in
[`docs/evidence/PRODUCT-MAINLINE-2026-08-26.md`](docs/evidence/PRODUCT-MAINLINE-2026-08-26.md).
The direct-LAN phone/Web extension and `LOCAL-9` evidence are recorded in
[`docs/evidence/LAN-PORTABLE-2026-08-26.md`](docs/evidence/LAN-PORTABLE-2026-08-26.md).
The focused Web/Android UX pass and real `LOCAL-10` evidence are recorded in
[`docs/evidence/UX-FOCUS-2026-08-26.md`](docs/evidence/UX-FOCUS-2026-08-26.md).
The current three-page Android visual pass, system capture, filters, annotation,
assignment defaults and real image-detail smoke are recorded in
[`docs/evidence/ANDROID-THREE-PAGE-VISUAL-2026-08-27.md`](docs/evidence/ANDROID-THREE-PAGE-VISUAL-2026-08-27.md).
The packaged desktop push/refresh pass and real `LOCAL-12` evidence are recorded
in
[`docs/evidence/EXE-PUSH-AUTOREFRESH-2026-08-26.md`](docs/evidence/EXE-PUSH-AUTOREFRESH-2026-08-26.md).
The corrected EXE proxy and exact `LOCAL-11` 4,471,962-byte image readback are
recorded in
[`docs/evidence/EXE-DETAIL-FIX-2026-08-27.md`](docs/evidence/EXE-DETAIL-FIX-2026-08-27.md).
