# ADR-0008: Optional Qingyu import and coordinated human closure

- Status: Accepted
- Date: 2026-08-28
- Superseded in part by: ADR-0009 (closure ordering and failure handling only)
- Owners: Relay QA Hub architecture
- Supersedes: ADR-0001 decision 7 only

## Context

QA Hub must let a signed-in user import the actionable Bug tasks assigned to the
same user in Qingyu and, after QA Hub's normal human Verification, close the
linked upstream task. ADR-0001 originally excluded every Qingyu identity, API,
state, and synchronization concern. That absolute exclusion no longer represents
the requested product, while its independent-source-of-truth boundary remains
mandatory.

## Decision

Qingyu is an optional server-side adapter. QR exchange, Bearer credentials,
current-user filtering, detail refresh, image retrieval, and resolve transitions
are performed only by the QA Hub API. The browser receives no Qingyu token.
Sessions are encrypted outside the source tree, while durable external-to-local
Bug links and synchronization outcomes are stored in QA Hub SQLite and included
in its normal recovery points.

Only actionable tasks assigned to the connected Qingyu user may be imported.
Import is idempotent and rechecks each task immediately before creation. A linked
task is resolved only as part of an authorized human passed Verification: QA Hub
first performs and verifies the Qingyu transition, then records the local result.
Failure leaves the local Verification pending. Relay and MCP delivery remain
unable to accept or close either record.

QA Hub remains fully usable when Qingyu is unavailable. Its identity, roles,
workflow, evidence, numbering, and Bug records never derive authority from
Qingyu, and Android remains outside this integration.

## Consequences

### Positive

- Users can migrate their assigned work without copying descriptions and images
  by hand, and linked closure does not silently diverge between the two systems.
- Upstream credentials stay out of browser storage, logs, and the QA Hub identity
  model.
- Remote failures are visible and retryable without corrupting local lifecycle
  state or weakening human acceptance.

### Costs and risks

- Qingyu protocol changes can break the optional adapter and require maintenance.
- Imported links and encrypted sessions add recovery and key-management duties.
- Coordinated closure is deliberately unavailable if the importing Qingyu account
  cannot be re-established or lacks the required transition permission.

## Rejected alternatives

- **Browser-held Qingyu token:** exposes upstream authority to page script and
  makes logout, logging, and shared-machine isolation unsafe.
- **Close locally before Qingyu:** creates a false completed state when the remote
  transition fails.
- **Allow Relay or MCP to synchronize closure:** bypasses the human Verification
  authority required by the QA Hub lifecycle.
- **Make Qingyu the identity or Bug source of truth:** would violate the retained
  independence and offline-operation requirements of ADR-0001.
