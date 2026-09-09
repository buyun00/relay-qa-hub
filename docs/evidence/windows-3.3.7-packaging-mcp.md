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
