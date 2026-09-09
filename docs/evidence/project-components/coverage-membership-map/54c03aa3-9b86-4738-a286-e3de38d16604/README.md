# Membership/detail/Phase A mapping audit

The reviewed mapper SHA is `685486b28a8b6934c26fc9a07871c74062e6bdd294ae3fb9f6d9488bb454d435`. Its three new evidence additions pass the bounded independent audit: **173/173 checks**, including 2,126 synthetic failed surfaces across current and retired items, exact retained progress/manual fields, source revalidation flags, two mapping passes, optional-proof absence and three corrupted-proof cases. The separate real generator → mapper → generator chain passes **12/12 checks** over 613 synthetic failures; only its generated files inside a new temporary directory were written. No service, browser, device, profile or business operation was performed.

The reference mapper is the committed source at `2d687b47b658d6d38e096872e9a92950bcb30c7d`, SHA `c0de8ebdc985eeecbda449977b0380d1eedef4de33cda2b9d6f524e3c81da02b`. The actual input matrix remains SHA `53eafe84381682efdb6a56cca8c2fd5044883a3e341a99b8b06eb242d8044990`, 991 current and 28 retired entries. Its historical source inventory is not silently refreshed by this mapper audit.

## Scope of the new mapping

| Original evidence | Rehashed SHA | Verified interpretation |
| --- | --- | --- |
| Web detail run `ab51a7d8.../proof.json` | `a860b14e12fdd1abe799e118722e4acf280903ae0e7c1b6c1a2cb790925bdcab` | 59 real checks; 3 detail requests, 2 genuine responses, injected failure and actual retry. Validation-only; no surface promotion. |
| Server MCP membership run `e21431f0.../proof.json` | `55ac6023679282fb4a7a0a985ff79db0a2718999f1869e41fe60b25e569834e5` | 35 JSON-RPC calls and 59 checks, plus separate health GET. Only baseline 02/04 `server_mcp` change to passed. |
| Phase A `contracts-result-phase-a/result.json` | `b35d2d0d774ce94ca902629625b68a068cdff21edc49f64000471e45a3e449ca` | API 260, storage 118 and temporary HTTP 215; frozen schema-15 source. Validation-only, explicitly not deployed to persistent 4419. |

The exact membership changes are `baseline-b949d66dbe2c5a/server_mcp` (02) and `baseline-725921666b2c57/server_mcp` (04). Their other surface result objects and the complete set of passed whole baselines are unchanged relative to the committed mapper. Baseline 01 gains only scoped progress. The audit also decodes the retained MCP error envelopes: disabled-A same-name login and old-A-token read both genuinely have `isError: true` and status 403. It does not treat outer JSON-RPC HTTP 200 as a successful business operation.

Appending one byte to each of the three proof bodies in virtual reads causes its pinned SHA guard to reject **before either virtual output write**. Missing optional proofs are recorded absent; missing membership evidence cannot promote 02/04. Removing either validation-only proof does not change any surface result. The real public proof bytes remain unchanged.

## Preserved failures and exact test correction

`chain-initial.mjs.txt` preserves the unmodified chain test. Its reproduced [exit-1 result](chain-initial-failure.json) shows two old route IDs, `http_route-73141f37d37021` and `http_route-2af3ffd1e0e3b1`, absent from current `items`. Both actually survive in `retiredItems` with their failed results, partial progress and revalidation flags; the old test looked only at current items. This reproduction uses temporary fixture `qa-coverage-chain-K6nSTG`; root's earlier `qa-coverage-chain-B7H72Q` failure remains separately retained.

The source correction only indexes **current + retired** for retention assertions. It adds uniqueness across those lists and still requires the rediscovered text control to be a current item, absent from retired items, `not_run` on Web/EXE and covered by an exact source-review marker. The [successful chain](chain-final.json) records both retired synthetic failures explicitly and identical normalized hashes after two full chains. No mapper or generator implementation was changed.

The new audit's own [first result](membership-audit.json) has 172/173 passing checks. Its one incorrect expectation was that `serverMembershipPriorProgress` must equal the pre-mapper synthetic partial. Baseline 02's older mapper block first records its historical partial; that is the snapshot entering the new membership block. The original artificial manual note/progress already remains verbatim in `retainedReviewNotes`, verified even in the first audit. `membership-audit-initial.mjs.txt` and logs preserve that failed expectation. The revised audit separately checks the exact pre-addition reference-mapper progress and original human note/progress history; [R2](membership-audit-r2.json) passes all 173 without changing the mapper, proofs or actual matrix.

The three actual generated files have identical before/after hashes in both tools:

- `coverage-matrix.json`: `53eafe84381682efdb6a56cca8c2fd5044883a3e341a99b8b06eb242d8044990`.
- `coverage-mapping-review.md`: `3b3f665486f7becb466141aebab30a2d5914f9705cbda22fd42117ac395ca041`.
- `coverage-matrix.md`: `1dc6079d911e0072d843b713aa81df63dfb30b9c7adfb0ae481978caa087ea6c`.

## Reproduction and limits

```powershell
node scripts/project-components/coverage-generation-chain.test.mjs
node scripts/project-components/membership-map.audit.mjs --expected-mapper 685486b28a8b6934c26fc9a07871c74062e6bdd294ae3fb9f6d9488bb454d435
```

Syntax checks, ESLint and Prettier passed for both final tool files. Output/log files in this directory were created under unique names; the older `map-coverage-evidence.recent-evidence.audit.mjs` and its historical pins were not edited or rerun. The chain discovers the source available at its recorded time; other agents' later source changes require a new result, not a rewritten old log. The audit evaluates actual complete mapper code with fixed time and in-memory output sinks; it is not a live API/UI rerun and does not itself write or publish a new real matrix. It supports the bounded mapping statements above, not complete baseline 02/04 across clients, physical Android, component execution, or current schema-15 deployment.
