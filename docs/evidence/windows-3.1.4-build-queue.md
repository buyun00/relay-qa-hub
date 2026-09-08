# Windows 3.1.4: Separate build-lock queue time

- Date: 2026-09-08 (Asia/Shanghai)
- Release ID: `20260908T060050204Z`
- Product/API source: `189b357d5e0bf64449a13b04d77870b0def4cdb4`

Jenkins can allocate a build number while its script still waits for the shared
Android/iOS build lock. The progress parser previously started preparation at
Jenkins timestamp zero and counted that wait as preparation, causing false alarms.

Read-only inspection of build 10159 / queue 760 confirmed the report. It logged
waiting for `iOS_Build_#30` at elapsed 00:00:05.931 and acquired the lock at
00:08:38.273. The explicit wait interval was 512345 ms. Replaying the real log
with the fix yields 6884 ms preparation, separately from that wait.

The parser now recognizes actual lock wait/acquisition output, exports a bounded
blocker identity and separate queue/execution timing, and excludes queue time from
preparation and historical execution estimates. Untimed logs use observed lower
bounds and do not invent historical durations. While waiting, the page shows
正在排队 and wait duration, without execution stages or phase-timeout notifications.
After acquisition it returns to the actual stage automatically. Raw Jenkins
BUILDING status and total elapsed time remain compatible with the build/upload
coordinator and its artifact timestamp window.

## Verification

- API packaging tests 22/22, Web 49/49 and desktop 88/88 passed. The API test
  command now includes the progress regression suite. TypeScript, changed-file
  lint/format, ADR/boundary and diff checks passed.
- Regression cases cover long lock waits, acquisition, corrected preparation and
  execution history, untimed observations, cancellation, missing acquisition
  markers, echoed commands, log redaction and suppressed stale phase warnings.
  A coordinator test verifies queued BUILDING tasks retain their automatic upload
  and start it only after successful completion.
- Browser fixtures verified a ten-minute wait displays the blocker/time without
  preparation or alarms, transitions back to preparation after acquisition, and
  fits wide/compact layouts. Screenshots were inspected.
- The official API restart script deployed the compiled change and recovered
  readiness with the matching product SHA. Authenticated read-back of the live
  progress API returned the exact 512345 ms wait and 6884 ms preparation.
- Full isolated packaged smoke passed. Native client checks also read the real
  build 10159, rendered its separate queue timer and verified no preparation alarm.
  Existing upload defaults, native IPC, history, final confirmation guards,
  supervisor dispatch and bundled worker hash checks passed unchanged.
- Live Ed25519 signatures, streamed installer/portable sizes and hashes matched;
  ASAR/source/Web resources matched. API readiness remained schema 12. Installer
  Authenticode is NotSigned, separate from the verified update manifest signature.
- An isolated actual 3.1.3 client upgraded to 3.1.4 and restarted, retaining its
  profile/runtime config, uploader account/checkpoint, build-chain records and
  rollback. Daily client processes/startup entries were preserved and test ports
  released.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Installer | 182621279 | `8badc9732a0b678dbc88ac45471a8b3e3abfccefe117651c4884d2089441f1cb` |
| Portable ZIP | 188632128 | `a396c31d367a95abeeceaf8bfd9be13d49b09ef943655c2a8171652a3be1aa80` |

Previous 3.1.3 artifacts and product source remain at
`apps/desktop/release/builds/prepublish-20260908T053707852Z-20260908T055627349Z`.
Receipts/scripts are in `work/windows-3.1.4-release`; diagnosis/browser evidence is
in `work/queue-display`. No Jenkins build was submitted, cancelled or restarted,
and no business upload/publication was performed by these checks.
