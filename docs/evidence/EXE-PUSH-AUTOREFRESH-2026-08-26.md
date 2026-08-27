# Windows EXE background, push, and automatic refresh sign-off

> Historical package sign-off. The package at the same delivery paths was
> superseded by the Bug-detail/large-attachment fix on 2026-08-27. Current
> hashes and real `LOCAL-11` evidence are in
> [`EXE-DETAIL-FIX-2026-08-27.md`](EXE-DETAIL-FIX-2026-08-27.md).

Verified on 2026-08-26 (Asia/Shanghai) against the live QA Hub API and the
current production Web bundle. Unity and Jenkins were not invoked.

## Deliverables

```text
apps/desktop/release/RelayQaHub-win32-x64/RelayQaHub.exe
  bytes:   235534336
  SHA-256: 6C32A6030B40BFAE90AF301AC916A4ED688F6158124E583086EC9060B0C2BE51

apps/desktop/release/RelayQaHub-win32-x64.zip
  bytes:   155002495
  SHA-256: 5A3D2FAFE51CAF626B207A7875652EA4B2D149A8158591AA8E0D85C773BD3765
```

The ZIP contains the complete portable Electron directory (75 files). The EXE
depends on the adjacent `resources`, DLL, and locale files; it must not be copied
alone. This slice intentionally does not claim an installer, code signature, or
single-file binary.

## Runtime configuration

`scripts/Configure-QAHubDesktopRuntime.ps1` read the current QA Hub runtime
credential without printing it and produced:

```text
%LOCALAPPDATA%\Relay QA Hub\desktop-runtime.json
%LOCALAPPDATA%\Relay QA Hub\desktop-access.token
%LOCALAPPDATA%\Relay QA Hub\notification-history.json
```

The runtime JSON contains the loopback API/WSS URLs and only a path to the token
file. The token is not embedded in `app.asar`; the directory and files grant
access only to the current Windows identity, SYSTEM, and local Administrators.
Run the configuration script again after a QA Hub credential rotation.

## Implemented notification and refresh path

1. A new Bug and its `occurrence.appended` Event now write one
   `qa-hub.notifications` Outbox fact in the same SQLite transaction.
2. Inbox consumption fans that fact out once to every active project member and
   labels it `新 Bug 已提交`; an idempotent Bug-create replay does not add another
   Outbox or notification.
3. Electron authenticates its WSS in the main process, treats the hint only as a
   wake-up, rereads durable Inbox, deduplicates by notification ID, submits a
   native Windows Notification, and sends a narrow `desktop:bug-changed` IPC.
4. The Web renderer immediately rereads the workbench on that IPC, including
   while the window is hidden. Ordinary visible browser pages use a five-second
   fallback poll plus focus/visibility refresh. A request sequence prevents a
   slower old list response from replacing a newer one.
5. Delivered notification IDs are persisted in a bounded 512-ID history, so an
   unread Inbox item is not shown again after an EXE restart.

## Real packaged smoke

Preconditions and build checks:

- Relay gate before the QA API reload: `runningTurns=0`, `queuedTurns=0`,
  `busyWorkers=0`, `pendingBuildDispatches=0`; historical Ops turns were all
  terminal.
- API readiness: HTTP 200 on `127.0.0.1:4319` after restart, PID `11468`.
- Production Web: HTTP 200 on `127.0.0.1:4174`, serving bundle
  `index-95na_eq_.js`.
- Desktop tests: 14/14; Web Vitest: 2/2; desktop/Web/storage TypeScript: pass;
  focused SQLite notification transaction: 1/1; Web, desktop, storage, and API
  production builds: pass.

Background lifecycle:

- The packaged window was visible with handle `16583004`.
- A real Windows `WM_CLOSE` changed its main-window handle to `0` while main PID
  `11796`, four package processes, the renderer, and API connections remained.
- The hidden renderer reported `visibilityState=hidden` and desktop notification
  status `connected` with `reconnectAttempt=0` and no error.

New-Bug push and automatic refresh:

```text
Bug:          LOCAL-12
Bug ID:       7e2c9c7f-2f87-4a7f-b1c4-ad0a4b2af243
Event ID:     026ae863-0275-4200-ac9e-7f8aef2b6a7e
Notification: 2986f845-d1dc-4ad8-914f-c2208ea0f08f
Title:        新 Bug 已提交
Marker:       EXE_AUTO_PUSH_20260826_144529_030
```

- The hidden renderer's row count changed from 4 to 5 and contained the unique
  marker in 499 ms without clicking refresh. Since the browser fallback skips
  hidden documents, this specifically proves the WSS/Inbox/IPC refresh path.
- `notification-history.json` contained the exact notification ID only after the
  native notification submission path ran.
- Windows event log
  `Microsoft-Windows-PushNotification-Platform/Operational` recorded at
  `2026-08-26 22:45:29`: event 3153, "Toast with notification tracking id 517
  is delivered to com.relayqahub.desktop on session 1", alongside events 3052,
  2418, and 2416 for the same local toast submission.

Restart and routing:

- After restarting the packaged App as PID `5480`, it reconnected WSS with no
  error and produced zero `com.relayqahub.desktop` toast-delivery events for the
  historical unread Inbox, proving persistent replay suppression.
- A second-instance `qa-hub://bug/7e2c9c7f-2f87-4a7f-b1c4-ad0a4b2af243`
  route restored the window, changed the list to the team/all scope, and opened
  the centered detail modal for the same Bug.
- The deep-link verification instance was PID `5480`, window visible, pinyin
  identity signed in, WSS connected, and the `LOCAL-12` detail open.
- The remote-debug verification instance was then stopped. Final handoff runs a
  fresh production instance as PID `15688` with a visible `Relay QA Hub` window,
  four package processes, three established API connections, API/LAN Web both
  HTTP 200, no listener on test port 9333, and zero historical toast replay.
  The final window is intentionally left at the minimal pinyin entry when its
  browser-session cookie is new.

## Run

```powershell
.\scripts\restart-mvp-api.ps1
.\scripts\Configure-QAHubDesktopRuntime.ps1
.\apps\desktop\release\RelayQaHub-win32-x64\RelayQaHub.exe
```

Use pinyin to enter the Web UI. Closing the window hides it to the tray; use the
tray menu's `退出 QA Hub` command for an actual process exit. The tray checkbox
can enable login startup, which launches with `--hidden`.
