# Shared incremental upload records — 3.3.5

Upload history, progress, results, downloadable diagnostics and automatic build
handoffs are now visible to every signed-in QA Hub user. Existing server records
are aggregated from their original locations; no migration, replay or re-upload
is needed. Login configuration remains specific to the signed-in user. Diagnostic
responses omit platform account bindings, and task mutation rights remain intact.

Validation before release: 54 Web tests, Web TypeScript and changed-file ESLint,
18 upload API/queue tests and 33 API/Jenkins/supervisor regressions passed. Tests
cover cross-user history and diagnostics, queued/running/failed/published states,
pending confirmation, restart, shared build tracking, preserved write permissions
and unauthenticated rejection.

Live comparison and retained task file hashes are in `work/shared-upload-records`;
packaged EXE and release evidence is in `work/windows-3.3.5-release`.

Release verified on 2026-09-08:

- Source `f0416eb4da824291fad3c47d0018688754393b18`, release
  `20260908T110747982Z`; live API reports that source and is ready.
- Both 林步云 and 饶小春 see the same existing 2.4.31, 2.4.32 and 2.4.33
  published tasks and both build handoffs (#10160 and #10161). Both can retrieve
  diagnostics with the original task audit. Persisted task file hashes are unchanged.
- Packaged EXE verification signs in to both real accounts, checks the shared list
  and follows #10161 to its 2.4.32 upload. Isolated response fixtures verify action
  visibility for queued, failed and pending-confirmation states without job writes.
- Live Web assets and package source match. Signed manifests and both downloaded
  artifacts verify; installer SHA-256 is
  `aea3b25ad16e45449c62d893ac5fc01ed1f50bea5185f6f97d7f68e7b822f4cf`.
- Isolated Windows 3.3.4 to 3.3.5 download, install and restart passed. Profile,
  runtime configuration and rollback were retained. All four daily EXE processes
  and startup entries were preserved. No upload, recovery or publication was
  submitted to verify this visibility change.
