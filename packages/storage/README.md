# `@relay-qa-hub/storage`

This package owns storage-facing ports and configuration validation. It does
not open a database, run migrations, create directories, or share state with
Relay.

The `UnitOfWork` contract keeps repositories transaction-scoped so business
state, append-only events, and outbox records can later be committed together.
The configuration boundary requires an absolute data root outside the source
tree and keeps SQLite WAL mandatory for the single-node first release.
