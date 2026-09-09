# Android lost-201 proxy — inert preparation

This record covers a new test runner, not an APK change. The runner and tests are separate from the frozen Android source. **No listener, outbound HTTP request, adb/device action, browser, service or business operation was used during this preparation.** The default CLI was executed and returned `not_run`. The real native/socket experiment remains unexecuted by this subtask.

Files:

- `scripts/project-components/android-recovery-proxy.mjs`, SHA256 `a164c85357260430d8ad8d8566ca7d9f98249669823dbbe8ecf3ea621430d7af`.
- `scripts/project-components/android-recovery-proxy.test.mjs`, SHA256 `199c37077ed4e1da80acc72cbde63015222435051480752cba6ecee1357c4c78`.
- [Final preparation log](runs/android-recovery-proxy-preparation-users500.txt): **19/19 pure-memory tests**, `node --check`, ESLint and Prettier passed. Tests call the actual controller and actual frozen1.1 request/response validators with injected memory-only forwarding/persistence. They do not claim a real HTTP server, socket drop, native UI or filesystem durability test.

## Scope and mechanism

The only forwarded business write is native **POST `/api/v1/bugs`**, in text-only form. An authenticated request must match the configured token fingerprint, project, actor header and frozen1.1 request schema. The first accepted native request fixes its submission ID, `Idempotency-Key` digest and exact raw-body SHA256. A new key, changed form or even JSON whitespace change cannot replace that request. Original bytes are forwarded without reconstructing the body; there is no retry loop or autonomous API call.

Before accepting that write, the runner must observe a scoped Bug list with zero items/no cursor and the project's five components all disabled. These observations must travel through the proxy; setup facts previously collected directly from4419 do not set the runner's flags. Open the native component view and return to its Bug list, or send explicitly controlled read-only requests using that native session. The proxy does not fetch those facts on its own.

For each incoming matching create, the adapter makes one request to the fixed upstream `http://127.0.0.1:4419`. It persists the real response bytes privately before checking exact201, vendor media type, the original frozen response schema, configured project/reporter, submitted owner/verifier and matching receipt identifiers. Successive receipts must retain the same Bug, occurrence, event and submission IDs. The first four valid receipts cause the still-connected client socket to be destroyed before response headers. A response that is invalid, belongs elsewhere, arrives after the client disconnected, or cannot be preserved is not counted as a successful injection.

After four drops, phase becomes `awaiting_explicit_native_confirmation`. No further create can reach the API until the operator writes the exact confirmation marker and then invokes the native action. Writing a marker or reading status causes no request. A fifth request before that marker fails the experiment and is not forwarded. A matching fifth native request forwards the real validated201 unchanged and sets `confirmed`. No sixth create is allowed. The marker is an operator assertion of the intended gesture; the proxy cannot prove which UI generated a request. Correlate the actual native click, UI hierarchy/screenshot, request timestamps, local row and official API readback before claiming APK acceptance.

Concurrent creates are refused. A native list refresh overlapping an in-flight create waits until its receipt identity is known, avoiding a false foreign-record result from normal commit/read timing. Unknown routes remain refused without broadening the allowlist. A targeted experiment error stops business forwarding and keeps its failure evidence.

## Native authentication and allowed reads

Two mutually exclusive authentication configurations exist:

1. `bearerTokenSha256` contains the already known native token digest and `bootstrapName` is `null`. A separately issued API login token cannot substitute for the APK's vault token.
2. `bearerTokenSha256` is `null` and `bootstrapName` is the exact fresh test name. The proxy allows native POST `/api/v1/auth/login` only with exact keys `{name,client,projectId}`, configured name/project and `client:"android"`; no incoming Authorization or Cookie is allowed on this bootstrap. The real200 must match the configured actor, name and project, a valid account ID, non-GM identity, valid43-character token and future expiry. The first account ID becomes fixed. Only the returned token's SHA256 is retained in memory; raw login requests, response bodies, token hashes and headers are not written to public or private evidence. The successful response is forwarded unchanged.

