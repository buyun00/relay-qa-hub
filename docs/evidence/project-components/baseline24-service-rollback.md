# Baseline 24: isolated service rollback and new-business retention

**Passed in the service/HTTP scope: 47 checks.** A real schema-14 API created new local business and human workflow records. After normal shutdown, its complete instance was preserved byte-for-byte. A separately compiled old API then served a separately restored schema-12 archive. Finally, the schema-14 API resumed with its original session and read back the new IDs, versions, task states, comment and attachment bytes.

This follows design §10.3, §16 and baseline 24: restore service while retaining the newer instance's operations and evidence. It does **not** promise to downgrade or merge schema-14 business into schema 12. Starting the old schema-12 executable against the old archive is additional compatibility evidence; the design does not require old software to interpret newer data.

## Independent source, roots and guard

All work took place under:

`C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\migration-rehearsal-81deb464\baseline24-5fd706c2`

- `legacy-source`: exported from Git commit `62b4495c9b28dc3aea1d5633e870be4e1fdf841f`. Its storage and API were compiled successfully with Node 24.19.0 and the pinned TypeScript compiler. Old storage output replaced the dependency copy completely, avoiding a mixture of new storage and old API code.
- `modern-snapshot`: copied compiled API/storage and runtime dependencies, bound to application-source commit `3b1371cbbaee4ab31f5861fe3cd72d6ff93c4789`. Every old/new source and executable file was hashed and checked before the run. The provenance file covers 3,233 legacy files and 2,425 modern files.
- `legacy-instance/data`: fresh official restore of the pinned schema-12 archive, with no migration to 14.
- `modern-instance/data`: separate fresh official restore and migration to schema 14.
- `retained-modern-before-rollback`: complete stopped modern instance, copied and verified before the first old API listen. The two database copies had been prepared during setup; no restore ever targeted or overwrote the modern root.

The original pinned source and existing rehearsal `migrated` / `rollback` copies were unchanged. The source archive SHA-256 remained `4f4023a122fbcd37bd8225909d540d778fa9d6024ab75846893e1326a6c58a65`. Both fresh data roots retained their original paused hold bytes; neither hold was released. Each official restore revalidated the original 878 referenced attachment files.

Each API child received an environment allowlist with its own data, evidence, backup, session credentials, people config, profile, temporary directories and update paths. No parent QA/proxy/credential settings were inherited. Before importing API main, the fixture checked resolved paths, schema, disabled backups, independent credentials, paused hold and exact loopback host/port. The modern API used `127.0.0.1:55900`; old API used `127.0.0.1:55904`. Web, MCP sidecar and desktop processes were not started.

The old program does not understand the new hold marker. It therefore ran behind a mandatory preloader that denied outgoing fetch/HTTP(S)/socket/TLS calls, executor child processes and listeners outside the specified fixture address. The old HTTP listener additionally allowed only official login and the selected read-only routes. Self-test verified ten main-process denials and that a Node worker inherits the preloader and rejects fetch. A second agent reviewed the exact guard and entry hashes before startup; the final guard hash was `6e02deaabf376a3c8176cebaca7b4f361c7f306b2dc1dc05c04e2ee09ce20be3`, and the entry hash was `4cc2268187311458fda6b8767568a4880f4d00a12cbc1d4cc74e88b188883c46`.

This is a guard for the inspected application and worker paths, not a general sandbox for arbitrary hostile native code. Every actual API/worker guard report recorded zero attempted outgoing operations and zero attempted executor subprocesses.

The old API still made expected **local** initialization writes: it copied its archived vendor uploader executable into its independent `data/integrations/increment-upload/bin`, initialized a new empty `queue.sqlite` with scheduler tables/index, and wrote an empty scheduler lease. Official login created a local session and could ensure compatible roles. No uploader executable ran, no existing external queue or credential directory was imported, and the Relay integration environment was empty.

## Actual sequence and retained new records

New business was created through the running API at `2026-09-08T20:16:35.868Z`–`20:16:39Z`. Writes used the documented HTTP adapter `POST /api/v1/mcp/call`, which invokes the same standard business routes; direct standard HTTP GETs read back details, comments, attachments and repair attempts. This run did not separately exercise a JSON-RPC MCP client.

Official project/name login created a test employee in the isolated migrated database. All five optional components remained disabled. A real 68-byte PNG went through upload init, chunk, finalize, binding and Bug creation. One Bug completed the human repair/verification/closure flow. A second retained an unfinished human verification deliberately, proving that an open local task and its evidence survive the rollback/resume sequence.

Account `10000000-0000-4000-8000-000000000020`, project `10000000-0000-4000-8000-000000000004`, actor/verifier `b829a7a1-64eb-422f-845a-3644433093c3`:

| Record                  | Canonical ID                           | Before rollback and after resume                 |
| ----------------------- | -------------------------------------- | ------------------------------------------------ |
| Closed Bug              | `afe2d5d9-0026-45fb-8eca-e54259a13e24` | `closed`, version 6                              |
| Its human RepairAttempt | `f54ec8f8-f529-4a1f-80e9-a832e135882f` | human/delivered, version 3                       |
| Its Verification        | `c0dbd87e-9976-441a-8563-deb1cf13e3c7` | `passed`, version 3                              |
| Unfinished Bug          | `c5e91043-4ca8-4f41-b69e-51c6fe0b0a04` | `ready_for_verification`, version 5              |
| Its human RepairAttempt | `f08a2c7b-ab35-4edf-ab05-36df78eafa54` | human/delivered, version 3                       |
| Its Verification        | `65da26bd-582d-4e15-b422-7e01039db42a` | `in_progress`, version 2                         |
| Comment                 | `8771d67a-8cce-4df0-b768-a462aabbaa9c` | version 1, original actor and body hash retained |
| Attachment              | `4c43c80e-ac49-41f7-8f0f-42f964213688` | binding retained; 68 bytes; identical SHA-256    |

