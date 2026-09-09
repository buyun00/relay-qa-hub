# Web A/B late response and unsubmitted draft isolation

This new runner is independent of the earlier detail-loading run. Default invocation is inert. The initial syntax/default/ESLint/Prettier checks and 16 pure tests passed; these preparation results are not live E2E evidence. Root subsequently authorized one actual run by this agent after reporting the source, test, and create-only gate hashes.

## Fixed boundaries and gate

The only instance is `C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/instance.json`, SHA-256 `2b8e97ce9b62d072b74eaf00015fb04f5b818d318203f2a91e59d15873da349b`. The gate is a new `browser-gate.json` under this instance's `acceptance` directory. It must contain `schemaVersion: 1`, `status: reviewed_web_project_switch_draft`, the exact `runnerSha256`, `instanceSha256`, `webBundleSha256`, and `api`/`web` objects with positive PID and parseable `startedAt`; `api.schemaVersion` is checked against actual readiness.

The authorized gate pins API 4419 PID 22852/start `2026-09-09T01:22:20.2728640Z`/schema 14 and Web 4274 PID 20284/start `2026-09-08T17:52:36.5080910Z`. Both single loopback listeners are verified before fixture writes. It pins the exact public publication proof at `docs/evidence/project-components/web-detail-fix-publication/e2d5cb4b-9068-4f14-9f90-d292ee4af864/deploy.json`, SHA-256 `0ec3abdbdbe85e1d3ab79155a8dcc2f31c21e999e634834ddb488000e90cff63`. All eight current Web assets and the actually loaded `Br-CEXQI` JS are checked; JS SHA-256 is `813277e9792c91d27b2e153322a0a2bfcad277ec57723df712f7d84ae24ad3ae`.

The runner uses vacant CDP port 9370, a new empty Edge profile, and new UUID runtime/public evidence directories. It never connects to an existing browser. Browser/CDP/control helper code was copied from frozen runner SHA `29aec997bfacc12f646254dd7aad7f9794200446686b33d27b0efcf1c5bd07ae`; neither that runner nor its earlier evidence is edited.

## Fixture writes and actual UI

Direct setup is limited to one GM login, two fresh projects, and four employee logins: one independently named shared employee logs into A and B, and two separately named sentinel employees each join only A or B. That is three new employee identities and four memberships, with normal session/capability/audit records. The browser logs into A once as the shared employee. There is no Bug POST, upload init/chunk/finalize/bind, comment, component configuration, component task, or identity-link write. All other API calls are exact A/B reads. Both projects must remain empty and all five components disabled.

Two deterministic valid 16×16 PNGs with different RGB pixels and hashes are created in the new runtime only. Actual browser form input seeds A and B with distinct text, PNG, owner sentinel, and shared verifier. The forms are closed using Cancel to preserve, rather than submit, their input. Exact scoped IndexedDB draft keys are read with readonly transactions; both stored File bytes and rendered blob preview bytes are hashed. No other profile or draft key is read.

The runner restores A's draft, closes its form, arms one late A members GET, and clicks the actual Refresh control. It retains a genuine A 200 reply and its hash, then uses the project selector to switch to B. It waits for new B members and empty-Bug replies, verifies B's current URL/selector/storage, restores B's form, and checks only B/shared personnel options and B's exact text/PNG/selection. The old A reply is then settled without changing its body.

The application keeps its genuine Abort behavior. A reply may already be canceled on project switch. Only a stored `Network.loadingFailed` event with the **same Network requestId**, `canceled === true`, observed after switch initiation, together with independently verified B selection, permits `expected_project_switch_cancellation`. A different request, missing/false cancellation, pre-switch cancellation, or arbitrary CDP continuation error remains failure. An acknowledged continuation is recorded separately and is not described as proof that an obsolete application callback ran.

The controlled late-response window remains 15 seconds; expiry fails and attempts original-response cleanup. B's draft is checked again after settlement, after actual page reload, and through A/B roundtrips. Both projects' final official Bug lists must still be empty, with components disabled. Normal `Browser.close` is the only shutdown path; profile and all evidence are retained, including a failed first run. No process-kill fallback exists.

## Execution and evidence

After creating the source-bound gate, execute from the worktree:

```powershell
node scripts/project-components/web-project-switch-draft-live.mjs --run C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/instance.json C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/acceptance/web-project-switch-draft-92f622d8-49b9-4f10-a580-3463722b630d/browser-gate.json
```

Each actual run creates `docs/evidence/project-components/web-project-switch-draft-live/<runId>/` plus `runtimeRoot/web-project-switch-draft-<runId>/`. Public proof records real form inputs, PNG screenshots, response/hold/cancellation correlation, exact draft fingerprints, final reads, source/gate hashes, and normal-close evidence. Non-authentication response bytes remain private; authentication bodies are not stored, credentials remain in memory, and public proof is redacted and scanned before writing.

The result covers fresh-profile A/B project, personnel, and unsubmitted text/PNG isolation for the observed trajectory. It does not claim all continuous frames, another user/account/server origin, real component execution, existing EXE/APK drafts, or late callback delivery if the browser canceled the request. Production, installed clients, current services, old evidence, root documents, matrix, and Git index are outside the mutation scope.
