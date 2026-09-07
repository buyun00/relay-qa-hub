# Windows 2.0.7: Consistent acceptance actions

- Date: 2026-09-07 (Asia/Shanghai)
- Release ID: `20260907T124224715Z`
- Product source: `3579f467747eb3eb73e5cc3d21d0f14dff7c613a`

## Cause and fix

`awaiting_build` and `ready_for_verification` both display as 已完成待验收.
The action footer still treated them differently: the former showed manual
completion before the rejection evidence, while the latter showed direct closure
after it. An additional owner hint incorrectly said the former was waiting for
the fixer.

Both stages now use the public verification status for acceptance eligibility.
The footer shows 验收不通过，打回待处理, 验收通过并关闭 and 删除 Bug together
after the rejection evidence. Manual completion remains available for pending and
in-progress Bugs. Human and Relay attempts share the button text; Relay rejection
still uses the existing continuation flow and status feedback.

Acceptance reuses `ensureVerificationStarted`: a delivered attempt awaiting a
build first enters verification through the formal versioned, idempotent complete
endpoint, then creates/starts verification and records its result. It retains the
existing repair attempt. No backend lifecycle change or production data migration
was necessary.

## Validation

- Web: 41 tests passed. Desktop: 49 tests passed. Web and Desktop TypeScript,
  changed-file ESLint/Prettier, ADR, architecture boundary and Git diff checks passed.
- Three existing storage integration tests passed: delivered code acceptance
  without a Build, multi-actor no-code verification, and Relay rejection followed
  by continuation and acceptance.
- Eight isolated browser scenarios covered both internal stages, human/Relay
  modes and passed/failed outcomes. They verified matching button layouts, one
  click through the existing verification requests, correct version/idempotency
  fields, original attempt reuse and no manual-complete request. All API responses
  in this fixture were intercepted; it performed no production writes.
- The actual packaged EXE passed the full isolated-profile desktop smoke. A
  read-only UI probe loaded live LOCAL-281 (`awaiting_build`, version 9) and
  LOCAL-320 (`ready_for_verification`, version 6), narrowing only the test list to
  those two records. Button text, coordinates and dimensions matched exactly.
  Their production versions and states remained unchanged.
- ASAR release/source metadata and eight packaged Web resources matched the build.
  Live Ed25519 update signatures and streamed installer/ZIP sizes and SHA-256
  values verified. API readiness remained ready at schema 12.
- An isolated old-release client installed this release and relaunched, preserving
  its profile, runtime configuration and rollback directory. The four existing
  daily client processes retained their process IDs and start times.
- Recovery validation passed with 788 attachments and zero rejected points.

## Artifacts and rollback

| Artifact     | Bytes     | SHA-256                                                          |
| ------------ | --------- | ---------------------------------------------------------------- |
| Installer    | 150392370 | 72d48365ef00ba240e01f58a7ec982fa34ff2f18d0c8fa5e2f6c8638f4cc6eb1 |
| Portable ZIP | 155369503 | 83ef1e174470dc02fa14307811e52ea660036da080ceb7e55e319a9f143ab796 |

Previous source, Web build, portable package, installers and manifests are retained
at `apps/desktop/release/builds/prepublish-20260907T121842239Z-20260907T123920165Z`.
Screenshots and test, live-download, package, recovery and update receipts are in
`D:\Relay-QA-Hub\work\windows-2.0.7-release`.
