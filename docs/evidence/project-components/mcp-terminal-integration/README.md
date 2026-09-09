# MCP terminal RepairAttempt integration evidence

This evidence covers the server catalog and adapter boundary for the committed terminal
RepairAttempt routes, plus regression coverage for the frozen Verification result tool. It does
not claim production, preview, database migration, or UI acceptance.

The shared server catalog now exposes `qa_fail_repair_attempt` and
`qa_supersede_repair_attempt`. Both inputs are closed schemas. The fail tool requires
`projectId`, `attemptId`, `expectedVersion`, and `reason`. The supersede tool additionally
requires a closed `successor` object containing `id`, `mode`, and `assigneeId`, with an optional
summary.

The adapter derives the canonical workflow idempotency key from the operation, RepairAttempt ID,
and expected version. An explicitly supplied key must be identical. Both terminal commands enter
the fixed authenticated HTTP route with the 1.1 vendor media type. This makes supersede use the
route's atomic representation, where the old attempt and explicit successor are one command.

The desktop's normal `sharedApi` mode continues to fetch `/api/v1/mcp/tools` and forward these
tools through `/api/v1/mcp/call`; no desktop product source change was needed. A focused desktop
test covers discovery and byte-for-byte argument forwarding.

The existing `qa_record_verification_result` definition and adapter remain unchanged. Focused
coverage confirms its closed request schema still accepts at most 20 unique attachment IDs and an
optional capture bundle ID, and that a request with exactly 20 IDs plus a capture bundle reaches
the Verification result HTTP route with its canonical key.

See `result.json` for source hashes, exact commands, and the integration boundary.
