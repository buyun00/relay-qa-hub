# Windows 2.0.6: Detail close button

- Date: 2026-09-07 (Asia/Shanghai)
- Release ID: `20260907T121842239Z`
- Product source: `4c03f0d2a9499e226d99a6b6071af32b6389c560`

## Cause and fix

In packaged 2.0.5 at a 1440 by 961 viewport, the detail close button occupied
`x=1204, y=45.857, width=40, height=40`. The underlying native draggable topbar
occupied `x=236, y=0, height=112`. The button and overlay had no explicit no-drag
region, while the topbar and brand still declared drag. The overlap explains why
the button was unresponsive even though backdrop dismissal and the shared React
close handler worked. Electron documents that native draggable regions ignore
pointer events, including those intended for overlapping buttons:
[Custom Window Interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions).

The detail overlay and close button now explicitly declare no-drag. While the
detail overlay exists, the underlying topbar and brand also become no-drag; normal
window dragging returns automatically when it closes. The rule covers loading and
loaded detail overlays. The loaded close button now has the accessible name
`关闭详情`, matching the loading view.

## Validation

- Web tests: 41 passed across nine files. Desktop tests: 49 passed.
- Changed Web and smoke-script ESLint, Web TypeScript, Prettier, ADR, architecture
  boundary and Git diff checks passed. Publication passed Web build/typecheck and
  Desktop build.
- The actual packaged 2.0.6 EXE passed the normal isolated-profile smoke suite. The
  close-button regression checked the button, overlay, topbar and brand were all
  no-drag, dispatched a Chromium pointer press/release at `1224, 65.857`, verified
  the modal disappeared, verified topbar/brand drag returned, and reopened detail
  successfully. Edit controls and the rest of the normal navigation also passed.
- Validation limit: the Windows computer-use surface did not expose the isolated
  QA Hub window. Pointer regression therefore used Chromium CDP plus computed
  native-region declarations; a physical OS mouse click was not independently
  exercised.
- ASAR version, release ID and source commit matched. Eight packaged Web resources
  and packaged MCP code matched build output. Online Ed25519 manifest signatures,
  installer and portable download sizes and SHA-256 values verified.
- An isolated client with an old release descriptor installed the published update
  and relaunched at this release ID, preserving its profile, runtime config and
  rollback directory. This validates the update path, not every historic client.
- The user's four existing daily EXE processes retained their process IDs and start
  times. No API restart or business-data change was needed. API readiness remained
  ready at schema 12. Recovery verification passed with 782 attachments and zero
  rejected recovery points.

## Release artifacts

| Artifact     | Bytes     | SHA-256                                                          |
| ------------ | --------- | ---------------------------------------------------------------- |
| Installer    | 150392445 | 1354e69cf87107cc6bd37e5c3e124c5b2fe121807fd203aad47d99d911f321e7 |
| Portable ZIP | 155369532 | 54483d089236e51a942949e8077f4a142648092ab152f4ed98581b23afe38c13 |

The previous Web build, complete portable package, installers, manifests and
committed Git source are retained at
`apps/desktop/release/builds/prepublish-20260907T120317028Z-20260907T121757126Z`.
Detailed baseline, test, package, live-download, recovery, process-preservation and
self-update receipts are retained in `D:\Relay-QA-Hub\work\windows-2.0.6-release`.