Attachment SHA-256: `6b1048f8a6d40bac0b2954c18fefa40c4ea7a96120fc2e54b7317c0e43c2bbec`. Comment body SHA-256: `c5d8614dc2ecbbf5450d38a8f5df63c571edadd16b2a81188b7b4448eaa282e3`.

The full JSON also records before/after IDs, versions, actors and states for the upload session, attachment binding, two occurrences, sixteen new events, employee/membership and five new local notification outbox rows. Those outbox rows target `qa-hub.notifications`, remain pending at attempt count zero, and are not Relay/build/upload jobs.

| Main database records          | Before new HTTP actions | Retained / after resume |
| ------------------------------ | ----------------------: | ----------------------: |
| Bugs                           |                     390 |                     392 |
| Comments                       |                      39 |                      40 |
| Attachments / blobs            |               947 / 878 |               948 / 879 |
| Human and other RepairAttempts |                     375 |                     377 |
| Verifications                  |                     324 |                     326 |
| Events                         |                   3,271 |                   3,287 |
| Outbox                         |                   2,021 |                   2,026 |

All pre-rollback and post-resume business-table fingerprints match, including the five pending local notification rows and the original 2,021 sent outbox rows.

## Retention, old executable readback and resume

The completed three-phase service sequence ran from `2026-09-08T20:18:12.780Z` to `20:18:31.666Z`:

1. Modern PID **18820**, port **55900**, returned ready/schema 14, reauthenticated the exact existing test employee, read the already-created records, and stopped normally. The original creation records were reused, not recreated.
2. The stopped modern instance was copied to `retained-modern-before-rollback`: **910 files, 753,461,759 bytes**, all file hashes matched. Main SQLite WAL was zero bytes. The copy includes the main database, referenced evidence, actual component-state files, independent runtime config/credentials and logs. The manifest SHA-256 is `1ad36a44c5265a3a0a35009d750afbeff07595eb45c704035ae88e547ba45885`.
3. Old PID **6780**, port **55904**, returned ready/schema **12**. Official name login preserved archived canonical user ID `0745fc62-601d-47f7-876c-66438698b10a`. It read 100 archived Bugs and the real archived Bug `fc3ddd29-9ada-4c6a-b3f0-b64d352b8a7f` at version 8. Attachment `21351a19-3fe5-48b4-b978-d64ec1944afe` downloaded successfully: 3,487,861 bytes, SHA-256 `73470971577ea3ceb30edf4e8cb713d449a3b6e66c566cac5e897e136566e2ce`. An unauthenticated download returned 401; a new schema-14 Bug ID returned 404 as expected. The fixture blocked the old packaging route with 403. The old API stopped normally, with original business/task/outbox fingerprints unchanged.
4. Before resuming, every modern source-instance file and retained-copy file still matched the pre-old-service manifest. Modern PID **7336**, port **55900**, then returned ready/schema 14. The original pre-stop session resolved the same employee. Direct authorized HTTP reads confirmed both new Bugs, comment, attachment bytes and exact historical RepairAttempt/Verification IDs, versions and states. This PID also stopped normally.

All three final PIDs exited **0**, with no forced stop, and both API ports were verified closed. A subsequent read-only immutable comparison matched every selected new identity/version/actor/state between the retained database and the resumed database. The entire retained 910-file copy was hashed again after resume and remained byte-for-byte identical. These two final checks supplement the 45 service checks, for **47 total**.

## Preserved failures, evidence and boundaries

Two harness failures remain retained:

- PID 11908 exited 1 before API main/listen. Disabled backup configuration returns only `{enabled:false}`; the fixture initially read a nonexistent parsed `backupRoot`. It was corrected to validate the explicit environment/config backup path. The new entry hash was independently reviewed before retry.
- PID 12148 successfully created the real new records, then exited normally after a harness assertion dereferenced the cleared active RepairAttempt pointer of a closed Bug. The fixture was corrected to use the existing authorized `GET /api/v1/repair-attempts/:id` historical route. The exact previously created records were retained and reused by the successful sequence. Product source was not changed.

[baseline24-service-rollback.json](baseline24-service-rollback.json) contains 59 HTTP request status/size/hash records across creation and completion, canonical before/after row identities, task versions/actors, process exits, guard reports, retention and original-copy hashes, all 47 checks and exact artifact paths/hashes. Private runtime retains `prepare.raw.log`, `guard-selftest.raw.log`, all restore/migrate logs, `rehearsal.attempt2.raw.log`, `rehearsal.attempt3.raw.log`, both failed reports, per-process logs, `compiled-provenance.json`, `retention-manifest.json` and `new-record-identities-before-after.json`. The executed fixture scripts are also retained there. They use exclusive fresh destinations and must not be rerun in place as though the completed fixture were empty.

Committed evidence contains no HTTP/MCP response bodies, real names, session tokens, CSRF values, cookies, passwords or credential values. It records IDs, counts, versions, codes and hashes. Nested JSON strings are recursively considered during redaction, and both instances' independently generated secret values were checked for absence. Business bytes and credentials remain outside the Git worktree.

This proves isolated service restoration and preservation/resumption of **new local human workflow task evidence**. It does not prove migration or restoration of legacy external upload/Relay/Qingyu filesystem queues, private workspaces, external credentials or remote task state; those remain outside the pinned recovery set and matrix 21 remains incomplete. It does not claim schema-14-to-12 downgrade/merge, production cutover, physical APK rollback, a Web client rollback exercise, or complete coverage of every client in baseline 24. Production and the primary preview instance were not modified, and no application source or commit was changed by this rehearsal.
