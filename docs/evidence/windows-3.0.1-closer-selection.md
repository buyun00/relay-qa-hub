# Windows 3.0.1: Preserve the first closer selection

- Date: 2026-09-08 (Asia/Shanghai)
- Release ID: `20260908T031155792Z`
- Product source: `8694c5c85f8cee916db62e56886b2384b3658aaa`

## Reproduction and fix

In detail, a workbench refresh replaced the members array, which changed the
`loadDetail` callback and triggered another detail load. That load reset the fixer
and closer controls, discarding unsaved selections even when the Bug was unchanged.
Assignments now have a draft per Bug. Refreshes update server facts without
clearing drafts; a successful save adopts the server receipt and clears only the
submitted draft. Failures and switching between Bugs retain unsaved selections.
Canonical member lookup remains in the rendered values, independent of detail I/O.

In overview, the closer select was bound only to the previous server row while the
PATCH was pending. An older list response could also overwrite the successful
PATCH result. The select now retains its pending choice, disables that row during
the write, ignores superseded list requests and preserves newer row versions.

The existing interaction remains: select a closer and press 保存分配 in detail;
selecting a closer in overview saves immediately. API payloads, canonical identity,
version checks, idempotency and backend lifecycle behavior are unchanged.

## Validation

| Scenario                                                | Before | After  |
| ------------------------------------------------------- | ------ | ------ |
| Detail selection survives workbench refresh             | Failed | Passed |
| Overview selection stays visible while PATCH is pending | Failed | Passed |
| Old list response cannot replace saved closer           | Failed | Passed |

- The detail scenario also verified a newer Bug description/version refresh,
  an intentionally failed save, retry without reselecting, and reopening after
  successful save. Overview submitted exactly one PATCH for one selection.
- The same scenarios passed in the actual packaged EXE. These regression probes
  intercepted all API requests using isolated fixtures and did not reassign any
  production Bugs. Headless browser screenshots and before/after JSON are retained.
- Web 41/41 and Desktop 59/59 tests passed, along with Web/Desktop TypeScript,
  changed-file ESLint/Prettier, ADR, boundary and Git diff checks.
- Full packaged desktop smoke passed: login, notifications, 18 MCP tools, detail
  open/close/edit, overview, Qingyu import and production-task reads.
- ASAR version/release/source metadata, eight packaged Web resources and desktop
  main/preload/updater/MCP outputs matched the publication build.
- Live Ed25519 manifest signatures and streamed installer/ZIP sizes and SHA-256
  values verified. API readiness stayed ready at schema 12.
- An isolated old-release client installed this release and relaunched, preserving
  its profile, runtime configuration and rollback directory. Daily client and
  startup state were preserved; temporary test ports were released.
- Recovery validation passed with 789 attachments and zero rejected points.

## Release artifacts

| Artifact     | Bytes     | SHA-256                                                          |
| ------------ | --------- | ---------------------------------------------------------------- |
| Installer    | 150396652 | 73fd8300558d1cebedc92467d2aee4aa6ac0c555c0736abc67dc4e1d52d51815 |
| Portable ZIP | 155372271 | 19b80e113d40b6b626063d0ded5a42968421b1ca5dc3a67bf526d72de6de1c96 |

Previous source and complete release artifacts are retained at
`apps/desktop/release/builds/prepublish-20260907T172648913Z-20260908T031038702Z`.
Detailed scripts, screenshots and receipts are in
`D:\Relay-QA-Hub\work\windows-3.0.1-release`.
