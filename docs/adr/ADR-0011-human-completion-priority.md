# ADR-0011: Human completion takes priority over automation

- Status: Accepted
- Date: 2026-09-07
- Owners: Relay QA Hub architecture
- Supersedes: Executor delivery as a prerequisite for a human to submit acceptance

## Context

Four Bugs remained in progress after Relay failed, requested input or stopped reporting.
The Web exposed completion only for running human attempts or delivered code. A person
who had handled the issue could not submit it for acceptance. The user requires human
operations to take priority over automated execution.

## Decision

Any authenticated active project member can use `POST /api/v1/bugs/:bugId/manual-complete`
with `expectedVersion` and `reason`, and the key
`workflow:manualCompleteBug:bug:<bugId>:v<expectedVersion>`. Web and Windows expose
“人工标记完成” for pending, in-progress and awaiting-build Bugs, independently of owner,
executor status, Relay availability, commits or Build facts.

Schema 12 records an immutable manual decision, its actor and the replaced attempt.
In one database transaction it supersedes an unfinished attempt, retains all delivery
history, creates the next human attempt and delivers that manual decision for acceptance.
The manual operation requires no automatic code or Build evidence; it does not claim
that Relay delivered or that a build succeeded. Bug owner and verification owner remain
unchanged. The existing verification workflow creates acceptance on demand and records
the later human result. This operation never fabricates a passed Verification or closure.

Typed database guards admit only the exact scoped human decision. The operation uses
version checks, immutable per-item idempotency receipts and a deferred reference requiring
the new attempt to exist before commit. Failure rolls back the entire operation. Late
Relay delivery cannot take ownership because its attempt is no longer active; pending
rework also refuses a newer local workflow. No external request runs in this transaction.

## Consequences

Manual completion remains available when the optional executor fails, is disabled or
has no delivery evidence. Another project member can operate it without reassignment.
Audit and original attempts remain readable, and repeated submission creates no second
attempt. Membership, tenant isolation, deleted-record protection and concurrent-change
checks still apply. Database upgrades require the verified recovery workflow; installer
rollback is not a schema downgrade after new human decisions have been recorded.

## Rejected alternatives

- Directly changing four production state fields without an operational UI or audit.
- Forging Relay delivery or successful Build evidence to unlock a button.
- Waiting for external cancellation, synchronization or retry before recording a human decision.
- Deleting or rewriting the executor's history, or automatically passing acceptance.
