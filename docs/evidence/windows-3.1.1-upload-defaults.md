# Windows 3.1.1: Recorded upload defaults and final confirmation

- Date: 2026-09-08 (Asia/Shanghai)
- Release ID: `20260908T043816190Z`
- Product source: `c4e76b0abe7a8c0cd329cf8eacb9ccf2ac8857a6`

New upload tasks default to the user's latest recorded product 2002, channel 1002,
tester 11562 and product/channel name. Summary and description both contain only
the resolved version number. The two endpoints are 完成发布 and 等待最终确认.
The latter completes upload, the recorded platform testing workflow, release copy
and preparation, then waits at status 60 for the explicit 确认发布 button.
Ordinary resume/reload does not grant final confirmation. Remote identity, status
and release directory are checked again before submitting publication.

The worker is now built as 0.3.0 from the handover source, checked into
`apps/desktop/uploader`. Four source files differ from the original: Engine,
Models, Program and SelfTest. The handover directory is unchanged. New behavior
is included in immutable task identity; legacy 0.2.0 task identity remains compatible.
Recorded testing state is explicitly audited and does not fabricate a game-test report.

## Verification

- Desktop 73/73 tests, Web 46/46 tests, worker 27/27 local self-tests passed.
- Worker tests cover the status-60 boundary, normal resume without publication,
  explicit confirmation exactly once, early confirmation refusal, changed remote
  status/release URL refusal, and version-only text with automatic version selection.
- Host tests cover recorded defaults, configuration persistence, exactly two new
  modes, preserved legacy recovery and separate confirmation dispatch/guards.
- Web/Desktop TypeScript, changed-file ESLint/Prettier, ADR/boundary and diff checks passed.
- Browser fixture interactions passed defaults, two modes, version-only text,
  navigation/draft retention, review and double-click protection, 100% upload
  without false publication, reload at the final gate, explicit confirmation and
  compact layout. Screenshots were visually inspected.
- Actual packaged native IPC showed worker 0.3.0, recorded defaults and two modes.
  Legacy recovery and final-gate history survived reload. An early confirm was
  refused, and a ready-to-confirm fixture still required platform login.
- The real packaged supervisor dispatched both `run` and `confirm-publish` to the
  real bundled worker. Invalid offline configurations failed before authentication
  or network access, producing durable exit-code 6 receipts and JSONL errors.
- Full portable smoke passed login, notifications, MCP, details, overview/date
  navigation and production-task reads. Packaged ASAR resources/source metadata
  and the external worker hash matched the build.
- Live Ed25519 manifest signatures, streamed installer/ZIP sizes and SHA-256 matched.
  API readiness stayed healthy at schema 12. Installer Authenticode is `NotSigned`,
  separate from the verified update-manifest signature.
- An isolated copy of the **actual archived 3.1.0** portable client downloaded and
  installed live 3.1.1, then relaunched with the same profile/runtime configuration.
  A seeded uploader account config and checkpoint remained byte-identical. The
  installed worker hash matched and a rollback directory was retained.
- The initial synthetic-client preparation hit a remote Electron dependency
  timeout; using the preserved actual 3.1.0 package removed that dependency and
  completed the real version-to-version upgrade check.
- Daily client processes and startup entries were preserved; isolated test ports released.

## Artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Installer | 182594135 | `6adb085a0eaca0ec5afde13cf551b686c263a509974033d712a143e2768dfbb0` |
| Portable ZIP | 188595741 | `0f8b91cecf334ebabc93c6f706734928781e46c3aa655a2b95aad2ae4bb862e0` |
| Worker 0.3.0 | 73958983 | `ac98a271deb77ddb6733e93703f0ba044df205c4c0a8a80804a9e3facbc524fb` |

Previous 3.1.0 installers, manifests, portable directory, Web build and committed
source remain at
`apps/desktop/release/builds/prepublish-20260908T034800193Z-20260908T042909476Z`.
Detailed local receipts/scripts/screenshots are under
`D:\Relay-QA-Hub\work\windows-3.1.1-release`.

These checks made no real business-platform upload or publication. Actual account
permissions, COS upload/recovery and server completion on a designated new version
remain business acceptance work; no historical version was replayed.
