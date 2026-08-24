# ADR-0005: Transactional Outbox/Inbox, signed webhooks, and reconciliation

- Status: Accepted
- Date: 2026-08-24
- Owners: Relay QA Hub integration and reliability

## Context

Relay and build systems can be unavailable, restart mid-delivery, retry, send duplicates, or deliver late and out of order. Relay UI SSE has a bounded backlog and is not a durable integration contract. A synchronous HTTP success also cannot prove that an external repair or build completed. Notifications need the same durability: Push is useful but not universally available.

## Decision

1. A local business mutation and its integration/notification Outbox messages commit in one transaction. `202 Accepted` means only that the Outbox accepted durable work.
2. Workers claim bounded messages, preserve order per aggregate, retry 408/425/429/5xx with exponential backoff and `Retry-After`, dead-letter permanent configuration failures, and recover abandoned `sending` claims after restart.
3. Incoming Relay/build events are authenticated before a durable Inbox insert. Provider event ID and delivery ID are unique; a canonical body hash detects conflicting duplicates.
4. Relay webhooks use versioned envelopes, timestamped HMAC over raw bytes, a bounded replay window, configured endpoint/secret, and payload allowlists. Secrets never appear in request bodies, database events, logs, or browser code.
5. Projection checks current repair attempt, generation, handling mode, external revision, and event ordering. Late Relay events cannot overwrite a superseding human or external attempt.
6. Reconciliation APIs repair missed projections and mapping drift. Durable contracts do not depend on UI SSE or an in-memory cursor.
7. Relay delivery evidence is accepted only when the signed event proves `pushed=true`, `verified=true`, and `commitSha=remoteSha`. It can set the attempt delivered and advance to build/verification readiness, but cannot pass verification or close a Bug.
8. Relay task closure is metadata only. A build completion is accepted only after provider/job/project/branch/full-SHA/mode identity checks.
9. In-app Inbox rows are the notification source of truth. Push is a best-effort channel driven from the notification Outbox; Push failure never rolls back or deletes an Inbox item.
10. Every handoff, continuation action, webhook, build event, and notification uses stable idempotency and correlation identifiers.

## Consequences

### Positive

- External outages cannot make local business actions falsely fail or disappear.
- Duplicates, restarts, and bounded UI event history do not create projection gaps.
- Integration identities and signatures are testable with fake servers before Relay changes.
- Notification work remains visible even when Push is refused or unsupported.

### Costs and risks

- Outbox lag, retry, dead-letter, ordering, signature rotation, and reconciliation need operations UI and alerts.
- Exactly-once external side effects are approximated through at-least-once delivery plus idempotent receivers.
- Contract compatibility must be versioned and continuously tested on both sides.

## Rejected alternatives

- **Synchronous external call inside the business transaction:** couples availability and still cannot atomically commit across systems.
- **Relay UI SSE as the integration feed:** bounded backlog and unversioned UI semantics can lose events.
- **Unsigned callbacks or callback URL in each request:** permits spoofing, exfiltration, and SSRF-style configuration abuse.
- **Push as notification truth:** unsupported or revoked subscriptions would lose business work.
