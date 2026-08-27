# Product mainline sign-off — 2026-08-26

This sign-off covers the user-approved browser Web, the SQLite-backed QA Hub API,
the three-page Android field App, and the already configured optional Relay M2M
boundary. Electron/EXE and Unity/Jenkins builds were deliberately not part of
this run.

## Runtime

- Browser Web: `http://127.0.0.1:4174/` (production `apps/web/dist`, API proxy enabled).
- API: `http://127.0.0.1:4319/api/v1/`; `/health/ready` returned `ready`, database
  schema `5`, with database/evidence/worker checks all `ok`.
- The v4-to-v5 migration canary used an online backup and an isolated API start.
  It returned schema `5`, `migrationBackupCreated=true`, and preserved all five
  Bugs that existed before the mainline smoke.
- Relay `http://127.0.0.1:4317/api/health` returned `ok=true`, version `0.3.2`,
  scheduler `activeTurns=0`, Ops `activeSessions=0`, checkpoint maintenance not
  running, and its task gate idle before QA Hub was restarted with the M2M
  configuration.

## Browser human-workflow smoke

The in-app browser logged in with `luodongle`, verified the sole Workbench
navigation, the four synchronized status cards, and the person scope selector.
It then created and closed this real SQLite-backed Bug:

- Bug: `LOCAL-6` / `3e8d8a73-7139-4e4f-8137-946de1d8783f`.
- Reporter/verifier: 罗东乐; fixer: 林步云.
- One PNG attachment was uploaded and rendered in the detail drawer.
- Flow: reported -> ready -> in progress -> ready for verification -> reporter
  return -> ready -> in progress -> ready for verification -> reporter close.
- Final state: `closed`, version `10`, `closedAt=2026-08-26T11:59:26.125Z`,
  with 14 audit/timeline events.
- The return reason was captured through the product's inline field; no native
  prompt or hidden test-only control was used.

## Android/Web same-source smoke

The repository APK was installed over the existing App without clearing App
data on MuMu `127.0.0.1:16384` (Android 15 / API 35). The App logged in with
`luodongle`, exposed exactly `我提交的 Bug`, `项目全部 Bug`, and `新建 Bug`,
loaded a real overlay capture, accepted two visible red strokes, and selected
吴鹏生 as fixer and 罗东乐 as verifier.

- Bug: `LOCAL-7` / `4e501616-6751-476c-b400-a3af354d540d`.
- Title: `Android_mainline_smoke_20260826`.
- Reporter: 罗东乐 (`10000000-0000-4000-8000-000000000003`).
- Fixer: 吴鹏生 (`20000000-0000-4000-8000-000000000001`).
- Verifier: 罗东乐; initial state `reported`, version `1`.
- Original PNG: 3,575,796 bytes,
  SHA-256 `cff3b625340ea653065a7c69b00974914477f5d6d1537413edc07224fea768d7`.
- Annotated PNG: 3,586,136 bytes,
  SHA-256 `4f6db2461368cf9e5a7ebfcd2b084de815ca84b33a909ef008aa06392cc3c61b`.
- Both attachments are `claimed` by the same Bug and carry capture ID
  `bc3bc34c-c34c-48a7-bbfa-06e066a26ca1`.
- The Web Workbench refreshed from six to seven Bugs, opened `LOCAL-7`, rendered
  both images, showed the same fixer/verifier, and displayed
  `Unity / Poco 上下文 · partial`.

The capture bundle was read back from the API with `enrichmentStatus=partial`,
Poco port `5001`, SDK `6`, four stored artifacts, and a successful
`qa.snapshot`. The snapshot echoed the same capture ID and returned scene
`Hall`, game version `2.1.65`, Unity `2022.3.62f3`, plus the accepted warnings
`business_provider_unavailable` and `business_fields_unavailable`. This proves
that partial Poco enrichment did not block the ordinary screenshot Bug.

Visual evidence:

- [Android annotated draft](android-mainline-2026-08-26-annotated.png)
- [Android final My Bugs list](android-mainline-2026-08-26-final-my-list.png)
- [Android project list](android-mainline-2026-08-26-project-list.png)

## APK and verification

- APK: `apps/android/app/build/outputs/apk/debug/app-debug.apk`.
- Final size: `33,883,530` bytes.
- Final SHA-256:
  `14CFD65B6944C7E1DEE7758BBAC01F213A90D1A5F4EABB63BD5FE725F29860E4`.
- The installed device `base.apk` produced the same SHA-256.
- Android core suites: 31/31; full JVM suite: 42/42; androidTest Kotlin
  compilation and final debug assembly passed.
- Storage migration/invariant tests: 74/74; API tests: 6/6; domain tests: 64/64.
- Web TypeScript, ESLint, Vitest (2/2), and Vite production build passed.

The App briefly raced its first list read against the WorkManager commit during
the smoke. A narrow receipt-driven list refresh was added, rebuilt, and verified
on the final installed APK: `LOCAL-7` appeared with no `NETWORK_IO` after the
normal page refresh, without resubmitting the Bug.

## Relay boundary

No new Relay task was dispatched. Read-only database evidence confirms the
configured principal `10000000-0000-4000-8000-000000000008` is active as
`Configured Relay executor` (`relay`). The latest `relay-main` receipt remains:

- status `fix_delivered`, external revision `53265`;
- build requirement `required`, build evidence `pending`;
- `requiresHumanVerification=1`;
- automation authority `delivery_build_projection_only`.

Therefore Relay can write delivery/build facts, but cannot verify or close a QA
Bug. The latest real receipt remains pending build evidence and did not close its
Bug.

## Remaining release tails

- This debug APK embeds the current internal QA credential and is for the
  controlled QA network/device only; do not distribute it externally.
- Offline operations currently stop retrying after four durable attempts.
- Poco enrichment is online best-effort. Its failure never blocks the ordinary
  durable Bug and attachments.
- A real-device/API 37, SELinux Enforcing, OEM power-management, signing, and
  installer matrix remains a release-hardening tail, not a blocker for this
  requested MuMu/internal mainline.

