# Verification result evidence Phase E

Status at 2026-09-09T12:47:23+08:00: **storage candidate passed**. This is an additive, unnumbered post-schema-17 candidate. It has not been added to `SQLITE_MIGRATIONS`, deployed to the independent preview, or accepted through HTTP, MCP, APK, EXE, or Web.

The candidate lets a Verification result claim 9 through 20 unique attachments, up to an exact aggregate limit of 100 MiB, and optionally consume one uploaded capture bundle. The result transaction requires the same account, project, actor, client submission, target Bug, active reservation, finalized upload, clean attachment, and capture identity. When a capture is supplied, the request attachment set must exactly equal every successful capture artifact, the primary system screenshot or recording must be present, no artifact may remain pending, and all capture IDs resolve to the same bundle identity. The transaction claims attachments, binds the capture, writes the Verification/Bug effects, event, notification, immutable result snapshot, submission, and committed idempotency receipt together.

Read paths now include Verification attachments and their capture bundle without changing the immutable original Bug attachment relation. Active project membership is still required. Bug soft deletion hides the attachment, capture metadata, and capture artifact while retaining all database and file evidence. Removing an ordinary original Bug attachment also hides its capture paths without deleting evidence. A later Bug attachment edit cannot remove immutable Verification evidence.

## Frozen migration boundary

The fixture first migrates a real SQLite file through schema 17. The candidate then replaces only the two result-validation triggers and adds the 20-item/100-MiB insert guard in a separate transaction. Source files for schema 15, 16, and 17 remained byte-for-byte equal to the preparation copies. Their migration history rows remained unchanged:

| Version | Name | Checksum |
| ---: | --- | --- |
| 15 | `immutable_verification_result_snapshots` | `5a6d8ed5b7ff4815d20ff613a2ad0c841512a919eb7e1cfa0adb72aa3c26fe6d` |
| 16 | `blocked_verification_result_receipts` | `7297cf8cda0470ad0606b7ec6ded7766aa79f7de46e6521e9205332e735ea49c` |
| 17 | `immutable_workflow_projection_pages` | `d193e8763af1525014a572b899cbe20fae32660f8847025ce6b1675c23f6566f` |

A result with eight real uploaded PNG attachments was committed on schema 17 before the candidate SQL was applied. All table fingerprints and the full schema-history, result-snapshot, submission, and committed-receipt rows were identical after the SQL change. The original result replayed unchanged before and after closing and reopening the database. Direct snapshot update/delete and committed-receipt mutation attempts were rejected.

## Verification

The focused suite used fresh SQLite files and real uploaded/finalized file bytes. It passed 9/9 tests. It exercised every attachment count from 9 through 20, the 21-item rejection, exact 100 MiB acceptance, 100 MiB plus one byte rejection, passed/failed/blocked capture results, set mismatch, duplicate, missing/random capture, wrong actor/project/submission/target/intent, same-key changed payload, membership revocation/restoration, Bug soft deletion, ordinary removal, immutable Verification evidence, reopen replay, forged snapshot/receipt capture facts, and 11 injected transaction failure points.

The related storage regression run passed 131 tests, skipped one pre-existing optional Phase B archive test, and failed zero out of 132 tests. Storage production build, test typecheck, focused ESLint, focused Prettier, and `git diff --check` all exited 0. Exact commands and aggregate output are in `runs/` and machine-readable conclusions are in `result.json`. `source-freeze.json` records the source hashes and migration history.

The retained `preparation/` directory is intentionally unchanged. It contains the earlier failed upload-key, wrong-outbox-table, and TypeScript attempts as well as the pre-change source copies; those failures are part of the audit history and were not replaced by final output.

## Remaining integration and product gaps

- An integrator must assign this SQL the next migration version after coordinating with the independent Phase C migration candidate. Schema 15, 16, and 17 must remain unchanged.
- The current API parser and server MCP schema expose 20 attachments and an optional capture bundle, but this Phase E run did not build or exercise either transport. Their actual HTTP/MCP upload, bind, result, replay, read, and error behavior remains unverified with this candidate.
- The reviewed Web acceptance path still submits no attachments for a passed result; its failed-result path can submit attachments but does not pass a capture bundle. The reviewed Android `BugLifecycleClient` and repair smoke path submit empty Verification attachment arrays. No installed-client capture-result flow was exercised.
- The independent preview described by the handoff was still schema 17 before integration. No preview database migration, service restart, browser operation, installed EXE/APK operation, physical Android device check, upgrade, rollback, or production action was performed here.

