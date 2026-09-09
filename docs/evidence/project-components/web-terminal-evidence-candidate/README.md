# Web terminal repair and Verification evidence candidate

> **Superseded source snapshot.** A later audit found that 4 of the 8 recorded Web source hashes no longer matched and that this directory did not contain the raw HTTP projection output supporting one summary claim. It is retained as historical failure/development evidence only. It must not be cited as current Web acceptance; post-commit browser and source-bound evidence are required.

Status at 2026-09-09T11:57:34.5656880Z: **source candidate passed**. This evidence covers the Web client, its tests, and the Web source build. It was not installed, served, previewed, committed, released, or connected to preview or production.

## Assigned Verification access and complete personal scope

Verification mutation controls appear only when the current refresh's server-filtered verifier stream contains the Bug. That authority is bound to the authenticated actor, project, and exact list snapshot; the mutation helper repeats the same check. Other members retain read-only Bug detail and evidence visibility, while the server remains the final canonical-identity authority.

Server read models project historical reporter, owner, verifier, and repair-assignee IDs to the active canonical project identity without rewriting stored history. A browser session created for a source identity before linking resolves to the canonical principal on its next authenticated request. Focused storage coverage includes two direct source identities linked to one canonical member, a source membership disabled after linking, and historical Bug projection after that disable. User management rejects alias-to-alias links, so link chains are outside the permitted write model.

The default personal scope now reads two complete server-filtered streams: `ownerId=<person>` and `verificationOwnerId=<person>`. Each response requires a nonnegative safe-integer `snapshotSequence` and either a null cursor or a nonempty cursor no longer than 500 characters. Each stream freezes its first page's sequence, requires every continuation page to carry the exact same value, follows `nextCursor` until null, and rejects any repeated Bug ID instead of silently replacing it. Cross-page sequence drift and duplicate items fail closed as client consistency errors and are never treated as cursor invalidation. If the server explicitly invalidates a continuation cursor because its authorization or event snapshot changed, the client discards that partial stream and restarts once from page one. A second invalidation fails closed. Repeated cursors fail immediately and never trigger a snapshot restart.

Before unioning the owner and verifier streams, the workbench also requires their completed `snapshotSequence` values to match exactly. A mismatch updates no member or Bug collection, reports the consistency error, and leaves the prior list visible for a later refresh. Matching streams are unioned by Bug ID.

Visible projects and project members are also read through their complete cursor streams. The client freezes the first response snapshot, rejects drift, repeated cursors and duplicate IDs, caps each decoded page at the frozen contract's 100 items, and rejects members whose `projectId` differs from the requested project. It updates the UI only after the complete validated stream succeeds.

## Durable frozen Verification result

Every new Verification attachment identity is durably written through the project/actor draft key before the first network request. `AuthGate` serializes IndexedDB writes and returns the exact write promise to `App`; upload checkpoint callbacks await that promise before continuing.

Slow byte transfer and finalization finish before the short binding leases begin. Before freezing a result, a retained File whose binding lacks sufficient runway is uploaded under a fresh `clientAttachmentId` and rebound. The durable checkpoint stores the complete binding receipt: binding ID, attachment and submission identities, generation, expiry, target Bug, status, aggregate version, and replay marker.

Before the result POST, the client durably freezes the verification ID, expected version, outcome, summary, exact failure or blocked reason, sorted final attachment IDs, capture bundle ID, client submission ID, serialized request body, and project/actor/Bug/repair-attempt/draft scope. Refresh and lost-response recovery replay only that serialized request.

For an expired binding on an already frozen request, the client renews the same binding tuple in place with `leaseGeneration=N+1` and `expectedVersion=<previous binding version>`. It requires the exact returned binding ID, attachment ID, submission and attachment identities, target Bug, generation, and resulting version, then awaits durable persistence of the full receipt before POST. An interrupted durable write cannot advance the in-operation checkpoint: recovery replays the same renewal from the prior durable receipt and waits again. If generation 2 committed but its response was lost before persistence, the next call starts from the durable generation-1 receipt and sends the exact same generation-2 body and idempotency key; it does not create generation 3. The frozen attachment IDs and request body never change. A deployment that rejects generation renewal leaves the old checkpoint and pending frozen result intact for recovery; the fresh-identity fallback remains available before freeze.

A successful POST receipt must exactly match submission ID, verification ID, outcome, summary, resulting version, Bug, attachment IDs, capture ID, event shape, and replay flag. Because the frozen 1.1 result response intentionally omits failure and blocked reasons, the client then reads the rich `GET /api/v1/verifications/:id` record and strictly checks verification ID, Bug ID, status, summary, exact `failureReason`/`blockedReason` nullability and value, and version. The pending draft clears only after both checks pass.

The `awaiting_build` path does not let a verifier complete repair delivery: it only advances a Bug whose repair attempt is already `delivered`; it cannot change the attempt to delivered. The assigned-verifier checks still guard completion, Verification creation/start, and result submission, while version/attempt checks and 409/412 reconciliation preserve continuity. Existing eligibility and authorization tests cover those conditions.

## Verification

- Focused hardening suite: **60/60** tests across 3 files.
- Full Web suite: **140/140** tests across 17 files.
- Both Web TypeScript configurations passed with no emit.
- ESLint passed with zero warnings.
- Prettier passed for all changed Web source/test files; scoped `git diff --check` passed.
- Canonical identity storage fixture: **4/4** tests; full SQLite invariants: **69/69** tests; real HTTP projection fixture: **2/2** tests with 47 requests.
- Vite isolated source build passed with 1,886 transformed modules. JavaScript was 500.02 kB before gzip and 154.26 kB after gzip.
- Build output: `C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-schema19-sol-0909/builds/web-retry-hardening-identity-final-20260909T195700`.
- Canonical source-manifest SHA-256: `4bfddd371d732bec77b504227f0a036374782a774c23a07cfa2821fd97a53bfc`.

The earlier 124/124 result is retained as explicitly stale evidence in `reviewer-hardening-pre-independent-review-124-test.txt`. Initial failure evidence is also retained: the first runtime-path invocation, the first binding-receipt fixture failures, the first lint/format findings, and the cursor-test fixture type/lint findings. Final command outputs are preserved beside this README.

`QA_HUB_API_BASE_URL=http://127.0.0.1:4999` was supplied only as a build/test configuration value. No listener was started and no request reached that address; API tests use mocked `fetch` responses.

## Remaining architecture gaps

- The browser has no route or UI that creates a Verification capture bundle with the submission identity required by the server. The typed and frozen paths retain a supplied capture bundle ID; the current usable UI supplies individually uploaded image evidence.
- The existing Web/API lifecycle actions do not directly mark an external successor started or delivered. An external successor can be created, displayed, failed, or superseded.
- The Web client validates the full frozen `nativeBug` response, including required `projectId`, and rejects missing, malformed, additional, duplicate, oversized, or cross-project items before updating UI state.
- No live browser/API integration, installed desktop client, preview, production, release, upgrade, or rollback was exercised by this source candidate.
