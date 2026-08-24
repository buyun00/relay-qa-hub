# Architecture decision records

These accepted records freeze the P0 architecture boundary for Relay QA Hub. Later changes require a superseding ADR and a contract compatibility review; editing history in place is not sufficient.

| ADR | Decision |
|---|---|
| [ADR-0001](ADR-0001-independent-source-of-truth.md) | QA Hub is an independent source of truth; Relay is optional |
| [ADR-0002](ADR-0002-workflow-aggregate-separation.md) | Bug state, repair attempts, builds, and verification are separate concepts |
| [ADR-0003](ADR-0003-sqlite-wal-and-repository-boundary.md) | SQLite WAL is the first single-node store behind repository interfaces |
| [ADR-0004](ADR-0004-content-addressed-evidence.md) | Evidence uses quarantine, resumable upload, and content-addressed blobs |
| [ADR-0005](ADR-0005-reliable-integration-messaging.md) | Integration uses transactional Outbox/Inbox, signed webhooks, and reconciliation |
| [ADR-0006](ADR-0006-authentication-rbac-and-shared-devices.md) | Authentication, project RBAC, machine scopes, and shared-device isolation are first-class |
| [ADR-0007](ADR-0007-app-first-android-and-poco-bridge.md) | Native Android is the primary client; Web is post-MVP; Poco is a loopback-only read-only enrichment bridge |

## Immutable-principle coverage

The numbering below matches section 1 of `docs/IMPLEMENTATION_PLAN.md`.

| Principle | Frozen by | Verification implication |
|---|---|---|
| 1. No shared QA/Relay database, attachments, process, service account, or modules | ADR-0001, ADR-0004 | Isolation tests and separate configuration/data roots |
| 2. Bug state and repair mode are orthogonal | ADR-0002 | Domain transition table and invariant tests |
| 3. Relay delivery can never accept or close a QA Bug | ADR-0002, ADR-0005 | Event projection tests reject automatic verification/closure |
| 4. Ordinary closure requires a passed verification for an exact attempt and testable build | ADR-0002 | Closure and commit-identity guard tests |
| 5. Writes are idempotent, authorized, audited, and optimistic-lock protected | ADR-0002, ADR-0005, ADR-0006 | API, transaction, RBAC, audit, and version-conflict tests |
| 6. Semantic duplicate candidates never auto-merge | ADR-0002 | Candidate API is read-only until explicit human choice |
| 7. In-app Inbox is the notification source of truth | ADR-0005 | Push failure cannot lose or roll back an Inbox notification |
| 8. Source code or a temporary port is not delivery proof | ADR-0001, ADR-0003 | Real service, restore, device, HTTPS, and canary gates stay separate |
| 9. Existing Relay workspace changes are preserved | ADR-0001 | Before/after worktree fingerprint and no destructive Git operations |
| 10. No push, public publish, or production-data deletion without explicit authorization | ADR-0001 | Local-only commits and production change gates |
