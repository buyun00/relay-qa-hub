# Windows/Web 3.2.0 — server-owned incremental uploads

Verified on 2026-09-08. Product source:
`baf48c26783a99086dbf836b150c3cf7861ff4d7`.
Release: `20260908T065914967Z`.

## Delivered behavior

Upload submission, queue, platform accounts, worker supervision, task checkpoints,
test-status workflow, final publication confirmation, diagnostics and external-build
handoff now belong to the API server. Browser and desktop use the same authenticated
API. Windows no longer ships an upload executable or local build/upload supervisor.
Old upload IPC rejects execution with `UPLOAD_MOVED_TO_SERVER`.

Durable request IDs prevent duplicate submission after a lost reply. SQLite stores
the queue, dispatch intents, scheduler ownership and actor audit. Tasks retain their
product/channel reservation through failure and final-confirmation waiting. Explicit
recovery uses the original file and target. Cancelling a queued recovery preserves
the original failed task. A completed build's pinned ZIP takes priority over the
next queued build, with the existing freshness and conditional-download checks.

The recorded defaults (2002 / 1002 / tester 11562), version-only descriptions,
two publication endpoints and four parallel COS parts are preserved. Accounts are
scoped to the authenticated QA Hub user; snapshots and downloadable diagnostics
exclude passwords and tokens. The detailed contract is
[Server incremental upload](../SERVER-INCREMENT-UPLOAD.md).

## Verification

- API suite: **95/95**; migrated host/build-coordinator tests: **29/29**.
- Web: **53/53**; desktop: **59/59**; worker 0.4.0 self-test: **34/34**.
- Type checking, relevant ESLint/Prettier, ADR and repository-boundary checks passed.
- The archive-worker regression contained a pre-existing hard-coded schema-10
  expectation. It now verifies preservation of the actual source backup schema
  (currently 12), without changing archive behavior or the production schema.
- Queue tests cover concurrent actors, idempotent requests, live scheduler exclusion,
  restart, lost dispatch/launch acknowledgements, channel holds, queued cancellation,
  credentials and completed-build handoff ordering.
- A real server supervisor and real pinned EXE continued after the API closed and
  wrote a final receipt. A deliberately mismatched local auth-cache origin produced
  `AUTH_REQUIRED` before any network operation. Restart read the same run, without
  launching it again.
- Browser verification used the real API/queue with fixture execution and no desktop
  bridge. A lost submission reply reused the original request key. After closing the
  submitting browser, a new browser read the same task and explicitly confirmed it.
  Diagnostic download, queued recovery controls and the combined-build menu passed.
- Packaged Windows verified live server API access, worker 0.4.0 availability,
  recorded defaults and exactly two endpoints. Local execution was rejected, no
  local upload directory was created and malformed submission returned HTTP 400
  without creating a server job.
- Actual archived **3.1.4 → 3.2.0** update installed and relaunched from a renamed
  portable folder. Runtime configuration, profile, old upload account, checkpoint
  and build-chain sentinels retained their hashes; rollback remained available.
  The installed client no longer contains `resources/uploader/ozdqp-uploader.exe`.

## Live release and runtime

The live API was restarted through the official guarded service script, with source
`baf48c26783a99086dbf836b150c3cf7861ff4d7`, PID 8228 and generation
`20260908065856548`. Readiness is schema 12 with database, evidence and worker OK.
The new server state root is
`D:\Relay-QA-Hub-Data\production\integrations\increment-upload`.
The live read-back reported `execution=server`, worker 0.4.0 available, an existing
queue database and the correct versioned binary hash. No business upload was started.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Setup EXE | 150428517 | `53124acc6503cf281fc21dedbd921c0cadc3fb1073b38ec4f68a21c7ac10f20f` |
| Portable ZIP | 155405312 | `e1fa6a856a481536c395ed77f5fa99ea8e8f7d612bfaeb2ff3d7834aa0b26929` |
| Server worker 0.4.0 | 73987655 | `095352393e09e526b23b255398737798e93381879f9163ffbc6a2ed2b992d0fe` |

Live Ed25519 manifests and both streamed download hashes passed. Packaged release
metadata matches the product source, and all eight Web resources match the build.
Windows Authenticode is `NotSigned`; it is distinct from the valid update-manifest
signature. All four daily client processes and startup entries were preserved.
The isolated verification ports were released.

The complete previous release, manifests, installers, Web assets, portable folder
and committed source are retained at
`D:\Relay-QA-Hub\apps\desktop\release\builds\prepublish-20260908T060050204Z-20260908T065044121Z`.
Receipts and screenshots are in `work/backend-upload` and
`work/windows-3.2.0-release`.

## Migration and business acceptance boundary

Old local task/account/ZIP records are retained, not silently imported or re-uploaded.
An old client already executing a task does not participate in the server queue;
update submitting clients and reconcile unfinished old jobs before submitting the
same target again. The original reported local waiting error was not available on
this host and is not claimed to have been diagnosed or retried.

The server platform account still needs its first configuration for the user's QA
Hub identity. Once configured, other clients share it. The checks above did not log
into the real upload platform, run a new COS transfer, execute game tests or publish
a business version. Those operations remain for the user's intended next upload.
