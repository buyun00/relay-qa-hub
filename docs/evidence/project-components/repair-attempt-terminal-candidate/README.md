# RepairAttempt terminal candidate evidence

Status at 2026-09-09T13:22:48+08:00: **candidate passed**. This is an additive, unnumbered post-schema-17 migration, storage adapter, and API route candidate. It has not been registered in the migration chain, storage index, worker, application route table, automation route table, or deployed to preview or production.

The repaired implementation emits one terminal effect event. `failRepairAttempt` and legacy `supersedeRepairAttempt` use `from_state='in_progress'` and `to_state='ready'` because the frozen Bug transition releases the active RepairAttempt and moves the Bug to `ready`. Atomic vendor supersede leaves the Bug in `in_progress`, replaces the active pointer, and therefore uses `NULL`/`NULL`. Every terminal event has exactly `status`, `repairAttemptId`, bounded `reason`, `fromVersion`, and `toVersion` in its payload. This is the split required by the existing schema-17 Bug and RepairAttempt guards and the frozen domain decisions; no base guard or schema 15, 16, or 17 source was changed.

The legacy follow-up create path now emits the existing typed creation payload: `status`, `repairAttemptId`, `fromVersion`, and `toVersion`. Parent identity, mode, assignee, and summary remain bound by the RepairAttempt row and immutable parent-plan snapshot rather than being copied into the bounded Event payload.

The immutable terminal snapshot retains the raw reason and full response facts while the Event stores only bounded/redacted audit text. Receipt replay returns the response media selected by the first successful request, even when a later `Accept` header prefers another representation. The request receipt digest is a canonical internal digest over operation, tenant/actor/target scope, request intent, and idempotency key; media negotiation remains outside that intent digest.

## Frozen migration boundary

The fixture migrates a fresh real SQLite file through schema 17 and applies only `REPAIR_ATTEMPT_TERMINAL_SNAPSHOT_SQL`. The candidate is not present in `SQLITE_MIGRATIONS` and has no assigned version. The schema 15, 16, and 17 files are byte-for-byte equal to `HEAD`, and their checksums remain:

| Version | Name | Checksum |
| ---: | --- | --- |
| 15 | `immutable_verification_result_snapshots` | `5a6d8ed5b7ff4815d20ff613a2ad0c841512a919eb7e1cfa0adb72aa3c26fe6d` |
| 16 | `blocked_verification_result_receipts` | `7297cf8cda0470ad0606b7ec6ded7766aa79f7de46e6521e9205332e735ea49c` |
| 17 | `immutable_workflow_projection_pages` | `d193e8763af1525014a572b899cbe20fae32660f8847025ce6b1675c23f6566f` |

## Verification

The authoritative fresh run is in `runs/focused-http-13.log.txt`: 13 tests passed, zero failed, in 9326.9507 ms. The suite uses real random loopback HTTP, real browser/bearer authentication, fresh schema-17 SQLite files, the candidate SQL, and integrity checks after server shutdown. It covers planned/running failure, bounded secret and multibyte audit reasons, legacy and vendor supersede, atomic successor creation, legacy parent follow-up, rollback, concurrent/repeated requests, authorization rechecks, soft deletion, immutable snapshots/receipts, explicit media negotiation, and replay of the first negotiated media with the canonical digest.

Fixture TypeScript, storage TypeScript, API TypeScript, focused ESLint, focused Prettier, scoped `git diff --check`, and the evidence/hash verifier all exited zero. Machine-readable conclusions are in `result.json`; exact source hashes and frozen migration history are in `source-freeze.json`. The older top-level logs are retained as intermediate and failure evidence; `runs/` is the final repaired run set.

## Remaining integration boundary

- An integrator must coordinate the next migration version after the independent candidates and register the migration, storage exports/worker command, and authenticated routes.
- No combined application, MCP, Web, EXE, APK, preview, upgrade, rollback, or production workflow was exercised by this candidate.
- No production data, preview data, installed client, or daily client was changed.