`QaHubRoot` performs entry → name login → project list each time its process starts. To support code22 → code23 and one further recovery restart, at most **three** successful same-identity native bootstraps are permitted per runner. A later bootstrap must keep the same account/actor/project/name; it rotates only the current in-memory token binding. Old tokens cease to be accepted. The creation identity/body remain fixed. Concurrent authentication/creation and a fourth bootstrap are refused. Stop and review a failed run instead of extending its limit while it is active.

Allowed reads are limited to:

- Unauthenticated exact `/api/v1/project-entry/<configured-project>`; returned ID and active state are checked.
- Authenticated `/api/v1/projects?limit=100`; response must contain exactly the configured fresh project and no continuation cursor.
- `/api/v1/bugs?projectId=<configured-project>&limit=<bounded-value>`, with optional state; duplicate or unknown query keys are refused. Before first create this must be empty; afterward every returned Bug must be the recorded one.
- Exact project `components`, `users`, `members` and `modules` paths; `members?limit=100` and `users?limit=500` are explicitly supported. The native tools page reads users before components. The users response must have the matching root projectId and at most500 UUID user IDs; any additional per-item project/account scope must also match. The actual ManagedProjectUser DTO has no per-item projectId, so scope is not inferred from an invented field. Missing `x-qa-project-id` is accepted because the immutable path and authenticated fingerprint bind scope. Any supplied project/actor header must match.
- The recorded Bug's exact detail, events/comments/attachments/human-workflow reads, with only the allowed limit query. Unknown Bug IDs cannot be read through the runner.

No GM login, user change, comment write, attachment upload, capture creation, update download, component task, arbitrary proxy URL or production port is allowed. Text-only means attachment IDs must be empty and captureBundleId absent. Existing code22 captured drafts whose STAGE upload has not finished cannot be tested with this runner. The current bounded legacy case is a new synthetic **text** create from code22, exhausted before upgrading, then recovered with code23 using the same still-running proxy and unchanged API origin. Image staging and corrupt-protocol modes require a separate bounded implementation and review.

## Configuration and explicit start — not executed

The root agent supplied the fresh test identity after official membership readback: project `b9a42a41-c15d-4393-8568-61d22a30ba98`, actor `9229e801-0ad6-4616-85b4-d40d66b50822`, name `AndroidRecovery65ee5dc8`. These identifiers are not authentication secrets. The following is a reviewable example only; port4559 has not been probed by this subtask.

```json
{
  "schemaVersion": 1,
  "mode": "drop-create-201",
  "runId": "65ee5dc8-3f23-4f28-ad97-daa1de8b0ece",
  "projectId": "b9a42a41-c15d-4393-8568-61d22a30ba98",
  "actorId": "9229e801-0ad6-4616-85b4-d40d66b50822",
  "bearerTokenSha256": null,
  "bootstrapName": "AndroidRecovery65ee5dc8",
  "listenHost": "127.0.0.1",
  "listenPort": 4559,
  "apiOrigin": "http://127.0.0.1:4419",
  "privateRunDirectory": "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/android-recovery-proxy-65ee5dc8-3f23-4f28-ad97-daa1de8b0ece",
  "scriptSha256": "a164c85357260430d8ad8d8566ca7d9f98249669823dbbe8ecf3ea621430d7af",
  "requestTimeoutMs": 15000,
  "maxRunMs": 1800000,
  "maxRequests": 500
}
```

Save the config only beneath the known private preview runtime, for example the root-owned `android-code23-recovery-65ee5dc8-3f23-4f28-ad97-daa1de8b0ece/proxy-config.json`. The runner insists on absolute paths, matching script SHA, fixed loopback4419 upstream, permitted distinct port, unique run ID and a new exact sibling output directory. It checks existing path components for links and refuses existing output directories. It does not reuse or overwrite an old run. The output parent must already exist.

