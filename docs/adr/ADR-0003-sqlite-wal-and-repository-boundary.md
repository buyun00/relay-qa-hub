# ADR-0003: SQLite WAL first, behind a repository boundary

- Status: Accepted
- Date: 2026-08-24
- Owners: Relay QA Hub storage and operations

## Context

The debug release is a single Windows deployment with modest initial write concurrency. It still needs transactions, foreign keys, constraints, optimistic locking, online backup, crash recovery, and reliable event/outbox commits. Introducing a distributed database before observing real contention would increase operational risk, while coupling domain code to SQLite would make a later move unnecessarily expensive.

## Decision

1. The initial transactional store is SQLite in WAL mode with foreign keys enabled, bounded busy timeout, short write transactions, explicit migrations, and integrity checks.
2. Database files live under the configured external data root, never in source control and never in Relay data directories.
3. Domain services depend on repository and unit-of-work interfaces. SQL and SQLite-specific pragmas remain inside `packages/storage`.
4. Schema migrations are forward-compatible for blue/green application rollout. Every important migration is preceded by an online backup and followed by integrity, foreign-key, and application canary checks.
5. Outbox records and the business mutation that caused them share one database transaction. Workers claim bounded batches and recover abandoned claims after restart.
6. Health distinguishes process liveness from database readiness, evidence-disk readiness, migration compatibility, worker progress, and capacity thresholds.
7. Move to PostgreSQL when measured sustained lock contention, multi-instance requirements, cross-host recovery, dataset size, or concurrency exceeds documented thresholds. The migration requires its own ADR and rehearsal.
8. A release is not operationally complete until the real service, backup, isolated restore, and rollback evidence required by its gate are recorded.

## Consequences

### Positive

- Simple single-node deployment with strong local transactions and mature backup tools.
- Domain and API tests can use real constraints without a separate database service.
- Repository seams preserve a credible PostgreSQL migration path.

### Costs and risks

- Long transactions and unbounded worker batches can cause write contention and must be measured.
- Database and content-addressed evidence require a coordinated consistency manifest.
- Multi-instance active/active is intentionally unavailable in the first release.

## Rejected alternatives

- **PostgreSQL immediately:** adds service, credential, upgrade, and recovery complexity before a measured need.
- **JSON/files as the primary business store:** cannot provide the required constraints and atomic business/Event/Outbox transaction.
- **Shared Relay SQLite:** violates ownership, availability, authorization, and restore boundaries.
- **Database-specific calls from domain code:** obstructs tests and a future storage migration.
