# Phase A: isolated complete main, storage worker and server MCP

The successful run `be5c18d7-8150-4684-b7c4-a9044c11b796` made **127 recorded network requests: 111 direct HTTP requests to 4459 and 16 JSON-RPC requests to server MCP 4461**. All **247 checks passed**. The separate post-run read-only SQL/artifact audit passed **69/69**. MCP's internal route injections are not additional network requests. Startup readiness polling is outside the numbered request ledger and is not included in 127.

The recorded window was `2026-09-09T03:08:49.190Z` through `2026-09-09T03:08:54.894Z`. This is real complete application execution: the retained official `run-preview-service.mjs` imports the frozen `apps/api/dist/main.js`, which constructs the real worker, stores, authorization context and component runtime. The retained official `preview-mcp.mjs` proxies actual JSON-RPC requests to this API. No test-created Fastify application, mocked worker or external executor was substituted.

## Frozen execution inputs and isolation

Phase A source was committed as `2d687b4`; its 12 source/test pins and the prior 260 API / 118 storage gate are in `../contracts-result-phase-a/result.json`. Those prior fixture tests are separate from this full-main run. No build or install was performed for this experiment.

The initial complete API/storage/upload-contract/runtime dependency copy contains 5,763 files. Twelve unreferenced `workflow-projection-*` dist files from unfinished Phase D were explicitly excluded. The later successful experiment inherited every original product/dependency byte; only the test guard changed after the first startup rejection. Each experiment has its complete file/hash manifest.

| Successful experiment pin                                                              | SHA-256                                                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `e9662073-77cf-44b5-a04d-3649e1651e20/prepare.json` plan contents; private `plan.json` | `92c82df8a872b0f750918024cf12ec6bde050cc4945ab3272774d2e1fb2ce36e` |
| Complete retained closure manifest                                                     | `0838760bdb7c01796d8e6d72c4bb68e8f31461f77f7bd19239de7f531d5099e9` |
| Instance configuration                                                                 | `51096c689260debe77ea62743ad99809643a5de1c1374673016d2f36a6526df7` |
| Executed guard                                                                         | `b64b2dd6462dd8404c5f77a107936c6557111bcba503ff65aad0612c0b9b4949` |
| Successful run's retained runner                                                       | `3ab4d665d619bb295746024823bc1f443916d57cfb13d396fa10581cb5928be0` |

Private experiment root:

`C:\Users\lin0\.codex\parallel-runtimes\result-phase-a-e9662073-77cf-44b5-a04d-3649e1651e20`

`source` and `runtime` are siblings. The instance has independent data, backup, evidence/quarantine, logs, downloads, cookie identity and random private credentials. Only 4459/API and 4461/server MCP ran. Configured 4458/Web and 4460/desktop MCP are unused placeholders. Original preview 4419/4421/4274, installed clients, production paths and global configuration were not operated on.

Every new business project was read back with exactly five components disabled. The data-root import marker stayed `paused`, and automatic backups were disabled through the existing instance environment. The main process additionally used a preloader that refused outside connections, non-designated listens, external DNS, TLS, datagrams and child processes. Only MCP-to-API `127.0.0.1:4459` traffic was permitted. Literal `127.0.0.1` DNS lookup was allowed because Node uses it while binding the explicit loopback listener. The guard is a process-level test barrier, not a general sandbox for malicious native code.

The guard self-test separately proved ten denied operations in its main thread and ten in a Worker inheriting the preload. It is guard evidence, not application success. Successful actual API and MCP process logs contain no forbidden-operation attempts.

## Actual business coverage

- New projects and employees were created through official authenticated HTTP routes; the full main's internal seed remained confined to this new database.
- Legacy JSON `passed` and `failed` requests used valid minimum/maximum idempotency key lengths 1 and 200. Vendor requests exercised both JSON body compatibility and vendor media. First receipts and repeats were compared, including after a later Bug title/version change. Altered same-key content returned 409 with no additional domain effect.
- Each result had one result event, one notification outbox entry and one immutable result snapshot. HTTP result projections match the retained immutable snapshot through the frozen, negotiated response serializer. Seven complete snapshots survive in the database, including one legitimate non-first repair attempt with a real parent ID.
- Cookie plus CSRF succeeded; missing/bad CSRF failed. Bearer replay returned the original receipt. Wrong target version returned 412; legacy body with vendor-only acceptance returned 406 before business writes. An unassigned employee and body injection of the server-only verifier flag were rejected. Wrong project, revoked membership and deleted target replays were rejected with the expected 404/403 boundaries. Tracked business table fingerprints stayed identical after each tested rejection.
- Server MCP performed actual initialize, initialized notification, discovery of the existing 90 tools, employee login, Bug creation, durable comment/replay, human completion, verification creation/start, and closure by another active ordinary employee. The same actor was rejected by the stricter frozen result route. SQL confirms that ordinary closure's event actor differs from the assigned verifier exactly as permitted by the unchanged human workflow policy. Closed history and comment content were read back through MCP.
- No Relay/build/upload/Qingyu component route was invoked. Notification outbox rows are retained task evidence; no external delivery is claimed.