```powershell
node scripts/project-components/android-recovery-proxy.mjs --run 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\android-code23-recovery-65ee5dc8-3f23-4f28-ad97-daa1de8b0ece\proxy-config.json'
```

Only this explicit `--run` form opens the configured listener. The script contains no adb or child-process call. Root must independently verify the free host port, retain the device's original reverse mappings, add the one preview tcp4419 → host proxy-port mapping, and restore it after the experiment. Do not change the APK origin, primary API listener or daily mapping. Preserve the code22 data/archive and old unsent drafts as described in the separate [code23 plan](android-code23-recovery-plan.md).

Keep the process alive across the upgrade. There is no resumable runner-state import: restarting it into the same output directory is refused, and starting a different run after the Bug exists fails the required empty-project check. A stopped partial run is evidence for review, not a fresh chance to drop more responses for the same logical intent.

## Status, confirmation, timeout and exit

- Read the private `status.json` directly, or GET `http://127.0.0.1:<proxy-port>/_qa_proxy/status`. This endpoint is read-only, returns no token/hash/header/body content and does not call the API. It exposes run ID, configured scope, phase, counters, original key/body hashes and public receipt IDs. The endpoint is local and unauthenticated; it is not an Internet-facing control API.
- After status reports four drops, root writes **once**, using an exclusive file create, `confirm-native-action.json` in the runner output directory. Its exact keys are `{runId,keySha256,bodySha256,explicitNativeAction:true}` with values copied from that run's current status. Then root performs the actual native confirmation. Do not create the marker before inspecting four-drop state, and do not send a script-generated POST as the purported native click.
- To stop, write `stop.json` with `{runId:"<this-run>",stop:true}` into that directory, or send the runner process SIGINT/SIGTERM. A250ms local-file check triggers shutdown; it sends no API request. The configured maximum runtime also stops the runner.
- Each forwarded HTTP operation has a total deadline, not only an inactivity timer. Shutdown closes the listener, waits for in-flight handler/forward completion and allows at most request-timeout plus a small close allowance for sockets. Private responses already received remain. Abrupt host termination cannot promise a final status record; durable completed request/receipt files and event records must then be reconciled manually.

`status.json` is atomically replaced from a synced temporary file. Original request and each real create-response file use exclusive create plus `fsync` before a loss can be recorded. `public-events.jsonl` contains only fixed diagnostic codes, synthetic IDs, counters and hashes; unknown error text is reduced to a fixed code. It never contains Authorization/Cookie headers or request/response body text. Login responses are never persisted. Only reviewed public metadata should be copied into Git; original request/receipt bytes, native vault/data and APK remain private.

The earlier18-test log remains at [original preparation log](runs/android-recovery-proxy-preparation.txt). Root static review identified the missing exact users?limit=500 native prerequisite before any run. The narrow correction and one parameterized scope/query test produced the separate19-test log; no live attempt was spent on that preparation defect.

## What validation establishes

The19 memory-only tests cover strict config/path/auth constraints, four drops and one exact final receipt decision, explicit fifth-request gate, original bytes/key invariance, wrong project/actor/token/receipt IDs, schema/media errors, persistence failures, concurrent POST refusal, disconnected-client refusal, read/commit overlap, bounded same-identity bootstrap/rotation and credential-free diagnostics. They compile the real frozen schema instead of using a permissive mock schema. Static checks and default `not_run` prove the prepared entry point is inert in the tested invocation.

They do **not** validate actual OS binding conflict behavior, Android network timing, graceful native close, disk-full behavior, private filesystem atomicity, actual API session media/fields, UI gestures, queue persistence across APK upgrade, upload handling or physical-device recovery. Root's controlled run must record those applicable outcomes separately and leave the others unexecuted. No baseline or existing matrix was modified by this preparation.
