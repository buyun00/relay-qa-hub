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
