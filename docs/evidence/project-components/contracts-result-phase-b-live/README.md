# Phase B: blocked results through complete main and real storage worker

The independent full-main run `fd3648a5-61f9-4c17-8c44-fa6eb00e5341` passed **246/246 checks** on its first attempt. It recorded **115 real network requests: 98 direct HTTP requests to API4459 and 17 JSON-RPC requests to server MCP4461**. MCP's internal route injections are not counted as additional network requests; initial readiness polling is outside this numbered ledger.

The run lasted from `2026-09-09T03:21:24.344Z` to `2026-09-09T03:21:29.776Z`. The original `run-preview-service.mjs` loaded the copied complete `main.js`, which created the real worker, storage adapters, authorization context and component runtime. The original server MCP proxy forwarded actual JSON-RPC requests. Readiness reported **schema16**, with database, evidence and worker checks healthy. No test-assembled Fastify app or mocked storage worker was used.

## Inputs and isolation

The experiment copied root's already-built and verified Phase B dist; it did not run build or install. At preparation HEAD was `a293ed4895fe1d3de3c1f8b308ca41eeaa52ed07`; Phase B files were independently pinned rather than treating that earlier HEAD alone as their provenance. Eight source/test pins include the five changed product files, Phase B HTTP test, unchanged frozen response serializer and actual app registration file.

The closure contains **5,771 files** across API/storage/upload-contract, required runtime dependencies, official startup/proxy scripts and the test guard. **24 unfinished Phase D dist files** matching `^(sqlite-)?workflow-projection` were excluded. No subsequent source changes or rebuilds were copied into this experiment. The numbered run retained the exact driver it executed.

| Pin                                                                                   | SHA-256                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Private plan and identical public `93ba2b78-ec31-41ad-a62e-540218654fc2/prepare.json` | `6d1dfbbd99c242993d67716a392c37a58a7ba00e608ed04f01473a461cb169d1` |
| Closure manifest                                                                      | `f099470fe6d4067a1223dffbbf9f366cd5c16c87c015df7ddf11e90ce92c93d0` |
| Instance configuration                                                                | `5b6a981cb8cdfea2991fb1b5a12169a35dd622106595f271e667de9d420811f5` |
| Guard                                                                                 | `a11df8fc32fb3bbc927b937596fa1a512a3486805837fde7394eb1cd001f0346` |
| Executed driver                                                                       | `ad15f3c1bca4882152f722d1de2232cc48fb83c9a6698ea397bd16d2c5572f01` |
| Actual run raw                                                                        | `2978f312e9047be9d58b95c6e6e7b624acba5e88ba548b22b0d62a54aea9ab84` |

All files and database state remain below:

`C:\Users\lin0\.codex\parallel-runtimes\result-phase-b-93ba2b78-ec31-41ad-a62e-540218654fc2`

The source and runtime directories are siblings. Data, backups, evidence/quarantine, logs, downloads, cookies and private credentials are independently scoped. Only API4459 and server MCP4461 started. The configured4458/Web and4460/desktop MCP were unused. No original preview4419/4421/4274, production service, installed EXE/APK, global configuration or Phase A evidence was changed.

Each fresh business project was read back with exactly five disabled components. The import marker stayed `paused`; automatic backups were disabled through the official instance configuration. The preloader permits only MCP-to-API `127.0.0.1:4459`, exact designated loopback listens and literal loopback address resolution. Other networking/DNS/TLS/datagrams and child process creation are refused. Before application startup, ten deliberate denials in the self-test main thread and ten in an inherited Worker verified that barrier. They are guard evidence, not application success. Neither actual application process attempted a forbidden operation. This process-level guard is not a general malicious-native-code sandbox.

## Actual blocked-result behavior

Both legacy JSON and vendor requests completed this real sequence:

1. Create a new Bug and human repair round, deliver a no-code fix, create/start Verification.
2. Submit `blocked` and its `blockedReason`. The Verification advances exactly once; Bug remains `ready_for_verification`, retains its delivered active Attempt, clears only `active_verification_id`, and advances its version once. The complete repair-attempt table fingerprint is unchanged.
3. Repeat the request with its original key and body: the original receipt returns without any additional domain fact. The legacy path used a valid200-character key; the vendor path used its canonical workflow key.
4. Edit the Bug title/version and replay the old blocked request: it still returns the original result. Changed same-key reason returns409 with all tracked domain facts unchanged.
5. Create and start a different Verification against the same delivered Attempt. A new-key attempt to write another result to the old terminal blocked Verification returns412 without effects.
6. Submit `passed` to the new Verification and close the Bug. The old blocked request still replays its original receipt, and its historical Verification remains blocked. The Attempt is still byte-for-byte unchanged.

