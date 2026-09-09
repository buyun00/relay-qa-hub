# Shared Web detail loading: prepared, not run

This is an inert browser acceptance runner for the published `Br-CEXQI` bundle. Preparation ran 11 pure tests, syntax checks, the default CLI, ESLint, and Prettier successfully. It did not start Edge, inspect a live profile, open a port, connect to an API, create a fixture, operate a client, or publish a build. These results are preparation checks, not browser acceptance.

- Runner: `scripts/project-components/web-detail-loading-live.mjs`, SHA-256 `29aec997bfacc12f646254dd7aad7f9794200446686b33d27b0efcf1c5bd07ae`.
- Tests: `scripts/project-components/web-detail-loading-live.test.mjs`, SHA-256 `12babaace3b71d4e380c620e63257e3797bf08f52f0dbe230dbb279a675ad497`.
- Results and raw logs: [checks.json](checks.json), [pure-tests.txt](pure-tests.txt), [default-inert.txt](default-inert.txt), [lint.txt](lint.txt), [format.txt](format.txt), and the two syntax logs.
- Existing browser/CDP/control helper provenance: `scripts/project-components/web-rejected-media-recovery-live.mjs`, observed SHA-256 `dc1f93799397e9c45a5feb520722d1e46453288f4ddfcb53d6d8315923c9f2be`. That source and its historical evidence were not edited. The new runner has its own route guards, response controls, output directories, and checks.

## Exact execution gate

Root created the gate; this preparation did not replace it. The runner requires its exact path and SHA-256 `93cf0483a13b02ab8ed31f3799e61f69f2c76368ec51280a6c1388f48159c56c`:

`C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/acceptance/web-detail-fix-publication-e2d5cb4b-9068-4f14-9f90-d292ee4af864/browser-gate.json`

It also requires the exact public [publication proof](../../web-detail-fix-publication/e2d5cb4b-9068-4f14-9f90-d292ee4af864/deploy.json), SHA-256 `0ec3abdbdbe85e1d3ab79155a8dcc2f31c21e999e634834ddb488000e90cff63`, and all eight served files' sizes and hashes. The JS is 477,433 bytes with SHA-256 `813277e9792c91d27b2e153322a0a2bfcad277ec57723df712f7d84ae24ad3ae`. The actual browser-loaded JS must match too.

Preflight checks the single loopback API listener at 4419 with PID 22852/start `2026-09-09T01:22:20.2728640Z`, and Web listener at 4274 with PID 20284/start `2026-09-08T17:52:36.5080910Z`. It verifies API ready/schema 14 and vacant CDP port 9368 before fixture mutations. The gate's `postScope` is a reference to root's separate publication preservation evidence; the runner does not independently repeat that entire production/device inventory.

From the worktree, the explicitly armed command is:

```powershell
node scripts/project-components/web-detail-loading-live.mjs --run C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/instance.json C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/acceptance/web-detail-fix-publication-e2d5cb4b-9068-4f14-9f90-d292ee4af864/browser-gate.json
```

Without `--run`, even nonexistent configuration arguments produce `not_run` without operational setup. No actual execution occurred during this preparation.

## Bounded actual flow

An armed run creates a fresh UUID run directory, empty Edge profile, fresh project, fresh employee, and exactly one text-only Bug through the official API. It checks all five components are disabled. GM and employee secrets stay in memory; authentication bodies are not written. There are no attachment uploads, comments, component task submissions, or changes to an existing project.

The new headless Edge uses only its fresh profile and loopback CDP 9368. The runner checks the spawned browser PID before attaching to its page. Every page request passes an exact origin/project/path/query/method allowlist. Browser login is restricted to the fresh employee/project. Browser business writes are rejected; the Bug is created only by the bounded official fixture setup.

1. The browser logs in, loads the fixture row, and receives an actual five-disabled component response. An actual click issues the first detail GET. The runner obtains a genuine upstream 200 and records its bytes/hash, then holds delivery. The actual DOM must show loading and no error. It captures a screenshot, releases the original response unchanged, and requires the real detail to render.
2. A second actual click opens the same fixture. The runner uses CDP `Fetch.failRequest` with `Failed` for that GET, without inventing a server status or response body. The actual application's catch branch must show its error and Retry control.
3. An actual Retry click issues a third GET. It must receive a genuine 200, match the original fixture DTO, clear the error, and render the detail. The run requires exactly three controlled detail requests and two real 200 responses.

Only during those three steps, subsequent genuine same-project component GET 200 responses may be held to isolate background refresh timing. The initial disabled state is already checked. The maximum isolation window remains **15 seconds**; expiry records failure and immediately starts best-effort release. Each hold/release records the real request ID, status, and response hash. Responses are never replaced with synthetic success. Normal completion closes the detail before releasing the component replies.

Every intercepted real response is registered before body parsing or validation. Deadline and final cleanup share releases so a concurrent cleanup cannot issue duplicate continuation commands. A failed release remains recorded, while other entries are attempted. Cleanup releases original replies, then requests normal `Browser.close`. It never uses a kill fallback or removes the profile. A timeout, handler failure, unreleased response, or failed normal close is `failed_retained`; the runner does not increase the deadline or retry the business scenario automatically.

Final official reads check exactly one fixture Bug, unchanged Bug DTO/events, no comments, no attachments, five components off, and the same observed API/Web identities. New output is create-only under `docs/evidence/project-components/web-detail-loading-live/<runId>/`; private raw non-authentication bodies and the fresh profile remain under `runtimeRoot/web-detail-loading-<runId>/`. Public JSON is recursively redacted and scanned for in-memory secret literals, JWT-shaped values, and private-key material before writing.

## Evidence limits

The 11 tests exercise the actual exported allowlist, fault plan, response ledger, release helper, redactor, and inert CLI. They are pure fixtures and do not prove live CDP behavior. The armed test uses controlled network failure rather than a real backend outage. The background component hold is a harness control; it does not establish that normal background refresh never causes another detail GET, and it does not establish complete fault recovery in all timing conditions.

This plan does not add continuous all-frame observation, images, comments, client upgrades, cross-project operations, or component execution. Root's previously captured native EXE .9 loading and loaded frames remain separate historical evidence. The existing source tests, earlier Web recovery runs, and release proof are not rewritten as results of this runner.
