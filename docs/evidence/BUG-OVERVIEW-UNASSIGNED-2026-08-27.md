# Shared Bug overview and unassigned ownership evidence — 2026-08-27

## Delivered behavior

- `总览` is an independent Web/EXE destination beside `工作台`; it does not
  replace the four lifecycle shortcuts.
- The dense shared table shows Bug key, problem content, priority/severity,
  reporter, fixer, status, created time and updated time.
- Search, grouped lifecycle, severity, sorting and owner filters are available.
  `未分配` is a dedicated shortcut and every visible row has a direct owner
  selector; eligible current users also get `认领` on unassigned rows.
- `GET /api/v1/bugs` accepts `ownerState=assigned|unassigned`, rejects combining
  it with `ownerId`, and accepts an explicit overview window up to 500 rows.
- Web/EXE and Android create flows now default the fixer to empty. The verifier
  continues to default to the signed-in person.

## Automated verification

- Web Vitest: `8/8`; TypeScript and Vite production build passed.
- API node:test: `9/9`; the query parser covers unassigned ownership, the
  ownerId/ownerState conflict and the 500-row upper bound.
- Contract 1.1.0 validation and additive compatibility passed; the reviewed
  strict baseline was regenerated and then matched.
- Desktop node:test: `27/27`; TypeScript, package and updater signing passed.
- Android `testDebugUnitTest`: `57/57`; `assembleDebug` passed. A contract test
  proves that `ownerId` is omitted while `verificationOwnerId` remains present.

## Running-service verification

- API PID `7344` ready on `4319`; Web PID `23720` ready on `4174`.
- Authenticated production API read: all `19` current Bugs partitioned exactly
  into `1` unassigned and `18` assigned; neither filtered response contained an
  item from the opposite partition.
- In-app browser: the overview loaded all `19` rows, exposed all eight table
  columns and all filters, then `未分配 1` reduced the result to one row with one
  `认领` action and no error.
- In-app browser new-Bug form: fixer was `暂不指定`; verifier was the signed-in
  user.

## Released artifacts

Windows portable release:

- Release ID: `20260827T062551963Z`
- ZIP size: `155,044,980` bytes
- ZIP SHA-256: `3746D0872B94091885DC5B3B851FDB6043D4204524FDD1712D0F609BC48BB0CE`
- The live 4174 update manifest reported the same release, size and SHA-256 and
  carried its Ed25519 signature.
- Fresh-profile packaged smoke loaded `19` overview rows and `19` owner
  selectors, with the unassigned filter present; workbench, Poco detail, image,
  remembered pinyin and notification connection checks also passed.

Android controlled-LAN release:

- Version: `0.1.4-debug` (`versionCode 5`, Android 12/API31+)
- APK size: `33,931,144` bytes
- APK SHA-256: `81C5EB63CE9D8798C695757FA8634966590E35F8500D88668A500D97E4C55647`
- The live 4174 APK route returned the same length with
  `application/vnd.android.package-archive`.

No real Bug was reassigned or claimed during verification; the production
owner facts were read only.
