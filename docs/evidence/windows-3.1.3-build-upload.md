# Windows 3.1.3: Tester migration and one-click build/upload

- Date: 2026-09-08 (Asia/Shanghai)
- Release ID: `20260908T053707852Z`
- Product source: `88dadd5b6c24de362450d3013b8556a26047c5f3`
- Previous multipart release: 3.1.2, verified and published first.

Legacy cached tester 1 now migrates to the recorded ID 11562. A defaults-version
marker preserves later deliberate manual choices. The fix was completed and
tested before the build/upload work.

打外网包 now opens 仅打外网包 and 打包并上传增量. The combined action displays
the saved product/channel/tester/version and one of the two workflow endpoints,
checks upload authentication before submitting Jenkins, and tracks the exact
queue/build in Electron main. The chain persists across page reload/application
restart. It freezes account/owner/input identity, rejects unsuccessful builds or
unverified/replaced ZIPs, and creates one stable upload job after success.
取消自动上传 preserves the Jenkins build. The upload link selects the exact job;
等待最终确认 still stops before the final confirmation action.

Worker 0.3.2 retains four concurrent resumable COS parts and adds optional source
pinning: If-Unmodified-Since, response size/time checks and post-download HEAD.
Complete local files remain snapshots of the original task. The source server has
no ETag; freshness uses size/time/build-window guards plus local ZIP/SHA validation.
No previous worker task identity or checkpoint format was replaced.

## Verification

- Desktop 87/87, Web 46/46, worker 33/33 tests passed. TypeScript, changed-file
  lint/format, ADR/boundary and diff checks passed.
- Thirteen coordinator tests cover exact queue association, restart, frozen
  settings, auth failure before submission, duplicate clicks, lost submission and
  handoff acknowledgements, build failure/cancellation, stale/newer/missing ZIP,
  wrong queue, overlapping writers, owner/account switches and cancellation.
  The progress request omits unresolved build parameters because the existing API
  rejects empty ID lists; the fixture validates that existing route contract.
- The real uploader host/supervisor test verifies a single persistent job/launch
  intent after lost handoff acknowledgement and refuses changed input/source.
- Three new worker download tests reject replacement before/during download and
  verify that recovery retains an already complete local ZIP. Existing real-SDK
  loopback multipart, cancellation/resume and final-confirmation tests still pass.
- Browser interactions verify legacy tester migration, reload and manual choice
  preservation; both dropdown actions, account prerequisite, frozen defaults,
  double-click coalescing, restored chain, exact upload link and no automatic final
  confirmation in prepare mode. Wide and compact screenshots were inspected.
- Full isolated packaged smoke passed login, notifications, MCP, details,
  overview/date navigation and production-task reads. Native IPC verified tester
  migration, the real dropdown, durable chain/history reload, malformed input
  refusal and auth failure before Jenkins submission. The actual packaged worker
  executed run/confirm-publish with offline invalid configs and durable receipts.
- Packaged ASAR/Web/coordinator/uploader files match local build/source metadata;
  the external EXE hash matches both runtime and packaging pins. The first package
  attempt stopped at the old hash pin; updating that pin completed the release gate.
- Live Ed25519 signatures, streamed installer/portable sizes and SHA-256 matched.
  API readiness remained healthy at schema 12. Authenticode is `NotSigned`, separate
  from the verified update manifest signature.
- An isolated copy of the actual archived 3.1.2 client downloaded and installed
  live 3.1.3, then relaunched. Profile/runtime configuration, uploader account,
  checkpoint and build-chain fixture files were preserved; the installed worker
  hash matched and rollback remained available.
- Daily client processes/startup entries were preserved; test ports were released.

## Artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Installer | 182620353 | `e51a611904d8408c0fa91c2ba12fad597bf785fe494501b3d6e25c8fc827a2b6` |
| Portable ZIP | 188631416 | `334cf0d7d1d77fc9b50fb6e9e0e537c6afc8fcecffc3ac404fcf359e9dc62ff6` |
| Worker 0.3.2 | 73987655 | `43a3ba2d30f4b1792e0406aa92ead1a61624c7aa491bfa9ae7e5be2b559b7a3d` |

Previous 3.1.2 files and its product source are retained at
`apps/desktop/release/builds/prepublish-20260908T050537567Z-20260908T052919754Z`.
Detailed receipts/scripts are in `work/windows-3.1.3-release`; browser evidence is
in `work/upload-followups`.

These checks did not submit a real Jenkins build or perform a real platform upload,
testing transition or publication. Full business acceptance and actual WAN speed
remain to be observed on the next designated new-version upload.
