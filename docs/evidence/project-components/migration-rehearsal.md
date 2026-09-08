# Offline archive migration rehearsal

Scope authorized by the coordinator: validate a completed production recovery archive, pin it under the preview runtime, restore/migrate only isolated copies, and verify rollback. No active production SQLite file, WAL, queue, credentials directory, service or external executor is copied or started. Business bytes remain outside the Git worktree.

## Pinned source

- Inventory candidate `2267bc98-a0b9-45dc-b951-f3f7da669d99` had already expired from rolling retention when this rehearsal began. No live database was substituted.
- Selected archive: `E:\Relay-QA-Hub-Archives\production\rpo\2026-09-08T17-02-43.337Z.81deb464-a1a0-47a0-ad51-54ae62536fa5.sqlite`.
- Archive creation `2026-09-08T17:02:43.337Z`, schema 12, applicationId 1363232834, 29,790,208 bytes.
- SHA-256 before and after copying: `4f4023a122fbcd37bd8225909d540d778fa9d6024ab75846893e1326a6c58a65`; pinned source matches. Manifest SHA-256 `40a331a5282c3f748f87927927c9db27fd93c3b7bdbf415320452a6d95675c25`.
- Official `validateArchivedSqliteRecoveryPointWithAttachments` verified the complete database/manifest/attachment binding set. Attachment inventory SHA-256 `38638e2b9aa6475f596528dc259f8c388fe6d02aa36fb2381b8363321eca2dfa`; 878 entries, 693,410,217 bytes. Every referenced source and copied attachment matched its declared size and SHA-256.
- Runtime root: `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\migration-rehearsal-81deb464`. `source\rpo` contains the pinned, immutable input; `migrated` contains the schema-14 copy; `rollback` contains a separately restored schema-12 copy.
- Ancestors and copied paths were checked for reparse points and containment; destination creation is exclusive. The first pin script invocation failed before work because a Windows ESM import needed `file:///`; that import was fixed before successful validation/copy.

The recovery set covers main SQLite and its referenced attachments. Separate increment-upload queue/owner/workspace files, Relay batch/upload directories, third-party state and production credentials are outside this archive and were not copied. This rehearsal does not prove their migration.

## Isolation contract and reusable command

`scripts/project-components/offline-import.mjs` accepts all five explicit arguments: `--archive`, `--expected-sha256`, `--allowed-root`, `--data-root`, `--mode` (`restore`, `migrate`, `verify`). It validates a strict manifest-bound archive, rejects links and path overlap, restores through official storage helpers, blocks network calls in its own process, and starts no executors. A repeated destination must retain the same pinned source and a paused hold.

Each restored data root receives `.qa-hub-import-hold.json` before migration. Contract:

```json
{
  "markerVersion": 1,
  "operation": "project-components-offline-import",
  "state": "paused",
  "source": {
    "archiveId": "<pinned archive basename>",
    "createdAt": "<archive UTC timestamp>",
    "databaseSha256": "<SHA-256>",
    "attachmentInventorySha256": "<SHA-256>"
  },
  "heldExecutors": ["relay-outbox", "upload", "build", "qingyu-sync", "scheduled-jobs"],
  "requiresExplicitRelease": true,
  "createdAt": "<restore UTC timestamp>",
  "release": null
}
```

The offline command never releases this hold or changes original task/outbox business states. Runtime/pump/claim enforcement is being integrated separately by the coordinating agent: a present marker with a state other than explicit `released` must block execution. No API, worker or pump may be started against these copies before that enforcement is present and release is explicitly authorized.

## Observed restore result

The `migrated` destination was first restored at schema 12 with official helpers. Integrity `ok`, foreign-key violations 0, 878 restored attachments verified. Original-column, order-independent row fingerprints matched all 58 original business tables; role and migration-history tables also matched before migration. The comparator permits only additive rows in `membership_roles` and `schema_migrations` during a later schema migration, retaining every original row digest. It refuses immutable inspection when a nonempty WAL exists.

Selected source counts: 390 Bugs; 28 users and 28 memberships; 3,271 events; 39 comments; 947 attachment records backed by 878 distinct blobs; 382 Bug attachments; 217 capture bundles; 778 capture artifacts; 375 repair attempts; 324 verifications; 2,021 outbox records. Actual business content, credentials and row values are never written to this evidence document; detailed hashes/counts remain in runtime `pin-validation.json` and destination `.qa-hub-offline-import.json` / `offline-import-reports`.

## Final migration and rollback

The coordinated schema-14 build was used. Migration history records version 13 at `2026-09-08T17:32:03.817Z` (59 ms) and version 14 at `2026-09-08T17:32:03.864Z` (43 ms). Checksums are `ce4f7c937968fc70efdd0103effa8d7e4ab306b9bacfeffeb0e0af56a748ba6a` and `2ec8c004579950e18c6a270901d866a270fce0cca87a1514e54a1b740895cef9`. The automatic pre-migration backup `migrated\migration-backups\qa-hub.sqlite.v12-to-v14.4cc2d906-8dbb-446a-9abf-015e9d3000ee.sqlite` exactly matches the pinned source database SHA-256.

The first migration completed in SQLite, but its post-migration attachment helper rejected the old inventory: `ATTACHMENT_RESTORE_SOURCE_INVALID: attachment inventory manifest bytes do not match the backup database inventory`. That helper reconstructs inventory bytes including database schema provenance; a schema-12 archive inventory consequently differs from one reconstructed from schema 14. The original inventory was preserved. The corrected offline command verifies the copied files against the pinned source database/inventory, then separately proves that every old database reference table is unchanged. It now writes a migration-stage report before further validation. The original first-run error and observed schema history are retained as evidence; the subsequent migrate call was an idempotent 14→14 run with no applied migrations.

Final migration verification at `2026-09-08T17:36:40.244Z` passed: schema 14, integrity `ok`, foreign-key violations 0, all 878 attachments match, and all 58 original business-table fingerprints match. All original role/history rows are retained; exactly 56 membership roles and two migration-history rows were added. Eight original identity links now also appear in the new project-scoped identity table. There are zero component configuration rows, so optional components remain disabled and unconfigured. The held import preserves all original task/outbox statuses without replaying them.

The independent `rollback` restore completed at `2026-09-08T17:37:15.740Z`: schema 12, integrity `ok`, foreign-key violations 0, 878 attachments verified, all original table fingerprints and counts equal the source. Its database SHA-256 exactly equals the original archive and pre-migration backup. The migrated copy remains available independently. Both restored roots retain `state: paused`, and neither has started an API, worker, connector or outbox pump.

Repeated restore against the same held source and repeated migration were accepted without business changes. Wrong expected archive hash, target outside the allowed root, and target containing the source were each rejected before mutation. Runtime `negative-guards.json`, `migration-stage-and-rollback.json`, `.qa-hub-offline-import.json` and timestamped `offline-import-reports` retain the checks. By the final recheck, the rolling origin archive had expired; the already pinned source remained unchanged and was the only subsequent restore input. No live database was substituted.

This is an offline recovery-set rehearsal, not a production cutover. All 2,021 archived outbox records are already `sent`; the archive cannot prove that a pending imported job is blocked. Claim/pump hold behavior requires its own bounded fixture tests, and external component directories remain outside the proven recovery set. No hold was released and no runtime endpoint was pointed at these copies.
