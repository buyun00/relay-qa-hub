# ADR-0001: Independent source of truth and optional Relay executor

- Status: Accepted
- Date: 2026-08-24
- Owners: Relay QA Hub architecture

## Context

QA must be able to report, triage, assign, record a human or external repair, associate a build, verify, reopen, and close a bug while Relay is unavailable. Relay already has useful repair execution capabilities, but its scheduler, task database, attachments, browser control plane, and deployment lifecycle are not a safe product boundary for QA data. Qingyu is an unrelated upstream defect source and must not become a dependency of the new product.

The existing `D:\Relay-Unity-Orchestrator` worktree contains user changes. Building the QA product must not mutate, hide, reorder, or discard that work. Source completion and temporary development ports are also insufficient evidence of production delivery.

## Decision

1. QA Hub owns the authoritative Bug, Occurrence, RepairAttempt, Build, Verification, Event, attachment, notification, identity, and integration-link records.
2. QA Hub has its own repository, process set, database, evidence tree, secrets, service identity, authentication, deployment unit, health endpoints, backup, restore, and rollback procedure.
3. Source lives at `D:\Relay-QA-Hub`; persistent data is configured outside it, initially `D:\Relay-QA-Hub-Data`.
4. QA Hub never imports Relay modules, reads or writes Relay SQLite, accesses Relay attachment storage, or authenticates users with Relay sessions.
5. Relay is an optional M2M executor reached only through a versioned, scoped integration contract. The QA browser never calls Relay port 4317 directly.
6. Relay downtime degrades Relay-specific attempts only. The manual and external-repair closed loops remain available.
7. Qingyu accounts, IDs, cookies, tokens, APIs, status, and synchronization are outside the runtime, data, authentication, and state model.
8. The Relay worktree is read-only until the P5 integration package is explicitly active. Before any P5 edit, its live and Git state must be re-audited. No reset, clean, restore, stash, rebase, overwrite, or work loss is permitted.
9. Git commits remain local. Public publishing, pushing, production data deletion, and production cutover require separate explicit authorization.
10. A gate is delivered only with its required runtime evidence. Source, a simulator, or a temporary port cannot substitute for real service, device, restore, HTTPS, and canary checks.

## Consequences

### Positive

- QA data and manual workflows survive Relay outages or upgrades.
- Integration failures are explicit, retryable, and removable without corrupting business state.
- Authentication, retention, backup, and release policy can evolve independently.
- Relay user work and production tasks remain protected during early QA Hub development.

### Costs and risks

- Separate operations, identity, storage, monitoring, and backup must be built and owned.
- Cross-system behavior requires durable contracts and reconciliation instead of direct function calls.
- Some production gates need external infrastructure or human/device evidence and may remain blocked after source work is complete.

## Rejected alternatives

- **Relay plugin or monolith module:** couples QA availability, schema, deployment, and authorization to Relay.
- **Shared Relay database or attachment directory:** makes ownership, backup, access control, and failure isolation ambiguous.
- **Browser-to-Relay API calls:** exposes the control plane and M2M credentials to an untrusted client.
- **Qingyu synchronization as the product backbone:** violates the independence requirement and creates an external identity/state dependency.
- **Treating source completion as release completion:** cannot prove runtime, device, recovery, or rollback behavior.
