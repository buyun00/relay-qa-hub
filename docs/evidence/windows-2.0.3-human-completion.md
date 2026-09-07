# Windows 2.0.3: Human completion priority

- Date: 2026-09-07 (Asia/Shanghai)
- Release ID: 20260907T101527405Z
- Product source and deployed API: 0deb3b76a8c5231e77d3b5a4bbbc6a3f00291df3
- Database: schema 12; [ADR-0011](../adr/ADR-0011-human-completion-priority.md).

## Behavior

Pending, in-progress and awaiting-build Bugs expose 人工标记完成 to project members.
The operation is independent of the owner, Relay status, code delivery and Build evidence.
It atomically records a human decision and a new human repair round, retains the former
round and submits acceptance with the original owner and verifier unchanged. Old Relay
callbacks cannot overwrite the new round. Human acceptance remains a separate operation.

## Requested production changes

The authenticated API resolved the existing canonical actor and exact four Bug UUIDs.
Each Bug was checked at in_progress/version 3, completed independently through the new
manual-complete endpoint, read back and replayed with the same idempotency key.

| Bug | Result | Version | Human decisions |
| --- | --- | --- | --- |
| LOCAL-303 | ready_for_verification | 6 | 1 |
| LOCAL-313 | ready_for_verification | 6 | 1 |
| LOCAL-320 | ready_for_verification | 6 | 1 |
| LOCAL-325 | ready_for_verification | 6 | 1 |

Original Relay attempts are superseded and retained as the human attempts' parents.
No passed Verification or closure was created. Original verification owners were retained.
Quick integrity check was ok, foreign-key violations were zero. Final readback at
2026-09-07T10:19:16.140Z confirmed all four remained pending acceptance.

## Validation

- Storage invariants and migrations: 83 passed. Expanded manual regression also passed
  for failure, input, running, submitted and blocked receipts, another member's authority,
  late delivery, idempotency mismatch, full acceptance and forced rollback without partial facts.
- API and Relay transport: 22 passed; Web: 41 passed; Desktop: 45 passed.
- Changed-source TypeScript, ESLint, Prettier, ADR, boundary, diff and frozen 1.1.0 checks passed.
- Production-copy exercise completed all four records with owners preserved and integrity ok.
- Recovery archive validated with 759 attachment entries and zero rejected points.
  The forward migration backup is retained under the production migration backup root.
- Packaged ASAR version, release descriptor and eight Web files matched the validated source.
- Actual packaged-client login, MCP, workbench, details, editing, evidence, overview and
  production navigation passed. The manual button was visible and enabled; its click
  emitted the exact scoped endpoint and idempotency key. The UI test intercepted writes
  and returned an isolated failure; the button became retryable without changing its test Bug.
- An isolated client upgraded from an old release descriptor through the live signed
  installer, restarted with the actual release ID, and preserved profile, runtime config
  and rollback directory. The user's ordinary installed client was not force-closed.

## Delivery and retention

Live Ed25519 manifest signature and streamed installer/portable downloads verified.

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| Installer | 150390975 | f9f480ec4bf80e1f33631d3ff3515f1a88f90c639cf5e2ff2ad8d19c192ca626 |
| Portable ZIP | 155367490 | 16098de30271edeedc5674606dc401c8e6d01dd5f8f8405b0f5627d7a70fc304 |

The first packaging attempt timed out retrieving Electron's checksum file. The existing
43.4.1 archive was verified against the pinned installed Electron checksum manifest;
its checksum cache was populated without changing package source and packaging succeeded.

Prior published Web/Desktop, installers, manifests and source are retained at
apps/desktop/release/builds/prepublish-20260906T033735389Z-20260907T100633393Z.
API/storage candidates in that folder are identified as candidates in rollback.json;
the prior Git source archive is the source for rebuilding old backend code. Installer
rollback alone is not a database downgrade after new human decisions.

Detailed receipts, release logs, hashes, button screenshot, canary, recovery and update
proof are retained in D:\Relay-QA-Hub\work\windows-2.0.3-release.
