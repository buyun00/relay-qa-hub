# Shared Web project switch and unsubmitted draft E2E

Actual run `9320822e-6d6d-4f78-a6cb-eb59cb0a7013` passed **164/164 checks**, exit 0, from `2026-09-09T03:00:41.290Z` to `03:00:48.840Z`. The executing agent used a new dedicated headless Edge profile and real shared Web/API, CDP 9370. The follow-up file audit passed **400/400 checks** and visually inspected all eight screenshots; it is a same-agent artifact review, not a second live execution or independent operator certification. The original [proof](proof.json), screenshots and runner copies are unchanged.

The gate pinned API 4419 PID 22852/start `2026-09-09T01:22:20.2728640Z`, Web 4274 PID 20284/start `2026-09-08T17:52:36.5080910Z`, instance SHA `2b8e97ce9b62d072b74eaf00015fb04f5b818d318203f2a91e59d15873da349b`, and [published Web proof](../../web-detail-fix-publication/e2d5cb4b-9068-4f14-9f90-d292ee4af864/deploy.json) SHA `0ec3abdbdbe85e1d3ab79155a8dcc2f31c21e999e634834ddb488000e90cff63`. All eight current Web assets passed real hash checks; the browser actually loaded `index-Br-CEXQI.js`, SHA `813277e9792c91d27b2e153322a0a2bfcad277ec57723df712f7d84ae24ad3ae`.

## Fresh scope and actual inputs

| Scope | ID |
| --- | --- |
| Project A | `2cba798b-4188-43e8-af1b-6fd3bed18976` |
| Project B | `d6d2129c-02a9-4f33-878b-353b45f88ef3` |
| Shared employee | `6c9ee84f-bea0-408c-8679-4fb59393f08f` |
| A-only employee / A draft owner | `0b556aaf-fb1e-4fbf-8a27-0c14c3a03d8d` |
| B-only employee / B draft owner | `409c5bc4-019b-463b-8e99-5f98d4415225` |

The shared employee is each draft's verifier. All three employee names contain independently generated nonces. Actual form input was `UNSUBMITTED_A_PROJECT_SWITCH_9320822e-6d6d-4f78-a6cb-eb59cb0a7013` and the corresponding `UNSUBMITTED_B_...` text. Two new valid 16×16 PNGs, each 79 bytes, were selected through the native file input: A red SHA `e6c79220953bc0a966fc8fb5e72c4bbf39d3abdac760277a29a091d5ccf742aa`; B blue SHA `04156bb30bd0571d2c1e381c2bc3f8e6e4c82e1d0a3f4e3bfe61d4229dd09269`. Both IndexedDB File bytes and actual rendered Blob bytes were hashed. These are **unsubmitted local PNGs**, not downloaded or server-bound attachments.

Direct setup made one GM login, two project creates and four employee logins; the browser made one additional shared-employee login. Project creation also adds the existing GM creator `850912b5-61bf-4f6b-aae6-f7c59e1b087e` to each new project. Thus there are three new employees and six new project memberships (four employee plus two creator memberships), not six new employees. Exact personnel options include the actual creator, shared employee, and the respective exclusive employee. There were no Bug, attachment-upload, comment, component-configuration or component-task writes. Final official reads show zero Bugs and all five components off in both projects.

The ledger contains **18 direct API calls, 47 browser request records and 28 intercepted response records**. Its 93 mixed records must not be described as 93 HTTP requests. The eight asset preflights are recorded separately through hash checks.

## Observed late-response trajectory

One actual A members GET was held at its genuine 200 response at `03:00:44.803Z`, Fetch ID `interception-job-20.0`, Network ID `9456.28`, body SHA `b826c55d99bb7001a2701e500130159c756a61e1ee4aa1617916f011c5a0c513`. The actual project selector switched to B at `03:00:45.071Z`. Chromium reported the same Network ID with `canceled: true`, `net::ERR_ABORTED`, at `03:00:45.103Z`. Fresh B state was verified at `03:00:45.257Z`; only then did the ledger accept expected cancellation at `03:00:45.440Z` (637 ms after the hold).

