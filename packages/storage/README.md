# `@relay-qa-hub/storage`

This package owns storage-facing ports, configuration validation, and the
single-node SQLite implementation. It never shares a database or filesystem
state with Relay.

The `UnitOfWork` contract keeps repositories transaction-scoped so business
state, append-only events, and outbox records can later be committed together.
The configuration boundary requires an absolute data root outside the source
tree and keeps SQLite WAL mandatory for the single-node first release.

## SQLite execution boundary

`SqliteStorageWorker` is an internal execution primitive, not an
application-facing repository and not exported from the package root. It owns
one `node:sqlite` `DatabaseSync` connection in a dedicated worker thread and
serializes requests. Its deliberately incomplete Bug allocator exists only
behind `allowUnsafeTestCommands` for the 50-request migration stress test; the
API process must use the complete UnitOfWork path delivered by P1.2 so Bug,
Submission, Event, Outbox, and idempotency effects commit atomically.
Synchronous SQLite work must not be imported into an API request event loop.
Any worker error or unexpected exit is terminal: pending and later requests
fail closed rather than hanging or silently opening another writer.

The migration runner:

- accepts only an absolute database path and bounded busy timeout;
- pins a QA Hub `application_id`, migration names, versions, and SHA-256
  checksums;
- rejects foreign, divergent, future, and downgrade histories;
- backs up every non-empty version upgrade before applying it;
- applies each version under `BEGIN IMMEDIATE`, verifies foreign keys, and
  mirrors the authoritative migration history to `PRAGMA user_version`;
- requires WAL, foreign keys, FTS5, and a clean post-migration integrity check.

Attachment bytes remain outside SQLite. The schema stores only metadata,
digests, lifecycle state, and bindings to the separately owned attachment
store.
