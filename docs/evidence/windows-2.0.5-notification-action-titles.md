# Windows 2.0.5: Action-specific notification titles

- Date: 2026-09-07 (Asia/Shanghai)
- Release ID: `20260907T120317028Z`
- Product and deployed API source: `03ee2cbd45a8a3b9ba2310d75fd0e76abe0ec6ea`

## Behavior

Notification titles now describe the original event. Delivery or completion shows
`这个单子已完成，待验收`; successful human verification shows `这个单子已验收`;
other closure/duplicate events show `这个单子已关闭`. Creation, new feedback,
pending work, active repair, information changes, verification start/failure and
reopening have corresponding titles. Body text still contains the Bug number and
description, and click-through and recipients remain unchanged.

The initial `occurrence.appended` event is identified by its first aggregate
sequence; subsequent occurrences describe new feedback rather than a new Bug.
State titles use the source event, not the Bug's later current state.

New notifications persist the new wording. Existing Inbox records render through
the same mapping by joining their immutable source events. Notification IDs,
persisted titles, read state, version and delivery history are retained; the change
does not replay notifications. Already displayed Windows toast content is not rewritten.

## Validation

- Storage invariants and migration tests: 83 passed. Actual delivery and acceptance
  workflows verify the new titles. A legacy-title fixture verifies read-time wording,
  unchanged notification IDs and body, retained read/version state, and no consumption
  or rewriting of existing notification rows.
- Desktop tests: 49 passed. The transport forwards the durable acceptance title even
  when a push hint still says `有一个新单子`, retaining reconnect deduplication.
- Storage test TypeScript, API build, changed-source ESLint/Prettier, ADR, boundary
  and diff checks passed. Publication also passed Web typecheck/build and Desktop build.
- A consistent production SQLite copy exercised 2,214 historical notifications across
  recipients. All titles were projected; the stored notification fingerprint remained
  identical after rollback. The cohort included completion, acceptance, rejection,
  creation, information changes, pending and active repair.
- After deployment, the authenticated live API returned the new titles for the local
  user's canonical UUID `07b48903-5331-4b4c-8993-bf162db319bc`.
- A real packaged EXE with isolated profile/MCP port passed normal application smoke.
  Fifty native `shown` event IDs matched the live Inbox, including completion and
  acceptance. The packaged native constructor uses `QA Hub · ` plus the durable title.
- ASAR version, release ID and source commit matched. Packaged MCP code and eight Web
  resources matched the validated build output. Live Ed25519 manifest signatures and
  streamed installer/portable download sizes and SHA-256 values verified.
- An isolated old release descriptor upgraded through the published installer and
  relaunched at this release ID, preserving profile, runtime config and rollback.
  This checks the update path rather than every historical client version.
- The user's four existing daily EXE processes were preserved. API readiness remained
  ready at schema 12; recovery verification passed with 779 attachments and no rejected
  recovery points. No schema or business-state migration was needed.

## Release artifacts

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| Installer | 150392746 | 58f111da7018ba2462d6a51bdf942f4faf2080bdcb4c4b2fd6772e7d49baf46b |
| Portable ZIP | 155368840 | f502443bb5b6f7cb5470b1963bb13a483cbd702c42d5e38c33980aa91b5a9a82 |

Prior API/storage/Web builds, the complete portable package, installers, manifests
and Git source are retained at
`apps/desktop/release/builds/prepublish-20260907T115040042Z-20260907T120017733Z`.
Detailed test logs, source-copy/API/native notification receipts, release signatures,
package comparisons, recovery and self-update proof are retained in
`D:\Relay-QA-Hub\work\windows-2.0.5-release`.
