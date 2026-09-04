# ADR-0009: Local human closure is independent of Qingyu synchronization

- Status: Accepted
- Date: 2026-09-04
- Owners: Relay QA Hub architecture
- Supersedes: ADR-0008 closure ordering and failure handling only

## Context

An imported Bug currently cannot close in QA Hub when Qingyu login expires or its
task no longer has a resolution transition. The user requires QA Hub to close its
own Bug even when the upstream task cannot be closed. An optional adapter must not
override QA Hub's independent human acceptance.

## Decision

The human Verification result endpoint first commits the existing authorized local
result, including optimistic locking, idempotency, lifecycle events, and closure
acceptance evidence. Only a newly committed passed Verification closing its Bug
then attempts Qingyu synchronization. Local validation or storage failure must not
trigger any upstream mutation. Acceptance replays do not repeat synchronization.

Missing or expired login, unavailable transitions, timeouts, and other adapter
failures never roll back local closure or turn its successful response into an
error. Sync errors, including a missing linked session, remain in the separate
link status. The existing explicit sync endpoint can retry after login. A task
already known to be resolved, closed, verified, or completed needs no additional
transition. Cancelled or rejected tasks are not falsely marked synchronized.

The automatic sync attempt still uses the adapter's bounded HTTP requests; it is
not a durable background queue. A crash between local commit and synchronization
can leave the link unsynchronized, available for an explicit retry.

Contract compatibility: no request/response shape or database migration changes.
Existing Web, Windows, and Android clients receive their ordinary successful
Verification response despite optional Qingyu failure. Local authorization,
conflict, storage-error, and idempotency semantics remain unchanged. Relay and MCP
delivery still cannot perform human acceptance.

## Consequences

- QA Hub closure no longer depends on Qingyu availability or login.
- Local completion and upstream sync status can differ and are displayed separately.
- Successful sync is claimed only after upstream evidence, never because local
  closure succeeded. Failed sync can be retried without repeating acceptance.
- A sync attempt can still delay the response until its bounded requests finish;
  local closure has already committed at that point.

## Rejected alternatives

- **Keep upstream success mandatory:** blocks local acceptance on an optional
  service and conflicts with the user's requested independent lifecycle.
- **Skip local Verification or edit Bug state directly:** loses authorization,
  audit evidence, optimistic locking, and idempotency guarantees.
- **Mark every upstream failure successful:** conceals divergent state and destroys
  useful retry/error evidence.
