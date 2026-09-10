# QA Hub v2.1 external-component Luna audit

Date: 2026-09-10 (Asia/Shanghai)

Scope: read-only repository/runtime audit for independent external-component E2E.

## Result

No repository-owned, complete, independently runnable fixture was found for a
terminal external component chain. The existing code has contract tests and
injected fetch fakes, but those tests do not start a Jenkins, upload/COS,
Relay-AI, or Qingyu-compatible server and do not establish external terminal
artifact/order/callback evidence. No external component was enabled, no task
was submitted, and no network endpoint was called by this audit.

The designated v2.1 runtime is already populated by prior business acceptance:
it contains API/Web/server-MCP processes, an existing OZDQP project/Bug and
packaged-client evidence. Its preparation evidence is anchored to source
`7df05e5035958b4243ae70d4cd0107d5eb883fb1`, while the current source worktree
HEAD is `867387fe69714ae0c3aafa6182946ffd80495768`. It must not be treated as a
fresh component data root or as evidence for the current HEAD.

## Repository evidence

| Area | What exists | Acceptance limit |
| --- | --- | --- |
| Jenkins packaging | `apps/api/src/jenkins-builds.ts`, `apps/api/test/jenkins-builds.test.mjs`, `docs/JENKINS-PACKAGING.md` | Test uses injected `fetcher` and `component-test-config.mjs`; no Jenkins process/server or new artifact. |
| Incremental upload | `apps/api/src/increment-upload.ts`, `apps/api/src/uploader-host.ts`, `apps/api/test/increment-upload.test.mjs`, `apps/api/test/uploader-host.test.ts` | Disposable directories and mocked/injected transport; no real upload target, publication, or platform readback. |
| Single build/upload | `apps/api/src/build-upload-host.ts`, `apps/api/test/project-components-runtime.test.mjs` | The explicit test is named “performs no external execution” and asserts zero external calls. |
| Relay AI | `apps/fake-relay/server.mjs`, `docs/evidence/P5.1-*`, `P5.4-*` | A loopback fake Relay exists and is valid for fake handoff/callback smoke only; it cannot prove a real Relay project/workspace/executor. |
| Qingyu | `apps/api/src/qingyu-client.ts`, `apps/api/test/qingyu-integration.test.mjs`, `docs/adr/ADR-0008-optional-qingyu-adapter.md` | Tests inject a fake client/fixture responses; no independent third-party server, login identity, project, order, or remote terminal readback. |
| Matrix | `scripts/project-components/generate-coverage-matrix.mjs`, `docs/evidence/project-components/coverage-mapping-review.md`, `docs/evidence/project-components/coverage-matrix.json` | All `external_full_chain` rows and resources `external-build`, `external-upload`, `external-relay`, `external-qingyu` remain `not_run`/`unverified`. |

## Minimal safe execution plan when resources exist

1. Freeze a clean source/build identity and create a new component-only project
   under a new runtime subdirectory. Keep all component credentials in a fresh
   credential directory; never copy production or old-preview secrets.
2. Keep QA Hub API/Web/server-MCP on `4639/4640/4641` only if their process and
   source identity are freshly verified. Bind the EXE local MCP to `4642` with
   an instance-specific profile. Do not use `4319/4174/4320` or
   `4419/4274/4420`.
3. Enable one component version at a time through the real project-management
   HTTP/MCP route. Record the component version, config digest, actor and
   project ID before enqueueing.
4. Use dedicated external targets: Jenkins job/workspace and artifact path;
   upload account/product/channel and object prefix; Relay project/workspace
   and callback; Qingyu test identity/project/order. All targets must be
   disposable and loopback/internal-approved, with no genuine work-order
   mutation.
5. Drive the installed client and the corresponding HTTP/MCP entry. For each
   run, persist request/idempotency key, queue/task/order ID, state transitions,
   external response, final artifact bytes and SHA-256 (or callback payload),
   and QA Hub durable queue/history readback. A 200/listener/queued receipt,
   mock, upload percentage, or process exit is insufficient.
6. Exercise one success and one safe failure/retry/cancel path per component,
   retaining all local state. Stop only newly started disposable services and
   verify the protected daily/old-preview endpoints and processes remain
   unchanged.

## Required resources

| Resource | Required proof before execution |
| --- | --- |
| Jenkins | Dedicated test Job/workspace, free executor, independent artifact output/download, test credential reference. |
| Upload/COS | Dedicated account/product/channel/prefix, source ZIP, final target readback, hash/size and cleanup/retention policy. |
| Single chain | Both of the above plus exact build-to-upload handoff and one idempotent chain target. |
| Relay AI | Dedicated project/workspace, test task executor, callback endpoint/secret, external task and delivery evidence. |
| Qingyu | Dedicated test identity/project/order, QR/login or pre-authorized test session, import/resolve readback, and permission to mutate only test data. |
| Client/UI | Fresh instance-specific EXE profile or APK binding, plus a new test project and a way to inspect final UI state. |

No execution was started because none of these independent external resources
is present in the repository/runtime inventory. This is a resource gap, not a
source defect finding.

