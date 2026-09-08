# Held migration API service readback

Result: **passed**. On 2026-09-09, a new copy of the pinned schema-12 recovery archive was restored, migrated to schema 14, and opened by an isolated API with the import hold still paused. The API returned real archived Bug, comment and attachment data through official authenticated HTTP routes. Its owned process exited normally and its listener closed. This supplements the [offline rehearsal](migration-rehearsal.md); it does not replace the offline migration/rollback evidence.

## Preserved inputs and compiled sample

- Pinned archive: `source/rpo/2026-09-08T17-02-43.337Z.81deb464-a1a0-47a0-ad51-54ae62536fa5.sqlite`, below the existing `migration-rehearsal-81deb464` runtime.
- Archive SHA-256: `4f4023a122fbcd37bd8225909d540d778fa9d6024ab75846893e1326a6c58a65`.
- Final new runtime: `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\migration-rehearsal-81deb464\service-readback-8b94d602`.
- Official `scripts/project-components/offline-import.mjs --mode restore` and `--mode migrate` both exited 0 against this new runtime's `data` directory. The source archive, expected SHA-256, allowed root and data root were explicit arguments. All 878 archived attachment files were validated again. No SQL data was fabricated.
- The original pinned source and existing `migrated` / `rollback` copies were not used as running service databases. Their database hashes remained unchanged: source/rollback `4f4023a122fbcd37bd8225909d540d778fa9d6024ab75846893e1326a6c58a65`; migrated `290b4dec2de9f8f500b1e906b84233b76e103c49b35dde3986f90a7eb127e42a`.
- API and dependency artifacts were frozen at `2026-09-08T19:24:26.030Z`: 54 runtime packages, 2,425 files. The snapshot manifest SHA-256 is `fae57ebef03ed02cd268517a5779ec3985a9e9346705336ac26c6f4fd1a8f65f`; `main.js` SHA-256 is `8d39377d306c5424c1c2689f6d303e8e40d0ded610695a9f4464c758ca94cf38`. Every frozen file was checked before startup. Subsequent worktree builds did not alter this sample.

The frozen sample still contains the original runtime `onReady` / `onClose` hooks. Its runtime starts, but the paused import gate returns before dispatch. This readback does not validate the later change that moves component start until after successful listen and improves startup failure cleanup; that change has separate lifecycle tests.

## Isolation and execution hold

Instance `qa-hub-preview-migration-readback-8b94d602` used an independent config, random GM ID, session secret, debug token, GM password and cookie name. No existing credential file was copied. API bound only to `127.0.0.1:51708`; distinct reserved Web/MCP/desktop ports were 51709/51710/51711, and those services were never started. Automatic backups were explicitly disabled. The component data root and credential directory began empty.

The actual API data root was the restored `data` directory containing `.qa-hub-import-hold.json`. Its state remained `paused`, release remained null, and its byte hash stayed `18f0faa1fac37420c54ffd85b878a1122c1d688eb82f137d97e4746238008ad9`. The worker and component runtime both received that data-root hold. All five component states read through HTTP were disabled, and the main SQLite database still had zero component configuration rows.

A fixture-only bootstrap additionally rejected all outgoing `fetch`, HTTP(S), socket/TLS connections and executor subprocess creation. Incoming loopback HTTP and SQLite worker threads remained available. The final guard report records **zero outgoing network attempts and zero executor subprocess attempts**. No external endpoint, production queue, external task or migration hold release was exercised.

## Actual authorized HTTP reads

Final service window: `2026-09-08T19:35:15.954Z`–`2026-09-08T19:35:33.634Z` (2026-09-09 03:35 local). Owned API PID: **8532**.

