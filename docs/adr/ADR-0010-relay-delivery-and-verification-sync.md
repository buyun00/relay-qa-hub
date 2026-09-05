# ADR-0010: Relay delivery and human verification synchronization

- Status: Accepted
- Date: 2026-09-05
- Owners: Relay QA Hub architecture
- Supersedes: Relay receipt-only projection and one-handoff-per-task assumptions

## Context

LOCAL-257 and LOCAL-289 received verified Relay delivery but stayed in progress because
only their integration receipts changed. Users require delivery to enter acceptance,
rejection reasons to start the next Relay round, and accepted tasks to close on both sides.

## Decision

Schema 11 projects authenticated, applied inbox evidence bound to the exact account,
project, Bug, attempt, handoff, Relay principal and task. A pushed commit must match its
verified remote SHA. QA Hub records two local service audit events and advances only
the active Relay attempt from planned/version 1 through running/version 2 to
delivered/version 3, then moves its Bug to ready_for_verification. Existing receipts
are reconciled by the same idempotent projector. No Build, no-code exemption or human
acceptance is fabricated. Relay delivery can be inspected through the existing human
Verification workflow without requiring a Build fact; published build evidence remains
separate. Historical authenticated delivery stays valid if the integration is later disabled.

A human failed Verification persists its full reason and a durable rework request in
the same transaction. The background worker creates one new QA attempt and handoff,
then the Relay M2M API appends to the original task, branch and conversation. Original
handoffs remain immutable and readable. Each turn resolves to its owning handoff round,
so late events cannot change the next round. New work is rejected if its previous round
or defect/project identity is stale. A newer local workflow blocks queued rework instead
of overwriting it. Ordinary edits made while pending are carried into the new attempt.

A human passed Verification commits local closure and an acceptance outbox record
atomically. Relay closes only the current matching delivered task, without merging code
or writing to another linked system. No network request runs inside the QA transaction.
Transient delivery failures retry with bounded backoff; rework and acceptance remain
retryable beyond the ordinary handoff attempt limit. Permanent failures remain visible.
Acknowledgments replay after lost responses and do not regress delivery receipts.

## Consequences

- QA Hub retains human acceptance authority and all prior attempts, events and reasons.
- A rejection creates one new round, including when a response is lost or a service restarts.
- Clients show Relay delivery as pending acceptance and refresh changed detail state.
- Delivery evidence supports acceptance readiness, not proof of a successful build.
- Schema upgrades require a verified database-plus-attachment recovery point. Rolling
  back data after new writes requires an explicit reconciliation plan; installer rollback
  alone is not a database downgrade.

## Rejected alternatives

- Closing QA Bugs automatically when Relay reports success.
- Reusing or overwriting a failed attempt, or assigning old events to the latest handoff.
- Inventing no-code/build facts or skipping the typed event invariants.
- Waiting for Relay HTTP success before recording the user's acceptance or rejection.
