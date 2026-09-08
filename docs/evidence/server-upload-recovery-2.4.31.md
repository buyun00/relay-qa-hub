# Server upload recovery: 2.4.31

Task `aeba3bc8-dbb6-4c79-bd4a-3582aeda6c06` (platform version ID **833**) was
recovered through the authenticated server API and independently verified as
**PUBLISHED / SUCCEEDED / remote status 100** on 2026-09-08. The final worker exited
with code 0. The platform reports `publish_time = 2026-09-08 08:25:59`; this is the
platform's literal timestamp, without an inferred timezone conversion.

## Findings and corrections

- The original upload stopped at 50/143 parts, with part 26 exhausting retries.
  Its old log discarded the underlying SDK error, so that particular request's
  transport cause cannot be recovered retrospectively.
- Worker 0.4.1 added safe diagnostics. During the authorized recovery, parts
  69, 111, 122 and 131 failed after **30032, 30024, 30011 and 30017 ms**, respectively,
  with `CosClientException(10002) -> IOException -> SocketException(ConnectionAborted)`.
  The SDK maps its connection timeout to the whole synchronous `HttpWebRequest`.
  An actual SDK loopback reproduction timed out at 255 ms with a 200 ms setting;
  the same delayed response succeeded at 1073 ms with a 2000 ms setting.
  Worker 0.4.2 uses a 180-second request deadline and keeps the 90-second read/write
  timeout and eight-part concurrency.
- The first recovery uploaded all 143 parts, then failed during completion. The
  completion request previously preserved acknowledgment insertion order, which
  is not numeric part order after parallel uploads. Completion now sorts by part
  number. The old failure did not record the COS service code; it is not claimed
  that `InvalidPartOrder` was returned in that missing diagnostic.
- `HeadObject` returned HTTP 403 while `ListParts` succeeded. The old uncertain-merge
  recovery always stopped when HEAD could not prove completion. Recovery now also
  permits the **same still-active upload ID**, only after verifying all expected
  remote part sizes and MD5s against the original file. Missing/mismatched parts,
  mismatched existing objects, or inability to establish either state still stop it.
- API startup encountered a separate full E: archive volume (about 3 MB free).
  Its archive error caused the API to close after briefly becoming ready. Archive
  failures now log an explicit error, retain the completed local recovery point,
  and leave the API and scheduled backup cadence running. No backup or VM files
  were deleted during this work. At final verification E: had 16,253,370,368 bytes
  free and a real archive of **871 attachment entries** had succeeded.

## Live recovery proof

- Original file: **745,669,560 bytes**, SHA-256
  `872acf1c05356355d4ef74573094166f4ebab161a7a3a5264cc9fd5f06f42122`.
- Final run: `4a6ef8b8-7395-4c21-afed-fad06017f880`, worker **0.4.2**.
- Final resume reconciled **143/143 parts** and uploaded **zero additional parts**.
- COS merge, object registration, package binding, platform test-status workflow,
  release preparation and requested publication all completed on the original task.
  Tester remains **11562**. This recorded workflow does not execute game tests.
- Official version-detail GET and the QA Hub per-owner API both confirmed success.
  The formal directory was
  `release/dir/2609081VN3FMVHOxGBkycvER6ZCVJrZaXUwyC/`.
- API readiness passed after publication. The daily client was not stopped or
  modified for this recovery. Concurrent UI release work was left to its own task.

## Verification and implementation

- Worker self-tests: **36/36**, including safe diagnostic redaction and actual
  completion XML ordering after out-of-order acknowledgments.
- API main suite: **96/96** after the archive-startup regression was added.
- Host/build coordinator: **29/29**; queue/real server supervisor: **16/16** with
  the final worker pin. API compilation, formatting and relevant lint passed.
- Worker 0.4.2 SHA-256:
  `04d6d264c4ee814f5f271e743d4c314f19d204cdf78c96e5cda34d94bd530f88`.
- Changes: `a132da8` (safe COS diagnostics), `ecd54df` (archive failure isolation),
  `cae9832` (request timeout, part ordering and verified completion recovery).
- Detailed local receipts, preserved pre-recovery records and SDK fixture code:
  `work/upload-recovery/`. Final read-back is `recovered-2.4.31.json`.
