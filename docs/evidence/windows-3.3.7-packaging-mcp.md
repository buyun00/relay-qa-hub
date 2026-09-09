# Windows 3.3.7: packaging and increment-upload MCP

Nine additive MCP tools expose the existing authenticated backend APIs for build
status/submission, upload status/submission, one-call external Android build and
upload, upload recovery, final publication, and scoped cancellation. The EXE
creates no local upload process. Existing user ownership and shared history are
enforced by the backend; platform credentials are not tool inputs or outputs.

Default product 2002, Android channel 1002, tester 11562 and automatic version
match the shared upload contract. iOS uploads use channel 2004 and the existing
server-side latest-ZIP selection. The build preset remains Android-only. The two
modes are full publication and preparation through the final confirmation step.

Validation before packaging: desktop 69/69, related API 31/31 and Web 54/54 tests;
desktop/Web type checks, changed-file ESLint and Git whitespace checks passed.
New tests traverse real loopback MCP HTTP, the desktop authenticated API client,
real API HTTP routes, SQLite queue persistence and the build/upload handoff.
Jenkins and the platform worker are isolated fixtures: this is integration proof,
not a new production build or platform publication. It covers same-key replay,
conflict rejection, API/MCP restart, client-independent scheduling, pinned ZIP
handoff, shared reads, owner-only recovery, final confirmation, iOS parameters,
authentication errors and cancellation. Existing production data stays unchanged.

The one-click and upload tools retain durable request IDs. Ordinary build uses
the existing process-local Jenkins deduplication cache, is marked non-idempotent
in MCP annotations, and instructs callers to inspect the queue after uncertain
results or an API restart before considering resubmission.

Release receipts are retained in `work/windows-3.3.7-release`.

Release `20260909T095120896Z` was built from
`f3accee03ad6815ebc051a9e8363fae7799e9440` and published as Windows/Web 3.3.7.
Online manifests passed signature validation, and both actual downloads matched
their declared size and SHA-256:

- Installer: 150476619 bytes,
  `dca7528f21825e3c4f7d4a6afb98059846e4bf3b214ff5f3a5e22c072e65a94e`.
- Portable: 150832480 bytes,
  `a806e6ec44a65545424a425cda3dbef316c97bb3a41b854c1a5e954be59dc934`.

Packaged ASAR source identity, MCP modules and nine Web resources matched the
release build. Live Web JS/CSS matched byte-for-byte, and API readiness passed.
The production API and worker 0.4.4 required no restart or change for these tools.

Actual EXE acceptance on isolated port 4321 enumerated all 27 tools, read live
Jenkins status and build progress, and queried the published 2.4.35 task with
remote status 100 and four audit entries. Invalid/unsupported submissions failed
before reaching the production write APIs. No extra production build or upload
was submitted for this acceptance run; external execution in integration tests
used the fixtures described above.

The isolated real 3.3.6 to 3.3.7 update downloaded, installed and relaunched the
new package while retaining profile, runtime config, upload checkpoint/account,
build-chain fixtures and rollback. Existing daily EXE PIDs and startup settings
were preserved, and test ports were released. The live daily MCP on 4320 still
reports 3.3.4; it gains the new tools when that EXE is updated and restarted.
Previous 3.3.6 artifacts and source remain under
`apps/desktop/release/builds/prepublish-20260909T083154895Z-20260909T094943833Z`.
