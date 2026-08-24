# P0 contract walkthrough: twelve critical scenarios

The payloads are machine-validated from `packages/contracts/examples/critical-scenarios.json`. This table freezes the business interpretation that schema validity alone cannot express.

| # | Scenario | Contract outcome |
|---:|---|---|
| 1 | Mobile creates a Bug with first Occurrence | One Bug, Occurrence, Event, Inbox/Outbox transaction; state `reported` |
| 2 | The same client submission and canonical payload is retried | Return the original identifiers and `replayed=true`; create nothing new |
| 3 | A Build provider reports completion | Accept only the configured provider plus exact Job, project, branch, full SHA, mode, and ready status; then compare the SHA to the delivered attempt |
| 4 | A caller tries to close because Relay ended | Reject before mutation; closure requires a bound eligible Verification ID and domain guards |
| 5 | A developer starts a human attempt | Create one active `human` RepairAttempt; mode does not become a Bug state |
| 6 | A verifier passes an eligible attempt/build | Record immutable result, then the sole user-only `ready_for_verification -> closed` transition may run |
| 7 | A domain transition commits | Append a versioned Event with actor/correlation/causation and the same transaction's Outbox rows |
| 8 | QA dispatches selected evidence to Relay | Stable handoff ID/key; bounded evidence metadata and hashes are canonical, rotating URLs are not |
| 9 | Failed verification continues the existing Relay task | Stable action ID/key creates at most one new Turn and a new child RepairAttempt |
| 10 | Relay reports delivery | Accept only signed, current-attempt evidence with `pushed=true`, `verified=true`, and equal local/remote SHA; advance at most to build/verification readiness |
| 11 | Relay closes or archives its Task | Record metadata only; never pass Verification or close the QA Bug |
| 12 | A phone initializes resumable evidence upload | Create/resume an actor/project-bound quarantine session; no attachment exists until finalize and bind |

Cross-cutting rules for all writes: authenticate, authorize project/scope, validate idempotency key plus canonical hash, append audit, and avoid exposing host paths or secrets. Existing-aggregate mutations additionally require either a body `expectedVersion` or mandatory `If-Match`.

`packages/contracts/semantics/behavior-scenarios.json` supplies twelve executable cross-operation checks for replay convergence, payload mismatch, stale versions, machine denial, exact Build identity, late/older integration events, duplicate candidate-only behavior, Push degradation, and Relay task-close metadata handling.
