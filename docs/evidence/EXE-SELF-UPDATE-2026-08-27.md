# Windows EXE lifecycle and signed self-update evidence — 2026-08-27

## Follow-up repair: install-and-restart exited without installing

The reported client behavior was reproducible from the updater's failure boundaries: the helper assumed that the user's current portable-directory leaf matched the fixed top-level directory inside the signed ZIP. Any renamed/extracted location failed package discovery. The detached helper then swallowed the failure after the Electron process had exited, so reopening the client necessarily returned to the old release.

The repaired updater now:

- discovers exactly one bounded ZIP payload by the expected EXE instead of the user's directory name;
- waits for all processes whose executable is inside the current package and retries the same-volume swap while transient locks drain;
- preserves `desktop-runtime.json`, retains one timestamped rollback directory, and relaunches the new EXE;
- records a bounded atomic `last-update-result.json`; on failure it restores and relaunches the old EXE with a visible retry notice instead of silently disappearing;
- returns the renderer IPC result before scheduling application exit.

Final repaired release:

- Release ID: `20260827T070337800Z`
- ZIP size: `155,047,124` bytes
- ZIP SHA-256: `F23447902880B7434713DB1CAA27F1AE3CD7ECA88D101EC0ABABB1ACD9AAAF80`
- Live manifest and download: `http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64-latest.json` and `http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64.zip`

The permanent Windows regression packaged an old release as a user-renamed `QA Hub Renamed By User` directory, downloaded the live signed release, installed it, retained the rollback directory, preserved the runtime-config hash, and relaunched the new EXE. Extracting `release.json` from the installed `app.asar` returned exactly `20260827T070337800Z`. The final standalone package smoke then passed pinyin login, six Bug rows, detail image `1/1`, Poco region, four lifecycle shortcuts, connected notifications, and the 20-row shared overview. Desktop tests passed `29/29`; Web tests passed `8/8`.

Clients already carrying the earlier broken helper cannot receive this helper fix until they replace that package once. They should download and extract the repaired ZIP over a stable local folder; subsequent application updates use the repaired flow.

## Delivered behavior

- The four workbench shortcuts are exactly `待处理`, `处理中`, `待验收`, and `已完成`; `全部 Bug` is no longer a shortcut.
- Bug detail always keeps an expanded `Poco 详情（截图时游戏上下文）` region. A missing or failed capture shows an explicit unavailable/empty explanation instead of deleting the region.
- A token-free LAN client upgrades its notification transport from `disabled` to `connected` immediately after a successful pinyin browser session. The same session authenticates WSS hints and durable Inbox replay, so native Windows toast and list refresh share one actor identity without shipping a bearer.
- Successful pinyin is remembered in the desktop renderer and used to restore the browser session after restart. Logout clears it.
- The first normal launch enables Windows login startup once; the tray checkbox remains authoritative afterward.
- Packaged clients check a same-origin update manifest, verify its embedded Ed25519 public-key signature, download with bounded size/progress, verify exact size and SHA-256, and offer `安装并重启`. The independent Windows helper preserves `desktop-runtime.json`, swaps the portable directory, retains the old directory as a rollback backup, and relaunches the new EXE.

## Final artifact

- Release ID: `20260827T051223786Z`
- ZIP: `apps/desktop/release/RelayQaHub-win32-x64.zip`
- Size: `155,038,303` bytes
- SHA-256: `1785ED51C13815C2A038E664D06F62EA514084A64E01713BA1D57C6EDAC1A02F`
- Manifest: `apps/desktop/release/RelayQaHub-win32-x64-latest.json`
- Download: `http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64.zip`
- Update manifest: `http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64-latest.json`
- Manifest signature verified with the exact public key embedded in the final desktop build; local ZIP hash and manifest hash matched byte-for-byte.

The publisher private key is outside the repository at
`%LOCALAPPDATA%\Relay QA Hub Publisher\update-signing-private.pem`. Its contents were never written to source, logs, or the artifact. Authenticode is still not configured; the release does not claim Windows publisher signing.

## Verification

- TypeScript: Web, API, and Desktop passed.
- ESLint/Prettier: the changed TypeScript/TSX/MJS/CSS surface passed.
- Web Vitest: `7/7`.
- API node:test: `8/8`.
- Desktop node:test: `27/27`, including valid Ed25519 manifest acceptance and modified archive-hash rejection.
- Final packaged fresh-profile smoke against the real LAN services:
  - pinyin login succeeded and remembered `linbuyun`;
  - list loaded `6` real Bug rows;
  - shortcut labels were exactly the four requested lifecycle categories;
  - first Bug detail and its one evidence image loaded;
  - Poco region was visible;
  - notification state changed from `disabled` before login to `connected` after login.
- Real self-update E2E:
  - old release `20260827T051149740Z` discovered final release `20260827T051223786Z` from the live 4174 manifest;
  - it downloaded the full `155,038,303`-byte ZIP and reached `ready` only after signature/size/hash checks;
  - the independent helper logged both `update helper started` and `update installed`;
  - the portable directory was swapped and the app relaunched with `--updated`;
  - extracting `release.json` from the installed `app.asar` returned `20260827T051223786Z`.
- Runtime after rollout: API PID `24716` ready on `4319`; Web PID `19588` ready on `4174`; unauthenticated Web proxy remained `401`.
- HKCU startup entry `com.relayqahub.desktop` points to the final packaged EXE with `--hidden`.

All three named update E2E temp roots and their four remaining test processes were removed after verification.
