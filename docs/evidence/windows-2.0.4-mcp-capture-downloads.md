# Windows 2.0.4: MCP capture attachment downloads

- Date: 2026-09-07 (Asia/Shanghai)
- Release ID: `20260907T115040042Z`
- Product source: `036ee6ad247b5bc3e048e08ecb4b3b1d0a364fc2`

## Problem and change

`qa_get_bug_context` includes Poco artifacts from a Bug's capture bundles, but
`qa_materialize_attachment` previously accepted only the ordinary Bug attachment
list. A successfully stored snapshot therefore returned
`404 ATTACHMENT_NOT_BOUND_TO_BUG` before any download occurred.

The existing tool now resolves capture-only attachment IDs through captures
referenced by the Bug's ordinary attachments. It checks the project, primary
attachment, capture identity, artifact kind and succeeded status, then downloads
through the existing Bug-scoped capture artifact endpoint. The server remains
responsible for membership, current binding and evidence-read authorization.
The MCP validates media type, size and SHA-256 before writing its existing cache.
Ordinary attachment downloads retain their existing endpoint and integrity checks.
No API, database schema, stored binding or Bug lifecycle change was required.

## Validation

- Desktop tests: 49 passed, including capture-only snapshot, hierarchy, profiling
  and screenshot downloads; cache reuse; unrelated/failed evidence rejection;
  project, primary attachment and capture identity mismatches; invalid artifact
  kinds; corrupt size/hash/media type; unavailable captures and authentication errors.
- Desktop TypeScript, ESLint, changed-file Prettier, ADR, boundary and diff checks passed.
  Publication also passed Web TypeScript/build and Desktop build.
- The active locally remembered identity was resolved to canonical user UUID
  `07b48903-5331-4b4c-8993-bf162db319bc` before authenticated production reads.
  The legacy smoke account was disabled and was not enabled or reused.
- Source MCP and actual packaged EXE MCP both downloaded all four artifacts of
  `LOCAL-342` (`6ceea954-92d4-4a54-b8c3-2ffc9b04c9fc`). Size and SHA-256 matched
  for the system screenshot, Poco screenshot, snapshot and hierarchy. The snapshot
  parsed with 10 recent logs. The Bug remained reported/version 1.
- Packaged login, MCP, workbench, details, editing, evidence, overview and production
  navigation passed with isolated profile and MCP port 4322.
- ASAR version/release/source commit matched; packaged MCP code and eight Web files
  matched validated build output byte for byte.
- The live Ed25519 update manifest and streamed installer/portable downloads verified.
- An isolated client with an old release descriptor downloaded the published installer,
  upgraded and relaunched at the new release ID. User profile, runtime configuration
  and rollback directory were preserved. This exercises the supported update path,
  not every historical version.
- All four processes of the user's existing daily client remained unchanged.
  Existing clients load the MCP fix after updating and restarting.
- API readiness remained ready at schema 12. Recovery archive verification passed
  with 779 attachment entries and zero rejected recovery points.

## Delivery and retention

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| Installer | 150392757 | b98a1959c1d45d4395a798cedb6c4a02e46c960501ad8d98858e406d12f8421a |
| Portable ZIP | 155368841 | 9fc1b6962b051cc7e5134a23919c9442784331244d4625dedf927beb6bbdfc50 |

The previous published package, installers, manifests, Web output and Git source
are retained at
`apps/desktop/release/builds/prepublish-20260907T101527405Z-20260907T114956123Z`.
The six copied release files were checked against their original SHA-256 hashes.
Detailed logs, download receipts, package comparison, recovery and self-update
proof are retained in `D:\Relay-QA-Hub\work\windows-2.0.4-release`.
