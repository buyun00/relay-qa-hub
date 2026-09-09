# Read-only artifact audit for the Android dropped-response run

Preparation only. The audit script has not read the active private proxy directory. It has not called the API, adb, a device, or any port, and does not stop or alter the running proxy. Default invocation returns `not_run`. The parent will provide a completion boundary before the private-file audit runs.

## One identified optional GET

The parent supplied an unauthenticated GET refusal with target SHA256 `3ad87b1ad8b878338b28824a3aa4ef321b346681ad3ac6b2ff72b7e8036f2740`. Hashing source-known paths, without reading a token, produced an exact match for:

`/api/v1/android-updates/preview/latest.json`

`AndroidUpdateClient` builds this path in `apps/android/app/src/main/kotlin/com/relayqahub/android/network/ApkDistributionClient.kt:79`; lines83–87 add Accept and Cache-Control, with no Authorization. `FoundationViewModel.kt:553` invokes `checkForSelfUpdate()` during initialization; the method starts at582. The strict proxy rejected the update check before forwarding. This is an optional preview-update request, not a create request or an unexplained scope change.

The audit recognizes only **GET + AUTH_FINGERPRINT_REFUSED + this exact target hash** as the expected optional refusal. It does not ignore other denied paths, methods or codes, nor add the update route to the running proxy's allowlist.

## Inputs and checks

`scripts/project-components/android-recovery-proxy-audit.mjs` reads only these named files from the exact private `android-recovery-proxy-<runId>` directory:

- `status.json` and `public-events.jsonl`.
- `original-request.json` and `confirm-native-action.json`.
- `upstream-create-1.body` through `upstream-create-5.body`.

It does not read the native vault, login responses, credentials, APK archives or SQLite. The first matching request and five create receipts may contain private draft content; only their size/hash and validated canonical IDs enter the public report. Arbitrary raw event fields and unknown error text are not copied.

Checks cover the running source SHA (`a164c85357260430d8ad8d8566ca7d9f98249669823dbbe8ecf3ea621430d7af`), configured run/project/actor, confirmed/no-inflight state, exact4 drops and5 forwarded creates, original raw-body/key hashes, exact confirmation marker, original frozen1.1 request/response schemas, same Bug/occurrence/event/submission IDs in all five API receipts, scope/owner/verifier/content consistency, exact per-receipt file hashes and ordered action records. The final receipt must report replay. Event request/bootstrap/refusal counts must reconcile with status. Only the precise optional update refusal above is accepted; adapter failures and unknown events fail the audit.

The script first reads a bounded snapshot, builds the report in memory, then rereads and hashes every input once. A changing or missing input aborts with a fixed diagnostic and no derived report. There is no loop or polling. Root can provide a later stable boundary if necessary. Source-path links, unexpected runtime paths, oversize inputs and existing public output directories are refused.

## Explicit invocation — not executed

The proposed run is pinned to the parent's fresh project and native actor. After the parent reports completion, use a new output directory:

```powershell
node scripts/project-components/android-recovery-proxy-audit.mjs --audit `
  'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\android-recovery-proxy-65ee5dc8-3f23-4f28-ad97-daa1de8b0ece' `
  'C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub\docs\evidence\project-components\android-recovery-proxy-audits\65ee5dc8-first' `
  'b9a42a41-c15d-4393-8568-61d22a30ba98' `
  '9229e801-0ad6-4616-85b4-d40d66b50822'
```

It creates only a new public `proof.json` beneath its dedicated evidence subtree. No original is copied, rewritten or deleted. Console output contains report status/path and fixed failed-check codes. JWT, private-key and Bearer-literal patterns are checked before writing public output. A failed artifact comparison remains failed rather than changing expected values to match it.

## Validation and limits

Seven memory-only tests exercise the actual audit function and frozen schemas: valid4+1 lineage, exact optional-GET identification, changed scope/count/source/fingerprint, changed canonical receipt semantics even after rehashing, changed intent/marker, missing/reordered/extra event records, and secret-like raw fields excluded from failed reports. Default CLI, syntax, ESLint and formatting checks passed; [preparation log](runs/android-recovery-proxy-audit-preparation.txt) records the final checks.

This audit establishes the provenance and consistency of the pinned proxy artifacts. Five receipts returning the same Bug ID do not independently prove the API contains no additional Bug, and an operator marker does not prove an APK gesture. Root's official API count/content/event readback, actual native click screenshots and local persistent queue/receipt evidence remain separate requirements. The proxy's prerequisite GETs retain only hashes and validated flags; their original response bodies are not independently reconstructed here. Physical-device recovery and unsupported image/protocol modes remain untested.
