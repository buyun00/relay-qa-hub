# Live workflow concurrency acceptance

This directory retains immutable real-request runs, including failures. The runner is inert without `--run` and confines mutations to a newly created preview project with all five components disabled. Each race launches two requests before awaiting their responses: direct HTTP on 4419 and actual server JSON-RPC MCP on 4421, using the same employee, project, business key and canonical payload. No EXE session, UI, component execution, production route or external task is operated.

## First run: confirmed product failures

- Run `e94223b3-82c5-469d-b7ca-eea306ba0aab`; 2026-09-08 22:12:39–22:12:40 UTC.
- Evidence: [raw sanitized exchanges and assertions](e94223b3-82c5-469d-b7ca-eea306ba0aab.json); raw-byte SHA-256 `999efd88f54db67331b68c7d5aad9031f9f2048e94d625c23a5864433cc6370f`.
- Runtime: the existing preview API PID 18644, deployed `09f7150fc1c671d867bbdbc257cab0e61c78d20f` API change, schema 14. The proof records the exact on-disk API/storage dist and runner hashes. Runtime was not restarted or rebuilt for this run.
- 98 actual requests, 86 assertions: 67 passed and 19 failed; no harness exception. All 12 races observed both dispatches before either response completed.
- Six actions (`ready`, human repair plan/start/deliver, verification create/start) each executed once but rejected the same-key concurrent request and subsequent retries with `VERSION_CONFLICT`. Their 18 failed assertions distinguish exactly-once effects from the missing successful receipt replay.
- Creating a Bug with a reused submission ID and changed title returned HTTP 500 `SQLITE_IDEMPOTENCY_MISMATCH`. The frozen 1.1 contract requires HTTP 409 `IDEMPOTENCY_PAYLOAD_MISMATCH`. This is a product failure, not an accepted alternate error code.
- Same-key Bug creation, update, comment, passed verification result and soft deletion succeeded across HTTP/MCP without duplicate effects. Different edit keys at the same version produced one winner and one version conflict, with one event and one version increment.
- Fresh project `36f97393-1c30-4217-b4ff-1408ffb5e84c`, employee `ad045f49-111f-4aa2-87df-adcc19773836`. Bug `b7a00c7e-4700-4a77-bae4-cb48a1c1944f` went through one human repair and one verification, then was soft-deleted by the explicit test step. Project, employee, history, audit and deletion evidence remain retained.

This run does not pass baseline 14. It does not test APK/EXE/Web timeout recovery, local EXE MCP, all workflow actions, all attachment stages, or external task deduplication. The server-MCP action envelope also includes a fresh Bug read: comparisons deliberately use the shared resource DTO fields rather than claim byte-identical entire envelopes after later state changes.
