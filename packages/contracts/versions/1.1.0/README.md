# QA Hub contract 1.1.0 — App-first additive layer

This directory is an independently validated addition to the frozen flat
`1.0.0` contract. The Android compatibility reviews loosened the accepted API
floor from 35 to 31 on 2026-08-27 and from 31 to 29 on 2026-09-01; neither
change removed an operation, field, media type, status, or existing payload.
The strict 1.1.0 baseline was re-recorded after the explicit additive reviews.

## Wire compatibility and negotiation

All 35 version 1.0 operations, statuses, browser Cookie/CSRF requirements, JSON
request/response media types, state rules, and integration boundaries remain.
Version 1.1 adds a human-only short-lived native bearer as an **OR** alternative
for the same human operations. It is not a Relay M2M credential.

Existing operations that need richer App payloads retain their 1.0
`application/json` shape and add this explicit media type:

```text
application/vnd.relay-qa-hub.v1.1+json
```

The Android App targets `minSdk=29`, `compileSdk=37`, and `targetSdk=37`. It
selects request and response media from each operation's advertised OpenAPI
content. JSON operations prefer
`Accept: application/vnd.relay-qa-hub.v1.1+json, application/json;q=0.9`;
`getAttachment` instead prefers `application/octet-stream`, `streamEvents`
prefers `text/event-stream`, and both still accept the versioned and legacy JSON
error representations at lower quality values. `putUploadChunk` sends
`application/octet-stream`.
`minSdk` is a packaging/install floor, not a server admission rule: the backend
records any positive integer `androidApi` reported by a structurally valid
request and does not reject a submission merely because the client is older.
The App must not invent a JSON fallback for binary or SSE operations. This is
required because the frozen 1.0 response schemas use `additionalProperties:
false`; silently adding required fields to `application/json` would not be
wire-additive.

## Native session boundary

The App uses opaque, short-lived human access tokens plus rotating refresh
tokens. Login and refresh responses are `Cache-Control: no-store`; any encrypted
idempotency response snapshot is retained for at most five minutes and never
logged. Login replay is scoped by the successfully resolved account and
installation; refresh replay is scoped by the validated refresh-token family.
Credentials are validated before any secret response snapshot lookup, so an
unauthenticated caller cannot probe or replay another account's token response.
Shared-device sessions are short, cannot register Android Push, revoke
their device notification binding on logout, and require the App to clear that
account's Room/media/token namespace.

## Offline submission and attachment ownership

The durable path is:

```text
init -> chunks -> reconcile -> finalize -> scan observation -> attachment reservation -> capture bundle -> commit
```

`clientSubmissionId` identifies one final Bug/Occurrence action.
`clientAttachmentId` identifies one local media item within that submission.
Server uniqueness and authorization include the authenticated actor and project;
another actor or project never receives the original resource identity.

Stable keys are operation-scoped:

```text
submission:<submissionId>:commit
submission:<submissionId>:attachment:<attachmentId>:upload:<uploadAttempt>:init
submission:<submissionId>:attachment:<attachmentId>:upload:<uploadAttempt>:chunk:<chunkNumber>
submission:<submissionId>:attachment:<attachmentId>:upload:<uploadAttempt>:finalize
submission:<submissionId>:attachment:<attachmentId>:bind:<leaseGeneration>
```

The same scoped key and canonical payload returns the original safe response and
IDs. The same key with different canonical JSON, or different exact chunk bytes,
returns `409 IDEMPOTENCY_PAYLOAD_MISMATCH`. Every chunk has an exact byte length
and hash; the final chunk is the exact remainder and all confirmed bytes must
sum to `expectedSize`. Finalize always returns an unbound attachment. Bind stays
fail-closed until scanning is `clean`, compares `expectedVersion`, advances the
aggregate version, and returns a time-bounded lease. An expired upload restarts
with the next `uploadAttempt`; an expired unclaimed lease renews with the next
`leaseGeneration` without changing its tuple. A reservation is not a fake binding
to a Bug that does not yet exist; create/append/comment/verification commit freezes
the intent and target, then atomically claims every still-unexpired reservation
for the same account, actor, project, submission, and attachment or claims none. Final responses
use `qaItem: { type: "bug", id, key }`, so the durable QA item is unambiguous.

## Capture and Poco ceiling

System screenshot/recording is primary evidence. Poco data is optional,
time-correlated enrichment. The client reports negotiated/succeeded read-only
capabilities only after `GetSDKVersion` succeeds; the server derives
`unavailable | partial | complete`. Every artifact carries its own capture ID,
start/end timestamps, and skew; succeeded artifacts have one-to-one attachment
identities and each artifact kind occurs at most once. No contract
claims an atomic same-frame snapshot.

`qa.snapshot` request and response carry matching `captureId`, `nonce`, and
`schemaVersion`; `deadlineMs` is a relative monotonic remaining budget. Logs and
custom fields are bounded. The allowed method list contains only
`GetSDKVersion`, `Screenshot`, `Dump`, `GetScreenSize`,
`GetDebugProfilingData`, and `qa.snapshot`. Poco failure never blocks a normal
system-evidence submission.

Relay uses an explicit allowlist for repair delivery and exact-build projections.
Receipts always require human verification. Relay cannot create or change any
Verification outcome or QA Bug workflow state, including failed/blocked/cancelled
results as well as acceptance or closure.

## Repair, Build, and Verification write chain

A delivery creates a server-owned, versioned `BuildRequirement` and a typed,
immutable decision audit. Its basis is exactly one of `code_requires_build`,
`no_code_delivery`, or `authorized_no_build_exemption`; the latter preserves
the authorized actor, reason, delivery request digest, and audit identity so a
code delivery that legitimately produces no Build remains reachable at later
Verification writes. A required Build starts unlinked at version 1 and leaves
the Bug in `awaiting_build`.

`linkBuildRepair` compares the Build version, the Bug version captured at
delivery, and BuildRequirement version 1. One transaction writes the relation,
BuildRequirement version 2, and moves the Bug only to
`ready_for_verification`. The relation freezes either manifest proof bound to
the exact account/project/Build/Attempt/commit/manifest digest, or an audited
release-manager override bound to its reason, actor, policy, and audit event.
Verification creation and result recording must read that same decision and
relation; they never re-interpret current Build metadata. A second ready Build
with the same commit is not interchangeable unless it is the committed linked
Build.

Every patched write operation keeps its frozen `application/json` request and
success representation and also exposes the declared v1.1 vendor media. When
the v1.1 payload shape is unchanged, the vendor representation points to the
same rebased base schema rather than silently omitting the wire contract.

The versioned supersede request carries a client-generated successor ID plus
mode, assignee, and optional summary. The server proves the ID was unused and
atomically creates a planned child while superseding the old Attempt. Frozen
1.0 `application/json` has no successor draft, so it deliberately remains a
two-step compatibility flow: supersede the old Attempt and return the Bug to
`ready`, then call `createRepairAttempt` with `parentAttemptId` set to the old
Attempt. It never silently clones an old mode or assignee.

## Reproducible checks

From the repository root:

```text
npm run generate:contracts:app-first
npm run check:contracts:app-first
npm run check:contract-additive
npm run check:contract-breaking
npm run check:contract-breaking:app-first
```

The first breaking check protects 1.0.0. The last protects this directory with a
separate baseline. Never regenerate either baseline silently.