This proves the observed **genuine Abort cancellation path** kept A from replacing B's current project/person choices/draft. It does not prove delivery of an obsolete A callback into B. No Abort was disabled, no successful response was fabricated, and the canceled response was not continued. The final ledger has zero unreleased responses.

| Screenshot | Observation |
| --- | --- |
| [01 A draft](01-A-unsubmitted-text-PNG.png) | A text, A owner, shared verifier and red PNG entered |
| [02 B draft](02-B-unsubmitted-text-PNG.png) | Distinct B text, B owner, shared verifier and blue PNG entered |
| [03 A held](03-A-real-members-response-held.png) | A workbench visible during the correlated genuine response hold |
| [04 B before settlement](04-B-draft-before-A-settlement.png) | B form and blue PNG after actual switch |
| [05 B after settlement](05-B-draft-after-A-settlement.png) | Same B form after expected cancellation was accepted |
| [06 B page reload](06-B-durable-draft-reloaded.png) | B durable draft and PNG restored after actual `Page.reload` |
| [07 A roundtrip](07-A-draft-roundtrip.png) | A text/owner/red PNG restored separately |
| [08 B roundtrip](08-B-draft-roundtrip.png) | B text/owner/blue PNG remain separate |

Thirteen exact-scoped durable draft observations, visible form reads, URL/project-selector checks and project-selection storage checks support these frames. Modal background blur and visibly truncated long names/file labels mean exact IDs and file identity come from the recorded DOM/byte checks rather than inference from pixels. Frames 04/05/08 are byte-identical, as recorded; they are separate actual screenshot calls. They do not establish every intermediate frame.

Edge PID 20980 exited via normal `Browser.close`; no forced kill was used. The runner checked port 9370 release and the same observed API/Web process identities at completion. The profile and all test data remain in the new runtime. This audit did not re-query listeners, inspect active profiles, read credentials or operate any browser/device/service.

## Preserved failures, source and limits

The [first actual run](../97e972b8-4a90-48b7-bebe-8b49c58eed15/proof.json) remains `failed_retained`: it expected two members but observed the legitimate third creator member, before any Edge launch. Its source, gate, raw files and exit-1 log remain preserved. The narrow runner revision recognizes the creator membership inserted by `packages/storage/src/project-management-store.ts:451–457`; it does not filter out arbitrary extra members. The second run used entirely new fixture identities. Its 17 pure tests, syntax, default-inert, ESLint and Prettier checks passed in [the preparation directory](../../web-project-switch-draft-preparation/92f622d8-49b9-4f10-a580-3463722b630d/).

The artifact audit's own first pass mistakenly selected member `id` instead of the actual `userId` field. Its initial source and failed log are also preserved here; the corrected audit uses `userId` and passes against the unchanged raw bytes. This was an audit-reader error, not a rerun or modification of the successful E2E.

- Runner SHA: `a11a1a119045bb99bb383d69b1e1c85a1c93e7da0b3e2213f52e1e887241fc82`.
- Test SHA: `d10188a3c81838698c10157d80f569aadd4b0b283bd78e4a478ea8e0b359a7ec`.
- R2 gate SHA: `bc67dc74bc95ad3ee18dba89ff128947e71e589bc5b9e09bc97cc4f4e9ff918e`.
- Actual proof SHA: `6ce9d4bc6fe346e64ad9e9535c87f8be7a761f3547fda911e2ba0b498663d0fa`.

The [artifact audit](artifact-audit.json) rehashes all 40 non-authentication raw bodies, both private/public screenshot sets, original public/private proof, current/copied source, gates and fixture PNGs. Authentication response bodies were intentionally not stored, so their historical hashes cannot be recomputed. No claim is made for continuous-frame absence of leakage, a 15-second timeout, full browser process restart, cross-user/origin isolation, device or existing-client draft preservation, stale callback delivery after Abort, submission success or real component execution. No product source, existing evidence, matrix, root documentation, deployment or installed client was changed for this run.
