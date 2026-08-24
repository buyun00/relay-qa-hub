# ADR-0002: Separate Bug state, repair attempts, builds, and verification

- Status: Accepted
- Date: 2026-08-24
- Owners: Relay QA Hub domain

## Context

A Bug can be repaired by a person, Relay, or another external path, retried multiple times, included in multiple builds, fail verification, and later recur. Encoding all of those dimensions in one status produces ambiguous transitions and permits automation to make human decisions. Concurrent mobile retries and multi-user edits also require deterministic idempotency and conflict handling.

## Decision

1. Bug state answers only who acts next: `reported`, `needs_info`, `ready`, `in_progress`, `awaiting_build`, `ready_for_verification`, `closed`, `deferred`, `rejected`, or `duplicate`.
2. Each repair engagement is an immutable-history `RepairAttempt` with mode `human | relay | external` and its own status. Changing mode creates a new attempt and supersedes, rather than overwrites, the old one.
3. Build identity is separate from version labels. A required build is testable only after its manifest or an audited release-manager override proves inclusion of the exact delivered commit.
4. A `Verification` binds one non-superseded delivered attempt and, when required, one eligible build. Only an authorized human verifier can record `passed`, `failed`, or `blocked`.
5. Ordinary closure requires the latest eligible Verification to be `passed`. S0/S1 defects require repairer/verifier separation by default.
6. Verification failure retains the failed Verification and attempt, marks the attempt `verification_failed`, returns the Bug to `ready`, and allows a new child attempt.
7. Relay delivery or task closure can at most project the current Relay attempt to delivered and move the Bug to `awaiting_build` or `ready_for_verification`; it cannot create a passing Verification or close the Bug.
8. Bug/Occurrence/Event creation, transitions, audit Event, and required Outbox messages commit atomically. Mutable aggregates use integer versions; stale writes fail with `412 VERSION_CONFLICT`.
9. Every write uses an idempotency key plus canonical-payload hash. A repeated key with the same payload returns the original result; a different payload returns `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.
10. A stable `client_submission_id` is unique within a project. Semantic similarity only returns explained candidates; only an explicit person can append an Occurrence or mark a duplicate.

## Consequences

### Positive

- Automation cannot masquerade as acceptance.
- Failed and superseded work remains auditable.
- Exact commit/build/verification lineage can be proven.
- Retries converge without silently overwriting concurrent work.

### Costs and risks

- Queries and UI projections join several aggregates.
- Transition commands need centralized domain guards and transaction coordination.
- Reconciliation must understand attempt generation so late integration events cannot overwrite a newer human path.

## Rejected alternatives

- **One compound status enum:** creates a combinatorial state space and loses orthogonality.
- **One mutable repair record:** erases retry and responsibility history.
- **Close on Relay `turn.delivered` or task close:** confuses delivery with independent verification.
- **Match builds by display version only:** cannot prove that the tested artifact contains the fix.
- **AI auto-merge of similar reports:** similarity is probabilistic and cannot replace a human duplicate decision.
