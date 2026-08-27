# Persistent production data and off-disk backup evidence

- Verified on: `2026-08-27` (Asia/Shanghai)
- Production data root: `D:\Relay-QA-Hub-Data\production`
- Previous runtime root retained for rollback: `D:\Relay-QA-Hub-Data\mvp-e2e-20260826021925294\data`
- Local online backup root: `D:\Relay-QA-Hub-Backups\production`
- Off-disk archive root: `E:\Relay-QA-Hub-Archives\production`
- External people config: `D:\Relay-QA-Hub-Config\qa-people.json`
- Backup cadence: API start plus every 15 minutes

## What is persisted

The Web, Windows EXE, and Android APK do not own Bug data. The independent API
and SQLite worker are the only fact writers. The production SQLite database is
`D:\Relay-QA-Hub-Data\production\db\qa-hub.sqlite`; content-addressed evidence
is under `evidence\sha256`, and unfinished upload quarantine remains under
`quarantine`.

At cutover the verified isolated restore contained:

- database schema: `5`
- SQLite integrity: `ok`
- foreign-key violations: `0`
- Bugs: `19`
- latest Bug: `LOCAL-18`, updated `2026-08-27T05:31:21.448Z`
- attachment facts: `51`
- Bug/attachment bindings: `25`
- ready/clean referenced attachment blobs restored and revalidated: `51`

The live API returned the same 19 Bugs and the same latest Bug immediately
before cutover. The fixed production root then became ready and returned the
same facts. The old time-stamped data root was neither changed nor deleted.

## Real backup chain

The current database is WAL-mode. A live copy of only `qa-hub.sqlite`, or three
independent copies of `.sqlite`, `-wal`, and `-shm`, is not a consistent backup.
The API backup runner instead calls `node:sqlite backup()` on its existing
worker, validates size/SHA/application ID/schema/integrity/foreign keys, and
publishes a create-only manifest. It then archives that exact database together
with all referenced ready/clean evidence blobs. The attachment inventory,
completion marker, and DB/attachment binding marker are written and checked
before the point is admitted.

D: is on physical disk 1 (`SAMSUNG MZVLB1T0HALR-00000`) and E: is on physical
disk 0 (`KINGSTON SA400S37960G`), so loss of the D: disk does not remove the E:
recovery points. The people configuration is also external to the repository;
every distinct byte version is copied create-only to the E: archive under its
SHA-256 filename.

The first live E: point that was restored and checked used:

- created at: `2026-08-27T05:44:42.902Z`
- database SHA-256: `07b5e854b84f08cbaf1ebf5ae1634dcf73f29ceb2f4b17c6333db2856a825b5c`
- attachment inventory entries: `51`
- attachment inventory SHA-256: `e07bd4edb2151952450c31b1154c2fb44fc312f8bc0c6fd2f12dd29c00e6ee60`

`scripts\Verify-QAHubRecoveryPoint.mjs` validated the E: point, restored it
create-only to `D:\Relay-QA-Hub-Data\production`, and independently rechecked
the database and evidence. The following API start produced another complete
point at `2026-08-27T05:47:44.989Z` before it listened.

The first recovery point produced by an actually elapsed cadence (not a restart
or a shortened test interval) completed at `2026-08-27T06:02:46.456Z`
(`14:02:46` Asia/Shanghai), 15 minutes after the production API start. The
strict validator selected it with `rejectedRecoveryPointCount=0`, the same
database SHA-256, and all `51` attachment entries. The production `rpo` catalog
then contained four matching database/manifest/attachment-companion groups,
and the newest companion contained its inventory, completion marker, and
database binding marker; recursive WAL/SHM counts remained `0/0`. The API stayed
`ready` and continued to return `19` Bugs with latest Bug `LOCAL-18`.

## ReFS compatibility repair

The live E: ReFS developer volume exposed a Windows copy-offload stall: the
destination file became visible but `CopyFile` did not return, so the API
correctly stayed pre-listen and never reported a complete archive. Two such
attempts remained database-only and were rejected as complete system recovery
points. Their exact DB/manifest pairs were preserved under
`E:\Relay-QA-Hub-Archives\production\failed-attempts\db-only-before-refs-copy-fix`;
they were moved out of the production `rpo` catalog rather than deleted.

Archive database/manifest copies now use create-only buffered writes, and
attachment copies use a create-only stream followed by existing size/SHA
validation. Immutable SQLite file URIs prevent read-only validation from
creating WAL/SHM sidecars on the archive disk. The same current recovery point
then archived all 51 attachments in about 0.4 seconds, and a normal API restart
completed with a full archive and readiness in under 5 seconds.

Focused storage verification after the change: `89/89` passed, including online
backup, isolated restore, attachment restore, combined archive/idempotency, and
missing-blob fail-closed cases.

## Operations

Validate the newest complete E: point:

```powershell
$qaHubNode = 'C:\Users\lin0\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $qaHubNode .\scripts\Verify-QAHubRecoveryPoint.mjs `
  --archive-root 'E:\Relay-QA-Hub-Archives\production'
```

Restore only into a new directory, verify it, then deliberately change the data
root. Never restore over production:

```powershell
& $qaHubNode .\scripts\Verify-QAHubRecoveryPoint.mjs `
  --archive-root 'E:\Relay-QA-Hub-Archives\production' `
  --restore-root 'D:\Relay-QA-Hub-Data\restore-drill-YYYYMMDD-HHMMSS'
```

`scripts\restart-mvp-api.ps1` and `scripts\mvp-e2e-runtime.ps1` both load the
same persistent/backup policy. `PrepareStart` now reuses the current data root;
creating an empty test database requires the explicit `-FreshData` switch.

## Retention and remaining risk

No automatic deletion is enabled yet. The intended safe policy is all 15-minute
points for 24 hours, one point per day for 30 days, and one point per week for
12 weeks. It must delete only complete groups that have passed the database and
three attachment-marker checks; incomplete staging or invalid points must be
quarantined, not selected as recovery points.

E: protects against loss of the D: disk and source-code/rebuild mistakes. It
does not protect against loss, theft, ransomware, or catastrophic failure of
the whole PC. A later NAS/off-host copy can extend the same validated archive
format without changing the QA Hub lifecycle.