| Check                                                                                                            | Observed result                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /api/v1/health/ready`                                                                                       | HTTP 200; `ready`, schema `14`; database, evidence and worker all `ok`                 |
| Official `POST /api/v1/auth/login` with an existing archived name, selected project and Android session response | HTTP 200; existing stable user ID retained; selected project correct; `isGm: false`    |
| `GET /api/v1/projects/:projectId/components`                                                                     | HTTP 200; all five components disabled                                                 |
| `GET /api/v1/bugs?limit=100` with session Bearer and `x-qa-project-id`                                           | HTTP 200; 100 archived project Bugs read                                               |
| `GET /api/v1/bugs/:bugId` with the same authorization                                                            | HTTP 200; ID, version, title and description compared in memory with the archive       |
| `GET /api/v1/bugs/:bugId/comments?limit=500`                                                                     | HTTP 200; two actual comments; bodies, author IDs and timestamps matched archived rows |
| `GET /api/v1/bugs/:bugId/attachments?limit=100` and `GET /api/v1/attachments/:attachmentId`                      | HTTP 200; one bound attachment; downloaded bytes matched archived size and SHA-256     |
| Bug detail and attachment download without session authorization                                                 | HTTP 401 `UNAUTHENTICATED`                                                             |
| Existing Bug ID with another explicit project header                                                             | HTTP 404 `NOT_FOUND`                                                                   |
| `GET /api/v1/projects/:projectId/production/project`                                                             | HTTP 409 `IMPORT_EXECUTION_HELD`, before a connector request                           |
| `GET /api/v1/projects/:projectId/production/outbox`                                                              | HTTP 200; local history remained readable; zero version-bound rows                     |

Canonical IDs only:

- Account: `10000000-0000-4000-8000-000000000020`.
- Project: `10000000-0000-4000-8000-000000000004`.
- Archived employee: `07b48903-5331-4b4c-8993-bf162db319bc`.
- Bug: `fc3ddd29-9ada-4c6a-b3f0-b64d352b8a7f`.
- Comments: `01870094-137d-4b9e-8680-ce8b1b782f2b`, `d619ab6a-7985-42d3-853d-63d5365a2511`.
- Attachment: `21351a19-3fe5-48b4-b978-d64ec1944afe`; 3,487,861 bytes; SHA-256 `73470971577ea3ceb30edf4e8cb713d449a3b6e66c566cac5e897e136566e2ce`. Response hash header matched the downloaded bytes.

Names, Bug/comment text, attachment filenames/bytes and login tokens were not written to committed evidence. Response records contain only route, status, size, hash and error code.

## Preservation and shutdown

The HTTP harness passed 25 assertions. A further read-only original-column fingerprint comparison confirmed that all original users, memberships, roles and browser sessions remained present unchanged, bringing the evidence total to 26 assertions. Integrity remained `ok`, foreign-key violations remained zero, and schema remained 14.

Before/after table fingerprints were identical for Bugs, deletions, comments, attachments, blobs, Bug bindings, capture bundles/artifacts, repair attempts, verifications, outbox, events and component configuration. The only post-migration startup/login table changes were official bootstrap/authentication additions: one independent GM user, one GM membership, seven GM compatibility roles, and one employee browser session. All original 28 users, 28 memberships, 140 pre-migration roles and 504 sessions retain their original-column row hashes. The migration's 56 additional roles are covered by the offline migration evidence.

All 2,021 archived outbox records remained `sent` with the same full-table fingerprint. The new component runtime contained zero build tasks, zero sync tasks and zero component audit records. The controller requested SIGTERM through its own child's IPC channel; PID 8532 exited **0**, no forced stop was used, and a subsequent readiness request confirmed that the owned listener had closed. The source, existing migrated/rollback roots and all three readback attempts remain retained.

Two earlier harness attempts are preserved, without being counted as passing runs:

- `service-readback-3329a538`: login/components succeeded; the harness used nonexistent `/projects/:id/bugs` instead of the official `/bugs` route plus project header. HTTP 404 stopped the run; PID 2876 exited 0, with preservation and hold checks passing.
- `service-readback-6d17e2a9`: all actual Bug/comment/attachment reads succeeded; an extra negative assertion again used a nonexistent project-prefixed Bug route and expected 400 while receiving 404. PID 23916 exited 0. The final attempt uses the real global Bug route with an explicit wrong project header and verifies `NOT_FOUND`.

## Retained evidence and limits

[migration-service-readback.json](migration-service-readback.json) contains exact timestamps, IDs, status/size/hash records, 26 assertions, table counts/fingerprints and artifact hashes. The final runtime retains `controller.log`, `logs/api.stdout.log`, `logs/api.stderr.log`, `offline-restore.log`, `offline-migrate.log`, `outbound-guard.json`, `compiled-snapshot-manifest.json`, the controller/bootstrap scripts and the complete restored data. Earlier runtimes retain their original failed reports and logs. Independent secrets and actual business files stay outside the Git worktree.

This proves a held **schema-14 API service recovery readback** from the pinned archive. It does not claim that a schema-12 executable was started against the rollback copy, that production cutover occurred, or that any external component ran successfully. The archive contains no pending outbox records, so it cannot alone prove pending-job hold behavior. External component queue/workspace directories and credentials were outside the archived recovery set and remain outside this result.