## Preserved failures and corrections

1. Initial experiment `663e1ea3-5c33-4a98-988a-4d49166ae366`, run `205dcee1-e94d-4e5f-ab65-a1414d2ec923`: 0 business/network-ledger requests, 4/4 preceding checks. The guard incorrectly refused the literal loopback `dns.lookup` used by actual main startup. The API startup failure and official SIGTERM cleanup were retained. The next experiment inherited the original product closure and changed only this narrow guard behavior.
2. Run `dc97beff-e1ff-4162-b0df-05f54a4c7dfb`: complete main and MCP became ready with schema15; 3 recorded requests, 7/8 checks. The test-generated project key contained lowercase characters and was correctly rejected with 400. Static reinspection also confirmed project creation's existing status is 200, unlike Bug creation's 201. The runner corrected the synthetic key to the documented uppercase grammar and the existing route status. No Bug was created in that failed run; auth/session effects remain preserved. Both services exited normally. The successful run used fresh project/employee identifiers.
3. Post-run `audit-1788923489994.json`: the first audit incorrectly compared the full stored Verification object with its narrower frozen HTTP projection and failed at 26/27 checks. The corrected audit uses the retained frozen response serializer and deep object equality, without modifying any response, database or original proof. `audit-1788923528226.json` passed 69/69. This is an audit harness correction, not a product fix.

Raw files and runner copies from failed and successful runs are retained unchanged. The successful raw SHA-256 is `beaccbfa20d338e48fae91b235fca73752559f2151d0257912622871c9c6cac7`; final audit SHA-256 is `f5410a4b79e32ae8e9d54dcef74be063e826caa5e750eedb329ec053f4b23e31`.

## Shutdown, backup and boundaries

Successful API PID19400 and MCP PID18324 were given an owned IPC shutdown command that emits `SIGTERM` into the original main/MCP shutdown handlers. Both exited with code0. Post-run CIM and socket inspection confirmed those exact PIDs absent and 4459/4461 without listeners. No fallback kill or service manager operation was used.

Both SQLite online backups below are **2,035,712 bytes**, SHA-256 **`5d0e8d9c768f0756ec6360da03ea5921f61de4118c6498547065d30998a69cea`**:

`C:\Users\lin0\.codex\parallel-runtimes\result-phase-a-e9662073-77cf-44b5-a04d-3649e1651e20\runs\be5c18d7-8150-4684-b7c4-a9044c11b796\consistent-before-stop.sqlite`

`C:\Users\lin0\.codex\parallel-runtimes\result-phase-a-e9662073-77cf-44b5-a04d-3649e1651e20\runs\be5c18d7-8150-4684-b7c4-a9044c11b796\consistent-after-stop.sqlite`

Each backup was reopened read-only, passed integrity/foreign-key checks and matched the recorded nine-table business fingerprints. The two backup files themselves are byte-identical. No live WAL was copied. All projects, personnel, Bugs, attempts, verifications, events, receipts and soft-delete evidence remain in the private fixture. The audit records concrete actor/record/version/digest bindings.

Secrets are private-file/in-memory only. Public request headers exclude Authorization/Cookie/CSRF. JSON-inside-string is recursively redacted while primitive strings such as JSON-RPC `"2.0"` remain unchanged. Exact private instance secret values were scanned for absence from public raw output without printing them.

This run does **not** demonstrate installed client behavior, external tasks, blocked results, attachment counts9–20, capture-result binding, fail/supersede routes or workflow pagination. The long Chinese/control-character >64KiB receipt and schema14→15 preservation/recovery belong to the earlier Phase A real-HTTP/SQLite fixture proof, not this 127-request full-main run. No source was rebuilt, no shared release deployed, and no existing coverage matrix status was changed by this evidence.
