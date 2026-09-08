# Automatic recovery point retention

Production policy: `latest-two-and-09-shanghai`, enabled by
`QA_HUB_BACKUP_RETENTION_ENABLED=true` in `scripts/qa-hub-persistent-runtime.ps1`.

The API continues to make a WAL-safe full SQLite backup, then copies the database,
manifest, and referenced attachments to the off-disk archive. After a successful
archive, the archive worker applies retention to both the local backup and archive
`rpo` directories. The API event loop does not perform this cleanup.

- Keep the two newest automatic recovery points and the first successful point
  at or after 09:00 Asia/Shanghai. Overlapping selections count only once.
- Keep the previous anchor overnight, replacing it when the next day's 09:00
  recovery point succeeds. Historical daily anchors do not accumulate.
- The next backup timer is capped at 09:00; if a backup crosses that boundary,
  schedule a catch-up immediately after it finishes. Failed attempts retain the
  normal retry interval. After downtime, the first successful backup supplies
  the missed anchor; the system cannot reconstruct an exact historical 09:00 state.
- Both volumes' retained points must pass validation before any deletion. Each
  obsolete group is also validated before removing its database, manifest and
  attachment companion. An archive failure skips retention entirely.
- Only timestamp/UUID automatic names in the exact ordinary `rpo` directories
  are eligible. Reject redirected paths and nested junctions/symlinks. Leave
  incomplete/corrupt points, staging, failed-attempt evidence, manual names,
  configuration, and application rollback packages intact.
- Create an immutable plan and append validation/deletion/error/reconciliation
  records under `D:\Relay-QA-Hub-Backups\production\retention-audit`. Errors are
  reported separately from successful backups and do not disable the cadence.

Validation: API TypeScript build and ESLint passed; 10 backup/retention tests and
26 API/production-task regression tests passed. Tests cover day rollover,
deduplicated anchors, timer alignment, complete-group deletion on both roots,
idempotency, corruption, junction refusal, and isolated cleanup errors.

Production cleanup evidence is saved under
`D:\Relay-QA-Hub-Data\operations\backup-retention-20260908`.
The historical 2026-09-08 anchor is 09:10:20.746 Asia/Shanghai because the previous
cadence did not align to 09:00.