The vendor case uses a genuine successor human repair attempt with a non-null parent ID. Both the blocked and later passed immutable snapshots retain that relationship.

The frozen wire Verification DTO intentionally omits reason fields. Actual SQL `verifications.blocked_reason` and the complete immutable stored DTO retain the exact reason; `failure_reason` is null. The audit compares the actual HTTP response with the frozen serializer's negotiated projection, not with an invented expanded wire object.

Additional real requests cover missing/blank/null/overlong and mixed reasons, Cookie plus valid/missing/bad CSRF, Bearer replay, assigned-verifier rejection, attempted injection of the internal authorization flag, wrong target version412, legacy body with vendor-only acceptance406, wrong project404, revoked membership403 and soft-deleted result target404. Each tested rejection leaves the tracked domain fingerprint unchanged. Verification GET is also denied after soft deletion.

## Existing MCP behavior and its remaining boundary

The real server MCP handled initialize, initialized notification, discovery of90 tools, login, Bug creation, durable comment/replay, manual completion, Verification creation/start and ordinary closure by a different active employee. Closed context, latest Verification and comment text were read back. The same unassigned actor remained forbidden at the stricter frozen result route.

**`qa_bug_action` currently has no blocked action.** This run explicitly sent `action: "blocked"`, received the existing400 tool error and confirmed no domain changes. That rejection is a compatibility boundary; it is not evidence that MCP can submit blocked results. No extra tool or component action was added or invoked.

## SQL, shutdown and retained backups

API PID17808 and MCP PID17196 received owned IPC messages that emit `SIGTERM` into their original official shutdown handlers. Both exited with code0. No process kill or service manager operation was used.

The final read-only audit passed **86/86** checks. It confirms:

- Seven immutable snapshots remain: four blocked and three passed. Each has exactly one typed result event, matching account/project/Bug/Verification, actual actor, digest and result version.
- Six frozen HTTP projections and the ordinary MCP full result match their original persisted DTOs. Exactly one ordinary result event actor differs from its assigned verifier, preserving the human workflow permission rule.
- Online backups before and after shutdown have identical bytes and nine-table fingerprints; each opens read-only with clean integrity and foreign-key checks.
- The original process identities are absent and4459/4461 have no listeners. Process identity uses PID, executable and creation time because Windows may reuse the numeric PID.

The two retained archives are **1,966,080 bytes**, each SHA-256 **`b1380cee2f8fa55732cdef74a171ec9af356b0b517c9495886bdf8ed4fb02d19`**:

`C:\Users\lin0\.codex\parallel-runtimes\result-phase-b-93ba2b78-ec31-41ad-a62e-540218654fc2\runs\fd3648a5-61f9-4c17-8c44-fa6eb00e5341\consistent-before-stop.sqlite`

`C:\Users\lin0\.codex\parallel-runtimes\result-phase-b-93ba2b78-ec31-41ad-a62e-540218654fc2\runs\fd3648a5-61f9-4c17-8c44-fa6eb00e5341\consistent-after-stop.sqlite`

No live WAL was copied. All synthetic projects, employees, Bugs, rounds, verifications, events, notification rows, receipts and deletion evidence remain preserved. This run created no attachments or external tasks.

The first post-run audit `audit-1788924138805.json` passed72/72. While adding fourteen explicit event identity/version comparisons, `audit-1788924189124.json` stopped at13/14 checks because it only matched numeric PID17196; Windows had already reused that number for a new `pwsh.exe` created at03:23:06, after the original MCP node process exited at03:21:29. The failed audit retains the actual executable/time evidence. The corrected identity comparison did not operate on that unrelated process, alter application code, modify the database or change the successful run raw. Final `audit-1788924225990.json` passed86/86, SHA-256 `c40bdd1ca93fefe8d226d48a61267a58ddb813ad538e251417401f7ec47fb53e`.

Credentials remain private/in memory. Public headers exclude Authorization/Cookie/CSRF, nested JSON text is recursively redacted, primitive strings such as JSON-RPC `"2.0"` are preserved, and private instance secret values were scanned for absence without printing them.

This evidence proves the specified complete-main Phase B HTTP behavior and existing MCP compatibility. It does not prove installed client updates, physical Android behavior, external component execution, MCP blocked submission, attachment counts9–20/capture-result binding, fail/supersede or Phase D workflow pagination. Root's separate schema15→16 migration proof and266 API/118 storage gates are not relabeled as this actual115-request run. No matrix or production release was changed here.
