# QA Hub contract package

Contract version `1.0.0` freezes the P0 API, domain-state, event, upload, and Relay integration boundaries. The generated OpenAPI document is rooted at `/api/v1`; JSON Schema `$id` values are stable identifiers and do not imply a network dependency.

## Reproducible checks

From the repository root, with the pinned Node runtime on `PATH`:

```text
npm run generate:contracts
npm run check:contracts
npm run check:contract-breaking
```

`generate:contracts` is deterministic. `check:contract-breaking` compares canonical JSON hashes rather than formatting. Contract changes require compatibility review, a version decision, updated examples, and a deliberate `node packages/contracts/scripts/check-breaking.mjs --write-baseline`; silently rewriting the baseline is prohibited.

The freeze includes both twelve schema payload scenarios and twelve executable behavior scenarios. The latter exercise replay/mismatch idempotency, stale versions, machine-only denial, exact Build identity, late/out-of-order Relay events, semantic duplicate policy, Push degradation, and Relay task-close behavior.

## Idempotency and canonical payloads

- Every write supplies `Idempotency-Key`. Existing aggregate mutations also supply `If-Match` or the body's `expectedVersion`.
- A receiver stores the key, SHA-256 canonical request hash, status, and safe response snapshot transactionally with the business action.
- Canonical JSON uses UTF-8, lexicographically sorted object keys, JSON number/string normalization, and preserved array order.
- Relay handoff canonicalization removes only `selectedAttachments[*].downloadUrl` before hashing because URLs rotate. Attachment ID, filename, media type, size, SHA-256, and array order remain covered.
- The same key/hash returns the original safe response; the same key with a different hash returns `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.
- Handoff key: `qa:<qaInstanceId>:handoff:<handoffId>`.
- Continuation key: `qa:<qaInstanceId>:action:<actionId>`.

## Relay M2M and webhook boundary

The Relay-facing operations are a separate versioned API implemented in P5:

- `POST /api/integrations/qa/v1/handoffs` requires a scoped bearer identity with `qa:handoff:create`.
- `POST /api/integrations/qa/v1/handoffs/{handoffId}/turns` requires `qa:handoff:continue`.
- `GET /api/integrations/qa/v1/handoffs/{handoffId}` requires `qa:handoff:read` and returns only safe reconciliation fields.

Relay webhook authentication covers the exact raw body:

```text
X-Relay-Timestamp: <unix-seconds>
X-Relay-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>
Idempotency-Key: relay-main:event:<eventId>
X-Relay-Delivery-Id: relay-main:event:<eventId>
X-Relay-Event-Id: <eventId>
```

QA Hub verifies signature and configured replay window before inserting the durable Inbox row. It then deduplicates both `(relayInstanceId,eventId)` and `deliveryId`, checks body-hash conflicts, and applies ordered projections asynchronously.

The Build webhook uses its dedicated machine schema; it cannot claim a QA/user actor or submit an arbitrary domain Event. It must identify provider, external Job, project, branch, full source SHA, mode, status, and delivery.

No M2M identity or webhook event can pass a Verification, close/reject/defer a Bug, or decide a semantic duplicate. `turn.delivered` only becomes eligible after schema validation plus the executable cross-field invariant `commitSha == remoteSha`; `build.completed` must match the current attempt's delivered SHA; `task.closed` remains metadata-only. OpenAPI error responses enumerate cataloged codes for their exact HTTP status.
